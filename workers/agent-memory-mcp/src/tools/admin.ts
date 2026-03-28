/**
 * tools/admin.ts — Administration MCP tools
 */
import { z } from "zod";
import type { Env } from "../core/env.ts";
import { envEmbeddingDim, getEnvValue } from "../core/env.ts";
import { supa, rpc } from "../core/db.ts";
import { embed } from "../core/embeddings.ts";
import { validatePositive, validateRange, validateNonNegative } from "../core/utils.ts";

// ── Schemas ───────────────────────────────────────────────────────────────────

export const cleanupSchema = z.object({});

export const statsSchema = z.object({
  profile: z.string().optional().describe("Filter stats to a specific profile"),
});

export const healthSchema = z.object({});

export const profilesSchema = z.object({});

export const exportSchema = z.object({
  profile: z.string().optional().describe("Only export memories from this profile"),
});

export const reEmbedSchema = z.object({
  profile: z.string().optional().describe("Only re-embed memories in this profile"),
  batch_size: z.number().min(1).optional().describe("Number of memories to process at once (default: 50)"),
});

export const bulkDeleteSchema = z.object({
  tag: z.string().optional().describe("Delete memories with this tag"),
  source: z.string().optional().describe("Delete memories from this source"),
  profile: z.string().optional().describe("Delete memories in this profile"),
  before: z.string().optional().describe("Delete memories created before this date"),
  after: z.string().optional().describe("Delete memories created after this date"),
  dry_run: z.boolean().optional().describe("Show count without deleting"),
});

export const setProfileTtlSchema = z.object({
  profile: z.string().describe("Profile name"),
  days: z.number().min(0).describe("TTL in days (0 to clear)"),
});

export const renameTagSchema = z.object({
  old_tag: z.string().describe("Current tag name"),
  new_tag: z.string().describe("New tag name"),
  profile: z.string().optional().describe("Limit to a specific profile"),
  dry_run: z.boolean().optional().describe("Show count without renaming"),
});

// ── Tool Handlers ─────────────────────────────────────────────────────────────

export async function memoryCleanup(env: Env, _params: z.infer<typeof cleanupSchema>) {
  const result = await rpc(env, "cleanup_expired_memories", {});
  return { deleted_expired: result };
}

export async function memoryStats(env: Env, params: z.infer<typeof statsSchema>) {
  const result = await rpc(env, "memory_stats", {
    ...(params.profile && { profile_filter: params.profile }),
  });
  return result;
}

export async function memoryHealth(env: Env, _params: z.infer<typeof healthSchema>) {
  const checks: Record<string, unknown> = {};

  // 1. Check Supabase connectivity
  try {
    await supa(env, "GET", "/rest/v1/memories", undefined, { limit: "0", select: "id" });
    checks.supabase = "ok";
  } catch {
    checks.supabase = "failed";
  }

  // 2. Check RPC functions exist
  try {
    await rpc(env, "hybrid_search", {
      query_text: "__health_check__",
      query_embedding: Array(envEmbeddingDim(env)).fill(0),
      match_count: 1,
      match_threshold: 0.99,
    });
    checks.rpc_hybrid_search = "ok";
  } catch (e: unknown) {
    const msg = (e as Error).message ?? String(e);
    checks.rpc_hybrid_search = msg.includes("function") ? "missing" : "ok";
  }

  try {
    await rpc(env, "memory_stats", {});
    checks.rpc_memory_stats = "ok";
  } catch {
    checks.rpc_memory_stats = "missing (run updated schema.sql)";
  }

  try {
    await rpc(env, "bump_access_count", { memory_ids: [] });
    checks.rpc_bump_access_count = "ok";
  } catch {
    checks.rpc_bump_access_count = "missing (run updated schema.sql)";
  }

  // 3. Check embedding provider
  try {
    const vec = await embed(env, "health check test");
    checks.embedding_provider = "ok";
    checks.embedding_dim = vec.length;
    checks.embedding_model = getEnvValue(env, "EMBEDDING_MODEL");
  } catch (e: unknown) {
    checks.embedding_provider = "failed";
    checks.embedding_error = (e as Error).message ?? String(e);
  }

  // 4. Check dimension match
  const expectedDim = envEmbeddingDim(env);
  if (typeof checks.embedding_dim === "number") {
    checks.dim_match = checks.embedding_dim === expectedDim
      ? "ok"
      : `mismatch: got ${checks.embedding_dim}, expected ${expectedDim}`;
  }

  return checks;
}

export async function memoryProfiles(env: Env, _params: z.infer<typeof profilesSchema>) {
  try {
    const result = await rpc(env, "memory_stats", {});
    const stats = result as Record<string, unknown>;
    return { profiles: stats.by_profile };
  } catch {
    const rows = await supa(env, "GET", "/rest/v1/memories", undefined, {
      select: "profile",
      order: "profile",
    }) as Record<string, unknown>[];
    const counts: Record<string, number> = {};
    for (const r of rows) {
      const p = (r.profile as string) ?? "default";
      counts[p] = (counts[p] ?? 0) + 1;
    }
    return { profiles: counts };
  }
}

