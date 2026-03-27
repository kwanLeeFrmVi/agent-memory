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
  - **Memory ops**: store, retrieve, update, delete, compress, TTL
  - **Search**: hybrid semantic+keyword search via RRF, tag/source filtering
  - **Knowledge graph**: typed edges, relationship traversal, impact analysis
---

# Agent Memory

Persistent shared memory for AI agents backed by Supabase (PostgreSQL + pgvector). Memories are stored with vector embeddings for semantic search, full-text indexing for keyword search, and typed edges for a knowledge graph. Any agent or client that connects to the same Supabase project shares the same memory pool.

## Quick orientation

```
scripts/
  memory.ts      → Bun CLI: all operations in one command (store/search/link/etc.)
  schema.sql     → SQL to paste into Supabase SQL Editor (run once)
references/
  setup.md       → First-time: SQL schema, env config, pgvector setup
  operations.md  → Field reference: metadata schema, edge types, compression
  search.md      → Search parameters, RRF scoring, graph traversal details
  providers.md   → Embedding provider config + batch limits (Ollama, OpenAI, Cohere, Voyage, Gemini)
```

**Always use `memory.ts` for operations** — it handles embedding generation and Supabase calls in one step, so you never need to manage embeddings manually or chain curl commands.

Read reference files only when you need parameter details or troubleshooting. If just getting started, read `setup.md` first.

## Environment variables

All env vars use the `AM_` prefix to avoid collisions. Falls back to unprefixed if `AM_` not set (e.g. `AM_SUPABASE_URL` → `SUPABASE_URL`), so multiple Supabase projects can coexist.

```bash
# Required — Supabase connection
AM_SUPABASE_URL=https://<project-ref>.supabase.co
AM_SUPABASE_SERVICE_KEY=<service_role_key>       # NOT anon key — full access needed

# Required — Pick ONE embedding provider:
AM_EMBEDDING_PROVIDER=ollama                      # ollama | openai | cohere | voyage | gemini
AM_EMBEDDING_MODEL=mxbai-embed-large             # model name for chosen provider
AM_EMBEDDING_DIM=1024                             # must match model's output dimension

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

## Sub-skill routing

| User intent                          | Command                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| "remember", "store", "save"          | `bun memory.ts store "text" [--tags t1,t2] [--source s] [--profile p] [--ttl days]` |
| "recall", "what do you know", "find" | `bun memory.ts search "query" [--limit n] [--profile p] [--min-confidence f]`       |
| "get this memory"                    | `bun memory.ts get <uuid>`                                                          |
| "related to", "knowledge graph"      | `bun memory.ts related <uuid> [--depth n]`                                          |
| "forget", "delete"                   | `bun memory.ts delete <uuid>`                                                       |
| "link these two"                     | `bun memory.ts link <uuid-a> <uuid-b> [--type supports]`                            |
| "unlink these two"                   | `bun memory.ts unlink <uuid-a> <uuid-b> [--type supports]`                          |
| "recent memories"                    | `bun memory.ts recent [--limit n] [--source s]`                                     |
| "memories tagged X"                  | `bun memory.ts tag <tag>`                                                           |
| "update this memory"                 | `bun memory.ts update <uuid> --content "new text"`                                  |
| "delete expired"                     | `bun memory.ts cleanup`                                                             |
| "how many memories"                  | `bun memory.ts stats [--profile p]`                                                 |
| "check system health"               | `bun memory.ts health`                                                              |
| "list profiles"                      | `bun memory.ts profiles`                                                            |
| "export memories"                    | `bun memory.ts export [--profile p] [--output file.json]`                           |
| "import memories"                    | `bun memory.ts import <file.json> [--re-embed]`                                     |
| "re-embed all memories"             | `bun memory.ts re-embed [--profile p] [--batch-size n]`                             |
| "set up memory", "create tables"     | Read `setup.md`, run `schema.sql`                                                   |
| "which provider"                     | Read `providers.md`                                                                 |

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

## Using memory.ts

One command handles everything — embedding generation + Supabase in a single step:

```bash
MEMORY=~/.agents/skills/agent-memory/scripts/memory.ts

# Store a memory
bun $MEMORY store "We decided to use JWT for auth, not sessions" --tags decision,auth

# Search (hybrid semantic + keyword)
bun $MEMORY search "authentication approach" --limit 5

# Search with confidence filter
bun $MEMORY search "auth" --min-confidence 0.8

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
```

All commands output clean JSON. Embeddings are stripped from output — you never see the raw float arrays.

For full field reference, read `operations.md`. For search parameters, read `search.md`.
