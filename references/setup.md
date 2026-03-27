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

Set `EMBEDDING_DIM` in your env to match. Default in schema.sql is **1024** (works for Ollama mxbai-embed-large, Cohere, Voyage-3).

## Step 3: Run schema.sql

Open `scripts/schema.sql`, replace `1024` with your chosen dimension if different, then paste the entire file into Supabase SQL Editor and run it.

The schema creates:
- `memories` table with vector embedding, full-text search, tags, TTL, compression fields
- `memory_edges` table for the knowledge graph
- HNSW index for fast vector search
- GIN index for full-text search
- Five RPC functions: `match_memories`, `hybrid_search`, `find_related_memories`, `get_memories_by_tag`, `cleanup_expired_memories`

## Step 4: Configure environment variables

```bash
# Required
export SUPABASE_URL="https://<project-ref>.supabase.co"
export SUPABASE_SERVICE_KEY="<your-service-role-key>"  # Settings → API → service_role

# Embedding provider
export EMBEDDING_PROVIDER="ollama"          # ollama | openai | cohere | voyage | gemini
export EMBEDDING_MODEL="mxbai-embed-large"
export EMBEDDING_DIM="1024"

# Provider API key (only the one you use)
export OLLAMA_BASE_URL="http://localhost:11434"
```

Get your Supabase keys from: **Project Settings → API**.
Use the **service_role** key (not the anon key) so the skill can insert and delete.

## Step 5: Verify

```bash
# Test connection
curl "$SUPABASE_URL/rest/v1/memories?limit=1" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY"

# Should return [] or a list of memories (not an error)
```

## Step 6: Test embedding generation

Follow `providers.md` to verify your embedding provider is working before storing the first memory.

## Changing embedding dimension later

If you need to switch models/providers with a different dimension:

```sql
-- Drop and recreate (loses all data — export first!)
drop table memory_edges;
drop table memories;
-- Then re-run schema.sql with the new dimension
```

To export before dropping:
```bash
curl "$SUPABASE_URL/rest/v1/memories?select=id,content,metadata,tags,source,created_at" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" > memories_backup.json
```

## Row-Level Security (optional but recommended for multi-user)

By default the schema has RLS disabled for simplicity. To restrict access by profile/agent:

```sql
alter table memories enable row level security;
create policy "agent_access" on memories
  using (metadata->>'agent_id' = current_setting('app.agent_id', true));
```

Then set `app.agent_id` in your connection or via Supabase Edge Functions.
