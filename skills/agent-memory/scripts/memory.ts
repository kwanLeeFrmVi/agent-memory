#!/usr/bin/env bun
/**
 * memory.ts — Agent memory CLI
 *
 * Handles embedding generation + Supabase calls in one step.
 * Designed for LLM use: minimal output, clean JSON, one command per operation.
 *
 * Usage:
 *   bun memory.ts store "text" [--tags t1,t2] [--source s] [--profile p] [--ttl days] [--metadata '{}']
 *   bun memory.ts search "query" [--limit n] [--threshold f] [--profile p] [--tag t] [--source s] [--min-confidence f]
 *   bun memory.ts get <uuid>
 *   bun memory.ts recent [--limit n] [--source s] [--profile p]
 *   bun memory.ts tag <tag> [--limit n] [--profile p]
 *   bun memory.ts update <uuid> [--content "text"] [--confidence f] [--tags t1,t2] [--metadata '{}']
 *   bun memory.ts delete <uuid>
 *   bun memory.ts link <uuid-a> <uuid-b> [--type supports] [--strength f]
 *   bun memory.ts unlink <uuid-a> <uuid-b> [--type supports]
 *   bun memory.ts related <uuid> [--depth n] [--min-strength f]
 *   bun memory.ts cleanup
 *   bun memory.ts stats [--profile p]
 *   bun memory.ts health
 *   bun memory.ts profiles
 *   bun memory.ts export [--profile p] [--output file.json]
 *   bun memory.ts import <file.json> [--re-embed]
 *   bun memory.ts re-embed [--profile p] [--batch-size n]
 *
 * Env vars (AM_ prefix takes priority, falls back to unprefixed):
 *   AM_SUPABASE_URL / SUPABASE_URL
 *   AM_SUPABASE_SERVICE_KEY / SUPABASE_SERVICE_KEY. (sb_secret_xxx)
 *   AM_EMBEDDING_PROVIDER / EMBEDDING_PROVIDER  (ollama|openai|cohere|voyage|gemini)
 *   AM_EMBEDDING_MODEL / EMBEDDING_MODEL
 *   AM_EMBEDDING_DIM / EMBEDDING_DIM            (default: 1024)
 *   AM_OPENAI_API_KEY / OPENAI_API_KEY           (if using OpenAI)
 *   AM_COHERE_API_KEY / COHERE_API_KEY           (if using Cohere)
 *   AM_VOYAGE_API_KEY / VOYAGE_API_KEY           (if using Voyage)
 *   AM_GEMINI_API_KEY / GEMINI_API_KEY           (if using Gemini)
 *   AM_OLLAMA_BASE_URL / OLLAMA_BASE_URL         (if using Ollama, default: http://localhost:11434)
 *   AM_SOURCE / MEMORY_SOURCE                    (default: "agent")
 *   AM_PROFILE / MEMORY_PROFILE                  (default: "default")
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
  const v = env(key);
  if (!v) fatal(`Missing env var: AM_${key} (or ${key})`);
  return v!;
}

/**
 * Resolve env var with AM_ prefix priority, then fallback to unprefixed.
 * For MEMORY_SOURCE/MEMORY_PROFILE, the AM_ form is AM_SOURCE/AM_PROFILE.
 */
function env(key: string): string | undefined {
  return process.env[`AM_${key}`] ?? process.env[key];
}

/**
 * Same as env() but for the two legacy-named optional vars.
 */
function envSource(): string {
  return process.env.AM_SOURCE ?? process.env.MEMORY_SOURCE ?? "agent";
}

function envProfile(): string {
  return process.env.AM_PROFILE ?? process.env.MEMORY_PROFILE ?? "default";
}

function envEmbeddingDim(): number {
  return parseInt(process.env.AM_EMBEDDING_DIM ?? process.env.EMBEDDING_DIM ?? "1024");
}

// ── Output ───────────────────────────────────────────────────────────────────

function out(data: unknown) {
  const jsonStr = JSON.stringify(data);
  try {
    const proc = Bun.spawnSync(["bunx", "--bun", "@toon-format/cli"], {
      stdin: Buffer.from(jsonStr)
    });
    if (proc.exitCode === 0) {
      console.log(proc.stdout.toString().trimEnd());
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
  } catch {
    console.log(JSON.stringify(data, null, 2));
  }
}

function fatal(msg: string, detail?: unknown): never {
  const err: Record<string, unknown> = { error: msg };
  if (detail) err.detail = detail;
  console.error(JSON.stringify(err, null, 2));
  process.exit(1);
}

// ── Validation helpers ───────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUuid(value: string, label = "id"): string {
  if (!UUID_RE.test(value)) fatal(`Invalid UUID for ${label}: ${value}`);
  return value;
}

function validateRange(value: number, min: number, max: number, label: string): number {
  if (isNaN(value) || value < min || value > max) {
    fatal(`${label} must be between ${min} and ${max}, got: ${value}`);
  }
  return value;
}

function validatePositive(value: number, label: string): number {
  if (isNaN(value) || value <= 0) {
    fatal(`${label} must be > 0, got: ${value}`);
  }
  return value;
}

function validateNonNegative(value: number, label: string): number {
  if (isNaN(value) || value < 0) {
    fatal(`${label} must be >= 0, got: ${value}`);
  }
  return value;
}

function parseTags(raw: string): string[] {
  return raw.split(",").map((t) => t.trim()).filter(Boolean);
}

