/**
 * core/db.ts — Supabase client wrappers
 */
import { required } from "./env.ts";
import { fatal } from "./utils.ts";

export function sanitizeErrorText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9]+/g, "sk-[REDACTED]")
    .replace(/eyJ[A-Za-z0-9._\-]+/g, "[REDACTED_TOKEN]");
}

export async function supa(
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

export async function rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
  return supa("POST", `/rest/v1/rpc/${fn}`, args);
}
