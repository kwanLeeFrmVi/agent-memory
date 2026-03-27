---
name: agent-memory
description: |
  Persistent, searchable shared memory for AI coding agents using Supabase + pgvector.
  Supports Ollama and third-party embedding models (OpenAI, Cohere, Voyage AI, Google Gemini).
  Works across any client (Claude Code, Claude.ai, Cursor, etc.) since memories live in Supabase.

  Use this skill whenever the user wants to:
  - Store or remember something: "remember this", "save this decision", "store this context", "note that we decided to..."
  - Recall or search memories: "what do you know about X", "recall previous decisions", "find related memories", "what did we decide about auth?"
  - Explore relationships: "what's related to this", "show the knowledge graph", "how does X connect to Y", "trace dependencies"
  - Start a new session: "load context", "restore memory", "what was I working on", "pick up where we left off"
  - Set up the system: "set up shared memory", "configure memory backend", "initialize pgvector", "create memory tables"

  Trigger even when the user doesn't use the word "memory" — any request to persist, recall, or relate information across sessions qualifies.

  Sub-skills:
  - **Memory ops**: store, retrieve, update, delete, compress, merge, bulk-delete, TTL
  - **Search**: hybrid semantic+keyword search via RRF, tag/source/date filtering
  - **Knowledge graph**: typed edges, relationship traversal, auto-linking, impact analysis
  - **Batch & context**: store-batch, context loader, suggest-tags, dedup
allowed-tools: Bash(bun*)
---

# Agent Memory

Persistent shared memory for AI agents backed by Supabase (PostgreSQL + pgvector). Memories are stored with vector embeddings for semantic search, full-text indexing for keyword search, and typed edges for a knowledge graph. Any agent or client that connects to the same Supabase project shares the same memory pool.

## Output handling

All commands return clean JSON (embeddings stripped). **Parse JSON output and summarize it in natural language for the user** — do not print raw JSON arrays unless the user explicitly asks for them. When a command returns an `id`, remember it for subsequent operations in the same session.

## Sub-skill routing

| User intent                                | Command                                                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| "remember", "store", "save"                | `bun $MEMORY store "text" [--tags t1,t2] [--source s] [--profile p] [--ttl days] [--dedup] [--auto-link]`  |
| "recall", "what do you know", "find"       | `bun $MEMORY search "query" [--limit n] [--profile p] [--min-confidence f] [--after date] [--before date]` |
| "get this memory"                          | `bun $MEMORY get <uuid>`                                                                                   |
| "related to", "knowledge graph"            | `bun $MEMORY related <uuid> [--depth n]`                                                                   |
| "forget", "delete"                         | `bun $MEMORY delete <uuid>`                                                                                |
| "link these two"                           | `bun $MEMORY link <uuid-a> <uuid-b> [--type supports]`                                                     |
| "unlink these two"                         | `bun $MEMORY unlink <uuid-a> <uuid-b> [--type supports]`                                                   |
| "recent memories"                          | `bun $MEMORY recent [--limit n] [--source s] [--after date] [--before date]`                               |
| "memories tagged X"                        | `bun $MEMORY tag <tag>`                                                                                    |
| "update this memory"                       | `bun $MEMORY update <uuid> --content "new text"`                                                           |
| "delete expired"                           | `bun $MEMORY cleanup`                                                                                      |
| "delete all with tag/source/date"          | `bun $MEMORY bulk-delete [--tag t] [--source s] [--profile p] [--before d] [--after d] [--dry-run]`        |
| "how many memories"                        | `bun $MEMORY stats [--profile p]`                                                                          |
| "check system health"                      | `bun $MEMORY health`                                                                                       |
| "list profiles"                            | `bun $MEMORY profiles`                                                                                     |
| "export memories"                          | `bun $MEMORY export [--profile p] [--output file.json]`                                                    |
| "import memories"                          | `bun $MEMORY import <file.json> [--re-embed]`                                                              |
| "re-embed all memories"                    | `bun $MEMORY re-embed [--profile p] [--batch-size n]`                                                      |
| "compress", "summarize memory"             | `bun $MEMORY compress <uuid> "shorter version"`                                                            |
| "load context", "pick up where I left off" | `bun $MEMORY context "topic" [--limit n] [--depth d] [--profile p]`                                        |
| "store multiple", "batch import"           | `bun $MEMORY store-batch <file.json> [--dedup] [--auto-link]`                                              |
| "merge these memories"                     | `bun $MEMORY merge <uuid1> <uuid2> [--delete-originals]`                                                   |
| "suggest tags for"                         | `bun $MEMORY suggest-tags "content" [--limit n]`                                                           |
| "set up memory", "create tables"           | Read `setup.md`, run `schema.sql`                                                                          |
| "which provider"                           | Read `providers.md`                                                                                        |

