/**
 * commands/crud.ts — CRUD + content management commands
 * cmdGet, cmdRecent, cmdTag, cmdUpdate, cmdDelete,
 * cmdCompress, cmdRevert, cmdMerge
 */
import { env, envSource, envProfile } from "../core/env.ts";
import { out, fatal, flag, parseTags, safeJsonParse, validatePositive, validateRange } from "../core/utils.ts";
import { validateUuid } from "../core/utils.ts";
import { supa, rpc } from "../core/db.ts";
import { embed } from "../core/embeddings.ts";

export async function cmdGet(positional: string[]) {
  const id = positional[0];
  if (!id) fatal("Usage: get <uuid>");
  validateUuid(id);

  const result = await supa("GET", "/rest/v1/memories", undefined, { id: `eq.${id}` }) as unknown[];
  if (!Array.isArray(result) || result.length === 0) fatal("Memory not found", { id });
  const { embedding: _e, search_vector: _s, ...clean } = result[0] as Record<string, unknown>;
  out(clean);
}

export async function cmdRecent(flags: Record<string, string | boolean>) {
  const limit = flag(flags, "limit") ?? "3";
  validatePositive(parseInt(limit), "--limit");
  const source = flag(flags, "source");
  const profile = flag(flags, "profile");
  const afterDate = flag(flags, "after");
  const beforeDate = flag(flags, "before");
  const pinnedOnly = flags["pinned"] === true;
  const minImportanceRaw = flag(flags, "min-importance");

  const pairs: [string, string][] = [
    ["order", "created_at.desc"],
    ["limit", limit],
    ["select", "id,content,source,profile,tags,metadata,confidence,access_count,is_pinned,importance,created_at,expires_at"],
  ];
  if (source) pairs.push(["source", `eq.${source}`]);
  if (profile) pairs.push(["profile", `eq.${profile}`]);
  if (afterDate) pairs.push(["created_at", `gte.${afterDate}`]);
  if (beforeDate) pairs.push(["created_at", `lte.${beforeDate}`]);
  if (pinnedOnly) pairs.push(["is_pinned", "eq.true"]);
  if (minImportanceRaw) pairs.push(["importance", `gte.${validateRange(parseFloat(minImportanceRaw), 0, 1, "--min-importance")}`]);

  // Filter out expired memories: expires_at is null OR expires_at > now
  const now = new Date().toISOString();
  pairs.push(["or", `expires_at.is.null,expires_at.gt.${now}`]);

  const results = await supa("GET", "/rest/v1/memories", undefined, pairs);
  out(results);
}

export async function cmdTag(positional: string[], flags: Record<string, string | boolean>) {
  const tag = positional[0];
  if (!tag) fatal("Usage: tag <tag> [--limit n] [--profile p]");

  const limit = validatePositive(parseInt(flag(flags, "limit") ?? "20"), "--limit");

  const result = await rpc("get_memories_by_tag", {
    tag,
    limit_count: limit,
    ...(flag(flags, "profile") && { profile_filter: flag(flags, "profile") }),
  });
  out(result);
}

export async function cmdUpdate(positional: string[], flags: Record<string, string | boolean>) {
  const id = positional[0];
  if (!id) fatal("Usage: update <uuid> [--content text] [--confidence f] [--tags t1,t2] [--metadata '{}']");
  validateUuid(id);

  const patch: Record<string, unknown> = {};

  const content = flag(flags, "content");
  if (content) {
    patch.content = content;
    patch.embedding = await embed(content);
    patch.embedding_model = env("EMBEDDING_MODEL") ?? null;
  }

  const confidence = flag(flags, "confidence");
  if (confidence) patch.confidence = validateRange(parseFloat(confidence), 0, 1, "--confidence");

  const tagsRaw = flag(flags, "tags");
  if (tagsRaw) patch.tags = parseTags(tagsRaw);

  const metaRaw = flag(flags, "metadata");
  if (metaRaw) patch.metadata = safeJsonParse(metaRaw, "--metadata");

  if (Object.keys(patch).length === 0) fatal("Provide at least one of: --content, --confidence, --tags, --metadata");

  const result = await supa("PATCH", "/rest/v1/memories", patch, { id: `eq.${id}` }) as unknown[];
  const updated = Array.isArray(result) ? result[0] : result;
  const { embedding: _e, search_vector: _s, ...clean } = (updated ?? { id }) as Record<string, unknown>;
  out(clean);
}

export async function cmdDelete(positional: string[]) {
  const id = positional[0];
  if (!id) fatal("Usage: delete <uuid>");
  validateUuid(id);

  await supa("DELETE", "/rest/v1/memories", undefined, { id: `eq.${id}` });
  out({ deleted: id });
}