function safeJsonParse(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (e) {
    fatal(`Invalid JSON for ${label}: ${(e as Error).message}`, raw);
  }
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

function sanitizeErrorText(text: string): string {
  // Strip anything that looks like an API key or bearer token
  return text
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9]+/g, "sk-[REDACTED]")
    .replace(/eyJ[A-Za-z0-9._\-]+/g, "[REDACTED_TOKEN]");
}

async function supa(
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string> | [string, string][],
  extraHeaders?: Record<string, string>
): Promise<unknown> {
  const base = required("SUPABASE_URL");
  const key = required("SUPABASE_SERVICE_KEY");

  let url = `${base}${path}`;
  if (query) {
    if (Array.isArray(query)) {
      if (query.length > 0) {
        const params = new URLSearchParams();
        for (const [k, v] of query) params.append(k, v);
        url += "?" + params.toString();
      }
    } else if (Object.keys(query).length > 0) {
      url += "?" + new URLSearchParams(query).toString();
    }
  }

  const headers: Record<string, string> = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
    ...extraHeaders,
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    fatal(`Supabase ${method} ${path} → ${res.status}`, sanitizeErrorText(text));
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
      const key = required("OPENAI_API_KEY"); // AM_OPENAI_API_KEY || OPENAI_API_KEY
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
  if (embedding.length !== expectedDim) {
    fatal(`Embedding dimension mismatch: got ${embedding.length}, expected ${expectedDim} (AM_EMBEDDING_DIM). Check your model/provider config.`);
  }

  return embedding;
}

async function embedForQuery(text: string): Promise<number[]> {
  // Same as embed() but uses query-optimised input_type for providers that distinguish
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
    if (!res.ok) fatal("Gemini query embedding failed", sanitizeErrorText(await res.text()));
    const j = (await res.json()) as { embedding: { values: number[] } };
    return j.embedding.values;
  }

  // Ollama and OpenAI don't distinguish document vs query
  return embed(text);
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdStore(positional: string[], flags: Record<string, string | boolean>) {
  const content = positional[0];
  if (!content) fatal("Usage: store <content> [--tags t1,t2] [--source s] [--profile p] [--ttl days] [--metadata '{}'] [--dedup threshold] [--auto-link]");

  const tagsRaw = flag(flags, "tags");
  const source = flag(flags, "source") ?? envSource();
  const profile = flag(flags, "profile") ?? envProfile();
  const ttlDays = flag(flags, "ttl");
  const metaRaw = flag(flags, "metadata");
  const dedupRaw = flags["dedup"];
  const dedupThreshold = dedupRaw === true ? 0.95 : (typeof dedupRaw === "string" ? validateRange(parseFloat(dedupRaw), 0, 1, "--dedup") : null);
  const autoLink = flags["auto-link"] === true;

  const embedding = await embed(content);

  // Dedup check: search for similar memories before storing
  if (dedupThreshold !== null) {
    const dupes = await rpc("match_memories", {
      query_embedding: embedding,
      match_threshold: dedupThreshold,
      match_count: 1,
      ...(profile && { profile_filter: profile }),
    }) as Record<string, unknown>[];

    if (Array.isArray(dupes) && dupes.length > 0) {
      out({ skipped: true, reason: "duplicate_found", similarity: dupes[0].similarity, existing: dupes[0] });
      return;
    }
  }

  const row: Record<string, unknown> = {
    content,
    embedding,
    source,
    profile,
    tags: tagsRaw ? parseTags(tagsRaw) : [],
    metadata: metaRaw ? safeJsonParse(metaRaw, "--metadata") : {},
    embedding_model: env("EMBEDDING_MODEL") ?? null,
  };

  if (ttlDays) {
    const days = validatePositive(parseInt(ttlDays), "--ttl");
    const exp = new Date();
    exp.setDate(exp.getDate() + days);
    row.expires_at = exp.toISOString();
  }

  const result = await supa("POST", "/rest/v1/memories", row) as unknown[];
  const saved = Array.isArray(result) ? result[0] : result;
  // Return only the essentials — embedding is huge and useless to the LLM
  const { embedding: _e, search_vector: _s, ...clean } = saved as Record<string, unknown>;

  // Auto-link: find similar memories and create edges
  if (autoLink && clean.id) {
    const similar = await rpc("match_memories", {
      query_embedding: embedding,
      match_threshold: 0.5,
      match_count: 5,
      ...(profile && { profile_filter: profile }),
    }) as Record<string, unknown>[];

    const links: string[] = [];
    if (Array.isArray(similar)) {
      for (const s of similar) {
        if (s.id !== clean.id) {
          try {
            await supa("POST", "/rest/v1/memory_edges", {
              source_id: clean.id,
              target_id: s.id,
              edge_type: "similar",
              strength: Math.min((s.similarity as number), 1),
            });
            links.push(s.id as string);
          } catch { /* edge may already exist */ }
        }
      }
    }
    if (links.length > 0) (clean as Record<string, unknown>).auto_linked = links;
  }

  out(clean);
}

