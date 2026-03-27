# Memory Operations

Day-to-day operations: store, retrieve, update, delete, TTL management, and compression.

## Storing a memory

Two steps: (1) generate embedding, (2) insert into Supabase.

```bash
# Step 1: Get embedding from your provider (see providers.md)
EMBEDDING=$(curl -s http://localhost:11434/api/embeddings \
  -d "{\"model\":\"$EMBEDDING_MODEL\",\"prompt\":\"$CONTENT\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['embedding'])")

# Step 2: Insert
curl -s "$SUPABASE_URL/rest/v1/memories" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d "{
    \"content\": \"$CONTENT\",
    \"embedding\": $EMBEDDING,
    \"source\": \"claude-code\",
    \"tags\": [\"decision\", \"auth\"],
    \"metadata\": {
      \"project\": \"my-app\",
      \"confidence\": 0.9
    }
  }"
```

### Metadata fields

| Field | Type | Description |
|-------|------|-------------|
| `content` | text | The memory text (required) |
| `embedding` | vector | Float array from embedding model (required) |
| `source` | text | Which agent/client stored it, e.g. `"claude-code"` |
| `tags` | text[] | Categorization tags for filtering, e.g. `["decision", "auth"]` |
| `metadata` | jsonb | Arbitrary structured data |
| `profile` | text | Partition namespace, e.g. `"work"` or `"personal"` |
| `expires_at` | timestamptz | Auto-expire timestamp (null = never) |
| `confidence` | float | 0-1 score for how reliable this memory is |

## Retrieving a memory by ID

```bash
curl "$SUPABASE_URL/rest/v1/memories?id=eq.<uuid>" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY"
```

## Listing recent memories

```bash
# Most recent 20
curl "$SUPABASE_URL/rest/v1/memories?order=created_at.desc&limit=20" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY"

# Filter by source
curl "$SUPABASE_URL/rest/v1/memories?source=eq.claude-code&order=created_at.desc&limit=20" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY"

# Filter by tag (uses PostgreSQL array contains)
curl "$SUPABASE_URL/rest/v1/rpc/get_memories_by_tag" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tag": "decision", "limit_count": 20}'
```

## Updating a memory

```bash
curl -X PATCH "$SUPABASE_URL/rest/v1/memories?id=eq.<uuid>" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Updated content",
    "metadata": {"updated": true}
  }'
```

When updating content, also regenerate and update the embedding (otherwise search results will be stale):

```bash
# Regenerate embedding for updated content
NEW_EMBEDDING=$(...)  # call your provider
curl -X PATCH "$SUPABASE_URL/rest/v1/memories?id=eq.<uuid>" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"content\": \"...\", \"embedding\": $NEW_EMBEDDING}"
```

## Deleting a memory

```bash
# Delete one
curl -X DELETE "$SUPABASE_URL/rest/v1/memories?id=eq.<uuid>" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY"

# Edges referencing this memory are auto-deleted (ON DELETE CASCADE)
```

## TTL (time-to-live / expiration)

Set `expires_at` when storing to auto-expire:

```bash
# Expires in 7 days
curl "$SUPABASE_URL/rest/v1/memories" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Temporary note",
    "embedding": [...],
    "expires_at": "'$(date -u -d '+7 days' '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -v+7d '+%Y-%m-%dT%H:%M:%SZ')'"
  }'
```

Expired memories are hidden from search automatically (the RPC functions filter `expires_at > now()` or `expires_at is null`). To permanently delete expired ones:

```bash
curl "$SUPABASE_URL/rest/v1/rpc/cleanup_expired_memories" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

## Confidence scores

`confidence` (0-1 float) tracks how reliable a memory is. Use it to:
- Reinforce memories confirmed correct: `{"confidence": 0.95}`
- Downgrade disputed memories: `{"confidence": 0.3}`
- Filter in search by requiring minimum confidence

```bash
# Only return high-confidence memories
curl "$SUPABASE_URL/rest/v1/memories?confidence=gte.0.8&order=confidence.desc" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY"
```

## Compression levels

`compression_level` tracks how much a memory has been summarized over time:
- `0` = full text preserved (default)
- `1` = compressed to key sentences (~30% of original)
- `2` = one-line summary

You can set this manually when storing a summarized version:

```bash
curl -X PATCH "$SUPABASE_URL/rest/v1/memories?id=eq.<uuid>" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content": "One-line summary", "compression_level": 2}'
```

## Access counting

`access_count` increments each time a memory is returned by search RPC functions. High-access memories resist auto-compression. You can query by it:

```bash
# Most-accessed memories (likely most valuable)
curl "$SUPABASE_URL/rest/v1/memories?order=access_count.desc&limit=10" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY"
```

## Profile partitioning

`profile` separates memories into namespaces (e.g., `"work"`, `"personal"`, `"project-foo"`). Pass it as a filter to any search:

```bash
curl "$SUPABASE_URL/rest/v1/memories?profile=eq.work&order=created_at.desc" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY"
```

The hybrid search RPC also accepts a `profile_filter` parameter.

## Linking memories (knowledge graph edges)

After storing two memories, link them:

```bash
curl "$SUPABASE_URL/rest/v1/memory_edges" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "source_id": "<uuid-1>",
    "target_id": "<uuid-2>",
    "edge_type": "supports",
    "strength": 0.8
  }'
```

Valid `edge_type` values: `supports`, `contradicts`, `expands`, `related`, `depends_on`, `similar`

See `search.md` for traversing the graph.
