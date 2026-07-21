# CLAUDE.md

Guidance for Claude Code (and other agents) working in this repository.

## What this is

`kite-connect-cli` — a TypeScript CLI and library for the Zerodha Kite Connect v3 API. It
places real orders with real money, so correctness, safety, and secret handling
outrank features. ESM-only, Node ≥ 22.12.

## Commands

```bash
npm run dev -- <args>   # run the CLI from source (e.g. npm run dev -- holdings)
npm test                # vitest: unit + in-process E2E + built-binary smoke
npm run typecheck       # tsc --noEmit over src + test + configs
npm run lint            # Biome format + lint check (read-only; CI runs `biome ci`)
npm run lint:fix        # Biome auto-fix
npm run build           # tsc -> dist/ (published build; no source maps)
npm run lint:publish    # publint + are-the-types-wrong on the packed tarball
```

Formatting/linting is Biome (`biome.json`): 2-space, single quotes, semicolons,
trailing commas, width 120. `noNonNullAssertion` and `useLiteralKeys` are disabled
by design. Pre-commit hook lives in `.githooks/` — enable with `npm run hooks:install`.

Tests must run with `TZ=Asia/Kolkata` (vitest config pins this). Use `--env sandbox`
for anything that would otherwise touch a real account.

## Architecture

- `src/cli.ts` — bin entry (shebang + compile cache) → `run.ts`.
- `src/run.ts` — commander wiring, per-invocation context, central error → exit-code mapping.
- `src/context.ts` — assembles config, credentials, client, api, instruments per run.
- `src/safety.ts` — confirmation prompts, kill switch, value cap, unique order tags.
- `src/commands/*` — one file per command group. Keep these thin: parse, prompt, render.
- `src/core/*` — the real logic: `client` (HTTP + retry policy), `api` (typed endpoints, batching, chunking), `auth`, `credentials`/`secretstore`, `redact`, `ratelimit`, `ticker` (WebSocket), `instruments`, `schemas` (zod), `errors`.
- `src/output/*` — io stream discipline, tables, INR/IST formatting.

Networking, validation, batching, and rate limiting live in `core/`, never in
commands, so the exported library gets identical behaviour.

## Invariants — do not weaken without a test and a reason

1. **Fail closed on safety.** Kill switch and value cap treat an unknown value as unsafe, not safe. No config key disables confirmations; `--yes` is call-site only.
2. **Redact secrets everywhere.** Tokens/secrets must never reach a log, error, or stack trace. New secret shapes go in `src/core/redact.ts` with a `test/redact.test.ts` case. `writeJson` already redacts.
3. **Never auto-retry writes.** `POST`/`PUT`/`DELETE` (place/modify/cancel) are never retried — Kite has no idempotency key. Ambiguous failures reconcile against a unique client tag.
4. **Key instruments by `EXCHANGE:TRADINGSYMBOL`, never by token.** Exchanges reuse numeric tokens after expiry.
5. **Validate every response** through a zod schema in `schemas.ts` (loose objects, so new Kite fields don't break parsing).

## Kite gotchas worth remembering

- Sessions die at 06:00 IST daily; a Kite-web login also invalidates the API token (only detectable as a later 403).
- Order acceptance ≠ execution. Check `orders get <id>`.
- Rate limits are tight: quotes 1/sec, historical 3/sec, orders 10/sec + 400/min + 5000/day.
- Historical data is a **paid add-on** — a 403 there is a permission problem, not an expired session.
- The ticker dispatches on packet **byte length**, not the subscribed mode; index vs tradeable layouts differ, and OHLC field order differs between them.

## Conventions

- British spelling in user-facing text (`authorise`, `colour`) to match Zerodha/SEBI usage.
- Comments explain *why*, not *what*. Match the density of the surrounding file.
- Add user-facing changes to `CHANGELOG.md` under `## [Unreleased]`.
- See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow and the release process.
