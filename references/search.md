# Search and Knowledge Graph — Reference

## Hybrid search (default)

Combines vector similarity and full-text keyword search using Reciprocal Rank Fusion (RRF). Results appearing in both semantic and keyword results score highest.

### Parameters

| Parameter         | CLI flag           | Default  | Description                                                                 |
| ----------------- | ------------------ | -------- | --------------------------------------------------------------------------- |
| `query_text`      | positional         | required | For keyword search                                                          |
| `query_embedding` | auto-generated     | required | For semantic search                                                         |
| `match_count`     | `--limit`          | 10       | Number of results                                                           |
| `match_threshold` | `--threshold`      | 0.3      | Minimum cosine similarity (0-1)                                             |
| `rrf_k`           | —                  | 60       | RRF smoothing constant; higher = flatter ranking                            |
| `profile_filter`  | `--profile`        | null     | Restrict to a profile namespace                                             |
| `source_filter`   | `--source`         | null     | Restrict to a specific source agent                                         |
| `tag_filter`      | `--tag`            | null     | Restrict to memories containing this tag                                    |
| `min_confidence`  | `--min-confidence` | 0        | Minimum confidence threshold                                                |
| `after_date`      | `--after`          | null     | Only return memories created after this date (ISO 8601, e.g. `2025-01-01`)  |
| `before_date`     | `--before`         | null     | Only return memories created before this date (ISO 8601, e.g. `2025-06-01`) |

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

### Result fields

```json
{
  "id": "uuid",
  "content": "memory text",
  "rrf_score": 0.0312,
  "semantic_rank": 1,
  "keyword_rank": 3,
  "metadata": {},
  "tags": ["decision"],
  "source": "claude-code",
  "confidence": 0.9,
  "created_at": "2025-..."
}
```

## Pure semantic search (match_memories RPC)

Used internally. Returns results ranked by cosine similarity only. Same parameters except no `query_text`.

## Graph traversal

`find_related_memories` performs BFS from a starting memory, following edges in both directions:

| Parameter         | CLI flag         | Default  | Description                     |
| ----------------- | ---------------- | -------- | ------------------------------- |
| `start_memory_id` | positional       | required | Starting node UUID              |
| `max_depth`       | `--depth`        | 2        | Maximum hops to traverse        |
| `min_strength`    | `--min-strength` | 0.5      | Minimum edge strength to follow |

### Result fields

```json
{
  "memory_id": "uuid",
  "content": "...",
  "depth": 1,
  "edge_type": "supports",
  "strength": 0.85,
  "path": ["start-uuid", "this-uuid"]
}
```

- Depth 0 = the starting memory itself
- Depth 1 = directly connected
- `path` shows the chain of IDs from start to this node — useful for explaining why a memory was included

## Date filtering

Both `search` and `recent` support `--after` and `--before` to restrict results to a time window. Dates must be ISO 8601 format (`YYYY-MM-DD` or full timestamp). These filters apply before scoring, so they do not affect RRF ranking — only which memories are eligible.

```bash
# Memories about auth from this year only
bun $MEMORY search "auth" --after 2025-01-01

# Recent memories in a date window
bun $MEMORY recent --after 2025-03-01 --before 2025-04-01
```

## Explore knowledge (combined search + graph)

For the richest context on a topic: search first to find seed memories, then expand each via `related` with depth=1. This retrieves both semantically relevant memories and their surrounding context — what supports them, what contradicts them, what they depend on.
