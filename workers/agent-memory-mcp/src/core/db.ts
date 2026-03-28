/**
 * core/db.ts — Supabase client wrappers for CF Workers
 */
import type { Env } from "./env.ts";
import { sanitizeErrorText } from "./utils.ts";

export async function supa(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string> | [string, string][],
  extraHeaders?: Record<string, string>
): Promise<unknown> {
  const base = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_KEY;

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
    throw new Error(`Supabase ${method} ${path} → ${res.status}: ${sanitizeErrorText(text)}`);
  }
  return text ? JSON.parse(text) : null;
}

export async function rpc(env: Env, fn: string, args: Record<string, unknown>): Promise<unknown> {
  return supa(env, "POST", `/rest/v1/rpc/${fn}`, args);
}