async function cmdSearch(positional: string[], flags: Record<string, string | boolean>) {
  const query = positional[0];
  if (!query) fatal("Usage: search <query> [--limit n] [--threshold f] [--profile p] [--tag t] [--source s] [--min-confidence f] [--after date] [--before date]");

  const limit = validatePositive(parseInt(flag(flags, "limit") ?? "10"), "--limit");
  const threshold = validateRange(parseFloat(flag(flags, "threshold") ?? "0.3"), 0, 1, "--threshold");
  const profile = flag(flags, "profile") ?? undefined;
  const tag = flag(flags, "tag") ?? undefined;
  const source = flag(flags, "source") ?? undefined;
  const minConfidenceRaw = flag(flags, "min-confidence");
  const minConfidence = minConfidenceRaw ? validateRange(parseFloat(minConfidenceRaw), 0, 1, "--min-confidence") : undefined;
  const afterDate = flag(flags, "after") ?? undefined;
  const beforeDate = flag(flags, "before") ?? undefined;

  const queryEmbedding = await embedForQuery(query);

  const results = await rpc("hybrid_search", {
    query_text: query,
    query_embedding: queryEmbedding,
    match_count: limit,
    match_threshold: threshold,
    ...(profile && { profile_filter: profile }),
    ...(source && { source_filter: source }),
    ...(tag && { tag_filter: tag }),
    ...(minConfidence !== undefined && { min_confidence: minConfidence }),
    ...(afterDate && { after_date: afterDate }),
    ...(beforeDate && { before_date: beforeDate }),
  });

  // Bump access_count for returned results (separate VOLATILE call)
  const rows = Array.isArray(results) ? results as Record<string, unknown>[] : [];
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id as string);
    rpc("bump_access_count", { memory_ids: ids }).catch(() => {});
  }

  out(results);
}

async function cmdGet(positional: string[]) {
  const id = positional[0];
  if (!id) fatal("Usage: get <uuid>");
  validateUuid(id);

  const result = await supa("GET", "/rest/v1/memories", undefined, { id: `eq.${id}` }) as unknown[];
  if (!Array.isArray(result) || result.length === 0) fatal("Memory not found", { id });
  const { embedding: _e, search_vector: _s, ...clean } = result[0] as Record<string, unknown>;
  out(clean);
}

async function cmdRecent(flags: Record<string, string | boolean>) {
  const limit = flag(flags, "limit") ?? "3";
  validatePositive(parseInt(limit), "--limit");
  const source = flag(flags, "source");
  const profile = flag(flags, "profile");
  const afterDate = flag(flags, "after");
  const beforeDate = flag(flags, "before");

  const pairs: [string, string][] = [
    ["order", "created_at.desc"],
    ["limit", limit],
    ["select", "id,content,source,profile,tags,metadata,confidence,access_count,created_at,expires_at"],
  ];
  if (source) pairs.push(["source", `eq.${source}`]);
  if (profile) pairs.push(["profile", `eq.${profile}`]);
  if (afterDate) pairs.push(["created_at", `gte.${afterDate}`]);
  if (beforeDate) pairs.push(["created_at", `lte.${beforeDate}`]);
  
  // Filter out expired memories: expires_at is null OR expires_at > now
  const now = new Date().toISOString();
  pairs.push(["or", `expires_at.is.null,expires_at.gt.${now}`]);

  const results = await supa("GET", "/rest/v1/memories", undefined, pairs);
  out(results);
}

async function cmdTag(positional: string[], flags: Record<string, string | boolean>) {
  const tag = positional[0];
  if (!tag) fatal("Usage: tag <tag> [--limit n] [--profile p]");

  const limit = validatePositive(parseInt(flag(flags, "limit") ?? "20"), "--limit");

  const result = await rpc("get_memories_by_tag", {
    tag,
    limit_count: limit,
    ...(flag(flags, "profile") && { profile_filter: flag(flags, "profile") }),
  });
  out(result);
}

async function cmdUpdate(positional: string[], flags: Record<string, string | boolean>) {
  const id = positional[0];
  if (!id) fatal("Usage: update <uuid> [--content text] [--confidence f] [--tags t1,t2] [--metadata '{}']");
  validateUuid(id);

  const patch: Record<string, unknown> = {};

  const content = flag(flags, "content");
  if (content) {
    patch.content = content;
    patch.embedding = await embed(content); // re-embed when content changes
    patch.embedding_model = env("EMBEDDING_MODEL") ?? null;
  }

  const confidence = flag(flags, "confidence");
  if (confidence) patch.confidence = validateRange(parseFloat(confidence), 0, 1, "--confidence");

  const tagsRaw = flag(flags, "tags");
  if (tagsRaw) patch.tags = parseTags(tagsRaw);

  const metaRaw = flag(flags, "metadata");
  if (metaRaw) patch.metadata = safeJsonParse(metaRaw, "--metadata");

  if (Object.keys(patch).length === 0) fatal("Provide at least one of: --content, --confidence, --tags, --metadata");

  const result = await supa("PATCH", "/rest/v1/memories", patch, { id: `eq.${id}` }) as unknown[];
  const updated = Array.isArray(result) ? result[0] : result;
  const { embedding: _e, search_vector: _s, ...clean } = (updated ?? { id }) as Record<string, unknown>;
  out(clean);
}

async function cmdDelete(positional: string[]) {
  const id = positional[0];
  if (!id) fatal("Usage: delete <uuid>");
  validateUuid(id);

  await supa("DELETE", "/rest/v1/memories", undefined, { id: `eq.${id}` });
  out({ deleted: id });
}

async function cmdLink(positional: string[], flags: Record<string, string | boolean>) {
  const [a, b] = positional;
  if (!a || !b) fatal("Usage: link <uuid-a> <uuid-b> [--type supports] [--strength 0.8]");
  validateUuid(a, "uuid-a");
  validateUuid(b, "uuid-b");

  const edgeType = flag(flags, "type") ?? "related";
  const strength = validateRange(parseFloat(flag(flags, "strength") ?? "0.7"), 0, 1, "--strength");

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
  validateUuid(a, "uuid-a");
  validateUuid(b, "uuid-b");

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
  validateUuid(id);

  const depth = validateNonNegative(parseInt(flag(flags, "depth") ?? "2"), "--depth");
  const minStrength = validateRange(parseFloat(flag(flags, "min-strength") ?? "0.5"), 0, 1, "--min-strength");

  const result = await rpc("find_related_memories", {
    start_memory_id: id,
    max_depth: depth,
    min_strength: minStrength,
  });
  out(result);
}

