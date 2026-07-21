# Contributing

Thanks for your interest in kite-cli. This tool places real orders with real money, so the bar for changes is deliberately high — but the workflow is ordinary.

## Prerequisites

- **Node 22.12 or newer** (`node -v`).
- npm 10+ (bundled with Node). npm 11.10+ is needed for the `min-release-age` install guard in `.npmrc`, but development works without it.

## Setup

```bash
git clone https://github.com/pungoyal/kite-cli.git
cd kite-cli
npm install
npm run hooks:install   # enable the Biome pre-commit hook (one time, per clone)
```

`hooks:install` points git at `.githooks/`. It is a manual step because git never
runs repo-committed hooks automatically, and this project's `.npmrc` sets
`ignore-scripts=true`, so nothing runs it for you. The hook only checks staged
files — it never rewrites them mid-commit.

## Development loop

Run the CLI straight from TypeScript source, no build step:

```bash
npm run dev -- holdings
npm run dev -- orders place NSE:INFY -s BUY -q 1 --dry-run
```

Work against Zerodha's public sandbox so you never risk real money:

```bash
npm run dev -- login --env sandbox
npm run dev -- --env sandbox holdings
```

## Checks

Everything CI runs, you can run locally. All of these must pass before a PR merges:

```bash
npm run lint          # Biome: formatting + lint (read-only; same as CI and the hook)
npm run lint:fix      # Biome: auto-fix formatting and safe lint issues
npm run typecheck     # tsc --noEmit over src, test, and configs
npm test              # vitest (unit, in-process E2E, and built-binary smoke)
npm run build         # tsc -> dist/
npm run lint:publish  # publint + are-the-types-wrong on the packed tarball
```

Formatting and linting are handled by [Biome](https://biomejs.dev) (config in
`biome.json`): 2-space indent, single quotes, semicolons, trailing commas,
120-column width. Two recommended rules are disabled deliberately —
`noNonNullAssertion` (non-null assertions are the intended pattern under
`noUncheckedIndexedAccess`) and `useLiteralKeys` (env vars are read via
`process.env['X']` by convention). The pre-commit hook runs `biome check` on
staged files; CI runs `biome ci` over everything.

Tests run with `TZ=Asia/Kolkata` because Kite timestamps are IST; the config pins this so results are identical on a UTC CI runner.

## Project layout

```
src/
  cli.ts            # bin entry (shebang, compile cache) -> run.ts
  run.ts            # commander wiring, context construction, error reporting
  context.ts        # per-invocation dependency assembly
  safety.ts         # confirmation, kill switch, value cap, order tags
  commands/         # one file per command group (thin; logic lives in core/)
  core/             # client, api, auth, credentials, redaction, rate limiting, ticker…
  output/           # io streams, tables, number/date formatting
test/               # *.test.ts — unit, E2E through run(), and smoke against dist/
```

Commands stay thin: parsing, prompting, and rendering only. Networking, validation, batching, and rate limiting belong in `core/` so every caller (CLI and library) gets the same behaviour.

## Non-negotiables

Three invariants hold everywhere. A change that weakens one needs a very good reason and a test:

1. **Safety defaults.** Order commands preview the *resolved* order and confirm. The kill switch and value cap fail **closed** — an unknown value is never treated as "within the cap." There is deliberately no config key to disable confirmations; `--yes` is call-site only.
2. **Secret redaction.** Access tokens and secrets never reach a log, error, or stack trace. New output paths must go through the redactor, and new secret shapes belong in `src/core/redact.ts` with a test in `test/redact.test.ts`.
3. **No blind retries of writes.** `POST`/`PUT`/`DELETE` are place/modify/cancel and are never retried automatically — Kite has no idempotency key. Ambiguous failures reconcile against a unique client tag instead.

## Commits and pull requests

- Keep commits focused and write a clear imperative subject line.
- Add or update tests with behavioural changes; keep `typecheck`, `test`, and `lint:publish` green.
- Note user-facing changes in `CHANGELOG.md` under `## [Unreleased]`.
- Security issues go through [SECURITY.md](SECURITY.md) as a private advisory — never a public issue or PR.

## Releasing (maintainers)

Releases are cut from a git tag and published to npm by
[`.github/workflows/release.yml`](.github/workflows/release.yml) using npm
[Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC — there is
no long-lived npm token anywhere).

Versioning follows [SemVer](https://semver.org/). While the package is `0.x`, a
**minor** bump may contain breaking changes and a **patch** is reserved for
backwards-compatible fixes.

To cut a release:

1. Make sure `main` is green in CI and the working tree is clean.
2. Move the `## [Unreleased]` notes in `CHANGELOG.md` under a new
   `## [X.Y.Z] - YYYY-MM-DD` heading, and update the compare links at the bottom.
   Commit it.
3. Bump the version and create the matching tag in one step:
   ```bash
   npm version minor -m "release: v%s"   # or: patch / major
   ```
   This updates `package.json` + `package-lock.json`, commits, and creates a
   `vX.Y.Z` tag.
4. Push the branch and the tag:
   ```bash
   git push origin main --follow-tags
   ```
5. The tag push triggers the release workflow, which re-runs typecheck, tests and
   build, asserts the shebang survived, validates the package shape, checks that
   the tag matches `package.json`, and then publishes with provenance.

Verify a published release with:

```bash
npm audit signatures      # registry signature + provenance attestation
npm view @pungoyal/kite-cli version
```

**First release only:** the trusted publisher must be configured once at
`npmjs.com/package/@pungoyal/kite-cli/access` (repository `pungoyal/kite-cli`, workflow
`release.yml`, environment `release`) before the first tag is pushed. Nothing in
CI can create that binding for you.
