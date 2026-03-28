#!/usr/bin/env bun
/**
 * memory.ts — Agent memory CLI entrypoint
 *
 * Handles embedding generation + Supabase calls in one step.
 * Designed for LLM use: minimal output, clean JSON, one command per operation.
 *
 * Usage:
 *   bun memory.ts store "text" [--tags t1,t2] [--source s] [--profile p] [--ttl days] [--metadata '{}']
 *   bun memory.ts search "query" [--limit n] [--threshold f] [--profile p] [--tag t] [--source s] [--min-confidence f]
 *   bun memory.ts get <uuid>
 *   bun memory.ts recent [--limit n] [--source s] [--profile p]
 *   bun memory.ts tag <tag> [--limit n] [--profile p]
 *   bun memory.ts update <uuid> [--content "text"] [--confidence f] [--tags t1,t2] [--metadata '{}']
 *   bun memory.ts delete <uuid>
 *   bun memory.ts link <uuid-a> <uuid-b> [--type supports] [--strength f]
 *   bun memory.ts unlink <uuid-a> <uuid-b> [--type supports]
 *   bun memory.ts related <uuid> [--depth n] [--min-strength f]
 *   bun memory.ts cleanup
 *   bun memory.ts stats [--profile p]
 *   bun memory.ts health
 *   bun memory.ts profiles
 *   bun memory.ts export [--profile p] [--output file.json]
 *   bun memory.ts import <file.json> [--re-embed]
 *   bun memory.ts re-embed [--profile p] [--batch-size n]
 *   bun memory.ts store-decision --decision "text" --rationale "text" [--alternatives t1,t2] [--reasoning-trace "text"] [--tags t1,t2] [--related uuid1,uuid2]
 *   bun memory.ts link-unlinked [--threshold f] [--batch-size n] [--profile p] [--dry-run]
 *   bun memory.ts set-profile-ttl --profile p --days n
 *   bun memory.ts revert <uuid>
 *   bun memory.ts impact <uuid>
 *   bun memory.ts rename-tag <old> <new> [--profile p] [--dry-run]
 *
 * Env vars (AM_ prefix takes priority, falls back to unprefixed):
 *   AM_SUPABASE_URL / SUPABASE_URL
 *   AM_SUPABASE_SERVICE_KEY / SUPABASE_SERVICE_KEY
 *   AM_EMBEDDING_PROVIDER / EMBEDDING_PROVIDER  (ollama|openai|cohere|voyage|gemini)
 *   AM_EMBEDDING_MODEL / EMBEDDING_MODEL
 *   AM_EMBEDDING_DIM / EMBEDDING_DIM            (default: 1024)
 *   AM_OPENAI_API_KEY / OPENAI_API_KEY
 *   AM_COHERE_API_KEY / COHERE_API_KEY
 *   AM_VOYAGE_API_KEY / VOYAGE_API_KEY
 *   AM_GEMINI_API_KEY / GEMINI_API_KEY
 *   AM_OLLAMA_BASE_URL / OLLAMA_BASE_URL         (default: http://localhost:11434)
 *   AM_SOURCE / MEMORY_SOURCE                    (default: "agent")
 *   AM_PROFILE / MEMORY_PROFILE                  (default: "default")
 */

import { loadEnv } from "./core/env.ts";
import { parseArgs, fatal } from "./core/utils.ts";

// ── Commands ──────────────────────────────────────────────────────────────────
import { cmdStore, cmdStoreBatch, cmdStoreDecision } from "./commands/store.ts";
import { cmdSearch, cmdContext, cmdSuggestTags } from "./commands/search.ts";
import { cmdGet, cmdRecent, cmdTag, cmdUpdate, cmdDelete, cmdCompress, cmdRevert, cmdMerge } from "./commands/crud.ts";
import { cmdLink, cmdUnlink, cmdRelated, cmdLinkUnlinked, cmdImpact } from "./commands/graph.ts";
import {
  cmdCleanup, cmdStats, cmdHealth, cmdProfiles, cmdExport, cmdImport,
  cmdReEmbed, cmdBulkDelete, cmdSetProfileTtl, cmdRenameTag,
} from "./commands/admin.ts";

// ── Help text ─────────────────────────────────────────────────────────────────

