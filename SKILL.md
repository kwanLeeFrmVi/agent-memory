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
  operations.md  → Full field reference and edge cases
  search.md      → Search parameters, graph traversal details
  providers.md   → Embedding provider config (Ollama, OpenAI, Cohere, Voyage, Gemini)
```

**Always use `memory.ts` for operations** — it handles embedding generation and Supabase calls in one step, so you never need to manage embeddings manually or chain curl commands.

Read reference files only when you need parameter details or troubleshooting. If just getting started, read `setup.md` first.

## Environment variables (required)

```bash
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_KEY=<service_role_key>       # NOT anon key — full access needed

# Pick ONE embedding provider:
EMBEDDING_PROVIDER=ollama                      # ollama | openai | cohere | voyage | gemini
EMBEDDING_MODEL=mxbai-embed-large             # model name for chosen provider
EMBEDDING_DIM=1024                             # must match model's output dimension

# Provider-specific API keys (only the one you use):
OLLAMA_BASE_URL=http://localhost:11434         # if using Ollama
OPENAI_API_KEY=sk-...                         # if using OpenAI
COHERE_API_KEY=...                            # if using Cohere
VOYAGE_API_KEY=...                            # if using Voyage AI
GEMINI_API_KEY=...                            # if using Google Gemini
```

Store these in `.env` or your shell profile. The skill reads them for all operations.

## Sub-skill routing

| User intent                          | Command                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| "remember", "store", "save"          | `bun memory.ts store "text" [--tags t1,t2] [--source s] [--profile p] [--ttl days]` |
| "recall", "what do you know", "find" | `bun memory.ts search "query" [--limit n] [--profile p]`                            |
| "related to", "knowledge graph"      | `bun memory.ts related <uuid> [--depth n]`                                          |
| "forget", "delete"                   | `bun memory.ts delete <uuid>`                                                       |
| "link these two"                     | `bun memory.ts link <uuid-a> <uuid-b> [--type supports]`                            |
| "recent memories"                    | `bun memory.ts recent [--limit n] [--source s]`                                     |
| "memories tagged X"                  | `bun memory.ts tag <tag>`                                                           |
| "update this memory"                 | `bun memory.ts update <uuid> --content "new text"`                                  |
| "delete expired"                     | `bun memory.ts cleanup`                                                             |
| "how many memories"                  | `bun memory.ts stats`                                                               |
| "set up memory", "create tables"     | Read `setup.md`, run `schema.sql`                                                   |
| "which provider"                     | Read `providers.md`                                                                 |

## Core data model (mental model)

```
memories
  id, content, embedding (vector), metadata (jsonb)
  source, tags[], profile
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

# Get a specific memory
bun $MEMORY get <uuid>

# Show recent
bun $MEMORY recent --limit 10

# Link two memories
bun $MEMORY link <uuid-a> <uuid-b> --type supports --strength 0.9

# Graph traversal from a memory
bun $MEMORY related <uuid> --depth 2

# Stats overview
bun $MEMORY stats
```

All commands output clean JSON. Embeddings are stripped from output — you never see the raw float arrays.

For full operation patterns, read `operations.md`. For search parameters, read `search.md`.
