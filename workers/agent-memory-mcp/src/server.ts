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
    description: "Persistent memory storage with semantic search, graph relationships, and TTL management",
  });

  // ── Store Tools ─────────────────────────────────────────────────────────────

  server.registerTool(
    "memory_store",
    {
      title: "Memory Store",
      description: "Store a new memory.",
      inputSchema: storeSchema,
    },
    async (params) => {
      const result = await memoryStore(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "memory_store_batch",
    {
      title: "Memory Store Batch",
      description: "Store multiple memories.",
      inputSchema: storeBatchSchema,
    },
    async (params) => {
      const result = await memoryStoreBatch(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "memory_store_decision",
    {
      title: "Memory Store Decision",
      description: "Store a decision with rationale and alternatives.",
      inputSchema: storeDecisionSchema,
    },
    async (params) => {
      const result = await memoryStoreDecision(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Search Tools ────────────────────────────────────────────────────────────

  server.registerTool(
    "memory_search",
    {
      title: "Memory Search",
      description: "Search memories with semantic and keyword support.",
      inputSchema: searchSchema,
    },
    async (params) => {
      const result = await memorySearch(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "memory_context",
    {
      title: "Memory Context",
      description: "Get query context via graph traversal.",
      inputSchema: contextSchema,
    },
    async (params) => {
      const result = await memoryContext(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "memory_suggest_tags",
    {
      title: "Memory Suggest Tags",
      description: "Suggest tags based on existing memories.",
      inputSchema: suggestTagsSchema,
    },
    async (params) => {
      const result = await memorySuggestTags(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── CRUD Tools ───────────────────────────────────────────────────────────────

  server.registerTool(
    "memory_get",
    {
      title: "Memory Get",
      description: "Get memory by UUID.",
      inputSchema: getSchema,
    },
    async (params) => {
      const result = await memoryGet(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "memory_recent",
    {
      title: "Memory Recent",
      description: "List recent memories.",
      inputSchema: recentSchema,
    },
    async (params) => {
      const result = await memoryRecent(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "memory_tag",
    {
      title: "Memory Tag",
      description: "List memories by tag.",
      inputSchema: tagSchema,
    },
    async (params) => {
      const result = await memoryTag(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "memory_update",
    {
      title: "Memory Update",
      description: "Update a memory.",
      inputSchema: updateSchema,
    },
    async (params) => {
      const result = await memoryUpdate(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "memory_delete",
    {
      title: "Memory Delete",
      description: "Delete memory by UUID.",
      inputSchema: deleteSchema,
    },
    async (params) => {
      const result = await memoryDelete(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "memory_compress",
    {
      title: "Memory Compress",
      description: "Compress memory content.",
      inputSchema: compressSchema,
    },
    async (params) => {
      const result = await memoryCompress(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "memory_revert",
    {
      title: "Memory Revert",
      description: "Revert compressed memory.",
      inputSchema: revertSchema,
    },
    async (params) => {
      const result = await memoryRevert(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "memory_merge",
    {
      title: "Memory Merge",
      description: "Merge multiple memories.",
      inputSchema: mergeSchema,
    },
    async (params) => {
      const result = await memoryMerge(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Graph Tools ──────────────────────────────────────────────────────────────

  server.registerTool(
    "memory_link",
    {
      title: "Memory Link",
      description: "Link two memories.",
      inputSchema: linkSchema,
    },
    async (params) => {
      const result = await memoryLink(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "memory_unlink",
    {
      title: "Memory Unlink",
      description: "Unlink two memories.",
      inputSchema: unlinkSchema,
    },
    async (params) => {
      const result = await memoryUnlink(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "memory_related",
    {
      title: "Memory Related",
      description: "Find related memories.",
      inputSchema: relatedSchema,
    },
    async (params) => {
      const result = await memoryRelated(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "memory_link_unlinked",
    {
      title: "Memory Link Unlinked",
      description: "Auto-link orphan memories.",
      inputSchema: linkUnlinkedSchema,
    },
    async (params) => {
      const result = await memoryLinkUnlinked(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "memory_impact",
    {
      title: "Memory Impact",
      description: "Find dependent memories.",
      inputSchema: impactSchema,
    },
    async (params) => {
      const result = await memoryImpact(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Admin Tools ──────────────────────────────────────────────────────────────

  server.registerTool(
    "memory_cleanup",
    {
      title: "Memory Cleanup",
      description: "Delete expired memories.",
      inputSchema: cleanupSchema,
    },
    async (params) => {
      const result = await memoryCleanup(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "memory_stats",
    {
      title: "Memory Stats",
      description: "Get memory statistics.",
      inputSchema: statsSchema,
    },
    async (params) => {
      const result = await memoryStats(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "memory_health",
    {
      title: "Memory Health",
      description: "Check system health.",
      inputSchema: healthSchema,
    },
    async (params) => {
      const result = await memoryHealth(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "memory_profiles",
    {
      title: "Memory Profiles",
      description: "List memory profiles.",
      inputSchema: profilesSchema,
    },
    async (params) => {
      const result = await memoryProfiles(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "memory_export",
    {
      title: "Memory Export",
      description: "Export all memories.",
      inputSchema: exportSchema,
    },
    async (params) => {
      const result = await memoryExport(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "memory_re_embed",
    {
      title: "Memory Re-embed",
      description: "Re-generate memory embeddings.",
      inputSchema: reEmbedSchema,
    },
    async (params) => {
      const result = await memoryReEmbed(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "memory_bulk_delete",
    {
      title: "Memory Bulk Delete",
      description: "Bulk delete memories.",
      inputSchema: bulkDeleteSchema,
    },
    async (params) => {
      const result = await memoryBulkDelete(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "memory_set_profile_ttl",
    {
      title: "Memory Set Profile TTL",
      description: "Set default profile TTL.",
      inputSchema: setProfileTtlSchema,
    },
    async (params) => {
      const result = await memorySetProfileTtl(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "memory_rename_tag",
    {
      title: "Memory Rename Tag",
      description: "Rename a tag.",
      inputSchema: renameTagSchema,
    },
    async (params) => {
      const result = await memoryRenameTag(env, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  return server;
}