async function cmdCleanup() {
  const result = await rpc("cleanup_expired_memories", {});
  out({ deleted_expired: result });
}

async function cmdStats(flags: Record<string, string | boolean>) {
  const profile = flag(flags, "profile") ?? undefined;
  const result = await rpc("memory_stats", {
    ...(profile && { profile_filter: profile }),
  });
  out(result);
}

async function cmdHealth() {
  const checks: Record<string, unknown> = {};

  // 1. Check Supabase connectivity
  try {
    await supa("GET", "/rest/v1/memories", undefined, { limit: "0", select: "id" });
    checks.supabase = "ok";
  } catch {
    checks.supabase = "failed";
  }

  // 2. Check RPC functions exist
  try {
    // Call hybrid_search with a zero-length vector to trigger param error (not "function not found")
    await rpc("hybrid_search", {
      query_text: "__health_check__",
      query_embedding: Array(envEmbeddingDim()).fill(0),
      match_count: 1,
      match_threshold: 0.99,
    });
    checks.rpc_hybrid_search = "ok";
  } catch (e: unknown) {
    const msg = (e as Error).message ?? String(e);
    checks.rpc_hybrid_search = msg.includes("function") ? "missing" : "ok";
  }

  try {
    await rpc("memory_stats", {});
    checks.rpc_memory_stats = "ok";
  } catch {
    checks.rpc_memory_stats = "missing (run updated schema.sql)";
  }

  try {
    await rpc("bump_access_count", { memory_ids: [] });
    checks.rpc_bump_access_count = "ok";
  } catch {
    checks.rpc_bump_access_count = "missing (run updated schema.sql)";
  }

  // 3. Check embedding provider
  try {
    const vec = await embed("health check test");
    checks.embedding_provider = "ok";
    checks.embedding_dim = vec.length;
    checks.embedding_model = env("EMBEDDING_MODEL");
  } catch {
    checks.embedding_provider = "failed";
  }

  // 4. Check dimension match
  const expectedDim = envEmbeddingDim();
  if (typeof checks.embedding_dim === "number") {
    checks.dim_match = checks.embedding_dim === expectedDim ? "ok" : `mismatch: got ${checks.embedding_dim}, expected ${expectedDim}`;
  }

  out(checks);
}

async function cmdProfiles() {
  // Use a direct query with select+group approach via PostgREST
  // PostgREST doesn't support GROUP BY directly, so use an RPC or fetch distinct
  try {
    const result = await rpc("memory_stats", {});
    const stats = result as Record<string, unknown>;
    out({ profiles: stats.by_profile });
  } catch {
    // Fallback: fetch distinct profiles manually
    const rows = await supa("GET", "/rest/v1/memories", undefined, {
      select: "profile",
      order: "profile",
    }) as Record<string, unknown>[];
    const counts: Record<string, number> = {};
    for (const r of rows) {
      const p = (r.profile as string) ?? "default";
      counts[p] = (counts[p] ?? 0) + 1;
    }
    out({ profiles: counts });
  }
}

async function cmdExport(flags: Record<string, string | boolean>) {
  const profile = flag(flags, "profile");
  const outputFile = flag(flags, "output");

  const q: Record<string, string> = {
    select: "id,content,original_content,source,profile,tags,metadata,confidence,access_count,compression_level,embedding_model,created_at,updated_at,expires_at",
    order: "created_at.asc",
    limit: "10000",
  };
  if (profile) q.profile = `eq.${profile}`;

  const rows = await supa("GET", "/rest/v1/memories", undefined, q);
  const data = {
    exported_at: new Date().toISOString(),
    profile_filter: profile ?? null,
    count: Array.isArray(rows) ? rows.length : 0,
    memories: rows,
  };

  if (outputFile) {
    await Bun.write(outputFile, JSON.stringify(data, null, 2));
    out({ exported: outputFile, count: data.count });
  } else {
    out(data);
  }
}

async function cmdImport(positional: string[], flags: Record<string, string | boolean>) {
  const filePath = positional[0];
  if (!filePath) fatal("Usage: import <file.json> [--re-embed]");

  const reEmbed = flags["re-embed"] === true;

  const file = Bun.file(filePath);
  if (!(await file.exists())) fatal(`File not found: ${filePath}`);

  const data = safeJsonParse(await file.text(), filePath) as Record<string, unknown>;
  const memories = (data.memories ?? data) as Record<string, unknown>[];

  if (!Array.isArray(memories)) fatal("Expected 'memories' array in import file");

  let imported = 0;
  let errors = 0;

  for (const mem of memories) {
    try {
      const row: Record<string, unknown> = {
        content: mem.content,
        source: mem.source ?? "import",
        profile: mem.profile ?? "default",
        tags: mem.tags ?? [],
        metadata: mem.metadata ?? {},
        confidence: mem.confidence ?? 0.8,
        compression_level: mem.compression_level ?? 0,
        original_content: mem.original_content ?? null,
        embedding_model: reEmbed ? (env("EMBEDDING_MODEL") ?? null) : (mem.embedding_model ?? null),
      };

      if (reEmbed) {
        row.embedding = await embed(mem.content as string);
      }

      if (mem.expires_at) row.expires_at = mem.expires_at;

      await supa("POST", "/rest/v1/memories", row);
      imported++;
    } catch {
      errors++;
    }
  }

  out({ imported, errors, total: memories.length });
}

