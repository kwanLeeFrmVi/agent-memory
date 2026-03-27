#!/usr/bin/env bun
/**
 * memory.ts — Agent memory CLI
 *
 * Handles embedding generation + Supabase calls in one step.
 * Designed for LLM use: minimal output, clean JSON, one command per operation.
 *
 * Usage:
 *   bun memory.ts store "text" [--tags t1,t2] [--source s] [--profile p] [--ttl days]
 *   bun memory.ts search "query" [--limit n] [--threshold f] [--profile p] [--tag t] [--source s]
 *   bun memory.ts get <uuid>
 *   bun memory.ts recent [--limit n] [--source s] [--profile p]
 *   bun memory.ts tag <tag> [--limit n] [--profile p]
 *   bun memory.ts update <uuid> [--content "text"] [--confidence f] [--tags t1,t2] [--metadata '{}']
 *   bun memory.ts delete <uuid>
 *   bun memory.ts link <uuid-a> <uuid-b> [--type supports] [--strength f]
 *   bun memory.ts unlink <uuid-a> <uuid-b> [--type supports]
 *   bun memory.ts related <uuid> [--depth n] [--min-strength f]
 *   bun memory.ts cleanup
 *   bun memory.ts stats
 *
 * Required env vars:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   EMBEDDING_PROVIDER (ollama|openai|cohere|voyage|gemini)
 *   EMBEDDING_MODEL, EMBEDDING_DIM
 *   + provider key (OPENAI_API_KEY etc.)
 */

// ── Env ──────────────────────────────────────────────────────────────────────

async function loadEnv() {
  // Bun auto-loads .env; also try .env.local for overrides
  const paths = [".env.local", ".env"];
  for (const p of paths) {
    const f = Bun.file(p);
    if (await f.exists()) {
      const text = await f.text();
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
}

function required(key: string): string {
  const v = process.env[key];
  if (!v) fatal(`Missing env var: ${key}`);
  return v!;
}

// ── Output ───────────────────────────────────────────────────────────────────

function out(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

function fatal(msg: string, detail?: unknown): never {
  const err: Record<string, unknown> = { error: msg };
  if (detail) err.detail = detail;
  console.error(JSON.stringify(err, null, 2));
  process.exit(1);
}

// ── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let i = 0;
  while (i < argv.length) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(argv[i]);
    }
    i++;
  }
  return { positional, flags };
}

function flag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

// ── Supabase ──────────────────────────────────────────────────────────────────

async function supa(
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>
): Promise<unknown> {
  const base = required("SUPABASE_URL");
  const key = required("SUPABASE_SERVICE_KEY");

  let url = `${base}${path}`;
  if (query && Object.keys(query).length > 0) {
    url += "?" + new URLSearchParams(query).toString();
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    fatal(`Supabase ${method} ${path} → ${res.status}`, text);
  }
  return text ? JSON.parse(text) : null;
}

async function rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
  return supa("POST", `/rest/v1/rpc/${fn}`, args);
}

// ── Embeddings ────────────────────────────────────────────────────────────────