export async function memoryExport(env: Env, params: z.infer<typeof exportSchema>) {
  const q: Record<string, string> = {
    select: "id,content,original_content,source,profile,tags,metadata,confidence,access_count,compression_level,embedding_model,created_at,updated_at,expires_at",
    order: "created_at.asc",
    limit: "10000",
  };
  if (params.profile) q.profile = `eq.${params.profile}`;

  const rows = await supa(env, "GET", "/rest/v1/memories", undefined, q);
  const data = {
    exported_at: new Date().toISOString(),
    profile_filter: params.profile ?? null,
    count: Array.isArray(rows) ? rows.length : 0,
    memories: rows,
  };

  return data;
}

export async function memoryReEmbed(env: Env, params: z.infer<typeof reEmbedSchema>) {
  const batchSize = validatePositive(params.batch_size ?? 50, "batch_size");

  const q: Record<string, string> = {
    select: "id,content",
    order: "created_at.asc",
    limit: String(batchSize),
  };
  if (params.profile) q.profile = `eq.${params.profile}`;

  let processed = 0;
  let errors = 0;
  let offset = 0;

  while (true) {
    const pageQ = { ...q, offset: String(offset) };
    const rows = await supa(env, "GET", "/rest/v1/memories", undefined, pageQ) as Record<string, unknown>[];

    if (!Array.isArray(rows) || rows.length === 0) break;

    for (const row of rows) {
      try {
        const newEmbedding = await embed(env, row.content as string);
        await supa(env, "PATCH", "/rest/v1/memories", {
          embedding: newEmbedding,
          embedding_model: getEnvValue(env, "EMBEDDING_MODEL") ?? null,
        }, { id: `eq.${row.id}` });
        processed++;
      } catch {
        errors++;
      }
    }

    offset += rows.length;
    if (rows.length < batchSize) break;
  }

  return { re_embedded: processed, errors, model: getEnvValue(env, "EMBEDDING_MODEL") };
}

export async function memoryBulkDelete(env: Env, params: z.infer<typeof bulkDeleteSchema>) {
  if (!params.tag && !params.source && !params.profile && !params.before && !params.after) {
    throw new Error("Provide at least one filter: tag, source, profile, before, or after");
  }

  const pairs: [string, string][] = [];
  if (params.tag) pairs.push(["tags", `cs.{${params.tag}}`]);
  if (params.source) pairs.push(["source", `eq.${params.source}`]);
  if (params.profile) pairs.push(["profile", `eq.${params.profile}`]);
  if (params.before) pairs.push(["created_at", `lt.${params.before}`]);
  if (params.after) pairs.push(["created_at", `gt.${params.after}`]);

  const countPairs: [string, string][] = [["select", "id"], ...pairs];
  const matches = await supa(env, "GET", "/rest/v1/memories", undefined, countPairs) as unknown[];
  const count = Array.isArray(matches) ? matches.length : 0;

  if (params.dry_run) {
    return { dry_run: true, would_delete: count };
  }

  if (count === 0) {
    return { deleted: 0 };
  }

  await supa(env, "DELETE", "/rest/v1/memories", undefined, pairs);
  return { deleted: count };
}

export async function memorySetProfileTtl(env: Env, params: z.infer<typeof setProfileTtlSchema>) {
  const days = validateNonNegative(params.days, "days");

  await supa(env, "POST", "/rest/v1/profile_settings", {
    profile: params.profile,
    ttl_days: days === 0 ? null : days,
  }, undefined, { Prefer: "resolution=merge-duplicates,return=representation" });

  return { profile: params.profile, ttl_days: days === 0 ? null : days };
}

export async function memoryRenameTag(env: Env, params: z.infer<typeof renameTagSchema>) {
  const dryRun = params.dry_run ?? false;

  const pairs: [string, string][] = [
    ["tags", `cs.{${params.old_tag}}`],
    ["select", "id,tags"],
  ];
  if (params.profile) pairs.push(["profile", `eq.${params.profile}`]);

  const matches = await supa(env, "GET", "/rest/v1/memories", undefined, pairs) as Record<string, unknown>[];
  const count = Array.isArray(matches) ? matches.length : 0;

  if (dryRun) {
    return { dry_run: true, would_rename: count, old_tag: params.old_tag, new_tag: params.new_tag };
  }

  let renamed = 0;
  for (const mem of (Array.isArray(matches) ? matches : [])) {
    const tags = (mem.tags as string[]).map((t) => (t === params.old_tag ? params.new_tag : t));
    try {
      await supa(env, "PATCH", "/rest/v1/memories", { tags }, { id: `eq.${mem.id}` });
      renamed++;
    } catch { /* skip */ }
  }

  return { renamed, profile: params.profile ?? "all", old_tag: params.old_tag, new_tag: params.new_tag };
}