async function cmdReEmbed(flags: Record<string, string | boolean>) {
  const profile = flag(flags, "profile");
  const batchSize = validatePositive(parseInt(flag(flags, "batch-size") ?? "50"), "--batch-size");

  const q: Record<string, string> = {
    select: "id,content",
    order: "created_at.asc",
    limit: String(batchSize),
  };
  if (profile) q.profile = `eq.${profile}`;

  let processed = 0;
  let errors = 0;
  let offset = 0;

  while (true) {
    const pageQ = { ...q, offset: String(offset) };
    const rows = await supa("GET", "/rest/v1/memories", undefined, pageQ) as Record<string, unknown>[];

    if (!Array.isArray(rows) || rows.length === 0) break;

    for (const row of rows) {
      try {
        const newEmbedding = await embed(row.content as string);
        await supa("PATCH", "/rest/v1/memories", {
          embedding: newEmbedding,
          embedding_model: env("EMBEDDING_MODEL") ?? null,
        }, { id: `eq.${row.id}` });
        processed++;
        if (processed % 10 === 0) {
          console.error(`re-embed progress: ${processed} done`);
        }
      } catch {
        errors++;
      }
    }

    offset += rows.length;
    if (rows.length < batchSize) break;
  }

  out({ re_embedded: processed, errors, model: env("EMBEDDING_MODEL") });
}

// ── New Commands ─────────────────────────────────────────────────────────────

async function cmdCompress(positional: string[], flags: Record<string, string | boolean>) {
  const id = positional[0];
  const compressed = positional[1];
  if (!id || !compressed) fatal("Usage: compress <uuid> <compressed-text>");
  validateUuid(id);

  const result = await supa("GET", "/rest/v1/memories", undefined, { id: `eq.${id}` }) as Record<string, unknown>[];
  if (!Array.isArray(result) || result.length === 0) fatal("Memory not found", { id });
  const current = result[0];

  const patch: Record<string, unknown> = {
    content: compressed,
    embedding: await embed(compressed),
    embedding_model: env("EMBEDDING_MODEL") ?? null,
    compression_level: Math.min(((current.compression_level as number) ?? 0) + 1, 2),
  };

  if (!current.original_content) {
    patch.original_content = current.content;
  }

  const updated = await supa("PATCH", "/rest/v1/memories", patch, { id: `eq.${id}` }) as unknown[];
  const saved = Array.isArray(updated) ? updated[0] : updated;
  const { embedding: _e, search_vector: _s, ...clean } = (saved ?? { id }) as Record<string, unknown>;
  out(clean);
}

async function cmdBulkDelete(flags: Record<string, string | boolean>) {
  const tag = flag(flags, "tag");
  const source = flag(flags, "source");
  const profile = flag(flags, "profile");
  const before = flag(flags, "before");
  const after = flag(flags, "after");
  const dryRun = flags["dry-run"] === true;

  if (!tag && !source && !profile && !before && !after) {
    fatal("Usage: bulk-delete [--tag t] [--source s] [--profile p] [--before date] [--after date] [--dry-run]");
  }

  const pairs: [string, string][] = [];
  if (tag) pairs.push(["tags", `cs.{${tag}}`]);
  if (source) pairs.push(["source", `eq.${source}`]);
  if (profile) pairs.push(["profile", `eq.${profile}`]);
  if (before) pairs.push(["created_at", `lt.${before}`]);
  if (after) pairs.push(["created_at", `gt.${after}`]);

  // Count matching memories first
  const countPairs: [string, string][] = [["select", "id"], ...pairs];
  const matches = await supa("GET", "/rest/v1/memories", undefined, countPairs) as unknown[];
  const count = Array.isArray(matches) ? matches.length : 0;

  if (dryRun) {
    out({ dry_run: true, would_delete: count });
    return;
  }

  if (count === 0) {
    out({ deleted: 0 });
    return;
  }

  await supa("DELETE", "/rest/v1/memories", undefined, pairs);
  out({ deleted: count });
}

async function cmdContext(positional: string[], flags: Record<string, string | boolean>) {
  const query = positional[0];
  if (!query) fatal("Usage: context <query> [--limit n] [--depth d] [--profile p]");

  const limit = validatePositive(parseInt(flag(flags, "limit") ?? "5"), "--limit");
  const depth = validateNonNegative(parseInt(flag(flags, "depth") ?? "2"), "--depth");
  const profile = flag(flags, "profile") ?? undefined;

  const queryEmbedding = await embedForQuery(query);
  const searchResults = await rpc("hybrid_search", {
    query_text: query,
    query_embedding: queryEmbedding,
    match_count: limit,
    match_threshold: 0.3,
    ...(profile && { profile_filter: profile }),
  }) as Record<string, unknown>[];

  if (!Array.isArray(searchResults) || searchResults.length === 0) {
    out({ query, memories: [], related: [] });
    return;
  }

  // Bump access counts
  const ids = searchResults.map((r) => r.id as string);
  rpc("bump_access_count", { memory_ids: ids }).catch(() => {});

  // Follow graph edges for each result
  const seen = new Set<string>(ids);
  const related: Record<string, unknown>[] = [];

  if (depth > 0) {
    for (const mem of searchResults) {
      try {
        const edges = await rpc("find_related_memories", {
          start_memory_id: mem.id,
          max_depth: depth,
          min_strength: 0.5,
        }) as Record<string, unknown>[];

        if (Array.isArray(edges)) {
          for (const edge of edges) {
            const mid = edge.memory_id as string;
            if (!seen.has(mid)) {
              seen.add(mid);
              related.push(edge);
            }
          }
        }
      } catch { /* ignore graph errors */ }
    }
  }

  out({
    query,
    memories: searchResults,
    ...(related.length > 0 && { related }),
  });
}

