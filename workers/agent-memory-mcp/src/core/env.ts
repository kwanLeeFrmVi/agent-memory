/**
 * core/env.ts — Environment variable accessors for CF Workers
 * All config comes from Worker secrets/bindings, not process.env
 */

export type Env = {
  // Supabase
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  // Embedding
  EMBEDDING_PROVIDER: string;
  EMBEDDING_MODEL: string;
  EMBEDDING_DIM?: string;
  // Provider API keys
  OPENAI_API_KEY?: string;
  COHERE_API_KEY?: string;
  VOYAGE_API_KEY?: string;
  GEMINI_API_KEY?: string;
  // Auth
  AUTH_ALLOWED_USERS: string; // JSON array of {username, password_hash}
  // KV binding for OAuth
  OAUTH_KV: KVNamespace;
  // Defaults
  DEFAULT_SOURCE?: string;
  DEFAULT_PROFILE?: string;
};

export function getEnvValue(env: Env, key: string): string | undefined {
  // Direct property access for typed env
  return (env as unknown as Record<string, string | undefined>)[key];
}

export function required(env: Env, key: string): string {
  const v = getEnvValue(env, key);
  if (!v) {
    throw new Error(`Missing env var: ${key}`);
  }
  return v;
}

export function envSource(env: Env): string {
  return env.DEFAULT_SOURCE ?? "mcp-worker";
}

export function envProfile(env: Env): string {
  return env.DEFAULT_PROFILE ?? "default";
}

export function envEmbeddingDim(env: Env): number {
  return parseInt(env.EMBEDDING_DIM ?? "1024");
}
