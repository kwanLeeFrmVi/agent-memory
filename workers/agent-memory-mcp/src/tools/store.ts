/**
 * tools/store.ts — Store MCP tools
 */
import { z } from "zod";
import type { Env } from "../core/env.ts";
import { envSource, envProfile, getEnvValue } from "../core/env.ts";
import { supa, rpc } from "../core/db.ts";
import { embed } from "../core/embeddings.ts";
import { parseTags, safeJsonParse, validateRange, validatePositive, validateUuid } from "../core/utils.ts";

// ── Schemas ───────────────────────────────────────────────────────────────────

export const storeSchema = z.object({
  content: z.string().describe("The memory content to store"),
  tags: z.string().optional().describe("Comma-separated list of tags (e.g., 'type:decision,project:myapp')"),
  source: z.string().optional().describe("Source identifier (default: 'mcp-worker')"),
  profile: z.string().optional().describe("Memory profile/partition (default: 'default')"),
  ttl_days: z.number().optional().describe("Time-to-live in days before automatic deletion"),
  metadata: z.string().optional().describe("Additional JSON metadata as string"),
  dedup_threshold: z.number().min(0).max(1).optional().describe("Skip if similarity >= threshold (0-1)"),
  auto_link: z.boolean().optional().describe("Automatically link to similar existing memories"),
  pin: z.boolean().optional().describe("Pin this memory as important"),
  importance: z.number().min(0).max(1).optional().describe("Importance score (0-1)"),
});

export const storeBatchSchema = z.object({
  memories: z.array(z.object({
    content: z.string(),
    tags: z.array(z.string()).optional(),
    source: z.string().optional(),
    profile: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })).describe("Array of memories to store"),
  dedup_threshold: z.number().min(0).max(1).optional().describe("Skip if similarity >= threshold"),
  auto_link: z.boolean().optional().describe("Automatically link to similar existing memories"),
  default_source: z.string().optional().describe("Default source for items without one"),
  default_profile: z.string().optional().describe("Default profile for items without one"),
});

