/**
 * core/embeddings.ts — LLM embedding generation for CF Workers
 * Supports: openai | cohere | voyage | gemini (no ollama - can't reach localhost)
 */
import type { Env } from "./env.ts";
import { envEmbeddingDim } from "./env.ts";
import { sanitizeErrorText } from "./utils.ts";

export async function embed(env: Env, text: string): Promise<number[]> {
  const provider = env.EMBEDDING_PROVIDER;
  const model = env.EMBEDDING_MODEL;

  if (!provider || !model) {
    throw new Error("Missing EMBEDDING_PROVIDER or EMBEDDING_MODEL");
  }

  let embedding: number[];

  switch (provider) {
    case "openai": {
      const key = env.OPENAI_API_KEY;
      if (!key) throw new Error("Missing OPENAI_API_KEY");
      const dim = envEmbeddingDim(env);
      const body: Record<string, unknown> = { model, input: text, dimensions: dim };
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`OpenAI embedding failed: ${sanitizeErrorText(await res.text())}`);
      const j = (await res.json()) as { data: { embedding: number[] }[] };
      embedding = j.data[0].embedding;
      break;
    }

    case "cohere": {
      const key = env.COHERE_API_KEY;
      if (!key) throw new Error("Missing COHERE_API_KEY");
      const res = await fetch("https://api.cohere.com/v2/embed", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          texts: [text],
          input_type: "search_document",
          embedding_types: ["float"],
        }),
      });
      if (!res.ok) throw new Error(`Cohere embedding failed: ${sanitizeErrorText(await res.text())}`);
      const j = (await res.json()) as { embeddings: { float: number[][] } };
      embedding = j.embeddings.float[0];
      break;
    }

    case "voyage": {
      const key = env.VOYAGE_API_KEY;
      if (!key) throw new Error("Missing VOYAGE_API_KEY");
      const res = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, input: [text], input_type: "document" }),
      });
      if (!res.ok) throw new Error(`Voyage embedding failed: ${sanitizeErrorText(await res.text())}`);
      const j = (await res.json()) as { data: { embedding: number[] }[] };
      embedding = j.data[0].embedding;
      break;
    }

    case "gemini": {
      const key = env.GEMINI_API_KEY;
      if (!key) throw new Error("Missing GEMINI_API_KEY");
      const dim = envEmbeddingDim(env);
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: `models/${model}`,
            content: { parts: [{ text }] },
            taskType: "RETRIEVAL_DOCUMENT",
            outputDimensionality: dim,
          }),
        }
      );
      if (!res.ok) throw new Error(`Gemini embedding failed: ${sanitizeErrorText(await res.text())}`);
      const j = (await res.json()) as { embedding: { values: number[] } };
      embedding = j.embedding.values;
      break;
    }

    default:
      throw new Error(`Unknown EMBEDDING_PROVIDER: ${provider}. Use: openai|cohere|voyage|gemini`);
  }

  // Validate embedding dimension matches config
  const expectedDim = envEmbeddingDim(env);
  if (embedding!.length !== expectedDim) {
    throw new Error(
      `Embedding dimension mismatch: got ${embedding!.length}, expected ${expectedDim} (EMBEDDING_DIM). Check your model/provider config.`
    );
  }

  return embedding!;
}

export async function embedForQuery(env: Env, text: string): Promise<number[]> {
  const provider = env.EMBEDDING_PROVIDER;
  const model = env.EMBEDDING_MODEL;

  if (!provider || !model) {
    throw new Error("Missing EMBEDDING_PROVIDER or EMBEDDING_MODEL");
  }

  if (provider === "cohere") {
    const key = env.COHERE_API_KEY;
    if (!key) throw new Error("Missing COHERE_API_KEY");
    const res = await fetch("https://api.cohere.com/v2/embed", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        texts: [text],
        input_type: "search_query",
        embedding_types: ["float"],
      }),
    });
    if (!res.ok) throw new Error(`Cohere query embedding failed: ${sanitizeErrorText(await res.text())}`);
    const j = (await res.json()) as { embeddings: { float: number[][] } };
    return j.embeddings.float[0];
  }

  if (provider === "voyage") {
    const key = env.VOYAGE_API_KEY;
    if (!key) throw new Error("Missing VOYAGE_API_KEY");
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, input: [text], input_type: "query" }),
    });
    if (!res.ok) throw new Error(`Voyage query embedding failed: ${sanitizeErrorText(await res.text())}`);
    const j = (await res.json()) as { data: { embedding: number[] }[] };
    return j.data[0].embedding;
  }

  if (provider === "gemini") {
    const key = env.GEMINI_API_KEY;
    if (!key) throw new Error("Missing GEMINI_API_KEY");
    const dim = envEmbeddingDim(env);
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: `models/${model}`,
          content: { parts: [{ text }] },
          taskType: "RETRIEVAL_QUERY",
          outputDimensionality: dim,
        }),
      }
    );
    if (!res.ok) throw new Error(`Gemini query embedding failed: ${sanitizeErrorText(await res.text())}`);
    const j = (await res.json()) as { embedding: { values: number[] } };
    return j.embedding.values;
  }

  // OpenAI doesn't distinguish document vs query
  return embed(env, text);
}
