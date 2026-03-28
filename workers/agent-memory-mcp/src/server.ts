/**
 * server.ts — MCP server factory with all tool definitions
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "./core/env.ts";

// Store tools
import {
  storeSchema,
  storeBatchSchema,
  storeDecisionSchema,
  memoryStore,
  memoryStoreBatch,
  memoryStoreDecision,
} from "./tools/store.ts";

// Search tools
import {
  searchSchema,
  contextSchema,
  suggestTagsSchema,
  memorySearch,
  memoryContext,
  memorySuggestTags,
} from "./tools/search.ts";

// CRUD tools
import {
  getSchema,
  recentSchema,
  tagSchema,
  updateSchema,
  deleteSchema,
  compressSchema,
  revertSchema,
  mergeSchema,
  memoryGet,
  memoryRecent,
  memoryTag,
  memoryUpdate,
  memoryDelete,
  memoryCompress,
  memoryRevert,
  memoryMerge,
} from "./tools/crud.ts";

// Graph tools
import {
  linkSchema,
  unlinkSchema,
  relatedSchema,
  linkUnlinkedSchema,
  impactSchema,
  memoryLink,
  memoryUnlink,
  memoryRelated,
  memoryLinkUnlinked,
  memoryImpact,
} from "./tools/graph.ts";

// Admin tools
import {
  cleanupSchema,
  statsSchema,
  healthSchema,
  profilesSchema,
  exportSchema,
  reEmbedSchema,
  bulkDeleteSchema,
  setProfileTtlSchema,
  renameTagSchema,
  memoryCleanup,
  memoryStats,
  memoryHealth,
  memoryProfiles,
  memoryExport,
  memoryReEmbed,
  memoryBulkDelete,
  memorySetProfileTtl,
  memoryRenameTag,
} from "./tools/admin.ts";

export function createMcpServer(env: Env): McpServer {
  const server = new McpServer({
    name: "agent-memory",
    version: "1.0.0",
  });

  // ── Store Tools ─────────────────────────────────────────────────────────────

  server.tool(
    "memory_store",
    "Store a new memory with content, tags, and optional metadata. Supports deduplication, auto-linking, and TTL.",
    storeSchema.shape,
    async (params) => {
      const result = await memoryStore(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "memory_store_batch",
    "Store multiple memories at once. Accepts a JSON array of memory objects.",
    storeBatchSchema.shape,
    async (params) => {
      const result = await memoryStoreBatch(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "memory_store_decision",
    "Store a decision with rationale, alternatives, and auto-link to related memories.",
    storeDecisionSchema.shape,
    async (params) => {
      const result = await memoryStoreDecision(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Search Tools ────────────────────────────────────────────────────────────

  server.tool(
    "memory_search",
    "Hybrid search (semantic + keyword) for memories. Supports filtering by profile, tag, source, date, and importance.",
    searchSchema.shape,
    async (params) => {
      const result = await memorySearch(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "memory_context",
    "Get context for a query by finding related memories via graph traversal.",
    contextSchema.shape,
    async (params) => {
      const result = await memoryContext(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "memory_suggest_tags",
    "Suggest tags for content based on similar existing memories.",
    suggestTagsSchema.shape,
    async (params) => {
      const result = await memorySuggestTags(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── CRUD Tools ───────────────────────────────────────────────────────────────

  server.tool(
    "memory_get",
    "Retrieve a single memory by UUID.",
    getSchema.shape,
    async (params) => {
      const result = await memoryGet(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "memory_recent",
    "List recent memories, optionally filtered by source, profile, date, or importance.",
    recentSchema.shape,
    async (params) => {
      const result = await memoryRecent(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "memory_tag",
    "List memories with a specific tag.",
    tagSchema.shape,
    async (params) => {
      const result = await memoryTag(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "memory_update",
    "Update a memory's content, confidence, tags, or metadata.",
    updateSchema.shape,
    async (params) => {
      const result = await memoryUpdate(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "memory_delete",
    "Delete a memory by UUID.",
    deleteSchema.shape,
    async (params) => {
      const result = await memoryDelete(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "memory_compress",
    "Compress a memory's content to a summarized version.",
    compressSchema.shape,
    async (params) => {
      const result = await memoryCompress(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "memory_revert",
    "Revert a compressed memory back to its original content.",
    revertSchema.shape,
    async (params) => {
      const result = await memoryRevert(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "memory_merge",
    "Merge multiple memories into one. Optionally delete originals.",
    mergeSchema.shape,
    async (params) => {
      const result = await memoryMerge(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Graph Tools ──────────────────────────────────────────────────────────────

  server.tool(
    "memory_link",
    "Create an edge between two memories (supports, contradicts, expands, related, depends_on, similar).",
    linkSchema.shape,
    async (params) => {
      const result = await memoryLink(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "memory_unlink",
    "Remove an edge between two memories.",
    unlinkSchema.shape,
    async (params) => {
      const result = await memoryUnlink(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "memory_related",
    "Find memories related to a starting memory via graph traversal.",
    relatedSchema.shape,
    async (params) => {
      const result = await memoryRelated(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "memory_link_unlinked",
    "Auto-link orphan memories to similar ones based on embedding similarity.",
    linkUnlinkedSchema.shape,
    async (params) => {
      const result = await memoryLinkUnlinked(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "memory_impact",
    "Find which memories depend on (link to) a given memory.",
    impactSchema.shape,
    async (params) => {
      const result = await memoryImpact(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Admin Tools ──────────────────────────────────────────────────────────────

  server.tool(
    "memory_cleanup",
    "Delete expired memories (those past their TTL).",
    cleanupSchema.shape,
    async (params) => {
      const result = await memoryCleanup(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "memory_stats",
    "Get statistics about memories (count, by profile, by source, etc.).",
    statsSchema.shape,
    async (params) => {
      const result = await memoryStats(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "memory_health",
    "Check system health (Supabase connection, RPC functions, embedding provider).",
    healthSchema.shape,
    async (params) => {
      const result = await memoryHealth(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "memory_profiles",
    "List all memory profiles and their memory counts.",
    profilesSchema.shape,
    async (params) => {
      const result = await memoryProfiles(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "memory_export",
    "Export all memories as JSON (optionally filtered by profile).",
    exportSchema.shape,
    async (params) => {
      const result = await memoryExport(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "memory_re_embed",
    "Re-generate embeddings for all memories (use after changing embedding model).",
    reEmbedSchema.shape,
    async (params) => {
      const result = await memoryReEmbed(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "memory_bulk_delete",
    "Delete multiple memories matching criteria (tag, source, profile, date).",
    bulkDeleteSchema.shape,
    async (params) => {
      const result = await memoryBulkDelete(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "memory_set_profile_ttl",
    "Set default TTL (in days) for a profile. New memories will auto-expire.",
    setProfileTtlSchema.shape,
    async (params) => {
      const result = await memorySetProfileTtl(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "memory_rename_tag",
    "Rename a tag across all memories.",
    renameTagSchema.shape,
    async (params) => {
      const result = await memoryRenameTag(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  return server;
}
