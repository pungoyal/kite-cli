# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is `0.x`, minor releases may contain breaking changes.

## [Unreleased]

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

[Unreleased]: https://github.com/pungoyal/kite-cli/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/pungoyal/kite-cli/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/pungoyal/kite-cli/releases/tag/v0.1.0