async function cmdStoreBatch(positional: string[], flags: Record<string, string | boolean>) {
  const filePath = positional[0];
  if (!filePath) fatal("Usage: store-batch <file.json> [--dedup threshold] [--auto-link] [--profile p] [--source s]");

  const file = Bun.file(filePath);
  if (!(await file.exists())) fatal(`File not found: ${filePath}`);

  const data = safeJsonParse(await file.text(), filePath) as unknown;
  const items = (Array.isArray(data) ? data : (data as Record<string, unknown>).memories ?? data) as Record<string, unknown>[];
  if (!Array.isArray(items)) fatal("Expected JSON array or {memories: [...]}");

  const dedupRaw = flags["dedup"];
  const dedupThreshold = dedupRaw === true ? 0.95 : (typeof dedupRaw === "string" ? parseFloat(dedupRaw) : null);
  const autoLink = flags["auto-link"] === true;
  const defaultSource = flag(flags, "source") ?? envSource();
  const defaultProfile = flag(flags, "profile") ?? envProfile();

  let stored = 0;
  let skipped = 0;
  let errors = 0;

  for (const item of items) {
    try {
      const content = item.content as string;
      if (!content) { errors++; continue; }

      const embedding = await embed(content);

      if (dedupThreshold !== null) {
        const dupes = await rpc("match_memories", {
          query_embedding: embedding,
          match_threshold: dedupThreshold,
          match_count: 1,
        }) as Record<string, unknown>[];
        if (Array.isArray(dupes) && dupes.length > 0) {
          skipped++;
          continue;
        }
      }

      const row: Record<string, unknown> = {
        content,
        embedding,
        source: (item.source as string) ?? defaultSource,
        profile: (item.profile as string) ?? defaultProfile,
        tags: Array.isArray(item.tags) ? item.tags : [],
        metadata: item.metadata ?? {},
        embedding_model: env("EMBEDDING_MODEL") ?? null,
      };

      const result = await supa("POST", "/rest/v1/memories", row) as unknown[];
      const saved = Array.isArray(result) ? result[0] : result;

      if (autoLink && saved) {
        const sid = (saved as Record<string, unknown>).id;
        const similar = await rpc("match_memories", {
          query_embedding: embedding,
          match_threshold: 0.5,
          match_count: 3,
        }) as Record<string, unknown>[];
        if (Array.isArray(similar)) {
          for (const s of similar) {
            if (s.id !== sid) {
              try {
                await supa("POST", "/rest/v1/memory_edges", {
                  source_id: sid,
                  target_id: s.id,
                  edge_type: "similar",
                  strength: Math.min((s.similarity as number), 1),
                });
              } catch { /* edge may exist */ }
            }
          }
        }
      }

      stored++;
    } catch {
      errors++;
    }
  }

  out({ stored, skipped, errors, total: items.length });
}

async function cmdMerge(positional: string[], flags: Record<string, string | boolean>) {
  if (positional.length < 2) fatal("Usage: merge <uuid1> <uuid2> [uuid3...] [--delete-originals] [--separator text]");

  const ids = positional.map((id) => validateUuid(id));
  const deleteOriginals = flags["delete-originals"] === true;
  const separator = flag(flags, "separator") ?? "\n---\n";

  const memories: Record<string, unknown>[] = [];
  for (const id of ids) {
    const result = await supa("GET", "/rest/v1/memories", undefined, { id: `eq.${id}` }) as Record<string, unknown>[];
    if (!Array.isArray(result) || result.length === 0) fatal(`Memory not found: ${id}`);
    memories.push(result[0]);
  }

  const mergedContent = memories.map((m) => m.content as string).join(separator);
  const mergedTags = [...new Set(memories.flatMap((m) => (m.tags as string[]) ?? []))];
  const mergedMeta: Record<string, unknown> = {};
  for (const m of memories) {
    Object.assign(mergedMeta, (m.metadata as Record<string, unknown>) ?? {});
  }
  mergedMeta.merged_from = ids;

  const embedding = await embed(mergedContent);
  const row: Record<string, unknown> = {
    content: mergedContent,
    embedding,
    source: (memories[0].source as string) ?? envSource(),
    profile: (memories[0].profile as string) ?? envProfile(),
    tags: mergedTags,
    metadata: mergedMeta,
    embedding_model: env("EMBEDDING_MODEL") ?? null,
  };

  const result = await supa("POST", "/rest/v1/memories", row) as unknown[];
  const saved = Array.isArray(result) ? result[0] : result;
  const newId = (saved as Record<string, unknown>).id;

  if (deleteOriginals) {
    for (const id of ids) {
      await supa("DELETE", "/rest/v1/memories", undefined, { id: `eq.${id}` });
    }
  } else {
    for (const id of ids) {
      try {
        await supa("POST", "/rest/v1/memory_edges", {
          source_id: newId,
          target_id: id,
          edge_type: "expands",
          strength: 1.0,
        });
      } catch { /* edge may exist */ }
    }
  }

  const { embedding: _e, search_vector: _s, ...clean } = (saved as Record<string, unknown>);
  (clean as Record<string, unknown>).merged_from = ids;
  (clean as Record<string, unknown>).originals_deleted = deleteOriginals;
  out(clean);
}

