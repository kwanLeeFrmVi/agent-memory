/**
 * commands/store.ts — Store commands
 * cmdStore, cmdStoreBatch, cmdStoreDecision
 */
import { env, envSource, envProfile } from "../core/env.ts";
import { out, fatal, flag, parseTags, safeJsonParse, validateRange, validatePositive } from "../core/utils.ts";
import { supa, rpc } from "../core/db.ts";
import { embed } from "../core/embeddings.ts";
import { validateUuid } from "../core/utils.ts";

async function getProfileTtl(profile: string): Promise<number | null> {
  try {
    const rows = await supa("GET", "/rest/v1/profile_settings", undefined, {
      profile: `eq.${profile}`,
      select: "ttl_days",
    }) as Record<string, unknown>[];
    if (Array.isArray(rows) && rows.length > 0 && rows[0].ttl_days != null) {
      return rows[0].ttl_days as number;
    }
  } catch { /* table may not exist yet */ }
  return null;
}

export async function cmdStore(positional: string[], flags: Record<string, string | boolean>) {
  const content = positional[0];
  if (!content) fatal("Usage: store <content> [--tags t1,t2] [--source s] [--profile p] [--ttl days] [--metadata '{}'] [--dedup threshold] [--auto-link] [--pin] [--importance 0-1]");

  const tagsRaw = flag(flags, "tags");
  const source = flag(flags, "source") ?? envSource();
  const profile = flag(flags, "profile") ?? envProfile();
  const ttlDays = flag(flags, "ttl");
  const metaRaw = flag(flags, "metadata");
  const dedupRaw = flags["dedup"];
  const dedupThreshold = dedupRaw === true ? 0.95 : (typeof dedupRaw === "string" ? validateRange(parseFloat(dedupRaw), 0, 1, "--dedup") : null);
  const autoLink = flags["auto-link"] === true;
  const isPinned = flags["pin"] === true;
  const importanceRaw = flag(flags, "importance");
  const importance = importanceRaw ? validateRange(parseFloat(importanceRaw), 0, 1, "--importance") : undefined;

  const embedding = await embed(content);

  // Dedup check: search for similar memories before storing
  if (dedupThreshold !== null) {
    const dupes = await rpc("match_memories", {
      query_embedding: embedding,
      match_threshold: dedupThreshold,
      match_count: 1,
      ...(profile && { profile_filter: profile }),
    }) as Record<string, unknown>[];

    if (Array.isArray(dupes) && dupes.length > 0) {
      out({ skipped: true, reason: "duplicate_found", similarity: dupes[0].similarity, existing: dupes[0] });
      return;
    }
  }

  const row: Record<string, unknown> = {
    content,
    embedding,
    source,
    profile,
    tags: tagsRaw ? parseTags(tagsRaw) : [],
    metadata: metaRaw ? safeJsonParse(metaRaw, "--metadata") : {},
    embedding_model: env("EMBEDDING_MODEL") ?? null,
    is_pinned: isPinned,
    ...(importance !== undefined && { importance }),
  };

  // Apply TTL from explicit flag or profile default
  const profileTtl = ttlDays ? null : await getProfileTtl(profile);
  const effectiveTtlStr = ttlDays ?? (profileTtl !== null ? String(profileTtl) : null);
  if (effectiveTtlStr) {
    const days = validatePositive(parseInt(effectiveTtlStr), "--ttl");
    const exp = new Date();
    exp.setDate(exp.getDate() + days);
    row.expires_at = exp.toISOString();
  }

  const result = await supa("POST", "/rest/v1/memories", row) as unknown[];
  const saved = Array.isArray(result) ? result[0] : result;
  const { embedding: _e, search_vector: _s, ...clean } = saved as Record<string, unknown>;

  // Auto-link: find similar memories and create edges
  if (autoLink && clean.id) {
    const similar = await rpc("match_memories", {
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
            await supa("POST", "/rest/v1/memory_edges", {
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

  out(clean);
}

export async function cmdStoreBatch(positional: string[], flags: Record<string, string | boolean>) {
  const filePath = positional[0];
  if (!filePath) fatal("Usage: store-batch <file.json> [--dedup threshold] [--auto-link] [--profile p] [--source s]");

  const file = Bun.file(filePath);
  if (!(await file.exists())) fatal(`File not found: ${filePath}`);

  const data = safeJsonParse(await file.text(), filePath) as unknown;
  const items = (Array.isArray(data) ? data : (data as Record<string, unknown>).memories ?? data) as Record<string, unknown>[];
  if (!Array.isArray(items)) fatal("Expected JSON array or {memories: [...]}");

  const dedupRaw = flags["dedup"];
  const dedupThreshold = dedupRaw === true ? 0.95 : (typeof dedupRaw === "string" ? parseFloat(dedupRaw) : null);
  const autoLink = flags["auto-link"] === true;
  const defaultSource = flag(flags, "source") ?? envSource();
  const defaultProfile = flag(flags, "profile") ?? envProfile();

  let stored = 0;
  let skipped = 0;
  let errors = 0;

  for (const item of items) {
    try {
      const content = item.content as string;
      if (!content) { errors++; continue; }

      const embedding = await embed(content);

      if (dedupThreshold !== null) {
        const dupes = await rpc("match_memories", {
          query_embedding: embedding,
          match_threshold: dedupThreshold,
          match_count: 1,
        }) as Record<string, unknown>[];
        if (Array.isArray(dupes) && dupes.length > 0) {
          skipped++;
          continue;
        }
      }

      const row: Record<string, unknown> = {
        content,
        embedding,
        source: (item.source as string) ?? defaultSource,
        profile: (item.profile as string) ?? defaultProfile,
        tags: Array.isArray(item.tags) ? item.tags : [],
        metadata: item.metadata ?? {},
        embedding_model: env("EMBEDDING_MODEL") ?? null,
      };

      const result = await supa("POST", "/rest/v1/memories", row) as unknown[];
      const saved = Array.isArray(result) ? result[0] : result;

      if (autoLink && saved) {
        const sid = (saved as Record<string, unknown>).id;
        const similar = await rpc("match_memories", {
          query_embedding: embedding,
          match_threshold: 0.5,
          match_count: 3,
        }) as Record<string, unknown>[];
        if (Array.isArray(similar)) {
          for (const s of similar) {
            if (s.id !== sid) {
              try {
                await supa("POST", "/rest/v1/memory_edges", {
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

  out({ stored, skipped, errors, total: items.length });
}

export async function cmdStoreDecision(positional: string[], flags: Record<string, string | boolean>) {
  const decision = flag(flags, "decision");
  const rationale = flag(flags, "rationale");
  if (!decision || !rationale) fatal("Usage: store-decision --decision <text> --rationale <text> [--alternatives t1,t2] [--reasoning-trace <text>] [--tags t1,t2] [--related uuid1,uuid2] [--profile p] [--source s]");

  const alternatives = flag(flags, "alternatives") ? parseTags(flag(flags, "alternatives")!) : [];
  const reasoningTrace = flag(flags, "reasoning-trace");
  const tagsRaw = flag(flags, "tags");
  const relatedRaw = flag(flags, "related");
  const profile = flag(flags, "profile") ?? envProfile();
  const source = flag(flags, "source") ?? envSource();

  const baseTags = tagsRaw ? parseTags(tagsRaw) : [];
  const tags = baseTags.includes("type:decision") ? baseTags : ["type:decision", ...baseTags];

  const content = rationale
    ? `Decision: ${decision}\n\nRationale: ${rationale}`
    : `Decision: ${decision}`;

  const meta: Record<string, unknown> = { decision, rationale };
  if (alternatives.length > 0) meta.alternatives = alternatives;
  if (reasoningTrace) meta.reasoning_trace = reasoningTrace;
  if (relatedRaw) meta.related_memories = parseTags(relatedRaw).map((id) => validateUuid(id, "related"));

  const embedding = await embed(content);

  // Dedup at 0.9 before inserting
  const dupes = await rpc("match_memories", {
    query_embedding: embedding,
    match_threshold: 0.9,
    match_count: 1,
    profile_filter: profile,
  }) as Record<string, unknown>[];
  if (Array.isArray(dupes) && dupes.length > 0) {
    out({ skipped: true, reason: "duplicate_found", similarity: dupes[0].similarity, existing: dupes[0] });
    return;
  }

  const row: Record<string, unknown> = {
    content,
    embedding,
    source,
    profile,
    tags,
    metadata: meta,
    embedding_model: env("EMBEDDING_MODEL") ?? null,
  };

  const result = await supa("POST", "/rest/v1/memories", row) as unknown[];
  const saved = Array.isArray(result) ? result[0] : result;
  const { embedding: _e, search_vector: _s, ...clean } = saved as Record<string, unknown>;

  // Auto-create `supports` edges for --related UUIDs
  if (relatedRaw && clean.id) {
    const relIds = parseTags(relatedRaw);
    for (const rid of relIds) {
      try {
        await supa("POST", "/rest/v1/memory_edges", {
          source_id: clean.id,
          target_id: rid,
          edge_type: "supports",
          strength: 0.8,
        });
      } catch { /* edge may already exist */ }
    }
  }

  out(clean);
}
