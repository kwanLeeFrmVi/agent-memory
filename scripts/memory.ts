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
 *   AM_SUPABASE_SERVICE_KEY / SUPABASE_SERVICE_KEY
 *   AM_EMBEDDING_PROVIDER / EMBEDDING_PROVIDER  (ollama|openai|cohere|voyage|gemini)
 *   AM_EMBEDDING_MODEL / EMBEDDING_MODEL
 *   AM_EMBEDDING_DIM / EMBEDDING_DIM
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
  query?: Record<string, string>,
  extraHeaders?: Record<string, string>
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
      const dim = env("EMBEDDING_DIM") ? parseInt(env("EMBEDDING_DIM")!) : undefined;
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
  const expectedDim = env("EMBEDDING_DIM") ? parseInt(env("EMBEDDING_DIM")!) : null;
  if (expectedDim && embedding.length !== expectedDim) {
    fatal(`Embedding dimension mismatch: got ${embedding.length}, expected ${expectedDim} (EMBEDDING_DIM). Check your model/provider config.`);
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
  if (!content) fatal("Usage: store <content> [--tags t1,t2] [--source s] [--profile p] [--ttl days] [--metadata '{}']");

  const tagsRaw = flag(flags, "tags");
  const source = flag(flags, "source") ?? envSource();
  const profile = flag(flags, "profile") ?? envProfile();
  const ttlDays = flag(flags, "ttl");
  const metaRaw = flag(flags, "metadata");

  const embedding = await embed(content);

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
  out(clean);
}

async function cmdSearch(positional: string[], flags: Record<string, string | boolean>) {
  const query = positional[0];
  if (!query) fatal("Usage: search <query> [--limit n] [--threshold f] [--profile p] [--tag t] [--source s] [--min-confidence f]");

  const limit = validatePositive(parseInt(flag(flags, "limit") ?? "10"), "--limit");
  const threshold = validateRange(parseFloat(flag(flags, "threshold") ?? "0.3"), 0, 1, "--threshold");
  const profile = flag(flags, "profile") ?? undefined;
  const tag = flag(flags, "tag") ?? undefined;
  const source = flag(flags, "source") ?? undefined;
  const minConfidenceRaw = flag(flags, "min-confidence");
  const minConfidence = minConfidenceRaw ? validateRange(parseFloat(minConfidenceRaw), 0, 1, "--min-confidence") : undefined;

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
  const limit = flag(flags, "limit") ?? "20";
  validatePositive(parseInt(limit), "--limit");
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
      query_embedding: Array(parseInt(env("EMBEDDING_DIM") ?? "1024")).fill(0),
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
  const expectedDim = env("EMBEDDING_DIM") ? parseInt(env("EMBEDDING_DIM")!) : null;
  if (expectedDim && typeof checks.embedding_dim === "number") {
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

// ── Main ──────────────────────────────────────────────────────────────────────

await loadEnv();

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log(`usage: bun memory.ts <command> [args]

commands:
  store    <content> [--tags t1,t2] [--source s] [--profile p] [--ttl days] [--metadata '{}']
  search   <query>   [--limit n] [--threshold f] [--profile p] [--tag t] [--source s] [--min-confidence f]
  get      <uuid>
  recent   [--limit n] [--source s] [--profile p]
  tag      <tag>     [--limit n] [--profile p]
  update   <uuid>    [--content text] [--confidence f] [--tags t1,t2] [--metadata '{}']
  delete   <uuid>
  link     <uuid-a> <uuid-b> [--type supports|contradicts|expands|related|depends_on|similar] [--strength f]
  unlink   <uuid-a> <uuid-b> [--type edge-type]
  related  <uuid>    [--depth n] [--min-strength f]
  cleanup
  stats    [--profile p]
  health
  profiles
  export   [--profile p] [--output file.json]
  import   <file.json> [--re-embed]
  re-embed [--profile p] [--batch-size n]

env vars (AM_ prefix takes priority, falls back to unprefixed):
  AM_SUPABASE_URL         Supabase project URL
  AM_SUPABASE_SERVICE_KEY service_role key
  AM_EMBEDDING_PROVIDER   ollama | openai | cohere | voyage | gemini
  AM_EMBEDDING_MODEL      model name for chosen provider
  AM_EMBEDDING_DIM        must match model output dimension
  AM_SOURCE               default source tag (default: "agent")
  AM_PROFILE              default profile (default: "default")`);
  process.exit(0);
}

const { positional, flags: cliFlags } = parseArgs(args);
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
  case "re-embed": await cmdReEmbed(cliFlags); break;
  default:         fatal(`Unknown command: ${cmd}`);
}