async function cmdSuggestTags(positional: string[], flags: Record<string, string | boolean>) {
  const content = positional[0];
  if (!content) fatal("Usage: suggest-tags <content> [--limit n]");

  const limit = validatePositive(parseInt(flag(flags, "limit") ?? "5"), "--limit");
  const embedding = await embed(content);

  const similar = await rpc("match_memories", {
    query_embedding: embedding,
    match_threshold: 0.3,
    match_count: 20,
  }) as Record<string, unknown>[];

  if (!Array.isArray(similar) || similar.length === 0) {
    out({ suggested_tags: [], reason: "no similar memories found" });
    return;
  }

  const tagScores: Record<string, number> = {};
  for (const mem of similar) {
    const tags = (mem.tags as string[]) ?? [];
    const sim = (mem.similarity as number) ?? 0.5;
    for (const t of tags) {
      tagScores[t] = (tagScores[t] ?? 0) + sim;
    }
  }

  const sorted = Object.entries(tagScores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag, score]) => ({ tag, score: Math.round(score * 100) / 100 }));

  out({ suggested_tags: sorted });
}

// ── Main ──────────────────────────────────────────────────────────────────────

const GLOBAL_HELP = `usage: bun memory.ts <command> [args]

Agent memory CLI. Handles embedding generation + Supabase calls in one step.
Designed for LLM use: minimal output, clean JSON, one command per operation.

commands:
  store        Store a new memory
  search       Search for memories (hybrid semantic + keyword)
  get          Retrieve a specific memory by UUID
  recent       List recently stored memories
  tag          Find memories by a specific tag
  update       Modify an existing memory
  delete       Delete a memory
  link         Create a relationship edge between two memories
  unlink       Remove a relationship edge
  related      Explore the knowledge graph from a specific memory
  cleanup      Remove expired memories based on TTL
  stats        Show memory database statistics
  health       Check system health and database connectivity
  profiles     List all memory profiles
  export       Export memories to JSON
  import       Import memories from JSON
  re-embed     Re-generate embeddings for existing memories
  compress     Summarize a verbose memory
  bulk-delete  Delete multiple memories by criteria
  context      Load context for a topic (search + graph combined)
  store-batch  Store multiple memories from a JSON array file
  merge        Combine multiple memories into one
  suggest-tags Suggest tags for new content

Run \`bun memory.ts <command> --help\` for details on a specific command.

env vars (AM_ prefix takes priority, falls back to unprefixed):
  AM_SUPABASE_URL         Supabase project URL
  AM_SUPABASE_SERVICE_KEY service_role key
  AM_EMBEDDING_PROVIDER   ollama | openai | cohere | voyage | gemini
  AM_EMBEDDING_MODEL      model name for chosen provider
  AM_EMBEDDING_DIM        embedding dimension (default: 1024)
  AM_SOURCE               default source tag (default: "agent")
  AM_PROFILE              default profile (default: "default")`;

