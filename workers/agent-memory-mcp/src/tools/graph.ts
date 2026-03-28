/**
 * tools/graph.ts — Knowledge graph MCP tools
 */
import { z } from "zod";
import type { Env } from "../core/env.ts";
import { supa, rpc } from "../core/db.ts";
import { embed } from "../core/embeddings.ts";
import { validateUuid, validateRange, validateNonNegative } from "../core/utils.ts";

// ── Schemas ───────────────────────────────────────────────────────────────────

export const linkSchema = z.object({
  source_id: z.string().describe("Source memory UUID"),
  target_id: z.string().describe("Target memory UUID"),
  type: z.enum(["supports", "contradicts", "expands", "related", "depends_on", "similar"]).optional().describe("Edge type (default: 'related')"),
  strength: z.number().min(0).max(1).optional().describe("Edge strength (default: 0.7)"),
});

export const unlinkSchema = z.object({
  source_id: z.string().describe("Source memory UUID"),
  target_id: z.string().describe("Target memory UUID"),
  type: z.enum(["supports", "contradicts", "expands", "related", "depends_on", "similar"]).optional().describe("Only unlink edges of this type"),
});

export const relatedSchema = z.object({
  id: z.string().describe("Starting memory UUID"),
  depth: z.number().min(0).optional().describe("Max traversal hops (default: 2)"),
  min_strength: z.number().min(0).max(1).optional().describe("Min edge strength (default: 0.5)"),
});

export const linkUnlinkedSchema = z.object({
  threshold: z.number().min(0).max(1).optional().describe("Min similarity to create edge (default: 0.85)"),
  batch_size: z.number().min(1).optional().describe("Max memories to process (default: 50)"),
  profile: z.string().optional().describe("Filter to a specific profile"),
  dry_run: z.boolean().optional().describe("Count orphans without creating edges"),
});

export const impactSchema = z.object({
  id: z.string().describe("Memory UUID to check impact for"),
});

// ── Tool Handlers ─────────────────────────────────────────────────────────────

export async function memoryLink(env: Env, params: z.infer<typeof linkSchema>) {
  validateUuid(params.source_id, "source_id");
  validateUuid(params.target_id, "target_id");

  const edgeType = params.type ?? "related";
  const strength = validateRange(params.strength ?? 0.7, 0, 1, "strength");

  const result = await supa(env, "POST", "/rest/v1/memory_edges", {
    source_id: params.source_id,
    target_id: params.target_id,
    edge_type: edgeType,
    strength,
  });
  const edge = Array.isArray(result) ? result[0] : result;
  return edge;
}

export async function memoryUnlink(env: Env, params: z.infer<typeof unlinkSchema>) {
  validateUuid(params.source_id, "source_id");
  validateUuid(params.target_id, "target_id");

  const q: Record<string, string> = {
    source_id: `eq.${params.source_id}`,
    target_id: `eq.${params.target_id}`,
  };
  if (params.type) q.edge_type = `eq.${params.type}`;

  await supa(env, "DELETE", "/rest/v1/memory_edges", undefined, q);
  return { unlinked: { source: params.source_id, target: params.target_id, ...(params.type && { type: params.type }) } };
}

export async function memoryRelated(env: Env, params: z.infer<typeof relatedSchema>) {
  validateUuid(params.id);

  const depth = validateNonNegative(params.depth ?? 2, "depth");
  const minStrength = validateRange(params.min_strength ?? 0.5, 0, 1, "min_strength");

  const result = await rpc(env, "find_related_memories", {
    start_memory_id: params.id,
    max_depth: depth,
    min_strength: minStrength,
  });
  return result;
}

export async function memoryLinkUnlinked(env: Env, params: z.infer<typeof linkUnlinkedSchema>) {
  const threshold = validateRange(params.threshold ?? 0.85, 0, 1, "threshold");
  const batchSize = validateNonNegative(params.batch_size ?? 50, "batch_size");
  const dryRun = params.dry_run ?? false;

  // Fetch memories
  const allMemories = await supa(env, "GET", "/rest/v1/memories", undefined, [
    ["select", "id,content,embedding"],
    ...(params.profile ? [["profile", `eq.${params.profile}`] as [string, string]] : []),
    ["limit", String(batchSize)],
  ]) as Record<string, unknown>[];

  const linkedSources = await supa(env, "GET", "/rest/v1/memory_edges", undefined, [
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
      const embedding = await embed(env, mem.content as string);
      const neighbors = await rpc(env, "match_memories", {
        query_embedding: embedding,
        match_threshold: threshold,
        match_count: 5,
        ...(params.profile && { profile_filter: params.profile }),
      }) as Record<string, unknown>[];

      if (Array.isArray(neighbors)) {
        for (const n of neighbors) {
          if (n.id === mem.id) continue;
          try {
            await supa(env, "POST", "/rest/v1/memory_edges", {
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

  return { processed: dryRun ? unlinked.length : processed, linked, skipped, errors, dry_run: dryRun };
}

export async function memoryImpact(env: Env, params: z.infer<typeof impactSchema>) {
  validateUuid(params.id);

  const edges = await supa(env, "GET", "/rest/v1/memory_edges", undefined, {
    target_id: `eq.${params.id}`,
    select: "source_id,edge_type,strength",
  }) as Record<string, unknown>[];

  if (!Array.isArray(edges) || edges.length === 0) {
    return { id: params.id, incoming_edges: 0, memories: [] };
  }

  const sourceIds = edges.map((e) => e.source_id as string);
  const memories: Record<string, unknown>[] = [];
  for (const sid of sourceIds) {
    try {
      const r = await supa(env, "GET", "/rest/v1/memories", undefined, {
        id: `eq.${sid}`,
        select: "id,content,tags,created_at",
      }) as Record<string, unknown>[];
      if (Array.isArray(r) && r.length > 0) {
        memories.push({ ...r[0], edge: edges.find((e) => e.source_id === sid) });
      }
    } catch { /* skip */ }
  }

  return { id: params.id, incoming_edges: edges.length, memories };
}
