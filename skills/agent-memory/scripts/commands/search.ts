/**
 * commands/search.ts — Search commands
 * cmdSearch, cmdContext, cmdSuggestTags
 */
import { flag, out, fatal, validatePositive, validateRange, validateNonNegative } from "../core/utils.ts";
import { rpc } from "../core/db.ts";
import { embedForQuery, embed } from "../core/embeddings.ts";

export async function cmdSearch(positional: string[], flags: Record<string, string | boolean>) {
  const query = positional[0];
  if (!query) fatal("Usage: search <query> [--limit n] [--threshold f] [--profile p] [--tag t] [--source s] [--min-confidence f] [--after date] [--before date] [--pinned] [--min-importance f] [--graph-depth n]");

  const limit = validatePositive(parseInt(flag(flags, "limit") ?? "10"), "--limit");
  const threshold = validateRange(parseFloat(flag(flags, "threshold") ?? "0.3"), 0, 1, "--threshold");
  const profile = flag(flags, "profile") ?? undefined;
  const tag = flag(flags, "tag") ?? undefined;
  const source = flag(flags, "source") ?? undefined;
  const minConfidenceRaw = flag(flags, "min-confidence");
  const minConfidence = minConfidenceRaw ? validateRange(parseFloat(minConfidenceRaw), 0, 1, "--min-confidence") : undefined;
  const afterDate = flag(flags, "after") ?? undefined;
  const beforeDate = flag(flags, "before") ?? undefined;
  const pinnedOnly = flags["pinned"] === true;
  const minImportanceRaw = flag(flags, "min-importance");
  const minImportance = minImportanceRaw ? validateRange(parseFloat(minImportanceRaw), 0, 1, "--min-importance") : undefined;
  const graphDepthRaw = flag(flags, "graph-depth");
  const graphDepth = graphDepthRaw ? validateNonNegative(parseInt(graphDepthRaw), "--graph-depth") : 0;

  const queryEmbedding = await embedForQuery(query);

  const results = await rpc("hybrid_search", {
    query_text: query,
    query_embedding: queryEmbedding,
    match_count: limit,
    match_threshold: threshold,
    ...(profile && { profile_filter: profile }),
    ...(source && { source_filter: source }),
    ...(tag && { tag_filter: tag }),
    ...(minConfidence !== undefined && { min_confidence: minConfidence }),
    ...(afterDate && { after_date: afterDate }),
    ...(beforeDate && { before_date: beforeDate }),
    ...(pinnedOnly && { pinned_only: true }),
    ...(minImportance !== undefined && { min_importance: minImportance }),
  });

  // Bump access_count for returned results (fire-and-forget)
  const rows = Array.isArray(results) ? results as Record<string, unknown>[] : [];
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id as string);
    rpc("bump_access_count", { memory_ids: ids }).catch(() => {});
  }

  // --graph-depth: inline graph traversal on each result
  if (graphDepth > 0 && rows.length > 0) {
    const seen = new Set<string>(rows.map((r) => r.id as string));
    const related: Record<string, unknown>[] = [];
    for (const mem of rows) {
      try {
        const edges = await rpc("find_related_memories", {
          start_memory_id: mem.id,
          max_depth: graphDepth,
          min_strength: 0.5,
        }) as Record<string, unknown>[];
        if (Array.isArray(edges)) {
          for (const edge of edges) {
            const mid = edge.memory_id as string;
            if (!seen.has(mid)) {
              seen.add(mid);
              related.push(edge);
            }
          }
        }
      } catch { /* ignore */ }
    }
    out({ query, memories: rows, ...(related.length > 0 && { related }) });
    return;
  }

  out(results);
}

export async function cmdContext(positional: string[], flags: Record<string, string | boolean>) {
  const query = positional[0];
  if (!query) fatal("Usage: context <query> [--limit n] [--depth d] [--profile p]");

  const limit = validatePositive(parseInt(flag(flags, "limit") ?? "5"), "--limit");
  const depth = validateNonNegative(parseInt(flag(flags, "depth") ?? "2"), "--depth");
  const profile = flag(flags, "profile") ?? undefined;

  const queryEmbedding = await embedForQuery(query);
  const searchResults = await rpc("hybrid_search", {
    query_text: query,
    query_embedding: queryEmbedding,
    match_count: limit,
    match_threshold: 0.3,
    ...(profile && { profile_filter: profile }),
  }) as Record<string, unknown>[];

  if (!Array.isArray(searchResults) || searchResults.length === 0) {
    out({ query, memories: [], related: [] });
    return;
  }

  // Bump access counts
  const ids = searchResults.map((r) => r.id as string);
  rpc("bump_access_count", { memory_ids: ids }).catch(() => {});

  // Follow graph edges for each result
  const seen = new Set<string>(ids);
  const related: Record<string, unknown>[] = [];

  if (depth > 0) {
    for (const mem of searchResults) {
      try {
        const edges = await rpc("find_related_memories", {
          start_memory_id: mem.id,
          max_depth: depth,
          min_strength: 0.5,
        }) as Record<string, unknown>[];

        if (Array.isArray(edges)) {
          for (const edge of edges) {
            const mid = edge.memory_id as string;
            if (!seen.has(mid)) {
              seen.add(mid);
              related.push(edge);
            }
          }
        }
      } catch { /* ignore graph errors */ }
    }
  }

  out({
    query,
    memories: searchResults,
    ...(related.length > 0 && { related }),
  });
}

export async function cmdSuggestTags(positional: string[], flags: Record<string, string | boolean>) {
  const content = positional[0];
  if (!content) fatal("Usage: suggest-tags <content> [--limit n]");

  const limit = validatePositive(parseInt(flag(flags, "limit") ?? "5"), "--limit");
  const embedding = await embed(content);

  const similar = await rpc("match_memories", {
    query_embedding: embedding,
    match_threshold: 0.3,
    match_count: 20,
  }) as Record<string, unknown>[];

  if (!Array.isArray(similar) || similar.length === 0) {
    out({ suggested_tags: [], reason: "no similar memories found" });
    return;
  }

  const tagScores: Record<string, number> = {};
  for (const mem of similar) {
    const tags = (mem.tags as string[]) ?? [];
    const sim = (mem.similarity as number) ?? 0.5;
    for (const t of tags) {
      tagScores[t] = (tagScores[t] ?? 0) + sim;
    }
  }

  const sorted = Object.entries(tagScores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag, score]) => ({ tag, score: Math.round(score * 100) / 100 }));

  out({ suggested_tags: sorted });
}
