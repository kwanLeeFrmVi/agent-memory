# Search and Knowledge Graph

Hybrid semantic+keyword search via RRF, tag filtering, and graph traversal.

## Hybrid search (recommended)

Combines vector similarity and full-text keyword search using Reciprocal Rank Fusion. Results that appear in both semantic and keyword results score highest.

```bash
# 1. Embed the query
QUERY="authentication decisions"
QUERY_EMBEDDING=$(curl -s http://localhost:11434/api/embeddings \
  -d "{\"model\":\"$EMBEDDING_MODEL\",\"prompt\":\"$QUERY\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['embedding'])")

# 2. Hybrid search
curl "$SUPABASE_URL/rest/v1/rpc/hybrid_search" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"query_text\": \"$QUERY\",
    \"query_embedding\": $QUERY_EMBEDDING,
    \"match_count\": 10,
    \"match_threshold\": 0.3
  }"
```

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query_text` | text | required | For keyword search |
| `query_embedding` | vector | required | For semantic search |
| `match_count` | int | 10 | Number of results |
| `match_threshold` | float | 0.3 | Minimum cosine similarity (0-1) |
| `rrf_k` | int | 60 | RRF smoothing constant, higher = flatter ranking |
| `profile_filter` | text | null | Restrict to a profile namespace |
| `source_filter` | text | null | Restrict to a specific source agent |
| `tag_filter` | text | null | Restrict to memories containing this tag |
| `min_confidence` | float | 0 | Minimum confidence threshold |

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

## Pure semantic search

When you only have a query vector (no text keywords):

```bash
curl "$SUPABASE_URL/rest/v1/rpc/match_memories" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"query_embedding\": $QUERY_EMBEDDING,
    \"match_threshold\": 0.5,
    \"match_count\": 10
  }"
```

## Filter by tag

Retrieve memories by tag without embedding a query:

```bash
curl "$SUPABASE_URL/rest/v1/rpc/get_memories_by_tag" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tag": "decision", "limit_count": 20, "profile_filter": "work"}'
```

## Filter by source + recency

```bash
# Everything stored by claude-code in last 7 days
curl "$SUPABASE_URL/rest/v1/memories?source=eq.claude-code&created_at=gte.$(date -u -d '-7 days' '+%Y-%m-%d' 2>/dev/null || date -u -v-7d '+%Y-%m-%d')&order=created_at.desc" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY"
```

---

## Knowledge graph

Memories are nodes; edges encode typed relationships between them.

### Storing an edge

```bash
curl "$SUPABASE_URL/rest/v1/memory_edges" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "source_id": "<memory-uuid-A>",
    "target_id": "<memory-uuid-B>",
    "edge_type": "supports",
    "strength": 0.85,
    "properties": {"context": "both discuss JWT auth approach"}
  }'
```

### Edge types

| Type | Meaning | Example |
|------|---------|---------|
| `supports` | A reinforces or validates B | "We use JWT" supports "JWT is stateless" |
| `contradicts` | A conflicts with B | Old decision contradicts new decision |
| `expands` | A adds detail to B | Implementation note expands architecture decision |
| `related` | Thematically connected | Two bugs in the same module |
| `depends_on` | A requires understanding B | Feature depends on auth system |
| `similar` | Conceptually alike | Two similar design patterns |

### Traversing the graph

Find all memories related to a starting memory (BFS, up to `max_depth` hops):

```bash
curl "$SUPABASE_URL/rest/v1/rpc/find_related_memories" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "start_memory_id": "<uuid>",
    "max_depth": 2,
    "min_strength": 0.5
  }'
```

### Result fields for graph traversal

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

Depth 0 = the starting memory itself. Depth 1 = directly connected. The `path` array shows the chain of IDs from start to this node — useful for explaining why a memory was included.

### Auto-linking similar memories

After storing a new memory, find the top-N most similar existing ones and create `similar` edges automatically:

```bash
# Search for similar memories
SIMILAR=$(curl -s "$SUPABASE_URL/rest/v1/rpc/match_memories" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"query_embedding\": $NEW_EMBEDDING, \"match_threshold\": 0.85, \"match_count\": 5}")

# For each result, create a "similar" edge
# (loop in your preferred language or shell)
```

This builds the graph organically as memories accumulate.

### Querying edges directly

```bash
# All outgoing edges from a memory
curl "$SUPABASE_URL/rest/v1/memory_edges?source_id=eq.<uuid>" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY"

# All edges of a specific type
curl "$SUPABASE_URL/rest/v1/memory_edges?edge_type=eq.contradicts" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY"

# Strong edges only
curl "$SUPABASE_URL/rest/v1/memory_edges?strength=gte.0.8" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY"
```

### Deleting an edge

```bash
curl -X DELETE "$SUPABASE_URL/rest/v1/memory_edges?id=eq.<edge-uuid>" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY"
```

---

## Explore knowledge (combined search + graph)

To get the richest context on a topic: hybrid search first, then expand via graph traversal.

```bash
# Step 1: find the top seeds
SEEDS=$(curl -s "$SUPABASE_URL/rest/v1/rpc/hybrid_search" ...)

# Step 2: for each seed, expand via find_related_memories with depth=1
for SEED_ID in $(echo $SEEDS | python3 -c "import sys,json; [print(m['id']) for m in json.load(sys.stdin)]"); do
  curl "$SUPABASE_URL/rest/v1/rpc/find_related_memories" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"start_memory_id\": \"$SEED_ID\", \"max_depth\": 1}"
done
```

This pattern retrieves both the semantically relevant memories and the context that surrounds them — what supports them, what contradicts them, what they depend on.
