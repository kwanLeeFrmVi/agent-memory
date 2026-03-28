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

## AI Instructions

1. **DO NOT read `memory.ts`**. Use `--help` to explore commands: `bun ~/.agents/skills/agent-memory/scripts/memory.ts --help`
2. **Output**: Summarize JSON in natural language. Do not print raw arrays. Remember `id`s for session reuse.
3. **Reporting**: After store, report: "Checked N. Stored K. Skipped M. Tags: [...]"
4. **Presentation**: Use 1-line summaries, relative timestamps, group graph hits, and surface `type:decision` prominently.

## Research (Store)

**Checklist**: 1. Worth storing? 2. Exists? (search first, skip if sim > 0.9) 3. Apply tags.
**Tags**: `type:decision`, `type:gotcha`, `type:pattern`, `type:config`, `type:architecture`, `type:reference`, `project:<name>`, `branch:<name>`
**Anti-patterns**: Do NOT store raw files, tool outputs, transcripts, generic facts, scratch notes.

```bash
MEMORY=~/.agents/skills/agent-memory/scripts/memory.ts

# Decisions (Auto-applies type:decision, dedups at 0.9, links supports)
bun $MEMORY store-decision --decision "Use JWT" --rationale "..." --alternatives "..." --reasoning-trace "..." --tags project:myapp --related <uuid>

# General (Always use --dedup and --auto-link)
bun $MEMORY store "Postgres pool exhausted..." --tags type:gotcha,project:myapp --dedup --auto-link

# Pin important memories
bun $MEMORY store "DB URL..." --tags type:config --pin --importance 0.9

# Batch
bun $MEMORY store-batch items.json --dedup 0.9 --auto-link
```

## Recall (Search)

**Strategy**: 1. `search "query"` 2. Rephrase if <3 hits 3. `related <uuid>` to follow graph 4. Filter `--tag type:decision`.

```bash
# Context load (combines search + graph)
PROJECT=$(git remote get-url origin 2>/dev/null | sed 's|.*/||;s|\.git$||')
bun $MEMORY context "$PROJECT" --depth 2 --limit 5
bun $MEMORY recent --limit 10

# Inline graph traversal (search + neighbors)
bun $MEMORY search "auth" --graph-depth 1

# Check impact before deleting (requires incoming_edges=0)
bun $MEMORY impact <uuid>
```

## Maintain (Admin)

```bash
bun $MEMORY set-profile-ttl --profile work --days 30
bun $MEMORY revert <uuid>                                   # Revert compression
bun $MEMORY link-unlinked --threshold 0.85                  # Repair graph
bun $MEMORY rename-tag old new --profile myapp
bun $MEMORY bulk-delete --tag deprecated --dry-run          # ALWAYS dry-run first
bun $MEMORY compress <uuid> "Summary"
bun $MEMORY merge <uuid1> <uuid2> --delete-originals
bun $MEMORY stats
bun $MEMORY health
```

## Core Model

- **Memories**: `id, content, original_content, embedding, source, profile, tags[], metadata, confidence, access_count, compression_level, is_pinned, importance`
- **Edges**: `source_id → target_id` (`supports|contradicts|expands|related|depends_on|similar`)
- **Profile**: `profile, ttl_days`

## Environment (`AM_` prefix)

`SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (API private key, formerly service_role), `EMBEDDING_PROVIDER` (ollama|openai|cohere|voyage|gemini), `EMBEDDING_MODEL`, `EMBEDDING_DIM` (must match). Provider keys (e.g., `OLLAMA_BASE_URL`, `OPENAI_API_KEY`). Defaults: `SOURCE=agent`, `PROFILE=default`.

## Docs

See `references/`: `operations.md`, `search.md`, `setup.md`, `providers.md`, `toon-format.md`.
