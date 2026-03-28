/**
 * core/utils.ts — Shared utility functions (CF Workers compatible)
 * No Bun APIs, no process.exit
 */

// ── Validation helpers ───────────────────────────────────────────────────────

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateUuid(value: string, label = "id"): string {
  if (!UUID_RE.test(value)) {
    throw new Error(`Invalid UUID for ${label}: ${value}`);
  }
  return value;
}

export function validateRange(value: number, min: number, max: number, label: string): number {
  if (isNaN(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}, got: ${value}`);
  }
  return value;
}

export function validatePositive(value: number, label: string): number {
  if (isNaN(value) || value <= 0) {
    throw new Error(`${label} must be > 0, got: ${value}`);
  }
  return value;
}

export function validateNonNegative(value: number, label: string): number {
  if (isNaN(value) || value < 0) {
    throw new Error(`${label} must be >= 0, got: ${value}`);
  }
  return value;
}

export function parseTags(raw: string): string[] {
  return raw.split(",").map((t) => t.trim()).filter(Boolean);
}

export function safeJsonParse(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON for ${label}: ${(e as Error).message}`);
  }
}

// ── Arg parsing (for tool inputs) ──────────────────────────────────────────────

export function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
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

export function flag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

// ── Error sanitization ────────────────────────────────────────────────────────

export function sanitizeErrorText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9]+/g, "sk-[REDACTED]")
    .replace(/eyJ[A-Za-z0-9._\-]+/g, "[REDACTED_TOKEN]");
}