export async function cmdCompress(positional: string[], flags: Record<string, string | boolean>) {
  const id = positional[0];
  const compressed = positional[1];
  if (!id || !compressed) fatal("Usage: compress <uuid> <compressed-text>");
  validateUuid(id);

  const result = await supa("GET", "/rest/v1/memories", undefined, { id: `eq.${id}` }) as Record<string, unknown>[];
  if (!Array.isArray(result) || result.length === 0) fatal("Memory not found", { id });
  const current = result[0];

  const patch: Record<string, unknown> = {
    content: compressed,
    embedding: await embed(compressed),
    embedding_model: env("EMBEDDING_MODEL") ?? null,
    compression_level: Math.min(((current.compression_level as number) ?? 0) + 1, 2),
  };

  if (!current.original_content) {
    patch.original_content = current.content;
  }

  const updated = await supa("PATCH", "/rest/v1/memories", patch, { id: `eq.${id}` }) as unknown[];
  const saved = Array.isArray(updated) ? updated[0] : updated;
  const { embedding: _e, search_vector: _s, ...clean } = (saved ?? { id }) as Record<string, unknown>;
  out(clean);
}

export async function cmdRevert(positional: string[]) {
  const id = positional[0];
  if (!id) fatal("Usage: revert <uuid>");
  validateUuid(id);

  const result = await supa("GET", "/rest/v1/memories", undefined, { id: `eq.${id}` }) as Record<string, unknown>[];
  if (!Array.isArray(result) || result.length === 0) fatal("Memory not found", { id });
  const mem = result[0];

  if (!mem.original_content) fatal("No original_content to revert to — memory was never compressed", { id });

  const restoredContent = mem.original_content as string;
  const newEmbedding = await embed(restoredContent);

  const updated = await supa("PATCH", "/rest/v1/memories", {
    content: restoredContent,
    original_content: null,
    compression_level: 0,
    embedding: newEmbedding,
    embedding_model: env("EMBEDDING_MODEL") ?? null,
  }, { id: `eq.${id}` }) as unknown[];

  const saved = Array.isArray(updated) ? updated[0] : updated;
  const { embedding: _e, search_vector: _s, ...clean } = (saved ?? { id }) as Record<string, unknown>;
  out(clean);
}

export async function cmdMerge(positional: string[], flags: Record<string, string | boolean>) {
  if (positional.length < 2) fatal("Usage: merge <uuid1> <uuid2> [uuid3...] [--delete-originals] [--separator text]");

  const ids = positional.map((id) => validateUuid(id));
  const deleteOriginals = flags["delete-originals"] === true;
  const separator = flag(flags, "separator") ?? "\n---\n";

  const memories: Record<string, unknown>[] = [];
  for (const id of ids) {
    const result = await supa("GET", "/rest/v1/memories", undefined, { id: `eq.${id}` }) as Record<string, unknown>[];
    if (!Array.isArray(result) || result.length === 0) fatal(`Memory not found: ${id}`);
    memories.push(result[0]);
  }

  const mergedContent = memories.map((m) => m.content as string).join(separator);
  const mergedTags = [...new Set(memories.flatMap((m) => (m.tags as string[]) ?? []))];
  const mergedMeta: Record<string, unknown> = {};
  for (const m of memories) {
    Object.assign(mergedMeta, (m.metadata as Record<string, unknown>) ?? {});
  }
  mergedMeta.merged_from = ids;

  const embedding = await embed(mergedContent);
  const row: Record<string, unknown> = {
    content: mergedContent,
    embedding,
    source: (memories[0].source as string) ?? envSource(),
    profile: (memories[0].profile as string) ?? envProfile(),
    tags: mergedTags,
    metadata: mergedMeta,
    embedding_model: env("EMBEDDING_MODEL") ?? null,
  };

  const result = await supa("POST", "/rest/v1/memories", row) as unknown[];
  const saved = Array.isArray(result) ? result[0] : result;
  const newId = (saved as Record<string, unknown>).id;

  if (deleteOriginals) {
    for (const id of ids) {
      await supa("DELETE", "/rest/v1/memories", undefined, { id: `eq.${id}` });
    }
  } else {
    for (const id of ids) {
      try {
        await supa("POST", "/rest/v1/memory_edges", {
          source_id: newId,
          target_id: id,
          edge_type: "expands",
          strength: 1.0,
        });
      } catch { /* edge may exist */ }
    }
  }

  const { embedding: _e, search_vector: _s, ...clean } = (saved as Record<string, unknown>);
  (clean as Record<string, unknown>).merged_from = ids;
  (clean as Record<string, unknown>).originals_deleted = deleteOriginals;
  out(clean);
}