const GLOBAL_HELP = `usage: bun memory.ts <command> [args]

Agent memory CLI. Handles embedding generation + Supabase calls in one step.
Designed for LLM use: minimal output, clean JSON, one command per operation.

commands:
  store             Store a new memory
  search            Search for memories (hybrid semantic + keyword)
  get               Retrieve a specific memory by UUID
  recent            List recently stored memories
  tag               Find memories by a specific tag
  update            Modify an existing memory
  delete            Delete a memory
  link              Create a relationship edge between two memories
  unlink            Remove a relationship edge
  related           Explore the knowledge graph from a specific memory
  cleanup           Remove expired memories based on TTL
  stats             Show memory database statistics
  health            Check system health and database connectivity
  profiles          List all memory profiles
  export            Export memories to JSON
  import            Import memories from JSON
  re-embed          Re-generate embeddings for existing memories
  compress          Summarize a verbose memory
  revert            Restore a compressed memory to its original content
  bulk-delete       Delete multiple memories by criteria
  context           Load context for a topic (search + graph combined)
  store-batch       Store multiple memories from a JSON array file
  merge             Combine multiple memories into one
  suggest-tags      Suggest tags for new content
  store-decision    Structured decision capture (decision + rationale + alternatives)
  link-unlinked     Create similarity edges for orphan memories
  set-profile-ttl   Set default TTL for a profile
  impact            Show what depends on a memory (incoming edges)
  rename-tag        Rename a tag across all memories in a profile

Run \`bun memory.ts <command> --help\` for details on a specific command.

env vars (AM_ prefix takes priority, falls back to unprefixed):
  AM_SUPABASE_URL         Supabase project URL
  AM_SUPABASE_SERVICE_KEY service_role key
  AM_EMBEDDING_PROVIDER   ollama | openai | cohere | voyage | gemini
  AM_EMBEDDING_MODEL      model name for chosen provider
  AM_EMBEDDING_DIM        embedding dimension (default: 1024)
  AM_SOURCE               default source tag (default: "agent")
  AM_PROFILE              default profile (default: "default")`;

