# Agent Memory MCP Server

A Cloudflare Workers MCP server for the [agent-memory](../skills/agent-memory) skill, enabling Claude Chat (web) and other MCP clients to interact with your memory store securely via OAuth 2.1.

## Features

- **26 MCP Tools** — All CLI commands exposed as tools (store, search, CRUD, graph, admin)
- **OAuth 2.1 Authentication** — Self-hosted OAuth with PKCE, dynamic client registration
- **Dual Transport Support** — Streamable HTTP and SSE (Server-Sent Events)
- **Edge Deployment** — Runs on Cloudflare Workers for low latency

## Quick Start

### Option A: Interactive Setup (Recommended)

Run the TUI setup wizard for guided configuration:

```bash
bun install
bun run setup
```

The wizard will:

1. Check Cloudflare authentication
2. Create KV namespace
3. Configure Supabase credentials
4. Set up embedding provider (OpenAI, Cohere, Voyage, or Gemini)
5. Create authentication users
6. Update `wrangler.toml` automatically
7. Set all Cloudflare secrets
8. Deploy the worker

### Option B: Manual Setup

#### 1. Install Dependencies

```bash
bun install
```

#### 2. Create KV Namespace

```bash
bunx wrangler kv namespace create OAUTH_KV
```

Copy the `id` from the output and update `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "OAUTH_KV"
id = "your-kv-namespace-id-here"
```

#### 3. Set Secrets

Set each required secret via `wrangler secret put`:

```bash
# Supabase (required)
bunx wrangler secret put SUPABASE_URL
bunx wrangler secret put SUPABASE_SERVICE_KEY  # API Private Key from Settings → API Keys

# Embedding provider (required)
bunx wrangler secret put EMBEDDING_PROVIDER  # openai | cohere | voyage | gemini
bunx wrangler secret put EMBEDDING_MODEL      # e.g. text-embedding-3-small
bunx wrangler secret put EMBEDDING_DIM        # e.g. 1024

# Provider API key (choose one based on EMBEDDING_PROVIDER)
bunx wrangler secret put OPENAI_API_KEY
# bunx wrangler secret put COHERE_API_KEY
# bunx wrangler secret put VOYAGE_API_KEY
# bunx wrangler secret put GEMINI_API_KEY

# Auth users (required)
bunx wrangler secret put AUTH_ALLOWED_USERS
```

#### AUTH_ALLOWED_USERS Format

JSON array of users with SHA-256 hashed passwords:

```json
[
  {
    "username": "you",
    "password_hash": "sha256:yoursalt:yourhash"
  }
]
```

To generate a hash:

```bash
# Node.js
node -e "const crypto = require('crypto'); const salt = 'randomsalt123'; const password = 'yourpassword'; const hash = crypto.createHash('sha256').update(salt + password).digest('hex'); console.log('sha256:' + salt + ':' + hash);"
```

#### 4. Run Locally

```bash
bun run dev
```

Server starts at `http://localhost:8787`.

#### 5. Test with MCP Inspector

```bash
bunx @modelcontextprotocol/inspector http://localhost:8787/mcp
```

The Inspector will guide you through OAuth authorization.

#### 6. Deploy

```bash
bun run deploy
```

After deployment, set secrets again for production:

```bash
bunx wrangler secret put SUPABASE_URL --env production
# ... repeat for all secrets
```

## Endpoints

| Endpoint                                  | Description                      |
| ----------------------------------------- | -------------------------------- |
| `/.well-known/oauth-authorization-server` | OAuth metadata                   |
| `/register`                               | Dynamic client registration      |
| `/authorize`                              | Authorization UI (login/consent) |
| `/token`                                  | Token endpoint                   |
| `/mcp`                                    | MCP server (Streamable HTTP)     |
| `/mcp/sse`                                | MCP server (SSE)                 |

## Available Tools

### Store

- `memory_store` — Store a memory with content, tags, metadata
- `memory_store_batch` — Store multiple memories at once
- `memory_store_decision` — Store a decision with rationale

### Search

- `memory_search` — Hybrid search (semantic + keyword)
- `memory_context` — Get context via graph traversal
- `memory_suggest_tags` — Suggest tags based on similar memories

### CRUD

- `memory_get` — Retrieve by UUID
- `memory_recent` — List recent memories
- `memory_tag` — List by tag
- `memory_update` — Update content/tags/metadata
- `memory_delete` — Delete by UUID
- `memory_compress` — Compress content
- `memory_revert` — Revert to original
- `memory_merge` — Merge multiple memories

### Graph

- `memory_link` — Create edge between memories
- `memory_unlink` — Remove edge
- `memory_related` — Find related via traversal
- `memory_link_unlinked` — Auto-link orphans
- `memory_impact` — Find dependents

### Admin

- `memory_cleanup` — Delete expired memories
- `memory_stats` — Get statistics
- `memory_health` — Health check
- `memory_profiles` — List profiles
- `memory_export` — Export as JSON
- `memory_re_embed` — Re-generate embeddings
- `memory_bulk_delete` — Delete by criteria
- `memory_set_profile_ttl` — Set profile TTL
- `memory_rename_tag` — Rename a tag

## Connecting from Claude Chat

1. Deploy the worker
2. In Claude Chat, add a new MCP server with your worker URL
3. Complete OAuth authorization
4. Tools are now available in Claude Chat

## Architecture

```
Claude Chat ─── OAuth 2.1 ───► CF Worker
                                 │
                     ┌───────────┼───────────┐
                     ▼           ▼           ▼
                  KV Store   Supabase   Embedding API
                 (tokens)   (memories)   (vectors)
```

## Security

- **HTTPS** — Enforced by Cloudflare
- **PKCE** — Prevents token interception
- **No implicit flow** — Authorization code only
- **Hashed passwords** — SHA-256 with salt
- **Secrets encryption** — Stored encrypted at rest
- **No ollama** — Removed (can't reach localhost from edge)

## Development

```bash
# Type checking
npx tsc --noEmit

# Generate types after wrangler.toml changes
npm run cf-typegen
```

## License

MIT
