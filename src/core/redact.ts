/**
 * Secret redaction for anything that can reach a log, a terminal, or a crash
 * report.
 *
 * The two highest-risk leak paths in this codebase, per the Kite API surface:
 *
 *   1. The `Authorization` header — it is literally `token <api_key>:<access_token>`
 *      and is attached to every single request.
 *   2. The WebSocket URL — `access_token` is a *query parameter*, so it appears
 *      verbatim in `ws` error messages and stack traces.
 *
 * Everything printed in verbose/debug mode must pass through `redact()`.
 * `test/redact.test.ts` asserts that a known token never survives.
 */

/** Values registered at runtime for exact-match scrubbing. */
const registeredSecrets = new Set<string>();

/**
 * Register a literal secret value so it is scrubbed wherever it appears, even
 * in contexts the pattern rules below do not anticipate (a Kite error message
 * that echoes input, a third-party stack trace).
 *
 * Short values are ignored: scrubbing a 4-character string would mangle
 * unrelated output for no security benefit.
 */
export function registerSecret(value: string | undefined | null): void {
  if (typeof value === 'string' && value.length >= 8) {
    registeredSecrets.add(value);
  }
}

/** Test-only: drop all registered secrets. */
export function clearRegisteredSecrets(): void {
  registeredSecrets.clear();
}

export const REDACTED = '[redacted]';

/** Key names whose values are always secret, matched case-insensitively. */
const SECRET_KEYS = new Set([
  'authorization',
  'api_secret',
  'apisecret',
  'access_token',
  'accesstoken',
  'request_token',
  'requesttoken',
  'refresh_token',
  'refreshtoken',
  'public_token',
  'publictoken',
  'enctoken',
  'checksum',
  'password',
  'totp',
  'x-kite-session',
]);

const PATTERNS: Array<[RegExp, string]> = [
  // Authorization: token api_key:access_token  (header form, any casing)
  [/\b(authorization\s*:\s*)(?:token\s+)?\S+/gi, `$1${REDACTED}`],
  // token <key>:<secret> appearing bare, e.g. inside a serialized headers object
  [/\btoken\s+[A-Za-z0-9_-]{4,}:[A-Za-z0-9_-]{6,}/g, `token ${REDACTED}`],
  // Any secret-ish key in a query string or form body: access_token=xxxx
  [
    /\b(api_secret|access_token|request_token|refresh_token|public_token|enctoken|checksum|password|totp)=[^&\s"']+/gi,
    `$1=${REDACTED}`,
  ],
  // JSON form: "access_token": "xxxx"
  [
    /("(?:api_secret|access_token|request_token|refresh_token|public_token|enctoken|checksum|password|totp)"\s*:\s*)"[^"]*"/gi,
    `$1"${REDACTED}"`,
  ],
];

/** Redact secrets from a string. Safe to call on arbitrary text. */
export function redactString(input: string): string {
  let out = input;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  // Exact-match pass last, so registered values are caught even where no
  // pattern applied.
  for (const secret of registeredSecrets) {
    if (secret && out.includes(secret)) {
      out = out.split(secret).join(REDACTED);
    }
  }
  return out;
}

/**
 * Deeply redact a value of any shape. Objects are walked by key (secret keys
 * have their values replaced wholesale) and strings are pattern-scrubbed.
 *
 * Cycles are handled; depth is capped to keep this cheap on the hot path.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 12) return '[truncated]';

  if (typeof value === 'string') return redactString(value);
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1, seen));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }

  if (value instanceof Headers) {
    const out: Record<string, unknown> = {};
    value.forEach((v, k) => {
      out[k] = SECRET_KEYS.has(k.toLowerCase()) ? REDACTED : redactString(v);
    });
    return out;
  }

  if (value instanceof URL) {
    return redactUrl(value);
  }

  // Types with no own enumerable properties must be handled before the generic
  // Object.entries walk below, which would otherwise flatten them to `{}`.
  // Dates matter most: tick timestamps flow straight into `kite watch --json`.
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (value instanceof Map) {
    return redact(Object.fromEntries(value), depth + 1, seen);
  }
  if (value instanceof Set) {
    return redact([...value], depth + 1, seen);
  }
  if (value instanceof RegExp) {
    return value.toString();
  }
  if (Buffer.isBuffer(value)) {
    return `[buffer ${value.length} bytes]`;
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEYS.has(key.toLowerCase()) ? REDACTED : redact(item, depth + 1, seen);
  }
  return out;
}

/**
 * Redact credentials from a URL's query string.
 *
 * This exists specifically for the ticker: `wss://ws.kite.trade?api_key=..&access_token=..`
 * must never be printed or embedded in an error. `api_key` is kept (it is
 * semi-public and useful for debugging); `access_token` is not.
 */
export function redactUrl(url: string | URL): string {
  let parsed: URL;
  try {
    parsed = typeof url === 'string' ? new URL(url) : url;
  } catch {
    // Not a parseable URL — fall back to pattern scrubbing.
    return redactString(String(url));
  }

  const copy = new URL(parsed.toString());
  for (const key of [...copy.searchParams.keys()]) {
    if (SECRET_KEYS.has(key.toLowerCase())) {
      copy.searchParams.set(key, REDACTED);
    }
  }
  if (copy.password) copy.password = REDACTED;
  return copy.toString();
}

/**
 * Mask a secret for display, showing only enough to identify which credential
 * it is. Used by `kite config show` and login confirmations.
 */
export function maskSecret(value: string, visible = 4): string {
  if (value.length <= visible) return '*'.repeat(8);
  return `${'*'.repeat(8)}${value.slice(-visible)}`;
}
