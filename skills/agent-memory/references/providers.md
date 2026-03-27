# Embedding Providers

Configure your embedding provider with `AM_EMBEDDING_PROVIDER`, `AM_EMBEDDING_MODEL`, and `AM_EMBEDDING_DIM`. All env vars fall back to unprefixed names if the `AM_` version isn't set. All embedding operations are handled by `memory.ts`.

---

## Ollama (local, no API key)

Best for: air-gapped environments, cost-free operation, privacy.

```bash
export AM_EMBEDDING_PROVIDER=ollama
export AM_EMBEDDING_MODEL=mxbai-embed-large   # or nomic-embed-text
export AM_EMBEDDING_DIM=768
export AM_OLLAMA_BASE_URL=http://localhost:11434  # default
```

### Pull a model first

```bash
ollama pull mxbai-embed-large   # 334M params, strong retrieval quality
ollama pull nomic-embed-text     # 137M params, long context (8K tokens)
```

---

## OpenAI

Best for: highest quality, production workloads.

```bash
export AM_EMBEDDING_PROVIDER=openai
export AM_EMBEDDING_MODEL=text-embedding-3-small   # or text-embedding-3-large
export AM_EMBEDDING_DIM=1536                        # 3072 for large
export AM_OPENAI_API_KEY=sk-...
```

---

## Cohere

Best for: multilingual content, moderate cost.

```bash
export AM_EMBEDDING_PROVIDER=cohere
export AM_EMBEDDING_MODEL=embed-english-v3.0   # or embed-multilingual-v3.0
export AM_EMBEDDING_DIM=768
export AM_COHERE_API_KEY=...
```

---

## Voyage AI

Best for: code and technical content (`voyage-code-2`).

```bash
export AM_EMBEDDING_PROVIDER=voyage
export AM_EMBEDDING_MODEL=voyage-code-2   # or voyage-3 (general)
export AM_EMBEDDING_DIM=1536              # voyage-3 is 1024
export AM_VOYAGE_API_KEY=...
```

---

## Google Gemini

Best for: if you're already in the Google ecosystem.

```bash
export AM_EMBEDDING_PROVIDER=gemini
export AM_EMBEDDING_MODEL=gemini-embedding-001
export AM_EMBEDDING_DIM=768
export AM_GEMINI_API_KEY=...
```

---

## Provider comparison

| Provider       | Dim  | Context    | Cost   | Privacy | Notes                   |
| -------------- | ---- | ---------- | ------ | ------- | ----------------------- |
| Ollama (mxbai) | 768  | 512 tokens | Free   | Local   | Good general quality    |
| Ollama (nomic) | 768  | 8K tokens  | Free   | Local   | Best for long memories  |
| OpenAI 3-small | 1536 | -          | Low    | Remote  | Most common default     |
| OpenAI 3-large | 3072 | -          | Medium | Remote  | Highest quality         |
| Cohere v3      | 1024 | 512 tokens | Low    | Remote  | Strong multilingual     |
| Voyage code-2  | 1536 | 16K tokens | Low    | Remote  | Best for code retrieval |
| Voyage 3       | 1024 | 32K tokens | Low    | Remote  | Best long-context       |
| Gemini         | 768  | -          | Low    | Remote  | Google ecosystem        |

**Recommendation**: Start with Ollama `mxbai-embed-large` (free, local, 768-dim). Switch to `voyage-code-2` if memories are primarily code/technical content and you want maximum retrieval quality.

---

## Switching providers

If you switch embedding providers, existing embeddings become incompatible (different dimensions and semantic spaces). Use the `re-embed` command:

```bash
# 1. Update env vars to new provider
# 2. Check how to re-embed all memories
bun memory.ts re-embed --help

# 3. If dimension changed, update schema.sql and recreate the table
```

The `embedding_model` column tracks which model generated each vector, so you can identify stale embeddings after a switch.
