# Agent Memory

Persistent shared memory for AI agents backed by Supabase (PostgreSQL + pgvector). Memories are stored with vector embeddings for semantic search, full-text indexing for keyword search, and typed edges for a knowledge graph. Any agent or client that connects to the same Supabase project shares the same memory pool.

This tool allows AI coding agents (Claude Code, Cursor, Claude.ai, etc.) to persist state, trace decisions, load context, and explore knowledge graphs across sessions.

## Table of Contents

- [Installation](#installation)
- [Key Features](#key-features)
- [Prerequisites](#prerequisites)
- [Configuration](#configuration)
- [Setup](#setup)
- [Usage](#usage)
- [Sub-commands](#sub-commands)
- [Data Model](#data-model)
- [Cloudflare Workers MCP Server](#cloudflare-workers-mcp-server)
- [Further Reading](#further-reading)

## Installation

To install this skill to your machine, run:

```bash
npx skills add kwanLeeFrmVi/agent-memory
```

## Key Features

- **Persistent Shared Memory**: Store and recall information across sessions and platforms.
- **Hybrid Search**: Semantic search via vector embeddings + keyword search using full-text indexing with Reciprocal Rank Fusion (RRF).
- **Knowledge Graph**: Typed relationship edges between memories (e.g., `supports`, `contradicts`, `depends_on`).
- **Multiple Embedding Providers**: Supports Ollama (local), OpenAI, Cohere, Voyage AI, and Google Gemini.
- **Smart Operations**: Auto-linking, duplicate detection (dedup), compression, merging, bulk deletion, and TTL support.

## Prerequisites

- [Bun](https://bun.sh/) installed (`curl -fsSL https://bun.sh/install | bash`)
- A [Supabase](https://supabase.com/) project
- An embedding provider (e.g., Ollama running locally, or an API key for OpenAI, etc.)

## Configuration

Set up your environment variables. The script uses the `AM_` prefix for all variables, falling back to unprefixed if `AM_` is not found.

```bash
# Required - Supabase Connection
export AM_SUPABASE_URL="https://<your-project>.supabase.co"
export AM_SUPABASE_SERVICE_KEY="<your-service-role-key>" # Must be service role key for full access

# Required - Embedding Provider Settings
export AM_EMBEDDING_PROVIDER="ollama" # ollama | openai | cohere | voyage | gemini
export AM_EMBEDDING_MODEL="mxbai-embed-large"
export AM_EMBEDDING_DIM="1024" # Must match your chosen model's output dimension

# Provider API Keys (Set the one you are using)
export AM_OLLAMA_BASE_URL="http://localhost:11434" # For local Ollama
export AM_OPENAI_API_KEY="sk-..."
export AM_COHERE_API_KEY="..."
export AM_VOYAGE_API_KEY="..."
export AM_GEMINI_API_KEY="..."

# Optional Defaults
export AM_SOURCE="agent"
export AM_PROFILE="default"
```

> **Tip:** For easy use across all terminal sessions, you should add these `export` statements to your shell configuration file (e.g., `~/.bashrc` or `~/.zshrc`) and run `source ~/.bashrc` or `source ~/.zshrc`.

## Setup

First, initialize the database schema in your Supabase project. You can run the provided SQL schema file:
`scripts/schema.sql`

This creates the `memories` and `memory_edges` tables, sets up pgvector, and configures full-text search.

## Usage

The main entry point is the `scripts/memory.ts` file.

```bash
# Get general help and list all commands
bun scripts/memory.ts --help

# Get help for a specific command
bun scripts/memory.ts store --help
bun scripts/memory.ts search --help
```

### Common Commands

**Store a memory** (with automatic deduplication and knowledge graph linking):

```bash
bun scripts/memory.ts store "Decided to use Supabase for persistent memory" \
  --tags decision,architecture \
  --dedup \
  --auto-link
```

**Load context** (hybrid search + graph traversal in one step):

```bash
bun scripts/memory.ts context "architecture decisions" --depth 2
```

**Search memories**:

```bash
bun scripts/memory.ts search "database setup" --limit 5
```

**Explore relationships**:

```bash
bun scripts/memory.ts related <memory-uuid> --depth 2
```

**Store a decision** (structured, with dedup + graph edges):

```bash
bun scripts/memory.ts store-decision \
  --decision "Use Supabase for persistent memory" \
  --rationale "Managed Postgres + pgvector in one service" \
  --alternatives "self-hosted postgres, pinecone"
```

**Check what depends on a memory before deleting**:

```bash
bun scripts/memory.ts impact <memory-uuid>
```

**Search with inline graph traversal**:

```bash
bun scripts/memory.ts search "authentication" --graph-depth 1
```

## Sub-commands

- **Storage & Retrieval**: `store`, `store-decision`, `get`, `recent`, `search`, `context`
- **Graph & Relationships**: `link`, `unlink`, `related`, `link-unlinked`, `impact`
- **Management & Maintenance**: `update`, `delete`, `tag`, `profiles`, `stats`, `health`, `cleanup`, `set-profile-ttl`, `rename-tag`
- **Advanced Operations**: `merge`, `compress`, `revert`, `bulk-delete`, `re-embed`, `store-batch`, `export`, `import`, `suggest-tags`

## Data Model

- **memories**: Stores content, original content (if compressed), vector embeddings, JSON metadata, source, tags, TTL expiration, `is_pinned`, `importance`, and metrics.
- **memory_edges**: Stores directed relationships between memories with edge types (`supports`, `contradicts`, `expands`, `related`, `depends_on`, `similar`) and confidence strengths.
- **profile_settings**: Per-profile defaults (e.g., `ttl_days` for automatic TTL on `store`).

## Cloudflare Workers MCP Server

Deploy agent-memory as a remote MCP server for Claude Chat (web) and other MCP clients. Useful in case your client does not support skills or has no environment to run the local helper scripts.

**Features:**

- 26 MCP tools (store, search, CRUD, graph, admin)
- OAuth 2.1 authentication with PKCE
- Streamable HTTP + SSE transports
- Edge deployment on Cloudflare Workers

**Quick Start:**

```bash
cd workers/agent-memory-mcp
npm install
npx wrangler kv namespace create OAUTH_KV
# Update wrangler.toml with the KV namespace ID
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_KEY
npx wrangler secret put EMBEDDING_PROVIDER
npx wrangler secret put EMBEDDING_MODEL
npx wrangler secret put AUTH_ALLOWED_USERS
npm run deploy
```

See [workers/agent-memory-mcp/README.md](workers/agent-memory-mcp/README.md) for full documentation.

## Further Reading

Check the `references/` directory for detailed documentation on:

- `operations.md`: Detailed field references and data models
- `search.md`: Hybrid search and RRF specifics
- `setup.md`: Database schema setup instructions
- `providers.md`: Embedding provider configuration details
- `toon-format.md`: Details about the TOON output format
