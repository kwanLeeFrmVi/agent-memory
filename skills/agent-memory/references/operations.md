# Memory Operations — Field Reference

All operations go through `memory.ts`. Use the CLI help for specific commands and flags:

```bash
bun ~/.agents/skills/agent-memory/scripts/memory.ts --help
```

## TTL (time-to-live / expiration)

Pass `--ttl <days>` on `store` to set expiration. Expired memories are hidden from search automatically (RPC functions filter `expires_at > now()` or `expires_at is null`). Use `cleanup` to permanently delete expired ones.

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

When compressing, the original text is saved in `original_content` for potential restoration.

## Access counting

`access_count` increments each time a memory is returned by search. High-access memories are likely most valuable. Access bumping happens via a separate `bump_access_count` RPC (VOLATILE) after search returns results.

## Profile partitioning

`profile` separates memories into namespaces (e.g., `"work"`, `"personal"`, `"project-foo"`). All search/list commands accept `--profile` to filter.

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
