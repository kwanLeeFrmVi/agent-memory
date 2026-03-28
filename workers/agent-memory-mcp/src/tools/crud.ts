/**
 * tools/crud.ts — CRUD MCP tools
 */
import { z } from "zod";
import type { Env } from "../core/env.ts";
import { envSource, envProfile, getEnvValue } from "../core/env.ts";
import { supa, rpc } from "../core/db.ts";
import { embed } from "../core/embeddings.ts";
import { parseTags, safeJsonParse, validatePositive, validateRange, validateUuid } from "../core/utils.ts";

// ── Schemas ───────────────────────────────────────────────────────────────────

export const getSchema = z.object({
  id: z.string().describe("UUID of the memory to retrieve"),
});

export const recentSchema = z.object({
  limit: z.number().optional().describe("Max results (default: 20)"),
  source: z.string().optional().describe("Filter by source"),
  profile: z.string().optional().describe("Filter by profile"),
  after: z.string().optional().describe("Filter by created_at >= date"),
  before: z.string().optional().describe("Filter by created_at <= date"),
  pinned: z.boolean().optional().describe("Only return pinned memories"),
  min_importance: z.number().min(0).max(1).optional().describe("Filter by min importance"),
});

export const tagSchema = z.object({
  tag: z.string().describe("Tag to search for"),
  limit: z.number().optional().describe("Max results (default: 20)"),
  profile: z.string().optional().describe("Filter by profile"),
});

export const updateSchema = z.object({
  id: z.string().describe("UUID of the memory to update"),
  content: z.string().optional().describe("New content (triggers re-embedding)"),
  confidence: z.number().min(0).max(1).optional().describe("New confidence score"),
  tags: z.string().optional().describe("New comma-separated tags (replaces existing)"),
  metadata: z.string().optional().describe("New JSON metadata (replaces existing)"),
});

export const deleteSchema = z.object({
  id: z.string().describe("UUID of the memory to delete"),
});

export const compressSchema = z.object({
  id: z.string().describe("UUID of the memory to compress"),
  compressed_text: z.string().describe("Summarized/compressed version of the content"),
});

export const revertSchema = z.object({
  id: z.string().describe("UUID of the memory to revert"),
});

export const mergeSchema = z.object({
  ids: z.array(z.string()).min(2).describe("UUIDs of memories to merge"),
  delete_originals: z.boolean().optional().describe("Delete original memories after merge"),
  separator: z.string().optional().describe("Separator between merged contents (default: '\\n---\\n')"),
});

// ── Tool Handlers ─────────────────────────────────────────────────────────────

export async function memoryGet(env: Env, params: z.infer<typeof getSchema>) {
  validateUuid(params.id);

  const result = await supa(env, "GET", "/rest/v1/memories", undefined, { id: `eq.${params.id}` }) as unknown[];
  if (!Array.isArray(result) || result.length === 0) {
    throw new Error(`Memory not found: ${params.id}`);
  }
  const { embedding: _e, search_vector: _s, ...clean } = result[0] as Record<string, unknown>;
  return clean;
}

export async function memoryRecent(env: Env, params: z.infer<typeof recentSchema>) {
  const limit = String(params.limit ?? 20);
  validatePositive(parseInt(limit), "limit");

  const pairs: [string, string][] = [
    ["order", "created_at.desc"],
    ["limit", limit],
    ["select", "id,content,source,profile,tags,metadata,confidence,access_count,is_pinned,importance,created_at,expires_at"],
  ];
  if (params.source) pairs.push(["source", `eq.${params.source}`]);
  if (params.profile) pairs.push(["profile", `eq.${params.profile}`]);
  if (params.after) pairs.push(["created_at", `gte.${params.after}`]);
  if (params.before) pairs.push(["created_at", `lte.${params.before}`]);
  if (params.pinned) pairs.push(["is_pinned", "eq.true"]);
  if (params.min_importance !== undefined) pairs.push(["importance", `gte.${validateRange(params.min_importance, 0, 1, "min_importance")}`]);

  // Filter out expired memories
  const now = new Date().toISOString();
  pairs.push(["or", `expires_at.is.null,expires_at.gt.${now}`]);

  const results = await supa(env, "GET", "/rest/v1/memories", undefined, pairs);
  return results;
}

export async function memoryTag(env: Env, params: z.infer<typeof tagSchema>) {
  const limit = validatePositive(params.limit ?? 20, "limit");

  const result = await rpc(env, "get_memories_by_tag", {
    tag: params.tag,
    limit_count: limit,
    ...(params.profile && { profile_filter: params.profile }),
  });
  return result;
}