export const storeDecisionSchema = z.object({
  decision: z.string().describe("The decision made"),
  rationale: z.string().describe("Why this decision was made"),
  alternatives: z.string().optional().describe("Comma-separated list of alternatives considered"),
  reasoning_trace: z.string().optional().describe("Full evaluation narrative"),
  tags: z.string().optional().describe("Additional tags (type:decision added automatically)"),
  related: z.string().optional().describe("Comma-separated UUIDs of related memories"),
  profile: z.string().optional().describe("Memory profile"),
  source: z.string().optional().describe("Source identifier"),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getProfileTtl(env: Env, profile: string): Promise<number | null> {
  try {
    const rows = await supa(env, "GET", "/rest/v1/profile_settings", undefined, {
      profile: `eq.${profile}`,
      select: "ttl_days",
    }) as Record<string, unknown>[];
    if (Array.isArray(rows) && rows.length > 0 && rows[0].ttl_days != null) {
      return rows[0].ttl_days as number;
    }
  } catch { /* table may not exist yet */ }
  return null;
}

// ── Tool Handlers ─────────────────────────────────────────────────────────────

export async function memoryStore(env: Env, params: z.infer<typeof storeSchema>) {
  const source = params.source ?? envSource(env);
  const profile = params.profile ?? envProfile(env);

  const embedding = await embed(env, params.content);

  // Dedup check
  if (params.dedup_threshold !== undefined) {
    const threshold = validateRange(params.dedup_threshold, 0, 1, "dedup_threshold");
    const dupes = await rpc(env, "match_memories", {
      query_embedding: embedding,
      match_threshold: threshold,
      match_count: 1,
      ...(profile && { profile_filter: profile }),
    }) as Record<string, unknown>[];

    if (Array.isArray(dupes) && dupes.length > 0) {
      return { skipped: true, reason: "duplicate_found", similarity: dupes[0].similarity, existing: dupes[0] };
    }
  }

  const row: Record<string, unknown> = {
    content: params.content,
    embedding,
    source,
    profile,
    tags: params.tags ? parseTags(params.tags) : [],
    metadata: params.metadata ? safeJsonParse(params.metadata, "metadata") : {},
    embedding_model: getEnvValue(env, "EMBEDDING_MODEL") ?? null,
    is_pinned: params.pin ?? false,
    ...(params.importance !== undefined && { importance: validateRange(params.importance, 0, 1, "importance") }),
  };

  // Apply TTL
  const profileTtl = params.ttl_days ? null : await getProfileTtl(env, profile);
  const effectiveTtl = params.ttl_days ?? profileTtl;
  if (effectiveTtl) {
    const days = validatePositive(effectiveTtl, "ttl_days");
    const exp = new Date();
    exp.setDate(exp.getDate() + days);
    row.expires_at = exp.toISOString();
  }

  const result = await supa(env, "POST", "/rest/v1/memories", row) as unknown[];
  const saved = Array.isArray(result) ? result[0] : result;
  const { embedding: _e, search_vector: _s, ...clean } = saved as Record<string, unknown>;

  // Auto-link
  if (params.auto_link && clean.id) {
    const similar = await rpc(env, "match_memories", {
      query_embedding: embedding,
      match_threshold: 0.5,
      match_count: 5,
      ...(profile && { profile_filter: profile }),
    }) as Record<string, unknown>[];

    const links: string[] = [];
    if (Array.isArray(similar)) {
      for (const s of similar) {
        if (s.id !== clean.id) {
          try {
            await supa(env, "POST", "/rest/v1/memory_edges", {
              source_id: clean.id,
              target_id: s.id,
              edge_type: "similar",
              strength: Math.min((s.similarity as number), 1),
            });
            links.push(s.id as string);
          } catch { /* edge may already exist */ }
        }
      }
    }
    if (links.length > 0) (clean as Record<string, unknown>).auto_linked = links;
  }

  return clean;
}

export async function memoryStoreBatch(env: Env, params: z.infer<typeof storeBatchSchema>) {
  const defaultSource = params.default_source ?? envSource(env);
  const defaultProfile = params.default_profile ?? envProfile(env);

  let stored = 0;
  let skipped = 0;
  let errors = 0;

  for (const item of params.memories) {
    try {
      if (!item.content) { errors++; continue; }

      const embedding = await embed(env, item.content);

      if (params.dedup_threshold !== undefined) {
        const dupes = await rpc(env, "match_memories", {
          query_embedding: embedding,
          match_threshold: params.dedup_threshold,
          match_count: 1,
        }) as Record<string, unknown>[];
        if (Array.isArray(dupes) && dupes.length > 0) {
          skipped++;
          continue;
        }
      }

      const row: Record<string, unknown> = {
        content: item.content,
        embedding,
        source: item.source ?? defaultSource,
        profile: item.profile ?? defaultProfile,
        tags: item.tags ?? [],
        metadata: item.metadata ?? {},
        embedding_model: getEnvValue(env, "EMBEDDING_MODEL") ?? null,
      };

      const result = await supa(env, "POST", "/rest/v1/memories", row) as unknown[];
      const saved = Array.isArray(result) ? result[0] : result;

      if (params.auto_link && saved) {
        const sid = (saved as Record<string, unknown>).id;
        const similar = await rpc(env, "match_memories", {
          query_embedding: embedding,
          match_threshold: 0.5,
          match_count: 3,
        }) as Record<string, unknown>[];
        if (Array.isArray(similar)) {
          for (const s of similar) {
            if (s.id !== sid) {
              try {
                await supa(env, "POST", "/rest/v1/memory_edges", {
                  source_id: sid,
                  target_id: s.id,
                  edge_type: "similar",
                  strength: Math.min((s.similarity as number), 1),
                });
              } catch { /* edge may exist */ }
            }
          }
        }
      }

      stored++;
    } catch {
      errors++;
    }
  }

  return { stored, skipped, errors, total: params.memories.length };
}

export async function memoryStoreDecision(env: Env, params: z.infer<typeof storeDecisionSchema>) {
  const profile = params.profile ?? envProfile(env);
  const source = params.source ?? envSource(env);

  const alternatives = params.alternatives ? parseTags(params.alternatives) : [];
  const baseTags = params.tags ? parseTags(params.tags) : [];
  const tags = baseTags.includes("type:decision") ? baseTags : ["type:decision", ...baseTags];

  const content = `Decision: ${params.decision}\n\nRationale: ${params.rationale}`;

  const meta: Record<string, unknown> = { decision: params.decision, rationale: params.rationale };
  if (alternatives.length > 0) meta.alternatives = alternatives;
  if (params.reasoning_trace) meta.reasoning_trace = params.reasoning_trace;
  if (params.related) meta.related_memories = parseTags(params.related).map((id) => validateUuid(id, "related"));

  const embedding = await embed(env, content);

  // Dedup at 0.9
  const dupes = await rpc(env, "match_memories", {
    query_embedding: embedding,
    match_threshold: 0.9,
    match_count: 1,
    profile_filter: profile,
  }) as Record<string, unknown>[];
  if (Array.isArray(dupes) && dupes.length > 0) {
    return { skipped: true, reason: "duplicate_found", similarity: dupes[0].similarity, existing: dupes[0] };
  }

  const row: Record<string, unknown> = {
    content,
    embedding,
    source,
    profile,
    tags,
    metadata: meta,
    embedding_model: getEnvValue(env, "EMBEDDING_MODEL") ?? null,
  };

  const result = await supa(env, "POST", "/rest/v1/memories", row) as unknown[];
  const saved = Array.isArray(result) ? result[0] : result;
  const { embedding: _e, search_vector: _s, ...clean } = saved as Record<string, unknown>;

  // Auto-create `supports` edges for related UUIDs
  if (params.related && clean.id) {
    const relIds = parseTags(params.related);
    for (const rid of relIds) {
      try {
        await supa(env, "POST", "/rest/v1/memory_edges", {
          source_id: clean.id,
          target_id: validateUuid(rid, "related"),
          edge_type: "supports",
          strength: 0.8,
        });
      } catch { /* edge may already exist */ }
    }
  }

  return clean;
}
