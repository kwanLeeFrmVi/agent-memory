<div align="center">
  <img src="assets/icon.png" width="75" height="75" alt="Agent Memory Icon" />
  <h1>Agent Memory</h1>
  <p><b>Persistent shared memory for AI agents — powered by Supabase, pgvector & knowledge graphs</b></p>
  <p>
    <a href="https://bun.sh"><img src="https://img.shields.io/badge/Bun-%23000000.svg?style=for-the-badge&logo=bun&logoColor=white" alt="Bun" /></a>
    <a href="https://supabase.com"><img src="https://img.shields.io/badge/Supabase-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white" alt="Supabase" /></a>
    <img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
    <a href="https://developers.cloudflare.com/workers/"><img src="https://img.shields.io/badge/Cloudflare_Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Cloudflare Workers" /></a>
    <img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="License MIT" />
  </p>
</div>

<br />

<div align="center">
  <img src="assets/beauty_graph.png" alt="Knowledge Graph Visualization" width="100%" />
</div>

<br />

> Store memories with vector embeddings for **semantic search**, full-text indexing for **keyword search**, and typed edges for a **knowledge graph**. Any agent or client that connects to the same Supabase project shares the same memory pool.

AI coding agents — Claude Code, Cursor, Claude.ai, and others — can use this to **persist state**, **trace decisions**, **load context**, and **explore knowledge graphs** across sessions.

---

## 📑 Table of Contents

