#!/usr/bin/env bun
/**
 * core/env.ts — Environment variable loading and accessors
 * Env vars use AM_ prefix priority, falling back to unprefixed.
 */

import { fatal } from "./utils.ts";

export async function loadEnv() {
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
        const val = trimmed.slice(eq + 1).trim().replace(/^[\"']|[\"']$/g, "");
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
}

/**
 * Resolve env var with AM_ prefix priority, then fallback to unprefixed.
 */
export function env(key: string): string | undefined {
  return process.env[`AM_${key}`] ?? process.env[key];
}

export function required(key: string): string {
  const v = env(key);
  if (!v) {
    fatal(`Missing env var: AM_${key} (or ${key})`);
  }
  return v!;
}

export function envSource(): string {
  return process.env.AM_SOURCE ?? process.env.MEMORY_SOURCE ?? "agent";
}

export function envProfile(): string {
  return process.env.AM_PROFILE ?? process.env.MEMORY_PROFILE ?? "default";
}

export function envEmbeddingDim(): number {
  return parseInt(process.env.AM_EMBEDDING_DIM ?? process.env.EMBEDDING_DIM ?? "1024");
}
