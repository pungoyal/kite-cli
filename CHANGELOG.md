# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is `0.x`, minor releases may contain breaking changes.

## [Unreleased]

### Added

- A `docs/` directory: a safety-model deep dive, a full configuration
  reference, a troubleshooting guide, a generated CLI command reference
  (`npm run docs:commands`, checked in CI), and a library API reference.
- A documentation site published to
  [pungoyal.github.io/kite-cli](https://pungoyal.github.io/kite-cli/), built
  from `docs/` with VitePress and deployed to GitHub Pages. The site is an
  isolated workspace, so it adds nothing to the installed CLI package.

## [0.2.0] - 2026-07-21

### Added

- **Price alerts (`kite alerts`).** Create, list, inspect, modify and delete Kite
  price alerts. `list`, `get` and `history` read your alerts; `create` and `modify`
  set the condition (`--operator` accepts `>=`/`<=`/`>`/`<`/`==` or aliases like
  `above`/`below`, and `--value` a constant or `--rhs-instrument` another
  instrument). `delete` takes one or more UUIDs.
  - **Simple** alerts only notify — they move no money, so the kill switch and
    value cap do not apply.
  - **ATO** (Alert-Triggers-Order) alerts place a real order when they fire.
    Creating one (`--type ato` with the order flags) goes through the same
    confirmation, value cap and kill switch as `orders place`.
- **Multiple accounts (profiles).** Run several Zerodha accounts side by side, each
  with its own Kite Connect app credentials and its own daily session. Select the
  target account with `--profile <name>` or `KITE_PROFILE`; manage profiles with
  `kite profiles` (`list`, `add`, `remove`, `use`, `current`). `kite whoami --all`
  lists every profile's session. See the new *Multiple accounts* README section.
  - Your existing single-account setup is the `default` profile and needs no
    migration; `--env sandbox` is now shorthand for `--profile sandbox`.
  - Trading safety (`trading.*`, kill switch, value cap) can be set per profile and
    inherits the global setting when unset — an omitted cap never means "no cap".

### Changed

- Money-moving confirmations now show the **verified account** they will hit — the
  user id returned by Kite, not just a label — as the first line of the preview.
- `kite whoami --json` now nests the Kite profile object under `account` and reports
  the active `profile`.

### Security

- Naming a profile explicitly (`--profile` / `KITE_PROFILE`) while
  `KITE_ACCESS_TOKEN` or `KITE_API_SECRET` is set in the environment is now refused,
  rather than silently using the ambient token against the named account.

## [0.1.1] - 2026-07-21

First release published through the automated GitHub Actions pipeline (npm Trusted
Publishing, OIDC — no long-lived token), carrying a provenance attestation you can
verify with `npm audit signatures`. `0.1.0` was published by hand to bootstrap the
package on npm.

### Changed

- `kite --version` now reads the version from `package.json` instead of a
  hardcoded constant, so it can never drift from the published version.

## [0.1.0] - 2026-07-21

Initial release (bootstrap-published to npm by hand; `0.1.1` is the first
provenance-backed release from CI).

### Added

- **Account** — `login` (browser loopback callback or `--manual`), `logout`, `whoami`. Supports the public Zerodha sandbox via `--env sandbox`.
- **Portfolio** — `holdings`, `positions` (net and intraday), `funds`, `convert` between products, and `authorise` to recover from a depository authorisation (HTTP 428).
- **Market data** — `quote` (with 5-level depth), `ltp`, `ohlc`, `history` (transparently chunked to per-interval range limits, then merged and de-duplicated), and `instruments search` / `refresh`.
- **Trading** — `orders place | list | get | modify | cancel`, `trades`, and `gtt place | list | get | delete` (single and two-leg OCO).
- **Live streaming** — `watch` over WebSocket for instruments, holdings, positions, and order updates, with a self-updating table or NDJSON output.
- **Scripting** — every command supports `--json`, writes data to stdout and everything else to stderr, honours `NO_COLOR`, and returns a distinct exit code per failure mode.
- **Library** — `KiteClient`, `KiteApi`, `Ticker`, and the error taxonomy are exported for use without the CLI.

### Security

- Credentials resolve from environment variables, then the OS keyring, then an AES-256-GCM file encrypted with scrypt (N=2¹⁷, r=8, p=1) whose KDF header is bound as additional authenticated data.
- The API secret is never accepted as a command-line argument; access tokens are registered with a redactor that scrubs every log line, error, and stack trace.
- The login callback binds to `127.0.0.1` only and validates a random CSRF state in constant time.
- TOTP seeds are never prompted for or stored.
- Supply-chain hardening: CI actions pinned to commit SHAs, dependency lifecycle scripts disabled, a dependency release cooldown, and a small, audited dependency tree.

### Safety

- Order commands preview the **resolved** order (real instrument token, lot size, computed value) and require confirmation, escalating to a typed challenge above a configurable value.
- A local kill switch (`trading.enabled`) and a per-order value cap (`trading.maxOrderValue`) that fails closed when a value cannot be determined.
- No mutating HTTP verb (`POST`/`PUT`/`DELETE`) is ever retried automatically. A timed-out placement is reconciled against a unique client tag rather than blindly re-sent.
- Client-side rate limiting per endpoint category, with the documented per-minute and per-day order caps enforced as a runaway-loop backstop.

[Unreleased]: https://github.com/pungoyal/kite-cli/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/pungoyal/kite-cli/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/pungoyal/kite-cli/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/pungoyal/kite-cli/releases/tag/v0.1.0
