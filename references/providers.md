# Embedding Providers

Configure your embedding provider with `AM_EMBEDDING_PROVIDER`, `AM_EMBEDDING_MODEL`, and `AM_EMBEDDING_DIM`. All env vars fall back to unprefixed names if the `AM_` version isn't set. All embedding operations are handled by `memory.ts`.

---

## Ollama (local, no API key)

Best for: air-gapped environments, cost-free operation, privacy.

```bash
export AM_EMBEDDING_PROVIDER=ollama
export AM_EMBEDDING_MODEL=mxbai-embed-large   # or nomic-embed-text
export AM_EMBEDDING_DIM=1024
export AM_OLLAMA_BASE_URL=http://localhost:11434  # default
```

### Pull a model first

```bash
ollama pull mxbai-embed-large   # 334M params, strong retrieval quality
ollama pull nomic-embed-text     # 137M params, long context (8K tokens)
```

API endpoint: `POST /api/embeddings` — response key: `embedding`.

**Batch limits**: Single text per request. No batch API.

---

## OpenAI

Best for: highest quality, production workloads.

```bash
export AM_EMBEDDING_PROVIDER=openai
export AM_EMBEDDING_MODEL=text-embedding-3-small   # or text-embedding-3-large
export AM_EMBEDDING_DIM=1536                        # 3072 for large
export AM_OPENAI_API_KEY=sk-...
```

**Dimension reduction**: text-embedding-3 supports truncated dimensions. Set `AM_EMBEDDING_DIM=256` to use 256 dims from text-embedding-3-small.

**Batch limits**: Up to 2048 texts per request. Rate limits vary by tier (TPM-based).

---

## Cohere

Best for: multilingual content, moderate cost.

```bash
export AM_EMBEDDING_PROVIDER=cohere
export AM_EMBEDDING_MODEL=embed-english-v3.0   # or embed-multilingual-v3.0
export AM_EMBEDDING_DIM=1024
export AM_COHERE_API_KEY=...
```

`input_type` matters for Cohere — `memory.ts` automatically uses `search_document` for storing and `search_query` for searching.

**Batch limits**: Up to 96 texts per request. Rate limit: 10,000 calls/min (production key).

---

## Voyage AI

Best for: code and technical content (`voyage-code-2`).

```bash
export AM_EMBEDDING_PROVIDER=voyage
export AM_EMBEDDING_MODEL=voyage-code-2   # or voyage-3 (general)
export AM_EMBEDDING_DIM=1536              # voyage-3 is 1024
export AM_VOYAGE_API_KEY=...
```

`input_type`: `memory.ts` uses `"document"` for storing, `"query"` for searching.

**Batch limits**: Up to 128 texts per request. Rate limit: 300 RPM / 1M TPM.

---

## Google Gemini

Best for: if you're already in the Google ecosystem.

```bash
export AM_EMBEDDING_PROVIDER=gemini
export AM_EMBEDDING_MODEL=gemini-embedding-001   # text-embedding-004 is deprecated
export AM_EMBEDDING_DIM=768
export AM_GEMINI_API_KEY=...
```

`taskType`: `memory.ts` uses `"RETRIEVAL_DOCUMENT"` for storing, `"RETRIEVAL_QUERY"` for searching.

**Batch limits**: Up to 100 texts per request. Rate limit: 1500 RPM.

---

## Provider comparison

| Provider | Dim | Context | Cost | Privacy | Batch limit | Notes |
|----------|-----|---------|------|---------|-------------|-------|
| Ollama (mxbai) | 1024 | 512 tokens | Free | Local | 1 | Good general quality |
| Ollama (nomic) | 1024 | 8K tokens | Free | Local | 1 | Best for long memories |
| OpenAI 3-small | 1536 | - | Low | Remote | 2048 | Most common default |
| OpenAI 3-large | 3072 | - | Medium | Remote | 2048 | Highest quality |
| Cohere v3 | 1024 | 512 tokens | Low | Remote | 96 | Strong multilingual |
| Voyage code-2 | 1536 | 16K tokens | Low | Remote | 128 | Best for code retrieval |
| Voyage 3 | 1024 | 32K tokens | Low | Remote | 128 | Best long-context |
| Gemini | 768 | - | Low | Remote | 100 | Google ecosystem |

**Recommendation**: Start with Ollama `mxbai-embed-large` (free, local, 1024-dim). Switch to `voyage-code-2` if memories are primarily code/technical content and you want maximum retrieval quality.

---

## Switching providers

If you switch embedding providers, existing embeddings become incompatible (different dimensions and semantic spaces). Use the `re-embed` command:

```bash
# 1. Update env vars to new provider
# 2. Re-embed all memories
bun memory.ts re-embed --batch-size 50

# 3. If dimension changed, update schema.sql and recreate the table
```

The `embedding_model` column tracks which model generated each vector, so you can identify stale embeddings after a switch.
