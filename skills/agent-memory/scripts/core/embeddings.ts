/**
 * core/embeddings.ts — LLM embedding generation
 * Supports: ollama | openai | cohere | voyage | gemini
 */
import { env, required, envEmbeddingDim } from "./env.ts";
import { fatal } from "./utils.ts";
import { sanitizeErrorText } from "./db.ts";

export async function embed(text: string): Promise<number[]> {
  const provider = required("EMBEDDING_PROVIDER");
  const model = required("EMBEDDING_MODEL");

  let embedding: number[];

  switch (provider) {
    case "ollama": {
      const base = env("OLLAMA_BASE_URL") ?? "http://localhost:11434";
      const res = await fetch(`${base}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: text }),
      });
      if (!res.ok) fatal("Ollama embedding failed", sanitizeErrorText(await res.text()));
      const j = (await res.json()) as { embedding: number[] };
      embedding = j.embedding;
      break;
    }

    case "openai": {
      const key = required("OPENAI_API_KEY");
      const dim = envEmbeddingDim();
      const body: Record<string, unknown> = { model, input: text, dimensions: dim };
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) fatal("OpenAI embedding failed", sanitizeErrorText(await res.text()));
      const j = (await res.json()) as { data: { embedding: number[] }[] };
      embedding = j.data[0].embedding;
      break;
    }

    case "cohere": {
      const key = required("COHERE_API_KEY");
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
      if (!res.ok) fatal("Cohere embedding failed", sanitizeErrorText(await res.text()));
      const j = (await res.json()) as { embeddings: { float: number[][] } };
      embedding = j.embeddings.float[0];
      break;
    }

    case "voyage": {
      const key = required("VOYAGE_API_KEY");
      const res = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, input: [text], input_type: "document" }),
      });
      if (!res.ok) fatal("Voyage embedding failed", sanitizeErrorText(await res.text()));
      const j = (await res.json()) as { data: { embedding: number[] }[] };
      embedding = j.data[0].embedding;
      break;
    }

    case "gemini": {
      const key = required("GEMINI_API_KEY");
      const dim = envEmbeddingDim();
      const body: Record<string, unknown> = {
        model: `models/${model}`,
        content: { parts: [{ text }] },
        taskType: "RETRIEVAL_DOCUMENT",
      };
      if (dim) body.outputDimensionality = dim;
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      if (!res.ok) fatal("Gemini embedding failed", sanitizeErrorText(await res.text()));
      const j = (await res.json()) as { embedding: { values: number[] } };
      embedding = j.embedding.values;
      break;
    }

    default:
      fatal(`Unknown EMBEDDING_PROVIDER: ${provider}. Use: ollama|openai|cohere|voyage|gemini`);
  }

  // Validate embedding dimension matches config
  const expectedDim = envEmbeddingDim();
  if (embedding!.length !== expectedDim) {
    fatal(
      `Embedding dimension mismatch: got ${embedding!.length}, expected ${expectedDim} (AM_EMBEDDING_DIM). Check your model/provider config.`
    );
  }

  return embedding!;
}

export async function embedForQuery(text: string): Promise<number[]> {
  const provider = env("EMBEDDING_PROVIDER") ?? "";
  const model = required("EMBEDDING_MODEL");

  if (provider === "cohere") {
    const key = required("COHERE_API_KEY");
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
    if (!res.ok) fatal("Cohere query embedding failed", sanitizeErrorText(await res.text()));
    const j = (await res.json()) as { embeddings: { float: number[][] } };
    return j.embeddings.float[0];
  }

  if (provider === "voyage") {
    const key = required("VOYAGE_API_KEY");
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, input: [text], input_type: "query" }),
    });
    if (!res.ok) fatal("Voyage query embedding failed", sanitizeErrorText(await res.text()));
    const j = (await res.json()) as { data: { embedding: number[] }[] };
    return j.data[0].embedding;
  }

  if (provider === "gemini") {
    const key = required("GEMINI_API_KEY");
    const dim = envEmbeddingDim();
    const body: Record<string, unknown> = {
      model: `models/${model}`,
      content: { parts: [{ text }] },
      taskType: "RETRIEVAL_QUERY",
    };
    if (dim) body.outputDimensionality = dim;
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) fatal("Gemini query embedding failed", sanitizeErrorText(await res.text()));
    const j = (await res.json()) as { embedding: { values: number[] } };
    return j.embedding.values;
  }

  // Ollama and OpenAI don't distinguish document vs query
  return embed(text);
}
