# Search and Knowledge Graph — Reference

All search and graph commands go through `memory.ts`. Use the CLI help for specific commands and flags:

```bash
bun ~/.agents/skills/agent-memory/scripts/memory.ts search --help
bun ~/.agents/skills/agent-memory/scripts/memory.ts context --help
bun ~/.agents/skills/agent-memory/scripts/memory.ts related --help
```

## Hybrid search (default)

Combines vector similarity and full-text keyword search using Reciprocal Rank Fusion (RRF). Results appearing in both semantic and keyword results score highest.

### RRF scoring explained

Reciprocal Rank Fusion combines two ranked lists without needing score normalization:

```
RRF_score = 1/(k + semantic_rank) + 1/(k + keyword_rank)
```

Where `k=60` (default). A memory ranked #1 in semantic and #3 in keyword gets:

```
1/(60+1) + 1/(60+3) = 0.01639 + 0.01587 = 0.03226
```

Memories only appearing in one list get a single reciprocal rank score. This naturally balances semantic understanding (meaning) with keyword precision (exact terms).

### Date filtering

Both `search` and `recent` commands support `--after` and `--before` flags to restrict results to a time window. Dates must be ISO 8601 format (`YYYY-MM-DD` or full timestamp). These filters apply before scoring, so they do not affect RRF ranking — only which memories are eligible.

## Pure semantic search (match_memories RPC)

Used internally. Returns results ranked by cosine similarity only. Useful for deduplication and auto-linking.

## Graph traversal

The `related` and `context` commands perform BFS from a starting memory or search result, following edges in both directions.

- Depth 0 = the starting memory itself
- Depth 1 = directly connected
- `path` in results shows the chain of IDs from start to this node — useful for explaining why a memory was included

## Explore knowledge (combined search + graph)

For the richest context on a topic: use the `context` command. It performs a search first to find seed memories, then automatically expands each via `related` traversal. This retrieves both semantically relevant memories and their surrounding context — what supports them, what contradicts them, what they depend on.
