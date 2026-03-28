/**
 * commands/admin.ts — Administration and maintenance commands
 * cmdCleanup, cmdStats, cmdHealth, cmdProfiles, cmdExport, cmdImport,
 * cmdReEmbed, cmdBulkDelete, cmdSetProfileTtl, cmdRenameTag
 */
import { env, envEmbeddingDim } from "../core/env.ts";
import { out, fatal, flag, safeJsonParse, validatePositive, validateRange, validateNonNegative } from "../core/utils.ts";
import { supa, rpc } from "../core/db.ts";
import { embed } from "../core/embeddings.ts";

export async function cmdCleanup() {
  const result = await rpc("cleanup_expired_memories", {});
  out({ deleted_expired: result });
}

export async function cmdStats(flags: Record<string, string | boolean>) {
  const profile = flag(flags, "profile") ?? undefined;
  const result = await rpc("memory_stats", {
    ...(profile && { profile_filter: profile }),
  });
  out(result);
}

export async function cmdHealth() {
  const checks: Record<string, unknown> = {};

  // 1. Check Supabase connectivity
  try {
    await supa("GET", "/rest/v1/memories", undefined, { limit: "0", select: "id" });
    checks.supabase = "ok";
  } catch {
    checks.supabase = "failed";
  }

  // 2. Check RPC functions exist
  try {
    await rpc("hybrid_search", {
      query_text: "__health_check__",
      query_embedding: Array(envEmbeddingDim()).fill(0),
      match_count: 1,
      match_threshold: 0.99,
    });
    checks.rpc_hybrid_search = "ok";
  } catch (e: unknown) {
    const msg = (e as Error).message ?? String(e);
    checks.rpc_hybrid_search = msg.includes("function") ? "missing" : "ok";
  }

  try {
    await rpc("memory_stats", {});
    checks.rpc_memory_stats = "ok";
  } catch {
    checks.rpc_memory_stats = "missing (run updated schema.sql)";
  }

  try {
    await rpc("bump_access_count", { memory_ids: [] });
    checks.rpc_bump_access_count = "ok";
  } catch {
    checks.rpc_bump_access_count = "missing (run updated schema.sql)";
  }

  // 3. Check embedding provider
  try {
    const vec = await embed("health check test");
    checks.embedding_provider = "ok";
    checks.embedding_dim = vec.length;
    checks.embedding_model = env("EMBEDDING_MODEL");
  } catch {
    checks.embedding_provider = "failed";
  }

  // 4. Check dimension match
  const expectedDim = envEmbeddingDim();
  if (typeof checks.embedding_dim === "number") {
    checks.dim_match = checks.embedding_dim === expectedDim
      ? "ok"
      : `mismatch: got ${checks.embedding_dim}, expected ${expectedDim}`;
  }

  out(checks);
}

export async function cmdProfiles() {
  try {
    const result = await rpc("memory_stats", {});
    const stats = result as Record<string, unknown>;
    out({ profiles: stats.by_profile });
  } catch {
    const rows = await supa("GET", "/rest/v1/memories", undefined, {
      select: "profile",
      order: "profile",
    }) as Record<string, unknown>[];
    const counts: Record<string, number> = {};
    for (const r of rows) {
      const p = (r.profile as string) ?? "default";
      counts[p] = (counts[p] ?? 0) + 1;
    }
    out({ profiles: counts });
  }
}

export async function cmdExport(flags: Record<string, string | boolean>) {
  const profile = flag(flags, "profile");
  const outputFile = flag(flags, "output");

  const q: Record<string, string> = {
    select: "id,content,original_content,source,profile,tags,metadata,confidence,access_count,compression_level,embedding_model,created_at,updated_at,expires_at",
    order: "created_at.asc",
    limit: "10000",
  };
  if (profile) q.profile = `eq.${profile}`;

  const rows = await supa("GET", "/rest/v1/memories", undefined, q);
  const data = {
    exported_at: new Date().toISOString(),
    profile_filter: profile ?? null,
    count: Array.isArray(rows) ? rows.length : 0,
    memories: rows,
  };

  if (outputFile) {
    await Bun.write(outputFile, JSON.stringify(data, null, 2));
    out({ exported: outputFile, count: data.count });
  } else {
    out(data);
  }
}

export async function cmdImport(positional: string[], flags: Record<string, string | boolean>) {
  const filePath = positional[0];
  if (!filePath) fatal("Usage: import <file.json> [--re-embed]");

  const reEmbed = flags["re-embed"] === true;

  const file = Bun.file(filePath);
  if (!(await file.exists())) fatal(`File not found: ${filePath}`);

  const data = safeJsonParse(await file.text(), filePath) as Record<string, unknown>;
  const memories = (data.memories ?? data) as Record<string, unknown>[];

  if (!Array.isArray(memories)) fatal("Expected 'memories' array in import file");

  let imported = 0;
  let errors = 0;

  for (const mem of memories) {
    try {
      const row: Record<string, unknown> = {
        content: mem.content,
        source: mem.source ?? "import",
        profile: mem.profile ?? "default",
        tags: mem.tags ?? [],
        metadata: mem.metadata ?? {},
        confidence: mem.confidence ?? 0.8,
        compression_level: mem.compression_level ?? 0,
        original_content: mem.original_content ?? null,
        embedding_model: reEmbed ? (env("EMBEDDING_MODEL") ?? null) : (mem.embedding_model ?? null),
      };

      if (reEmbed) {
        row.embedding = await embed(mem.content as string);
      }

      if (mem.expires_at) row.expires_at = mem.expires_at;

      await supa("POST", "/rest/v1/memories", row);
      imported++;
    } catch {
      errors++;
    }
  }

  out({ imported, errors, total: memories.length });
}

