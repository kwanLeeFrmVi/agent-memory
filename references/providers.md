# Embedding Providers

How to generate embeddings with each supported provider. Set `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, and `EMBEDDING_DIM` to match your choice.

---

## Ollama (local, no API key)

Best for: air-gapped environments, cost-free operation, privacy.

```bash
export EMBEDDING_PROVIDER=ollama
export EMBEDDING_MODEL=mxbai-embed-large   # or nomic-embed-text
export EMBEDDING_DIM=1024
export OLLAMA_BASE_URL=http://localhost:11434  # default
```

### Pull a model first

```bash
ollama pull mxbai-embed-large   # 334M params, strong retrieval quality
ollama pull nomic-embed-text     # 137M params, long context (8K tokens)
```

### Generate embedding

```bash
curl -s "$OLLAMA_BASE_URL/api/embeddings" \
  -d "{\"model\": \"$EMBEDDING_MODEL\", \"prompt\": \"text to embed\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['embedding'])"
```

Response key: `embedding` (array of floats).

---

## OpenAI

Best for: highest quality, production workloads.

```bash
export EMBEDDING_PROVIDER=openai
export EMBEDDING_MODEL=text-embedding-3-small   # or text-embedding-3-large
export EMBEDDING_DIM=1536                        # 3072 for large
export OPENAI_API_KEY=sk-...
```

### Generate embedding

```bash
curl -s https://api.openai.com/v1/embeddings \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"model\": \"$EMBEDDING_MODEL\", \"input\": \"text to embed\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data'][0]['embedding'])"
```

Response path: `data[0].embedding`.

**Dimension reduction**: text-embedding-3 supports truncated dimensions. To use 256 dims from text-embedding-3-small:
```bash
curl ... -d '{"model":"text-embedding-3-small","input":"...","dimensions":256}'
# Set EMBEDDING_DIM=256 accordingly
```

---

## Cohere

Best for: multilingual content, moderate cost.

```bash
export EMBEDDING_PROVIDER=cohere
export EMBEDDING_MODEL=embed-english-v3.0   # or embed-multilingual-v3.0
export EMBEDDING_DIM=1024
export COHERE_API_KEY=...
```

### Generate embedding

```bash
curl -s https://api.cohere.com/v2/embed \
  -H "Authorization: Bearer $COHERE_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$EMBEDDING_MODEL\",
    \"texts\": [\"text to embed\"],
    \"input_type\": \"search_document\",
    \"embedding_types\": [\"float\"]
  }" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['embeddings']['float'][0])"
```

Response path: `embeddings.float[0]`.

`input_type` matters for Cohere:
- `search_document` — when storing memories
- `search_query` — when embedding a search query

---

## Voyage AI

Best for: code and technical content (`voyage-code-2`).

```bash
export EMBEDDING_PROVIDER=voyage
export EMBEDDING_MODEL=voyage-code-2   # or voyage-3 (general)
export EMBEDDING_DIM=1536              # voyage-3 is 1024
export VOYAGE_API_KEY=...
```

### Generate embedding

```bash
curl -s https://api.voyageai.com/v1/embeddings \
  -H "Authorization: Bearer $VOYAGE_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$EMBEDDING_MODEL\",
    \"input\": [\"text to embed\"],
    \"input_type\": \"document\"
  }" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data'][0]['embedding'])"
```

Response path: `data[0].embedding`.

`input_type`: `"document"` for storing, `"query"` for searching.

---

## Google Gemini

Best for: if you're already in the Google ecosystem.

```bash
export EMBEDDING_PROVIDER=gemini
export EMBEDDING_MODEL=gemini-embedding-001   # text-embedding-004 is deprecated
export EMBEDDING_DIM=768
export GEMINI_API_KEY=...
```

### Generate embedding

```bash
curl -s "https://generativelanguage.googleapis.com/v1beta/models/$EMBEDDING_MODEL:embedContent?key=$GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"models/$EMBEDDING_MODEL\",
    \"content\": {\"parts\": [{\"text\": \"text to embed\"}]},
    \"taskType\": \"RETRIEVAL_DOCUMENT\"
  }" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['embedding']['values'])"
```

Response path: `embedding.values`.

`taskType`: `"RETRIEVAL_DOCUMENT"` for storing, `"RETRIEVAL_QUERY"` for searching.

---

## Provider comparison

| Provider | Dim | Context | Cost | Privacy | Notes |
|----------|-----|---------|------|---------|-------|
| Ollama (mxbai) | 1024 | 512 tokens | Free | Local | Good general quality |
| Ollama (nomic) | 1024 | 8K tokens | Free | Local | Best for long memories |
| OpenAI 3-small | 1536 | - | Low | Remote | Most common default |
| OpenAI 3-large | 3072 | - | Medium | Remote | Highest quality |
| Cohere v3 | 1024 | 512 tokens | Low | Remote | Strong multilingual |
| Voyage code-2 | 1536 | 16K tokens | Low | Remote | Best for code retrieval |
| Voyage 3 | 1024 | 32K tokens | Low | Remote | Best long-context |
| Gemini | 768 | - | Low | Remote | Google ecosystem |

**Recommendation for most users**: Start with Ollama `mxbai-embed-large` (free, local, 1024-dim). Switch to `voyage-code-2` if memories are primarily code/technical content and you want maximum retrieval quality.

---

## Switching providers

If you switch embedding providers, all existing embeddings become incompatible (different dimensions and different semantic spaces). You must re-embed everything:

```bash
# 1. Export all memory content
curl "$SUPABASE_URL/rest/v1/memories?select=id,content" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" > all_memories.json

# 2. Update EMBEDDING_PROVIDER, EMBEDDING_MODEL, EMBEDDING_DIM in env

# 3. Re-embed and update each row (use a script in your preferred language)
# For each memory: generate new embedding → PATCH memories?id=eq.<id>

# 4. Update schema dimension if changed (requires table rebuild — see setup.md)
```
