---
name: agent-memory
description: |
  Persistent shared memory for AI agents.

  Use this skill to:
  1. Store/Persist: Save context, decisions, or knowledge across sessions ("remember this", "save decision").
  2. Recall/Search: Retrieve past knowledge or explore relationships ("what do you know about X", "knowledge graph").
  3. Restore Context: Pick up where you left off or load past sessions.

  Trigger for ANY request to persist, recall, or relate information across sessions.
allowed-tools: Bash(bun*)
---

# Agent Memory

Persistent shared memory for AI agents backed by Supabase (PostgreSQL + pgvector). Memories are stored with vector embeddings for semantic search, full-text indexing for keyword search, and typed edges for a knowledge graph. Any agent or client that connects to the same Supabase project shares the same memory pool.

## Output handling

All commands return clean JSON (embeddings stripped). **Parse JSON output and summarize it in natural language for the user** — do not print raw JSON arrays unless the user explicitly asks for them. When a command returns an `id`, remember it for subsequent operations in the same session.

After any `store` or `store-decision`, report: "Checked N for duplicates. Stored K. Skipped M (already existed). Tags used: [...]"

## CRITICAL INSTRUCTION FOR AI

DO NOT read the entire `memory.ts` source file. Use `--help` flags to explore commands dynamically:

```bash
MEMORY=~/.agents/skills/agent-memory/scripts/memory.ts
bun $MEMORY --help
bun $MEMORY store --help
bun $MEMORY search --help
```

---

## Research (capturing knowledge)

**When to use**: User wants to persist information — decisions, gotchas, patterns, config, architecture notes.

### Pre-store checklist (run before every `store`)

1. **Is it worth storing?** Skip obvious/generic facts, raw tool output, temporary notes.
2. **Does it already exist?** Run `search` with the key terms first. Skip if similarity > 0.9.
3. **How to tag it?** Apply the taxonomy below.

### Tag taxonomy

| Tag                 | Meaning                                   |
| ------------------- | ----------------------------------------- |
| `type:decision`     | Why something was built a certain way     |
| `type:gotcha`       | Bugs, workarounds, surprising behavior    |
| `type:pattern`      | Conventions/approaches that worked        |
| `type:config`       | Environment vars, service setup           |
| `type:architecture` | How components connect                    |
| `type:reference`    | Links, external docs                      |
| `project:<name>`    | Project namespace                         |
| `branch:<name>`     | Scope to git branch (skip on main/master) |

Branch auto-detection: `` `git branch --show-current` ``

### Storing a decision

Use `store-decision` — not plain `store` — when capturing an architectural choice:

```bash
MEMORY=~/.agents/skills/agent-memory/scripts/memory.ts

bun $MEMORY store-decision \
  --decision "Use JWT for auth" \
  --rationale "Stateless, no session store needed" \
  --alternatives "sessions,oauth" \
  --reasoning-trace "Evaluated 3 options. Sessions require Redis. OAuth too heavy for internal API." \
  --tags project:myapp \
  --related <uuid-of-auth-architecture-memory>
```

`store-decision` auto-applies `type:decision`, deduplicates at 0.9 similarity, and creates `supports` edges to any `--related` UUIDs.

### Storing general knowledge

```bash
bun $MEMORY store "Postgres connection pool exhausted under load — increase max_connections in config" \
  --tags type:gotcha,project:myapp \
  --source claude-code \
  --dedup \
  --auto-link
```

Always use `--dedup` and `--auto-link` when storing to avoid duplicates and maintain the graph.

### Pinning important memories

Add `--pin` to mark a memory as permanently important. Pinned memories survive bulk TTL cleanups and can be retrieved with `--pinned` filter:

```bash
bun $MEMORY store "Production DB URL: postgres://..." \
  --tags type:config \
  --pin \
  --importance 0.9
```

### Anti-patterns — do NOT store

- Raw file contents or full code blocks
- Tool command outputs or log dumps
- Full conversation transcripts
- Generic knowledge ("Python uses indentation")
- Temporary scratch notes

### Batch storing

```bash
bun $MEMORY store-batch items.json --dedup 0.9 --auto-link --profile myapp
```

---

## Recall (retrieving knowledge)

**When to use**: User wants to find something, load context, understand relationships, or audit before deleting.

### Multi-step retrieval strategy

1. Run `search "query"` — broad hybrid search
2. If results are thin (< 3 hits), rephrase and retry
3. Run `related <uuid>` on top hits to follow graph edges
4. Filter by `type:decision` for past choices: `search "auth" --tag type:decision`
5. Present as clusters grouped by graph connections, not just a ranked list

### Loading context on session start

When the user says "pick up where we left off", "load context", or "what was I working on":

```bash
MEMORY=~/.agents/skills/agent-memory/scripts/memory.ts

# Detect project from git, then load context
PROJECT=$(git remote get-url origin 2>/dev/null | sed 's|.*/||;s|\.git$||' || echo "current project")

# Best: context command combines search + graph in one step
bun $MEMORY context "$PROJECT" --depth 2 --limit 5

# If vague, also check recent memories
bun $MEMORY recent --limit 10
```

