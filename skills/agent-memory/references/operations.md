# Memory Operations — Field Reference

All operations go through `memory.ts`. Use the CLI help for specific commands and flags:

```bash
bun ~/.agents/skills/agent-memory/scripts/memory.ts --help
```

## TTL (time-to-live / expiration)

Pass `--ttl <days>` on `store` to set expiration. Expired memories are hidden from search automatically (RPC functions filter `expires_at > now()` or `expires_at is null`). Use `cleanup` to permanently delete expired ones.

**Profile-level TTL default**: Use `set-profile-ttl` so all future `store` calls in a profile inherit a TTL without needing to pass `--ttl` each time:

```bash
bun memory.ts set-profile-ttl --profile work --days 30
bun memory.ts set-profile-ttl --profile work --days 0   # clear the default
```

The `store` command checks `profile_settings` for a default TTL if `--ttl` is not explicitly passed.

## Confidence scores

`confidence` (0-1 float) tracks how reliable a memory is:

- Reinforce memories confirmed correct: `update <uuid> --confidence 0.95`
- Downgrade disputed memories: `update <uuid> --confidence 0.3`
- Filter in search: `search "query" --min-confidence 0.8`

## Compression levels

`compression_level` tracks summarization state:

- `0` = full text preserved (default)
- `1` = compressed to key sentences (~30% of original)
- `2` = one-line summary

When compressing, the original text is saved in `original_content` for potential restoration. Use `revert <uuid>` to undo compression and re-embed the original content.

## Access counting

`access_count` increments each time a memory is returned by search. High-access memories are likely most valuable. Access bumping happens via a separate `bump_access_count` RPC (VOLATILE) after search returns results. The `stats` command surfaces `top_accessed` (top 5 by access count).

## is_pinned

`is_pinned` (boolean, default `false`) marks a memory as permanently important. Use `--pin` on `store` to set it. Pinned memories can be filtered with `--pinned` on `search` and `recent`. The `stats` command includes `pinned_count`.

```bash
bun memory.ts store "Critical production secret" --pin
bun memory.ts search "production" --pinned
bun memory.ts recent --pinned --limit 5
```

## importance

`importance` (0-1 float, default `0.5`) signals how significant a memory is for prioritization. Use `--importance` on `store`. Filter with `--min-importance` on `search` and `recent`.

```bash
bun memory.ts store "Core architecture decision" --importance 0.9
bun memory.ts search "architecture" --min-importance 0.7
```

## Profile partitioning

`profile` separates memories into namespaces (e.g., `"work"`, `"personal"`, `"project-foo"`). All search/list commands accept `--profile` to filter.

## profile_settings table

Stores per-profile defaults. Currently supports `ttl_days`. Created by the schema additions in `schema.sql`.

| Column     | Type        | Description                        |
|------------|-------------|------------------------------------|
| `profile`  | text (PK)   | Profile name                       |
| `ttl_days` | int or null | Default TTL in days; null = no TTL |

## Edge types

| Type          | Meaning                     | Example                                           |
| ------------- | --------------------------- | ------------------------------------------------- |
| `supports`    | A reinforces or validates B | "We use JWT" supports "JWT is stateless"          |
| `contradicts` | A conflicts with B          | Old decision contradicts new decision             |
| `expands`     | A adds detail to B          | Implementation note expands architecture decision |
| `related`     | Thematically connected      | Two bugs in the same module                       |
| `depends_on`  | A requires understanding B  | Feature depends on auth system                    |
| `similar`     | Conceptually alike          | Two similar design patterns                       |

Edge `strength` ranges 0-1. Graph traversal respects `--min-strength` to filter weak edges.

## New commands reference

### store-decision

Structured capture of architectural decisions. Always prefer this over plain `store` for `type:decision` content.

```bash
bun memory.ts store-decision \
  --decision "Use JWT for auth" \
  --rationale "Stateless, no session store needed" \
  --alternatives "sessions,oauth" \
  --reasoning-trace "Evaluated 3 options..." \
  --tags project:myapp \
  --related <uuid>
```

Stores `decision`, `rationale`, `alternatives[]`, `reasoning_trace` in `metadata`. Runs dedup at 0.9 threshold. Creates `supports` edges to `--related` UUIDs.

### link-unlinked

Scan orphan memories (no outgoing edges) and create `similar` edges to nearest neighbors.

```bash
bun memory.ts link-unlinked --threshold 0.85 --dry-run
bun memory.ts link-unlinked --threshold 0.85 --batch-size 100 --profile work
```

Returns `{ processed, linked, skipped, errors }`. Run after `re-embed`.

### set-profile-ttl

```bash
bun memory.ts set-profile-ttl --profile work --days 30
bun memory.ts set-profile-ttl --profile work --days 0   # clear
```

### revert

Restore original content from a compressed memory. Fails if `original_content` is null.

```bash
bun memory.ts revert <uuid>
```

### impact

Read-only. Show what depends on a memory before deleting it.

```bash
bun memory.ts impact <uuid>
# Returns: { id, incoming_edges: N, memories: [...sources] }
```

### rename-tag

```bash
bun memory.ts rename-tag bug type:gotcha --profile work --dry-run
bun memory.ts rename-tag bug type:gotcha --profile work
# Returns: { renamed: N, profile, old_tag, new_tag }
```

### search --graph-depth

Inline graph traversal on search results. `context` is a convenience alias over `search --graph-depth 2`.

```bash
bun memory.ts search "auth flow" --graph-depth 1
# Returns: { query, memories: [...], related: [...] }
```

## Extended stats fields

`stats` now returns additional fields:

| Field                | Description                               |
|----------------------|-------------------------------------------|
| `edge_count_by_type` | Count of edges per type (supports, etc.)  |
| `orphan_count`       | Memories with no edges at all             |
| `top_accessed`       | Top 5 memories by `access_count`          |
| `pinned_count`       | Count of `is_pinned = true` memories      |
| `avg_confidence`     | Average confidence score across profile   |