const COMMAND_HELP: Record<string, string> = {
  store: `usage: bun memory.ts store <content> [flags]

Store a new memory and automatically generate its embedding.

flags:
  --tags t1,t2     Comma-separated list of tags
  --source s       Source identifier (e.g., agent name)
  --profile p      Memory profile/partition (default: "default")
  --ttl days       Time-to-live in days before automatic deletion
  --metadata '{}'  Additional JSON metadata
  --dedup thres    Skip storing if similarity >= threshold (or use without value for 0.95)
  --auto-link      Automatically link to similar existing memories`,

  search: `usage: bun memory.ts search <query> [flags]

Search memories using hybrid search (semantic vector similarity + full-text keyword matching).

flags:
  --limit n          Max results to return (default: 10)
  --threshold f      Minimum similarity threshold (0.0 to 1.0, default: 0.3)
  --profile p        Filter by profile
  --tag t            Filter by specific tag
  --source s         Filter by source
  --min-confidence f Filter by minimum confidence score
  --after date       Filter by created_at >= date (ISO 8601)
  --before date      Filter by created_at <= date (ISO 8601)`,

  get: `usage: bun memory.ts get <uuid>

Retrieve a specific memory by its UUID. Returns clean JSON without the raw embedding vector.`,

  recent: `usage: bun memory.ts recent [flags]

List the most recently stored memories.

flags:
  --limit n      Max results to return (default: 20)
  --source s     Filter by source
  --profile p    Filter by profile
  --after date   Filter by created_at >= date
  --before date  Filter by created_at <= date`,

  tag: `usage: bun memory.ts tag <tag> [flags]

Retrieve memories that have a specific tag.

flags:
  --limit n      Max results to return (default: 20)
  --profile p    Filter by profile`,

  update: `usage: bun memory.ts update <uuid> [flags]

Update an existing memory. If --content is updated, its embedding will be automatically regenerated.

flags:
  --content text   New text content
  --confidence f   New confidence score (0.0 to 1.0)
  --tags t1,t2     New comma-separated tags (replaces existing)
  --metadata '{}'  New JSON metadata (replaces existing)`,

  delete: `usage: bun memory.ts delete <uuid>

Delete a specific memory by its UUID.`,

  link: `usage: bun memory.ts link <uuid-a> <uuid-b> [flags]

Create a typed directional edge between two memories in the knowledge graph.

flags:
  --type edge      Type of relationship (supports, contradicts, expands, related, depends_on, similar). Default: related.
  --strength f     Strength of the relationship (0.0 to 1.0, default: 0.7)`,

  unlink: `usage: bun memory.ts unlink <uuid-a> <uuid-b> [flags]

Remove a relationship edge between two memories.

flags:
  --type edge      Only delete edges of this specific type`,

  related: `usage: bun memory.ts related <uuid> [flags]

Explore the knowledge graph starting from a specific memory.

flags:
  --depth n        Max traversal hops (default: 2)
  --min-strength f Minimum edge strength to follow (default: 0.5)`,

  cleanup: `usage: bun memory.ts cleanup

Remove all memories whose expires_at date is in the past. Returns the number of deleted memories.`,

  stats: `usage: bun memory.ts stats [flags]

Show database statistics, including total memories, counts by profile/source, and edge counts.

flags:
  --profile p      Filter stats to a specific profile`,

  health: `usage: bun memory.ts health

Check connectivity to Supabase, verify RPC functions exist, and validate embedding provider setup.`,

  profiles: `usage: bun memory.ts profiles

List all active memory profiles and the number of memories in each.`,

  export: `usage: bun memory.ts export [flags]

Export memories to JSON format (excludes raw embedding vectors).

flags:
  --profile p      Only export memories from this profile
  --output file    Save to a file instead of printing to stdout`,

  import: `usage: bun memory.ts import <file.json> [flags]

Import memories from a JSON file.

flags:
  --re-embed       Regenerate embeddings for all imported memories using the current provider`,

  "re-embed": `usage: bun memory.ts re-embed [flags]

Regenerate embeddings for existing memories using the currently configured provider. Useful when switching embedding models.

flags:
  --profile p      Only re-embed memories in this profile
  --batch-size n   Number of memories to process at once (default: 50)`,

  compress: `usage: bun memory.ts compress <uuid> <compressed-text>

Replace a verbose memory's content with a shorter summarized version. The original content is preserved in the original_content field.`,

  "bulk-delete": `usage: bun memory.ts bulk-delete [flags]

Delete multiple memories matching specific criteria. ALWAYS use --dry-run first to check how many will be deleted.

flags:
  --tag t          Delete memories with this tag
  --source s       Delete memories from this source
  --profile p      Delete memories in this profile
  --before date    Delete memories created before this date
  --after date     Delete memories created after this date
  --dry-run        Print count of matched memories without deleting`,

  context: `usage: bun memory.ts context <query> [flags]

Load context for a task. Performs a hybrid search and follows knowledge graph edges from the results in one step.

flags:
  --limit n        Max search results to return initially (default: 5)
  --depth d        Graph traversal depth from search results (default: 2)
  --profile p      Filter by profile`,

  "store-batch": `usage: bun memory.ts store-batch <file.json> [flags]

Store multiple memories from a JSON array file. Expected format: [{"content": "...", "tags": [...]}, ...]

flags:
  --dedup thres    Skip storing items if similarity >= threshold
  --auto-link      Automatically link new memories to similar existing ones
  --profile p      Default profile for items without one
  --source s       Default source for items without one`,

  merge: `usage: bun memory.ts merge <uuid1> <uuid2> [uuid3...] [flags]

Combine multiple memories into a single new memory. Concatenates content, merges tags, and optionally links or deletes the originals.

flags:
  --delete-originals Remove the original memories after merging
  --separator text   String used to join contents (default: "\\n---\\n")`,

  "suggest-tags": `usage: bun memory.ts suggest-tags <content> [flags]

Suggest tags for new content based on similar existing memories in the database.

flags:
  --limit n        Max number of tags to suggest (default: 5)`
};

await loadEnv();

const args = process.argv.slice(2);
const { positional, flags: cliFlags } = parseArgs(args);

if (cliFlags.help || cliFlags.h || args.length === 0) {
  const cmd = positional[0];
  if (cmd && COMMAND_HELP[cmd]) {
    console.log(COMMAND_HELP[cmd]);
  } else {
    console.log(GLOBAL_HELP);
  }
  process.exit(0);
}

const cmd = positional[0];
const rest = positional.slice(1);

switch (cmd) {
  case "store":    await cmdStore(rest, cliFlags); break;
  case "search":   await cmdSearch(rest, cliFlags); break;
  case "get":      await cmdGet(rest); break;
  case "recent":   await cmdRecent(cliFlags); break;
  case "tag":      await cmdTag(rest, cliFlags); break;
  case "update":   await cmdUpdate(rest, cliFlags); break;
  case "delete":   await cmdDelete(rest); break;
  case "link":     await cmdLink(rest, cliFlags); break;
  case "unlink":   await cmdUnlink(rest, cliFlags); break;
  case "related":  await cmdRelated(rest, cliFlags); break;
  case "cleanup":  await cmdCleanup(); break;
  case "stats":    await cmdStats(cliFlags); break;
  case "health":   await cmdHealth(); break;
  case "profiles": await cmdProfiles(); break;
  case "export":   await cmdExport(cliFlags); break;
  case "import":   await cmdImport(rest, cliFlags); break;
  case "re-embed":     await cmdReEmbed(cliFlags); break;
  case "compress":     await cmdCompress(rest, cliFlags); break;
  case "bulk-delete":  await cmdBulkDelete(cliFlags); break;
  case "context":      await cmdContext(rest, cliFlags); break;
  case "store-batch":  await cmdStoreBatch(rest, cliFlags); break;
  case "merge":        await cmdMerge(rest, cliFlags); break;
  case "suggest-tags": await cmdSuggestTags(rest, cliFlags); break;
  default:             fatal(`Unknown command: ${cmd}`);
}