| Section                                   | What you'll find                 |
| ----------------------------------------- | -------------------------------- |
| [⚡ Quick Start](#-quick-start)           | One-command install              |
| [✨ Features](#-features)                 | Full capability overview         |
| [🔧 Setup](#-setup)                       | Prerequisites, config & database |
| [🚀 Usage](#-usage)                       | CLI commands & examples          |
| [📦 All Commands](#-all-commands)         | Complete sub-command reference   |
| [🗄️ Data Model](#️-data-model)             | Tables & schema overview         |
| [☁️ Cloud Deployment](#️-cloud-deployment) | Cloudflare Workers MCP server    |
| [📚 Further Reading](#-further-reading)   | In-depth documentation           |

---

## ⚡ Quick Start

You can easily add this skill to your AI coding environment using the `skills` CLI.

```bash
npx skills add kwanLeeFrmVi/agent-memory
```

That's it. The skill is installed and ready to use.

### Supported Environments

Once added, the `agent-memory` skill is automatically available in:

- **Cursor**: Use Composer or Chat and ask the agent to remember or recall context.
- **Windsurf**: Available via Cascade.
- **VSCode / OpenCode**: Supported via Cline, Roo Code, or any compatible AI extension.
- **Claude Code**: Works seamlessly in the terminal.
- **Claude Chat (Web)**: Requires [deploying to Cloudflare Workers](#%EF%B8%8F-cloud-deployment) (free). Then visit [claude.ai/settings/connectors](https://claude.ai/settings/connectors) → **Add Custom Connector** → enter your Worker URL → **Add & Connect** to authenticate via OAuth.
- **Gemini CLI**: Automatically loaded.

Simply tell your AI assistant: _"Remember this architectural decision for later"_ or _"What do you know about the database schema from our last session?"_

---

## ✨ Features

| Feature                          | Description                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------- |
| 🧠 **Persistent Shared Memory**  | Store and recall information across sessions and platforms                        |
| 🔍 **Hybrid Search**             | Semantic (vector) + keyword (full-text) search, merged via Reciprocal Rank Fusion |
| 🕸️ **Knowledge Graph**           | Typed relationship edges — `supports`, `contradicts`, `depends_on`, and more      |
| 🤖 **Multi-Provider Embeddings** | Ollama (local), OpenAI, Cohere, Voyage AI, Google Gemini                          |
| ⚙️ **Smart Operations**          | Auto-linking, dedup, compression, merging, bulk delete, TTL                       |

---

## 🔧 Setup

### Prerequisites

| Requirement            | How to get it                                                       |
| ---------------------- | ------------------------------------------------------------------- |
| **Bun**                | `curl -fsSL https://bun.sh/install \| bash`                         |
| **Supabase project**   | [supabase.com](https://supabase.com/) — free tier works             |
| **Embedding provider** | Ollama locally, or an API key for OpenAI / Cohere / Voyage / Gemini |

### Database Schema

Initialize your Supabase project with the provided schema:

```
scripts/schema.sql
```

This creates the `memories` and `memory_edges` tables, enables pgvector, and configures full-text search.

### Configuration

<details>
<summary><b>🔑 Environment variables (click to expand)</b></summary>

<br />

The script uses the `AM_` prefix for all variables, falling back to unprefixed if `AM_` is not found.

```bash
# ── Required ─────────────────────────────────────────
# Supabase Connection
export AM_SUPABASE_URL="https://<your-project>.supabase.co"
export AM_SUPABASE_SERVICE_KEY="<your-service-role-key>"

# Embedding Provider
export AM_EMBEDDING_PROVIDER="ollama"   # ollama | openai | cohere | voyage | gemini
export AM_EMBEDDING_MODEL="mxbai-embed-large"
export AM_EMBEDDING_DIM="1024"          # Must match your model's output dimension

# ── Provider API Keys (set the one you use) ──────────
export AM_OLLAMA_BASE_URL="http://localhost:11434"
export AM_OPENAI_API_KEY="sk-..."
export AM_COHERE_API_KEY="..."
export AM_VOYAGE_API_KEY="..."
export AM_GEMINI_API_KEY="..."

# ── Optional Defaults ────────────────────────────────
export AM_SOURCE="agent"
export AM_PROFILE="default"
```

> **Tip:** Add these `export` statements to `~/.zshrc` or `~/.bashrc` so they persist across terminal sessions. Run `source ~/.zshrc` afterward.

</details>

---

## 🚀 Usage

The main entry point is `scripts/memory.ts`:

```bash
bun scripts/memory.ts --help            # List all commands
bun scripts/memory.ts <command> --help   # Help for a specific command
```

### Store a memory

```bash
bun scripts/memory.ts store "Decided to use Supabase for persistent memory" \
  --tags decision,architecture \
  --dedup \
  --auto-link
```

### Load context (hybrid search + graph traversal)

```bash
bun scripts/memory.ts context "architecture decisions" --depth 2
```

### Search memories

```bash
bun scripts/memory.ts search "database setup" --limit 5
```

### Explore relationships

```bash
bun scripts/memory.ts related <memory-uuid> --depth 2
```

### Store a structured decision

```bash
bun scripts/memory.ts store-decision \
  --decision "Use Supabase for persistent memory" \
  --rationale "Managed Postgres + pgvector in one service" \
  --alternatives "self-hosted postgres, pinecone"
```

### Check impact before deleting

```bash
bun scripts/memory.ts impact <memory-uuid>
```

### Search with graph traversal

```bash
bun scripts/memory.ts search "authentication" --graph-depth 1
```

---

## 📦 All Commands

| Category                  | Commands                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Storage & Retrieval**   | `store` · `store-decision` · `get` · `recent` · `search` · `context`                                                |
| **Graph & Relationships** | `link` · `unlink` · `related` · `link-unlinked` · `impact`                                                          |
| **Management**            | `update` · `delete` · `tag` · `profiles` · `stats` · `health` · `cleanup` · `set-profile-ttl` · `rename-tag`        |
| **Advanced**              | `merge` · `compress` · `revert` · `bulk-delete` · `re-embed` · `store-batch` · `export` · `import` · `suggest-tags` |

---

## 🗄️ Data Model

| Table                  | Purpose                                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`memories`**         | Content, original (pre-compression) content, vector embeddings, JSON metadata, source, tags, TTL, `is_pinned`, `importance`, and access metrics            |
| **`memory_edges`**     | Directed relationships between memories — edge types: `supports`, `contradicts`, `expands`, `related`, `depends_on`, `similar` — with confidence strengths |
| **`profile_settings`** | Per-profile defaults (e.g., `ttl_days` for automatic TTL on `store`)                                                                                       |

---

## ☁️ Cloud Deployment

Deploy agent-memory as a **remote MCP server** on Cloudflare Workers — useful when your client doesn't support skills or has no local environment.

| Capability    | Detail                                           |
| ------------- | ------------------------------------------------ |
| **Tools**     | 26 MCP tools (store, search, CRUD, graph, admin) |
| **Auth**      | OAuth 2.1 with PKCE                              |
| **Transport** | Streamable HTTP + SSE                            |
| **Runtime**   | Cloudflare Workers (edge)                        |

<details>
<summary><b>🚀 Quick deploy steps (click to expand)</b></summary>

<br />

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

</details>

See [workers/agent-memory-mcp/README.md](workers/agent-memory-mcp/README.md) for full documentation.

---

## 📚 Further Reading

Detailed docs live in the `references/` directory:

| File             | Topic                            |
| ---------------- | -------------------------------- |
| `operations.md`  | Field references & data models   |
| `search.md`      | Hybrid search & RRF specifics    |
| `setup.md`       | Database schema setup            |
| `providers.md`   | Embedding provider configuration |
| `toon-format.md` | TOON output format               |

---

<div align="center">
  <sub>Built with ❤️ for AI agents that need to remember</sub>
</div>