## Common Agent Patterns

### Starting a session / loading context

When the user says "pick up where we left off", "load context", or "what was I working on":

```bash
MEMORY=~/.agents/skills/agent-memory/scripts/memory.ts

# Best: context command (search + graph traversal in one step)
bun $MEMORY context "current topic or project name" --depth 2 --limit 5

# If the topic is vague, also check recent memories
bun $MEMORY recent --limit 10
```

Summarize the returned memories in natural language. Mention which memories are from the graph (related) vs direct search hits.

### Storing decisions cleanly

When the user wants to remember an architectural decision, always use `--dedup` to avoid duplicates and `--auto-link` to connect related memories in the graph automatically:

```bash
bun $MEMORY store "We decided to use JWT for auth — stateless, no session store needed" \
  --tags decision,auth \
  --source claude-code \
  --dedup \
  --auto-link
```

Use structured tags: `decision`, `bug`, `context`, `todo`, `project:<name>`. The `source` field should identify the agent or client storing the memory (e.g., `claude-code`, `cursor`).

### Safe bulk deletion

**Always do a dry run first** before bulk-deleting. Show the count to the user and ask for confirmation:

```bash
# Step 1: preview (safe — no writes)
bun $MEMORY bulk-delete --tag deprecated --dry-run

# Step 2: only delete after user confirms
bun $MEMORY bulk-delete --tag deprecated
```

Use ISO 8601 date strings for date filters: `--before 2025-01-01` or `--after 2024-06-15`.

### Compressing and merging old memories

When a memory is too verbose or two memories overlap significantly, compress or merge them to keep the knowledge base lean:

```bash
# Compress one memory (original preserved in original_content field)
bun $MEMORY compress <uuid> "Concise one-sentence summary of the memory"

# Merge two overlapping memories into one (removes originals)
bun $MEMORY merge <uuid1> <uuid2> --delete-originals
```

Only compress/merge when the user explicitly asks, or when you notice clear duplication.

### Exploring the knowledge graph

To understand how a topic connects to other memories:

```bash
# Find everything related to a specific memory
bun $MEMORY related <uuid> --depth 2

# Or use context for a topic — it combines search + graph
bun $MEMORY context "authentication" --depth 2
```

Graph edge types: `supports`, `contradicts`, `expands`, `related`, `depends_on`, `similar`. Use `link` to manually create edges when you notice a connection the agent missed:

```bash
bun $MEMORY link <uuid-a> <uuid-b> --type supports --strength 0.9
```

## Core data model (mental model)

```
memories
  id, content, original_content, embedding (vector), embedding_model
  metadata (jsonb), source, tags[], profile
  confidence, access_count, compression_level
  created_at, updated_at, expires_at

memory_edges
  source_id → target_id
  edge_type: supports | contradicts | expands | related | depends_on | similar
  strength (0-1)
```

Each memory gets a vector embedding and a full-text search index automatically. Searches combine both via RRF (Reciprocal Rank Fusion) for best results.

## Using memory.ts — full command reference