const COMMAND_HELP: Record<string, string> = {
  store: `usage: bun memory.ts store <content> [flags]

Store a new memory and automatically generate its embedding.

flags:
  --tags t1,t2     Comma-separated list of tags
  --source s       Source identifier (e.g., agent name)
  --profile p      Memory profile/partition (default: "default")
  --ttl days       Time-to-live in days before automatic deletion
  --metadata '{}'  Additional JSON metadata
  --dedup thres    Skip storing if similarity >= threshold (or use without value for 0.95)
  --auto-link      Automatically link to similar existing memories`,

  search: `usage: bun memory.ts search <query> [flags]

Search memories using hybrid search (semantic vector similarity + full-text keyword matching).

flags:
  --limit n          Max results to return (default: 10)
  --threshold f      Minimum similarity threshold (0.0 to 1.0, default: 0.3)
  --profile p        Filter by profile
  --tag t            Filter by specific tag
  --source s         Filter by source
  --min-confidence f Filter by minimum confidence score
  --after date       Filter by created_at >= date (ISO 8601)
  --before date      Filter by created_at <= date (ISO 8601)`,

  get: `usage: bun memory.ts get <uuid>

Retrieve a specific memory by its UUID. Returns clean JSON without the raw embedding vector.`,

  recent: `usage: bun memory.ts recent [flags]

List the most recently stored memories.

flags:
  --limit n      Max results to return (default: 20)
  --source s     Filter by source
  --profile p    Filter by profile
  --after date   Filter by created_at >= date
  --before date  Filter by created_at <= date`,

  tag: `usage: bun memory.ts tag <tag> [flags]

Retrieve memories that have a specific tag.

flags:
  --limit n      Max results to return (default: 20)
  --profile p    Filter by profile`,

  update: `usage: bun memory.ts update <uuid> [flags]

Update an existing memory. If --content is updated, its embedding will be automatically regenerated.

flags:
  --content text   New text content
  --confidence f   New confidence score (0.0 to 1.0)
  --tags t1,t2     New comma-separated tags (replaces existing)
  --metadata '{}'  New JSON metadata (replaces existing)`,

  delete: `usage: bun memory.ts delete <uuid>

Delete a specific memory by its UUID.`,

  link: `usage: bun memory.ts link <uuid-a> <uuid-b> [flags]

Create a typed directional edge between two memories in the knowledge graph.

flags:
  --type edge      Type of relationship (supports, contradicts, expands, related, depends_on, similar). Default: related.
  --strength f     Strength of the relationship (0.0 to 1.0, default: 0.7)`,

  unlink: `usage: bun memory.ts unlink <uuid-a> <uuid-b> [flags]

Remove a relationship edge between two memories.

flags:
  --type edge      Only delete edges of this specific type`,

  related: `usage: bun memory.ts related <uuid> [flags]

Explore the knowledge graph starting from a specific memory.

flags:
  --depth n        Max traversal hops (default: 2)
  --min-strength f Minimum edge strength to follow (default: 0.5)`,

  cleanup: `usage: bun memory.ts cleanup

Remove all memories whose expires_at date is in the past. Returns the number of deleted memories.`,

  stats: `usage: bun memory.ts stats [flags]

Show database statistics, including total memories, counts by profile/source, and edge counts.

flags:
  --profile p      Filter stats to a specific profile`,

  health: `usage: bun memory.ts health

Check connectivity to Supabase, verify RPC functions exist, and validate embedding provider setup.`,

  profiles: `usage: bun memory.ts profiles

List all active memory profiles and the number of memories in each.`,

  export: `usage: bun memory.ts export [flags]

Export memories to JSON format (excludes raw embedding vectors).

flags:
  --profile p      Only export memories from this profile
  --output file    Save to a file instead of printing to stdout`,

  import: `usage: bun memory.ts import <file.json> [flags]

Import memories from a JSON file.

flags:
  --re-embed       Regenerate embeddings for all imported memories using the current provider`,

  "re-embed": `usage: bun memory.ts re-embed [flags]

Regenerate embeddings for existing memories using the currently configured provider. Useful when switching embedding models.

flags:
  --profile p      Only re-embed memories in this profile
  --batch-size n   Number of memories to process at once (default: 50)`,

  compress: `usage: bun memory.ts compress <uuid> <compressed-text>

Replace a verbose memory's content with a shorter summarized version. The original content is preserved in the original_content field.`,

  "bulk-delete": `usage: bun memory.ts bulk-delete [flags]

Delete multiple memories matching specific criteria. ALWAYS use --dry-run first to check how many will be deleted.

flags:
  --tag t          Delete memories with this tag
  --source s       Delete memories from this source
  --profile p      Delete memories in this profile
  --before date    Delete memories created before this date
  --after date     Delete memories created after this date
  --dry-run        Print count of matched memories without deleting`,

  context: `usage: bun memory.ts context <query> [flags]

Load context for a task. Performs a hybrid search and follows knowledge graph edges from the results in one step.

flags:
  --limit n        Max search results to return initially (default: 5)
  --depth d        Graph traversal depth from search results (default: 2)
  --profile p      Filter by profile`,

  "store-batch": `usage: bun memory.ts store-batch <file.json> [flags]

Store multiple memories from a JSON array file. Expected format: [{"content": "...", "tags": [...]}, ...]

flags:
  --dedup thres    Skip storing items if similarity >= threshold
  --auto-link      Automatically link new memories to similar existing ones
  --profile p      Default profile for items without one
  --source s       Default source for items without one`,

  merge: `usage: bun memory.ts merge <uuid1> <uuid2> [uuid3...] [flags]

Combine multiple memories into a single new memory. Concatenates content, merges tags, and optionally links or deletes the originals.

flags:
  --delete-originals Remove the original memories after merging
  --separator text   String used to join contents (default: "\\n---\\n")`,

  "suggest-tags": `usage: bun memory.ts suggest-tags <content> [flags]

Suggest tags for new content based on similar existing memories in the database.

flags:
  --limit n        Max number of tags to suggest (default: 5)`,

  "store-decision": `usage: bun memory.ts store-decision --decision <text> --rationale <text> [flags]

Capture a structured architectural decision with rationale, alternatives considered, and reasoning trace.
Automatically applies type:decision tag, runs dedup at 0.9 similarity, and creates 'supports' edges to --related memories.

flags:
  --decision text       The decision made (required)
  --rationale text      Why this decision was made (required)
  --alternatives t1,t2  Comma-separated list of alternatives considered
  --reasoning-trace text Full evaluation narrative stored in metadata
  --tags t1,t2          Additional tags (type:decision added automatically)
  --related uuid1,uuid2 UUIDs of memories this decision supports
  --profile p           Memory profile (default from AM_PROFILE)
  --source s            Source identifier`,

  "link-unlinked": `usage: bun memory.ts link-unlinked [flags]

Scan memories with no outgoing edges and create 'similar' edges to their nearest neighbors.
Useful after re-embed to rebuild the knowledge graph.

flags:
  --threshold f    Minimum similarity to create an edge (default: 0.85)
  --batch-size n   Max memories to process (default: 50)
  --profile p      Filter to a specific profile
  --dry-run        Count orphans without writing any edges`,

  "set-profile-ttl": `usage: bun memory.ts set-profile-ttl --profile <name> --days <n>

Set a default TTL for all future store operations in a profile.
Pass --days 0 to clear the default TTL.

flags:
  --profile p      Profile name (required)
  --days n         Default TTL in days; 0 = clear (required)`,

  revert: `usage: bun memory.ts revert <uuid>

Restore a compressed memory back to its original content (from original_content field).
Also re-generates the embedding and clears compression_level back to 0.
Fails if the memory was never compressed.`,

  impact: `usage: bun memory.ts impact <uuid>

Show all memories that depend on or reference a given memory via incoming edges.
Read-only safety check — useful before deleting a memory to see what would be affected.`,

  "rename-tag": `usage: bun memory.ts rename-tag <old> <new> [flags]

Rename a tag across all memories in a profile (or all profiles).

flags:
  --profile p      Limit to a specific profile
  --dry-run        Show how many memories would be affected without writing`,
};