Summarize results briefly: "Found 8 memories: 3 decisions about auth (JWT chosen, sessions rejected), 2 gotchas about DB pool exhaustion, 3 architecture notes." Let the user ask for more detail.

### Inline graph traversal during search

Use `--graph-depth` to get search hits plus their related memories in one call:

```bash
bun $MEMORY search "auth decisions" --graph-depth 1
# Returns: { memories: [...direct hits], related: [...graph neighbors] }
```

The `context` command is a convenience wrapper over `search --graph-depth 2`.

### Checking impact before deleting

Before deleting a memory, check what depends on it:

```bash
bun $MEMORY impact <uuid>
# Returns: { incoming_edges: N, memories: [...sources that reference this] }
```

Only delete if `incoming_edges` is 0, or if you re-link dependents first.

### Result presentation rules

- One-line summary per memory
- Use relative timestamps: "last week", "March 10", not raw ISO strings
- Group graph hits with their seed memory (label them "via graph")
- If nothing found, say "Nothing found for X" — do not hedge with "I couldn't find..."
- Surface `type:decision` memories prominently when the user asks why something works a certain way

---

## Maintain (admin operations)

**When to use**: System health, data hygiene, graph repair, profile management.

### Profile TTL defaults

Set a default TTL so all future `store` calls in a profile auto-expire:

```bash
bun $MEMORY set-profile-ttl --profile work --days 30
bun $MEMORY set-profile-ttl --profile work --days 0   # clear the default
```

### Reverting a compressed memory

If `compress` was applied and the summary is too lossy:

```bash
bun $MEMORY revert <uuid>
# Restores original_content → content, clears compression_level, re-embeds
```

### Repairing the graph after re-embed

After running `re-embed`, orphan memories lose their graph connections. Repair:

```bash
bun $MEMORY link-unlinked --threshold 0.85 --dry-run   # preview first
bun $MEMORY link-unlinked --threshold 0.85             # then apply
```

### Renaming a tag

```bash
bun $MEMORY rename-tag bug type:gotcha --profile myapp --dry-run
bun $MEMORY rename-tag bug type:gotcha --profile myapp
```

### Safe bulk deletion

**Always dry-run first:**

```bash
bun $MEMORY bulk-delete --tag deprecated --dry-run
# Show count to user and ask for confirmation
bun $MEMORY bulk-delete --tag deprecated
```

### Compression and merging

```bash
# Compress one verbose memory (original preserved in original_content)
bun $MEMORY compress <uuid> "One-sentence summary"

# Merge two overlapping memories
bun $MEMORY merge <uuid1> <uuid2> --delete-originals
```

Only compress/merge when the user explicitly requests it, or when duplication is obvious.

### Stats and health

```bash
bun $MEMORY stats
# Returns: total, by_profile, by_source, orphan_count, edge_count_by_type,
#          top_accessed, pinned_count, avg_confidence, expiring_in_7d

bun $MEMORY health
# Checks: Supabase connectivity, RPC functions, embedding provider, dimension match
```

---

## Core data model

```
memories
  id, content, original_content, embedding (vector), embedding_model
  source, profile, tags[], metadata (jsonb)
  confidence, access_count, compression_level
  is_pinned (bool), importance (0-1 float)
  created_at, updated_at, expires_at

memory_edges
  source_id → target_id
  edge_type: supports | contradicts | expands | related | depends_on | similar
  strength (0-1)

profile_settings
  profile, ttl_days
```

Each memory gets a vector embedding and a full-text search index automatically. Searches combine both via RRF (Reciprocal Rank Fusion). `is_pinned` and `importance` are filterable on all read commands.

---

## Environment variables

All env vars use the `AM_` prefix to avoid collisions. Falls back to unprefixed if `AM_` not set.

```bash
# Required — Supabase connection
AM_SUPABASE_URL=https://<project-ref>.supabase.co
AM_SUPABASE_SERVICE_KEY=<service_role_key>       # NOT anon key

# Required — Pick ONE embedding provider:
AM_EMBEDDING_PROVIDER=ollama                      # ollama | openai | cohere | voyage | gemini
AM_EMBEDDING_MODEL=mxbai-embed-large
AM_EMBEDDING_DIM=768                             # must match model's output dimension

# Provider-specific keys (only the one you use):
AM_OLLAMA_BASE_URL=http://localhost:11434
AM_OPENAI_API_KEY=sk-...
AM_COHERE_API_KEY=...
AM_VOYAGE_API_KEY=...
AM_GEMINI_API_KEY=...

# Optional defaults
AM_SOURCE=agent
AM_PROFILE=default
```

---

## Reference Documentation

For detailed information, read the `references/` directory:

- `references/operations.md`: Full field reference, data model, edge types, new fields (is_pinned, importance, profile_settings).
- `references/search.md`: Hybrid search parameters and RRF details.
- `references/setup.md`: One-time setup guide for pgvector and schema deployment.
- `references/providers.md`: Embedding provider configuration (Ollama, OpenAI, Cohere, Voyage, Gemini).
- `references/toon-format.md`: TOON compact output format.