export async function memoryUpdate(env: Env, params: z.infer<typeof updateSchema>) {
  validateUuid(params.id);

  const patch: Record<string, unknown> = {};

  if (params.content) {
    patch.content = params.content;
    patch.embedding = await embed(env, params.content);
    patch.embedding_model = getEnvValue(env, "EMBEDDING_MODEL") ?? null;
  }

  if (params.confidence !== undefined) {
    patch.confidence = validateRange(params.confidence, 0, 1, "confidence");
  }

  if (params.tags) {
    patch.tags = parseTags(params.tags);
  }

  if (params.metadata) {
    patch.metadata = safeJsonParse(params.metadata, "metadata");
  }

  if (Object.keys(patch).length === 0) {
    throw new Error("Provide at least one of: content, confidence, tags, metadata");
  }

  const result = await supa(env, "PATCH", "/rest/v1/memories", patch, { id: `eq.${params.id}` }) as unknown[];
  const updated = Array.isArray(result) ? result[0] : result;
  const { embedding: _e, search_vector: _s, ...clean } = (updated ?? { id: params.id }) as Record<string, unknown>;
  return clean;
}

export async function memoryDelete(env: Env, params: z.infer<typeof deleteSchema>) {
  validateUuid(params.id);

  await supa(env, "DELETE", "/rest/v1/memories", undefined, { id: `eq.${params.id}` });
  return { deleted: params.id };
}

export async function memoryCompress(env: Env, params: z.infer<typeof compressSchema>) {
  validateUuid(params.id);

  const result = await supa(env, "GET", "/rest/v1/memories", undefined, { id: `eq.${params.id}` }) as Record<string, unknown>[];
  if (!Array.isArray(result) || result.length === 0) {
    throw new Error(`Memory not found: ${params.id}`);
  }
  const current = result[0];

  const patch: Record<string, unknown> = {
    content: params.compressed_text,
    embedding: await embed(env, params.compressed_text),
    embedding_model: getEnvValue(env, "EMBEDDING_MODEL") ?? null,
    compression_level: Math.min(((current.compression_level as number) ?? 0) + 1, 2),
  };

  if (!current.original_content) {
    patch.original_content = current.content;
  }

  const updated = await supa(env, "PATCH", "/rest/v1/memories", patch, { id: `eq.${params.id}` }) as unknown[];
  const saved = Array.isArray(updated) ? updated[0] : updated;
  const { embedding: _e, search_vector: _s, ...clean } = (saved ?? { id: params.id }) as Record<string, unknown>;
  return clean;
}

export async function memoryRevert(env: Env, params: z.infer<typeof revertSchema>) {
  validateUuid(params.id);

  const result = await supa(env, "GET", "/rest/v1/memories", undefined, { id: `eq.${params.id}` }) as Record<string, unknown>[];
  if (!Array.isArray(result) || result.length === 0) {
    throw new Error(`Memory not found: ${params.id}`);
  }
  const mem = result[0];

  if (!mem.original_content) {
    throw new Error(`No original_content to revert to — memory was never compressed: ${params.id}`);
  }

  const restoredContent = mem.original_content as string;
  const newEmbedding = await embed(env, restoredContent);

  const updated = await supa(env, "PATCH", "/rest/v1/memories", {
    content: restoredContent,
    original_content: null,
    compression_level: 0,
    embedding: newEmbedding,
    embedding_model: getEnvValue(env, "EMBEDDING_MODEL") ?? null,
  }, { id: `eq.${params.id}` }) as unknown[];

  const saved = Array.isArray(updated) ? updated[0] : updated;
  const { embedding: _e, search_vector: _s, ...clean } = (saved ?? { id: params.id }) as Record<string, unknown>;
  return clean;
}

export async function memoryMerge(env: Env, params: z.infer<typeof mergeSchema>) {
  const ids = params.ids.map((id) => validateUuid(id));
  const separator = params.separator ?? "\n---\n";

  const memories: Record<string, unknown>[] = [];
  for (const id of ids) {
    const result = await supa(env, "GET", "/rest/v1/memories", undefined, { id: `eq.${id}` }) as Record<string, unknown>[];
    if (!Array.isArray(result) || result.length === 0) {
      throw new Error(`Memory not found: ${id}`);
    }
    memories.push(result[0]);
  }

  const mergedContent = memories.map((m) => m.content as string).join(separator);
  const mergedTags = [...new Set(memories.flatMap((m) => (m.tags as string[]) ?? []))];
  const mergedMeta: Record<string, unknown> = {};
  for (const m of memories) {
    Object.assign(mergedMeta, (m.metadata as Record<string, unknown>) ?? {});
  }
  mergedMeta.merged_from = ids;

  const embedding = await embed(env, mergedContent);
  const row: Record<string, unknown> = {
    content: mergedContent,
    embedding,
    source: (memories[0].source as string) ?? envSource(env),
    profile: (memories[0].profile as string) ?? envProfile(env),
    tags: mergedTags,
    metadata: mergedMeta,
    embedding_model: getEnvValue(env, "EMBEDDING_MODEL") ?? null,
  };

  const result = await supa(env, "POST", "/rest/v1/memories", row) as unknown[];
  const saved = Array.isArray(result) ? result[0] : result;
  const newId = (saved as Record<string, unknown>).id;

  if (params.delete_originals) {
    for (const id of ids) {
      await supa(env, "DELETE", "/rest/v1/memories", undefined, { id: `eq.${id}` });
    }
  } else {
    for (const id of ids) {
      try {
        await supa(env, "POST", "/rest/v1/memory_edges", {
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
  (clean as Record<string, unknown>).originals_deleted = params.delete_originals ?? false;
  return clean;
}
