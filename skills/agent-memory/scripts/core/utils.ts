/**
 * core/utils.ts — Shared utility functions
 * Output formatting, argument parsing, and validation helpers.
 */

// ── Output ───────────────────────────────────────────────────────────────────

export function out(data: unknown) {
  const jsonStr = JSON.stringify(data);
  try {
    const proc = Bun.spawnSync(["bunx", "--bun", "@toon-format/cli"], {
      stdin: Buffer.from(jsonStr),
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

export function fatal(msg: string, detail?: unknown): never {
  const err: Record<string, unknown> = { error: msg };
  if (detail) err.detail = detail;
  console.error(JSON.stringify(err, null, 2));
  process.exit(1);
}

// ── Validation helpers ───────────────────────────────────────────────────────

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateUuid(value: string, label = "id"): string {
  if (!UUID_RE.test(value)) fatal(`Invalid UUID for ${label}: ${value}`);
  return value;
}

export function validateRange(value: number, min: number, max: number, label: string): number {
  if (isNaN(value) || value < min || value > max) {
    fatal(`${label} must be between ${min} and ${max}, got: ${value}`);
  }
  return value;
}

export function validatePositive(value: number, label: string): number {
  if (isNaN(value) || value <= 0) {
    fatal(`${label} must be > 0, got: ${value}`);
  }
  return value;
}

export function validateNonNegative(value: number, label: string): number {
  if (isNaN(value) || value < 0) {
    fatal(`${label} must be >= 0, got: ${value}`);
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
    fatal(`Invalid JSON for ${label}: ${(e as Error).message}`, raw);
  }
}

// ── Arg parsing ──────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]) {
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