// ── Bootstrap ─────────────────────────────────────────────────────────────────

await loadEnv();

const args = process.argv.slice(2);
const { positional, flags: cliFlags } = parseArgs(args);

if (cliFlags.help || cliFlags.h || args.length === 0) {
  const cmd = positional[0];
  if (cmd && COMMAND_HELP[cmd]) {
    console.log(COMMAND_HELP[cmd]);
  } else {
    console.log(GLOBAL_HELP);
  }
  process.exit(0);
}

const cmd = positional[0];
const rest = positional.slice(1);

switch (cmd) {
  // Store
  case "store":           await cmdStore(rest, cliFlags); break;
  case "store-batch":     await cmdStoreBatch(rest, cliFlags); break;
  case "store-decision":  await cmdStoreDecision(rest, cliFlags); break;
  // Search
  case "search":          await cmdSearch(rest, cliFlags); break;
  case "context":         await cmdContext(rest, cliFlags); break;
  case "suggest-tags":    await cmdSuggestTags(rest, cliFlags); break;
  // CRUD
  case "get":             await cmdGet(rest); break;
  case "recent":          await cmdRecent(cliFlags); break;
  case "tag":             await cmdTag(rest, cliFlags); break;
  case "update":          await cmdUpdate(rest, cliFlags); break;
  case "delete":          await cmdDelete(rest); break;
  case "compress":        await cmdCompress(rest, cliFlags); break;
  case "revert":          await cmdRevert(rest); break;
  case "merge":           await cmdMerge(rest, cliFlags); break;
  // Graph
  case "link":            await cmdLink(rest, cliFlags); break;
  case "unlink":          await cmdUnlink(rest, cliFlags); break;
  case "related":         await cmdRelated(rest, cliFlags); break;
  case "link-unlinked":   await cmdLinkUnlinked(cliFlags); break;
  case "impact":          await cmdImpact(rest); break;
  // Admin
  case "cleanup":         await cmdCleanup(); break;
  case "stats":           await cmdStats(cliFlags); break;
  case "health":          await cmdHealth(); break;
  case "profiles":        await cmdProfiles(); break;
  case "export":          await cmdExport(cliFlags); break;
  case "import":          await cmdImport(rest, cliFlags); break;
  case "re-embed":        await cmdReEmbed(cliFlags); break;
  case "bulk-delete":     await cmdBulkDelete(cliFlags); break;
  case "set-profile-ttl": await cmdSetProfileTtl(cliFlags); break;
  case "rename-tag":      await cmdRenameTag(rest, cliFlags); break;
  default:                fatal(`Unknown command: ${cmd}`);
}
