# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is `0.x`, minor releases may contain breaking changes.

## [Unreleased]

## [0.1.0] - 2026-07-21

Initial release.

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
- Published from CI via npm Trusted Publishing (OIDC, no long-lived token) with provenance; CI actions are pinned to commit SHAs and dependency lifecycle scripts are disabled.

### Safety

- Order commands preview the **resolved** order (real instrument token, lot size, computed value) and require confirmation, escalating to a typed challenge above a configurable value.
- A local kill switch (`trading.enabled`) and a per-order value cap (`trading.maxOrderValue`) that fails closed when a value cannot be determined.
- No mutating HTTP verb (`POST`/`PUT`/`DELETE`) is ever retried automatically. A timed-out placement is reconciled against a unique client tag rather than blindly re-sent.
- Client-side rate limiting per endpoint category, with the documented per-minute and per-day order caps enforced as a runaway-loop backstop.

[Unreleased]: https://github.com/pungoyal/kite-connect-cli/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/pungoyal/kite-connect-cli/releases/tag/v0.1.0
