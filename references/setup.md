# Setup Guide

One-time setup: enable pgvector in Supabase and deploy the schema.

## Step 1: Enable pgvector in Supabase

In the Supabase dashboard → SQL Editor, run:

```sql
create extension if not exists vector with schema extensions;
```

If you get a permissions error, go to **Database → Extensions** in the dashboard and enable "vector" from the UI.

## Step 2: Set your embedding dimension

Choose your provider/model and note the output dimension. **You must pick this before running the schema** — changing it later requires dropping and recreating the table.

| Provider | Model | Dimension |
|----------|-------|-----------|
| Ollama | mxbai-embed-large | 1024 |
| Ollama | nomic-embed-text | 1024 |
| OpenAI | text-embedding-3-small | 1536 |
| OpenAI | text-embedding-3-large | 3072 |
| Cohere | embed-english-v3.0 | 1024 |
| Voyage AI | voyage-code-2 | 1536 |
| Voyage AI | voyage-3 | 1024 |
| Google Gemini | gemini-embedding-001 | 768 |

Set `AM_EMBEDDING_DIM` in your env to match. Default in schema.sql is **1024** (works for Ollama mxbai-embed-large, Cohere, Voyage-3).

## Step 3: Run schema.sql

Open `scripts/schema.sql`, replace `1024` with your chosen dimension if different, then paste the entire file into Supabase SQL Editor and run it.

The schema creates:
- `memories` table with vector embedding, full-text search, tags, TTL, compression fields
- `memory_edges` table for the knowledge graph
- HNSW index for fast vector search
- GIN index for full-text search
- Seven RPC functions: `match_memories`, `hybrid_search`, `find_related_memories`, `get_memories_by_tag`, `cleanup_expired_memories`, `bump_access_count`, `memory_stats`

## Step 4: Configure environment variables

All env vars use the `AM_` prefix to avoid collisions with other tools. If an `AM_`-prefixed var is not set, `memory.ts` falls back to the unprefixed name (e.g. `AM_SUPABASE_URL` → `SUPABASE_URL`). This lets you run multiple Supabase projects side by side.

```bash
# Required — Supabase connection
export AM_SUPABASE_URL="https://<project-ref>.supabase.co"
export AM_SUPABASE_SERVICE_KEY="<your-service-role-key>"  # Settings → API → service_role

# Required — Embedding provider
export AM_EMBEDDING_PROVIDER="ollama"          # ollama | openai | cohere | voyage | gemini
export AM_EMBEDDING_MODEL="mxbai-embed-large"
export AM_EMBEDDING_DIM="1024"

# Provider API key (only the one you use)
export AM_OLLAMA_BASE_URL="http://localhost:11434"   # default for Ollama
# export AM_OPENAI_API_KEY="sk-..."
# export AM_COHERE_API_KEY="..."
# export AM_VOYAGE_API_KEY="..."
# export AM_GEMINI_API_KEY="..."

# Optional defaults
export AM_SOURCE="agent"                       # default --source value
export AM_PROFILE="default"                    # default --profile value
```

Get your Supabase keys from: **Project Settings → API**.
Use the **service_role** key (not the anon key) so the skill can insert and delete.

### Multi-project setup

To point Agent Memory at a different Supabase project than other tools, just set the `AM_` vars. The unprefixed vars (`SUPABASE_URL`, `OPENAI_API_KEY`, etc.) remain available for other tools — `memory.ts` only reads them as fallbacks.

## Step 5: Verify

```bash
# Quick health check (tests Supabase, RPCs, and embedding provider)
bun memory.ts health
```

## Step 6: Test embedding generation

Follow `providers.md` to verify your embedding provider is working before storing the first memory.

## Changing embedding dimension later

If you need to switch models/providers with a different dimension:

```bash
# 1. Export first
bun memory.ts export --output memories_backup.json

# 2. Drop and recreate tables in Supabase SQL Editor
```

```sql
drop table memory_edges;
drop table memories;
-- Then re-run schema.sql with the new dimension
```

```bash
# 3. Import with re-embedding
bun memory.ts import memories_backup.json --re-embed
```

## Row-Level Security (optional but recommended for multi-user)

By default the schema has RLS disabled for simplicity. To restrict access by profile/agent:

```sql
alter table memories enable row level security;
create policy "agent_access" on memories
  using (metadata->>'agent_id' = current_setting('app.agent_id', true));
```

Then set `app.agent_id` in your connection or via Supabase Edge Functions.