async function embed(text: string): Promise<number[]> {
  const provider = required("EMBEDDING_PROVIDER");
  const model = required("EMBEDDING_MODEL");

  switch (provider) {
    case "ollama": {
      const base = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
      const res = await fetch(`${base}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: text }),
      });
      if (!res.ok) fatal("Ollama embedding failed", await res.text());
      const j = (await res.json()) as { embedding: number[] };
      return j.embedding;
    }

    case "openai": {
      const key = required("OPENAI_API_KEY");
      const dim = process.env.EMBEDDING_DIM ? parseInt(process.env.EMBEDDING_DIM) : undefined;
      const body: Record<string, unknown> = { model, input: text };
      if (dim) body.dimensions = dim;
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) fatal("OpenAI embedding failed", await res.text());
      const j = (await res.json()) as { data: { embedding: number[] }[] };
      return j.data[0].embedding;
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
      if (!res.ok) fatal("Cohere embedding failed", await res.text());
      const j = (await res.json()) as { embeddings: { float: number[][] } };
      return j.embeddings.float[0];
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
      if (!res.ok) fatal("Voyage embedding failed", await res.text());
      const j = (await res.json()) as { data: { embedding: number[] }[] };
      return j.data[0].embedding;
    }

    case "gemini": {
      const key = required("GEMINI_API_KEY");
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: `models/${model}`,
            content: { parts: [{ text }] },
            taskType: "RETRIEVAL_DOCUMENT",
          }),
        }
      );
      if (!res.ok) fatal("Gemini embedding failed", await res.text());
      const j = (await res.json()) as { embedding: { values: number[] } };
      return j.embedding.values;
    }

    default:
      fatal(`Unknown EMBEDDING_PROVIDER: ${provider}. Use: ollama|openai|cohere|voyage|gemini`);
  }
}

async function embedForQuery(text: string): Promise<number[]> {
  // Same as embed() but uses query-optimised input_type for providers that distinguish
  const provider = process.env.EMBEDDING_PROVIDER ?? "";
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
    if (!res.ok) fatal("Cohere query embedding failed", await res.text());
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
    if (!res.ok) fatal("Voyage query embedding failed", await res.text());
    const j = (await res.json()) as { data: { embedding: number[] }[] };
    return j.data[0].embedding;
  }

  if (provider === "gemini") {
    const key = required("GEMINI_API_KEY");
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: `models/${model}`,
          content: { parts: [{ text }] },
          taskType: "RETRIEVAL_QUERY",
        }),
      }
    );
    if (!res.ok) fatal("Gemini query embedding failed", await res.text());
    const j = (await res.json()) as { embedding: { values: number[] } };
    return j.embedding.values;
  }

  // Ollama and OpenAI don't distinguish document vs query
  return embed(text);
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdStore(positional: string[], flags: Record<string, string | boolean>) {
  const content = positional[0];
  if (!content) fatal("Usage: store <content> [--tags t1,t2] [--source s] [--profile p] [--ttl days]");

  const tagsRaw = flag(flags, "tags");
  const source = flag(flags, "source") ?? process.env.MEMORY_SOURCE ?? "agent";
  const profile = flag(flags, "profile") ?? process.env.MEMORY_PROFILE ?? "default";
  const ttlDays = flag(flags, "ttl");
  const metaRaw = flag(flags, "metadata");

  const embedding = await embed(content);

  const row: Record<string, unknown> = {
    content,
    embedding,
    source,
    profile,
    tags: tagsRaw ? tagsRaw.split(",").map((t) => t.trim()) : [],
    metadata: metaRaw ? JSON.parse(metaRaw) : {},
  };

  if (ttlDays) {
    const exp = new Date();
    exp.setDate(exp.getDate() + parseInt(ttlDays));
    row.expires_at = exp.toISOString();
  }

  const result = await supa("POST", "/rest/v1/memories", row) as unknown[];
  const saved = Array.isArray(result) ? result[0] : result;
  // Return only the essentials — embedding is huge and useless to the LLM
  const { embedding: _e, search_vector: _s, ...clean } = saved as Record<string, unknown>;
  out(clean);
}

async function cmdSearch(positional: string[], flags: Record<string, string | boolean>) {
  const query = positional[0];
  if (!query) fatal("Usage: search <query> [--limit n] [--threshold f] [--profile p] [--tag t] [--source s]");

  const limit = parseInt(flag(flags, "limit") ?? "10");
  const threshold = parseFloat(flag(flags, "threshold") ?? "0.3");
  const profile = flag(flags, "profile") ?? undefined;
  const tag = flag(flags, "tag") ?? undefined;
  const source = flag(flags, "source") ?? undefined;

  const queryEmbedding = await embedForQuery(query);

  const results = await rpc("hybrid_search", {
    query_text: query,
    query_embedding: queryEmbedding,
    match_count: limit,
    match_threshold: threshold,
    ...(profile && { profile_filter: profile }),
    ...(source && { source_filter: source }),
    ...(tag && { tag_filter: tag }),
  });

  out(results);
}

async function cmdGet(positional: string[]) {
  const id = positional[0];
  if (!id) fatal("Usage: get <uuid>");

  const result = await supa("GET", "/rest/v1/memories", undefined, { id: `eq.${id}` }) as unknown[];
  if (!Array.isArray(result) || result.length === 0) fatal("Memory not found", { id });
  const { embedding: _e, search_vector: _s, ...clean } = result[0] as Record<string, unknown>;
  out(clean);
}

async function cmdRecent(flags: Record<string, string | boolean>) {
  const limit = flag(flags, "limit") ?? "20";
  const source = flag(flags, "source");
  const profile = flag(flags, "profile");

  const q: Record<string, string> = {
    order: "created_at.desc",
    limit,
    select: "id,content,source,profile,tags,metadata,confidence,access_count,created_at,expires_at",
  };
  if (source) q.source = `eq.${source}`;
  if (profile) q.profile = `eq.${profile}`;

  const results = await supa("GET", "/rest/v1/memories", undefined, q);
  out(results);
}

async function cmdTag(positional: string[], flags: Record<string, string | boolean>) {
  const tag = positional[0];
  if (!tag) fatal("Usage: tag <tag> [--limit n] [--profile p]");

  const result = await rpc("get_memories_by_tag", {
    tag,
    limit_count: parseInt(flag(flags, "limit") ?? "20"),
    ...(flag(flags, "profile") && { profile_filter: flag(flags, "profile") }),
  });
  out(result);
}

async function cmdUpdate(positional: string[], flags: Record<string, string | boolean>) {
  const id = positional[0];
  if (!id) fatal("Usage: update <uuid> [--content text] [--confidence f] [--tags t1,t2] [--metadata '{}']");

  const patch: Record<string, unknown> = {};

  const content = flag(flags, "content");
  if (content) {
    patch.content = content;
    patch.embedding = await embed(content); // re-embed when content changes
  }

  const confidence = flag(flags, "confidence");
  if (confidence) patch.confidence = parseFloat(confidence);

  const tagsRaw = flag(flags, "tags");
  if (tagsRaw) patch.tags = tagsRaw.split(",").map((t) => t.trim());

  const metaRaw = flag(flags, "metadata");
  if (metaRaw) patch.metadata = JSON.parse(metaRaw);

  if (Object.keys(patch).length === 0) fatal("Provide at least one of: --content, --confidence, --tags, --metadata");

  const result = await supa("PATCH", "/rest/v1/memories", patch, { id: `eq.${id}` }) as unknown[];
  const updated = Array.isArray(result) ? result[0] : result;
  const { embedding: _e, search_vector: _s, ...clean } = (updated ?? { id }) as Record<string, unknown>;
  out(clean);
}

async function cmdDelete(positional: string[]) {
  const id = positional[0];
  if (!id) fatal("Usage: delete <uuid>");

  await supa("DELETE", "/rest/v1/memories", undefined, { id: `eq.${id}` });
  out({ deleted: id });
}

async function cmdLink(positional: string[], flags: Record<string, string | boolean>) {
  const [a, b] = positional;
  if (!a || !b) fatal("Usage: link <uuid-a> <uuid-b> [--type supports] [--strength 0.8]");

  const edgeType = flag(flags, "type") ?? "related";
  const strength = parseFloat(flag(flags, "strength") ?? "0.7");

  const valid = ["supports", "contradicts", "expands", "related", "depends_on", "similar"];
  if (!valid.includes(edgeType)) fatal(`--type must be one of: ${valid.join(", ")}`);

  const result = await supa("POST", "/rest/v1/memory_edges", {
    source_id: a,
    target_id: b,
    edge_type: edgeType,
    strength,
  });
  const edge = Array.isArray(result) ? result[0] : result;
  out(edge);
}

async function cmdUnlink(positional: string[], flags: Record<string, string | boolean>) {
  const [a, b] = positional;
  if (!a || !b) fatal("Usage: unlink <uuid-a> <uuid-b> [--type <edge-type>]");

  const q: Record<string, string> = {
    source_id: `eq.${a}`,
    target_id: `eq.${b}`,
  };
  const edgeType = flag(flags, "type");
  if (edgeType) q.edge_type = `eq.${edgeType}`;

  await supa("DELETE", "/rest/v1/memory_edges", undefined, q);
  out({ unlinked: { source: a, target: b, ...(edgeType && { type: edgeType }) } });
}

async function cmdRelated(positional: string[], flags: Record<string, string | boolean>) {
  const id = positional[0];
  if (!id) fatal("Usage: related <uuid> [--depth n] [--min-strength f]");

  const result = await rpc("find_related_memories", {
    start_memory_id: id,
    max_depth: parseInt(flag(flags, "depth") ?? "2"),
    min_strength: parseFloat(flag(flags, "min-strength") ?? "0.5"),
  });
  out(result);
}

async function cmdCleanup() {
  const result = await rpc("cleanup_expired_memories", {});
  out({ deleted_expired: result });
}

async function cmdStats() {
  const [total, bySource, byProfile] = await Promise.all([
    supa("GET", "/rest/v1/memories", undefined, {
      select: "count",
      head: "true",
    }).catch(() => null),
    supa("GET", "/rest/v1/memories", undefined, {
      select: "source",
      // PostgREST group-by via URL isn't straightforward; fetch distinct sources
    }).catch(() => null),
    supa("GET", "/rest/v1/memories", undefined, {
      select: "id,source,profile,confidence,compression_level,expires_at",
      limit: "1000",
      order: "created_at.desc",
    }),
  ]);

  const rows = Array.isArray(byProfile) ? (byProfile as Record<string, unknown>[]) : [];
  const sources: Record<string, number> = {};
  const profiles: Record<string, number> = {};
  let expiring = 0;
  const now = Date.now();

  for (const r of rows) {
    const s = (r.source as string) ?? "unknown";
    const p = (r.profile as string) ?? "default";
    sources[s] = (sources[s] ?? 0) + 1;
    profiles[p] = (profiles[p] ?? 0) + 1;
    if (r.expires_at && new Date(r.expires_at as string).getTime() - now < 7 * 86400_000) expiring++;
  }

  out({
    total_memories: rows.length,
    by_source: sources,
    by_profile: profiles,
    expiring_in_7d: expiring,
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

await loadEnv();

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log(`usage: bun memory.ts <command> [args]

commands:
  store   <content> [--tags t1,t2] [--source s] [--profile p] [--ttl days]
  search  <query>   [--limit n] [--threshold f] [--profile p] [--tag t] [--source s]
  get     <uuid>
  recent  [--limit n] [--source s] [--profile p]
  tag     <tag>     [--limit n] [--profile p]
  update  <uuid>    [--content text] [--confidence f] [--tags t1,t2] [--metadata '{}']
  delete  <uuid>
  link    <uuid-a> <uuid-b> [--type supports|contradicts|expands|related|depends_on|similar] [--strength f]
  unlink  <uuid-a> <uuid-b> [--type edge-type]
  related <uuid>    [--depth n] [--min-strength f]
  cleanup
  stats`);
  process.exit(0);
}

const { positional, flags } = parseArgs(args);
const cmd = positional[0];
const rest = positional.slice(1);

switch (cmd) {
  case "store":   await cmdStore(rest, flags); break;
  case "search":  await cmdSearch(rest, flags); break;
  case "get":     await cmdGet(rest); break;
  case "recent":  await cmdRecent(flags); break;
  case "tag":     await cmdTag(rest, flags); break;
  case "update":  await cmdUpdate(rest, flags); break;
  case "delete":  await cmdDelete(rest); break;
  case "link":    await cmdLink(rest, flags); break;
  case "unlink":  await cmdUnlink(rest, flags); break;
  case "related": await cmdRelated(rest, flags); break;
  case "cleanup": await cmdCleanup(); break;
  case "stats":   await cmdStats(); break;
  default:        fatal(`Unknown command: ${cmd}`);
}