```bash
MEMORY=~/.agents/skills/agent-memory/scripts/memory.ts

# Store a memory
bun $MEMORY store "We decided to use JWT for auth, not sessions" --tags decision,auth

# Store with dedup check (skip if >95% similar memory exists)
bun $MEMORY store "JWT auth decision" --tags decision --dedup

# Store and auto-link to similar memories in the knowledge graph
bun $MEMORY store "Session tokens expire after 24h" --tags auth --auto-link

# Search (hybrid semantic + keyword)
bun $MEMORY search "authentication approach" --limit 5

# Search with confidence filter
bun $MEMORY search "auth" --min-confidence 0.8

# Search within a date range (ISO 8601 format)
bun $MEMORY search "auth" --after 2025-01-01 --before 2025-06-01

# Get a specific memory
bun $MEMORY get <uuid>

# Show recent
bun $MEMORY recent --limit 10

# Link two memories
bun $MEMORY link <uuid-a> <uuid-b> --type supports --strength 0.9

# Unlink two memories
bun $MEMORY unlink <uuid-a> <uuid-b> --type supports

# Graph traversal from a memory
bun $MEMORY related <uuid> --depth 2

# Stats overview
bun $MEMORY stats

# Health check (Supabase + embeddings + RPCs)
bun $MEMORY health

# List all profiles with counts
bun $MEMORY profiles

# Export memories (excluding embeddings)
bun $MEMORY export --output backup.json

# Import memories with re-embedding
bun $MEMORY import backup.json --re-embed

# Re-embed all memories with current provider
bun $MEMORY re-embed --batch-size 50

# Compress a verbose memory (preserves original in original_content)
bun $MEMORY compress <uuid> "shorter summarized version"

# Bulk delete — always dry-run first
bun $MEMORY bulk-delete --tag deprecated --dry-run
bun $MEMORY bulk-delete --source old-agent --before 2025-01-01

# Load context for a task (search + graph traversal combined)
bun $MEMORY context "building auth system" --depth 2

# Batch store from JSON file with dedup + auto-linking
bun $MEMORY store-batch memories.json --dedup --auto-link

# Merge multiple memories into one
bun $MEMORY merge <uuid1> <uuid2> --delete-originals

# Suggest tags based on similar existing memories
bun $MEMORY suggest-tags "new auth middleware for Express"
```

For full field reference, read `operations.md`. For search parameters, read `search.md`.

## Prerequisites (first-time setup)

**Before using this skill, you must run the database schema setup:**

1. Open `scripts/schema.sql` in your editor
2. **Adjust the embedding dimension** on line 23 (`extensions.vector(768)`) to match your embedding model:
   - Ollama `mxbai-embed-large` or `nomic-embed-text` → 768
   - OpenAI `text-embedding-3-small` → 1536
   - OpenAI `text-embedding-3-large` → 3072
   - Cohere `embed-english-v3.0` → 1024
   - Voyage `voyage-code-2` → 1536
   - Voyage `voyage-3` → 1024
   - Google Gemini `gemini-embedding-001` → 768
3. Go to Supabase Dashboard → **SQL Editor**
4. Paste the entire `schema.sql` contents and click **Run**

This creates:

- `memories` table with vector embeddings and full-text search
- `memory_edges` table for knowledge graph relationships
- RPC functions: `hybrid_search`, `match_memories`, `find_related_memories`, `get_memories_by_tag`, `cleanup_expired_memories`, `bump_access_count`, `memory_stats`

**Troubleshooting 404 errors:** If you see `404` on `/rest/v1/rpc/<function_name>`, the function doesn't exist in your database. Re-run `schema.sql` to create it.

## Environment variables

All env vars use the `AM_` prefix to avoid collisions. Falls back to unprefixed if `AM_` not set (e.g. `AM_SUPABASE_URL` → `SUPABASE_URL`), so multiple Supabase projects can coexist.

```bash
# Required — Supabase connection
AM_SUPABASE_URL=https://<project-ref>.supabase.co
AM_SUPABASE_SERVICE_KEY=<service_role_key>       # NOT anon key — full access needed

# Required — Pick ONE embedding provider:
AM_EMBEDDING_PROVIDER=ollama                      # ollama | openai | cohere | voyage | gemini
AM_EMBEDDING_MODEL=mxbai-embed-large             # model name for chosen provider
AM_EMBEDDING_DIM=768                             # must match model's output dimension

# Provider-specific API keys (only the one you use):
AM_OLLAMA_BASE_URL=http://localhost:11434         # if using Ollama
AM_OPENAI_API_KEY=sk-...                         # if using OpenAI
AM_COHERE_API_KEY=...                            # if using Cohere
AM_VOYAGE_API_KEY=...                            # if using Voyage AI
AM_GEMINI_API_KEY=...                            # if using Google Gemini
```

### Optional defaults

```bash
AM_SOURCE=agent                                   # default source tag when --source not passed
AM_PROFILE=default                                # default profile when --profile not passed
```

Store these in `.env` or your shell profile. The skill reads them for all operations.