export async function cmdReEmbed(flags: Record<string, string | boolean>) {
  const profile = flag(flags, "profile");
  const batchSize = validatePositive(parseInt(flag(flags, "batch-size") ?? "50"), "--batch-size");

  const q: Record<string, string> = {
    select: "id,content",
    order: "created_at.asc",
    limit: String(batchSize),
  };
  if (profile) q.profile = `eq.${profile}`;

  let processed = 0;
  let errors = 0;
  let offset = 0;

  while (true) {
    const pageQ = { ...q, offset: String(offset) };
    const rows = await supa("GET", "/rest/v1/memories", undefined, pageQ) as Record<string, unknown>[];

    if (!Array.isArray(rows) || rows.length === 0) break;

    for (const row of rows) {
      try {
        const newEmbedding = await embed(row.content as string);
        await supa("PATCH", "/rest/v1/memories", {
          embedding: newEmbedding,
          embedding_model: env("EMBEDDING_MODEL") ?? null,
        }, { id: `eq.${row.id}` });
        processed++;
        if (processed % 10 === 0) {
          console.error(`re-embed progress: ${processed} done`);
        }
      } catch {
        errors++;
      }
    }

    offset += rows.length;
    if (rows.length < batchSize) break;
  }

  out({ re_embedded: processed, errors, model: env("EMBEDDING_MODEL") });
}

export async function cmdBulkDelete(flags: Record<string, string | boolean>) {
  const tag = flag(flags, "tag");
  const source = flag(flags, "source");
  const profile = flag(flags, "profile");
  const before = flag(flags, "before");
  const after = flag(flags, "after");
  const dryRun = flags["dry-run"] === true;

  if (!tag && !source && !profile && !before && !after) {
    fatal("Usage: bulk-delete [--tag t] [--source s] [--profile p] [--before date] [--after date] [--dry-run]");
  }

  const pairs: [string, string][] = [];
  if (tag) pairs.push(["tags", `cs.{${tag}}`]);
  if (source) pairs.push(["source", `eq.${source}`]);
  if (profile) pairs.push(["profile", `eq.${profile}`]);
  if (before) pairs.push(["created_at", `lt.${before}`]);
  if (after) pairs.push(["created_at", `gt.${after}`]);

  const countPairs: [string, string][] = [["select", "id"], ...pairs];
  const matches = await supa("GET", "/rest/v1/memories", undefined, countPairs) as unknown[];
  const count = Array.isArray(matches) ? matches.length : 0;

  if (dryRun) {
    out({ dry_run: true, would_delete: count });
    return;
  }

  if (count === 0) {
    out({ deleted: 0 });
    return;
  }

  await supa("DELETE", "/rest/v1/memories", undefined, pairs);
  out({ deleted: count });
}

export async function cmdSetProfileTtl(flags: Record<string, string | boolean>) {
  const profile = flag(flags, "profile");
  const daysRaw = flag(flags, "days");
  if (!profile || daysRaw === undefined) fatal("Usage: set-profile-ttl --profile <name> --days <n>");

  const days = validateNonNegative(parseInt(daysRaw), "--days");

  await supa("POST", "/rest/v1/profile_settings", {
    profile,
    ttl_days: days === 0 ? null : days,
  }, undefined, { Prefer: "resolution=merge-duplicates,return=representation" });

  out({ profile, ttl_days: days === 0 ? null : days });
}

export async function cmdRenameTag(positional: string[], flags: Record<string, string | boolean>) {
  const [oldTag, newTag] = positional;
  if (!oldTag || !newTag) fatal("Usage: rename-tag <old> <new> [--profile p] [--dry-run]");

  const profile = flag(flags, "profile") ?? undefined;
  const dryRun = flags["dry-run"] === true;

  const pairs: [string, string][] = [
    ["tags", `cs.{${oldTag}}`],
    ["select", "id,tags"],
  ];
  if (profile) pairs.push(["profile", `eq.${profile}`]);

  const matches = await supa("GET", "/rest/v1/memories", undefined, pairs) as Record<string, unknown>[];
  const count = Array.isArray(matches) ? matches.length : 0;

  if (dryRun) {
    out({ dry_run: true, would_rename: count, old_tag: oldTag, new_tag: newTag });
    return;
  }

  let renamed = 0;
  for (const mem of (Array.isArray(matches) ? matches : [])) {
    const tags = (mem.tags as string[]).map((t) => (t === oldTag ? newTag : t));
    try {
      await supa("PATCH", "/rest/v1/memories", { tags }, { id: `eq.${mem.id}` });
      renamed++;
    } catch { /* skip */ }
  }

  out({ renamed, profile: profile ?? "all", old_tag: oldTag, new_tag: newTag });
}
