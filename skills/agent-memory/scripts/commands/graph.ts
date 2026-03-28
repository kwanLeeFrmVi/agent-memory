/**
 * commands/graph.ts — Knowledge graph commands
 * cmdLink, cmdUnlink, cmdRelated, cmdLinkUnlinked, cmdImpact
 */
import { out, fatal, flag, validateRange, validateNonNegative } from "../core/utils.ts";
import { validateUuid } from "../core/utils.ts";
import { supa, rpc } from "../core/db.ts";
import { embed } from "../core/embeddings.ts";

export async function cmdLink(positional: string[], flags: Record<string, string | boolean>) {
  const [a, b] = positional;
  if (!a || !b) fatal("Usage: link <uuid-a> <uuid-b> [--type supports] [--strength 0.8]");
  validateUuid(a, "uuid-a");
  validateUuid(b, "uuid-b");

  const edgeType = flag(flags, "type") ?? "related";
  const strength = validateRange(parseFloat(flag(flags, "strength") ?? "0.7"), 0, 1, "--strength");

  const valid = ["supports", "contradicts", "expands", "related", "depends_on", "similar"];
  if (!valid.includes(edgeType)) fatal(`--type must be one of: ${valid.join(", ")}`);

  const result = await supa("POST", "/rest/v1/memory_edges", {
    source_id: a,
    target_id: b,
    edge_type: edgeType,
    strength,
  });
  const edge = Array.isArray(result) ? result[0] : result;
  out(edge);
}

export async function cmdUnlink(positional: string[], flags: Record<string, string | boolean>) {
  const [a, b] = positional;
  if (!a || !b) fatal("Usage: unlink <uuid-a> <uuid-b> [--type <edge-type>]");
  validateUuid(a, "uuid-a");
  validateUuid(b, "uuid-b");

  const q: Record<string, string> = {
    source_id: `eq.${a}`,
    target_id: `eq.${b}`,
  };
  const edgeType = flag(flags, "type");
  if (edgeType) q.edge_type = `eq.${edgeType}`;

  await supa("DELETE", "/rest/v1/memory_edges", undefined, q);
  out({ unlinked: { source: a, target: b, ...(edgeType && { type: edgeType }) } });
}

export async function cmdRelated(positional: string[], flags: Record<string, string | boolean>) {
  const id = positional[0];
  if (!id) fatal("Usage: related <uuid> [--depth n] [--min-strength f]");
  validateUuid(id);

  const depth = validateNonNegative(parseInt(flag(flags, "depth") ?? "2"), "--depth");
  const minStrength = validateRange(parseFloat(flag(flags, "min-strength") ?? "0.5"), 0, 1, "--min-strength");

  const result = await rpc("find_related_memories", {
    start_memory_id: id,
    max_depth: depth,
    min_strength: minStrength,
  });
  out(result);
}

export async function cmdLinkUnlinked(flags: Record<string, string | boolean>) {
  const threshold = validateRange(parseFloat(flag(flags, "threshold") ?? "0.85"), 0, 1, "--threshold");
  const batchSize = validateNonNegative(parseInt(flag(flags, "batch-size") ?? "50"), "--batch-size");
  const profile = flag(flags, "profile") ?? undefined;
  const dryRun = flags["dry-run"] === true;

  // Fetch memories
  const allMemories = await supa("GET", "/rest/v1/memories", undefined, [
    ["select", "id,content,embedding"],
    ...(profile ? [["profile", `eq.${profile}`] as [string, string]] : []),
    ["limit", String(batchSize)],
  ]) as Record<string, unknown>[];

  const linkedSources = await supa("GET", "/rest/v1/memory_edges", undefined, [
    ["select", "source_id"],
  ]) as Record<string, unknown>[];

  const linkedIds = new Set((linkedSources ?? []).map((r) => r.source_id as string));
  const unlinked = (Array.isArray(allMemories) ? allMemories : []).filter((m) => !linkedIds.has(m.id as string));

  let processed = 0;
  let linked = 0;
  let skipped = 0;
  let errors = 0;

  for (const mem of unlinked) {
    processed++;
    if (dryRun) continue;
    try {
      const embedding = await embed(mem.content as string);
      const neighbors = await rpc("match_memories", {
        query_embedding: embedding,
        match_threshold: threshold,
        match_count: 5,
        ...(profile && { profile_filter: profile }),
      }) as Record<string, unknown>[];

      if (Array.isArray(neighbors)) {
        for (const n of neighbors) {
          if (n.id === mem.id) continue;
          try {
            await supa("POST", "/rest/v1/memory_edges", {
              source_id: mem.id,
              target_id: n.id,
              edge_type: "similar",
              strength: Math.min(n.similarity as number, 1),
            });
            linked++;
          } catch { skipped++; }
        }
      }
    } catch { errors++; }
  }

  out({ processed: dryRun ? unlinked.length : processed, linked, skipped, errors, dry_run: dryRun });
}

export async function cmdImpact(positional: string[]) {
  const id = positional[0];
  if (!id) fatal("Usage: impact <uuid>");
  validateUuid(id);

  const edges = await supa("GET", "/rest/v1/memory_edges", undefined, {
    target_id: `eq.${id}`,
    select: "source_id,edge_type,strength",
  }) as Record<string, unknown>[];

  if (!Array.isArray(edges) || edges.length === 0) {
    out({ id, incoming_edges: 0, memories: [] });
    return;
  }

  const sourceIds = edges.map((e) => e.source_id as string);
  const memories: Record<string, unknown>[] = [];
  for (const sid of sourceIds) {
    try {
      const r = await supa("GET", "/rest/v1/memories", undefined, {
        id: `eq.${sid}`,
        select: "id,content,tags,created_at",
      }) as Record<string, unknown>[];
      if (Array.isArray(r) && r.length > 0) memories.push({ ...r[0], edge: edges.find((e) => e.source_id === sid) });
    } catch { /* skip */ }
  }

  out({ id, incoming_edges: edges.length, memories });
}
