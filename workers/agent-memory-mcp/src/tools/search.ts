/**
 * tools/search.ts — Search MCP tools
 */
import { z } from "zod";
import type { Env } from "../core/env.ts";
import { rpc } from "../core/db.ts";
import { embedForQuery, embed } from "../core/embeddings.ts";
import { validatePositive, validateRange, validateNonNegative } from "../core/utils.ts";

// ── Schemas ───────────────────────────────────────────────────────────────────

export const searchSchema = z.object({
  query: z.string().describe("Search query text"),
  limit: z.number().optional().describe("Max results (default: 10)"),
  threshold: z.number().min(0).max(1).optional().describe("Min similarity threshold (default: 0.3)"),
  profile: z.string().optional().describe("Filter by profile"),
  tag: z.string().optional().describe("Filter by specific tag"),
  source: z.string().optional().describe("Filter by source"),
  min_confidence: z.number().min(0).max(1).optional().describe("Filter by min confidence"),
  after: z.string().optional().describe("Filter by created_at >= date (ISO 8601)"),
  before: z.string().optional().describe("Filter by created_at <= date (ISO 8601)"),
  pinned: z.boolean().optional().describe("Only return pinned memories"),
  min_importance: z.number().min(0).max(1).optional().describe("Filter by min importance"),
  graph_depth: z.number().min(0).optional().describe("Include related memories up to N hops"),
});

export const contextSchema = z.object({
  query: z.string().describe("Context query text"),
  limit: z.number().optional().describe("Max initial results (default: 5)"),
  depth: z.number().min(0).optional().describe("Graph traversal depth (default: 2)"),
  profile: z.string().optional().describe("Filter by profile"),
});

export const suggestTagsSchema = z.object({
  content: z.string().describe("Content to suggest tags for"),
  limit: z.number().optional().describe("Max tags to suggest (default: 5)"),
});

// ── Tool Handlers ─────────────────────────────────────────────────────────────

export async function memorySearch(env: Env, params: z.infer<typeof searchSchema>) {
  const limit = validatePositive(params.limit ?? 10, "limit");
  const threshold = validateRange(params.threshold ?? 0.3, 0, 1, "threshold");
  const graphDepth = params.graph_depth !== undefined ? validateNonNegative(params.graph_depth, "graph_depth") : 0;

  const queryEmbedding = await embedForQuery(env, params.query);

  const results = await rpc(env, "hybrid_search", {
    query_text: params.query,
    query_embedding: queryEmbedding,
    match_count: limit,
    match_threshold: threshold,
    ...(params.profile && { profile_filter: params.profile }),
    ...(params.source && { source_filter: params.source }),
    ...(params.tag && { tag_filter: params.tag }),
    ...(params.min_confidence !== undefined && { min_confidence: params.min_confidence }),
    ...(params.after && { after_date: params.after }),
    ...(params.before && { before_date: params.before }),
    ...(params.pinned && { pinned_only: true }),
    ...(params.min_importance !== undefined && { min_importance: params.min_importance }),
  });

  const rows = Array.isArray(results) ? results as Record<string, unknown>[] : [];

  // Bump access_count
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id as string);
    rpc(env, "bump_access_count", { memory_ids: ids }).catch(() => {});
  }

  // Graph traversal
  if (graphDepth > 0 && rows.length > 0) {
    const seen = new Set<string>(rows.map((r) => r.id as string));
    const related: Record<string, unknown>[] = [];
    for (const mem of rows) {
      try {
        const edges = await rpc(env, "find_related_memories", {
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
    return { query: params.query, memories: rows, ...(related.length > 0 && { related }) };
  }

  return rows;
}

export async function memoryContext(env: Env, params: z.infer<typeof contextSchema>) {
  const limit = validatePositive(params.limit ?? 5, "limit");
  const depth = validateNonNegative(params.depth ?? 2, "depth");

  const queryEmbedding = await embedForQuery(env, params.query);
  const searchResults = await rpc(env, "hybrid_search", {
    query_text: params.query,
    query_embedding: queryEmbedding,
    match_count: limit,
    match_threshold: 0.3,
    ...(params.profile && { profile_filter: params.profile }),
  }) as Record<string, unknown>[];

  if (!Array.isArray(searchResults) || searchResults.length === 0) {
    return { query: params.query, memories: [], related: [] };
  }

  // Bump access counts
  const ids = searchResults.map((r) => r.id as string);
  rpc(env, "bump_access_count", { memory_ids: ids }).catch(() => {});

  // Follow graph edges
  const seen = new Set<string>(ids);
  const related: Record<string, unknown>[] = [];

  if (depth > 0) {
    for (const mem of searchResults) {
      try {
        const edges = await rpc(env, "find_related_memories", {
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

  return {
    query: params.query,
    memories: searchResults,
    ...(related.length > 0 && { related }),
  };
}

export async function memorySuggestTags(env: Env, params: z.infer<typeof suggestTagsSchema>) {
  const limit = validatePositive(params.limit ?? 5, "limit");
  const embedding = await embed(env, params.content);

  const similar = await rpc(env, "match_memories", {
    query_embedding: embedding,
    match_threshold: 0.3,
    match_count: 20,
  }) as Record<string, unknown>[];

  if (!Array.isArray(similar) || similar.length === 0) {
    return { suggested_tags: [], reason: "no similar memories found" };
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

  return { suggested_tags: sorted };
}
