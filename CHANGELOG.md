# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is `0.x`, minor releases may contain breaking changes.

## [Unreleased]

### Removed

- **Sandbox support (`--env`/`KITE_ENV`, the reserved `sandbox` profile) is
  gone.** Zerodha's Kite Connect sandbox turns out to be undocumented beyond
  a login form — `sandbox.kite.trade` is live, but neither Zerodha's own docs
  nor the developer forum say what identity to authenticate with, and it is
  not the same as your regular Zerodha login. Since the CLI could never
  actually complete a sandbox login, the entire environment concept (config
  `env`, `--env` flag, `endpointsFor`, `SANDBOX_CREDENTIALS`, the `/oms`
  route-prefix plumbing, the sandbox-only `user_id` WebSocket parameter, and
  the per-environment instrument cache) has been removed rather than kept
  around unused. `--dry-run` remains the supported way to preview an order
  without sending it.
  - **Breaking for library consumers:** `endpointsFor`, `type Environment`,
    `SANDBOX_CREDENTIALS`, and `SANDBOX_PROFILE` are no longer exported from
    the package root. `KiteClient`/`Ticker`'s `endpoints` option now takes the
    new `ENDPOINTS` constant instead of `endpointsFor('production' | 'sandbox')`.
  - **Breaking for CLI users:** the global `--env`/`KITE_ENV` flag, the
    `sandbox` profile, `kite profiles add --env`, and the `config.env` /
    per-profile `env` config keys are gone. A config file or session with a
    leftover `env` key still loads fine (the field is just ignored).

## [0.5.0] - 2026-07-22

### Added

- `kite mcp` runs a read-only [Model Context Protocol](https://modelcontextprotocol.io)
  server over stdio, so an LLM agent (Claude and others) can inspect a Kite
  account — profile, holdings, positions, funds, orders, trades, live
  quotes/LTP/OHLC, and instrument search. It **cannot** place, modify or cancel
  an order: a money-moving command must render the resolved order and be
  confirmed at a terminal, which an MCP server has none of, so writes are
  deliberately not exposed. The server is hand-rolled (no new dependencies, in
  keeping with the dependency budget), requires a live session, and redacts
  every tool result like the rest of the transport.
- `kite orders reconcile [tag]` makes the order-tag recovery path a first-class
  command. `orders place` already reconciles automatically the instant a
  placement fails — but that check is lost if the process is killed, a script
  crashes, or the terminal closes. This re-runs it on demand: given the unique
  tag every order carries, `kite orders reconcile <tag>` looks up the orderbook
  and reports whether the order actually reached Kite, so you know whether it is
  safe to place again. With no tag it lists the orders this CLI placed today. It
  is a query, not a mutation — it exits `0` on any clean answer, and `--json`
  carries a `placed` boolean as the machine-readable verdict.

## [0.4.0] - 2026-07-22

### Added

- `kite doctor` runs offline health checks — Node version, config file existence
  and permissions, OS keyring reachability, whether an API secret is stored, the
  cached session's expiry, and whether the login callback port is free — and
  prints a pass/warn/fail report (`--json` for scripts). It makes no network
  call: it exits non-zero only on a hard failure, and points at `kite whoami` to
  confirm the session is live on Kite's side.
- `kite completion <bash|zsh|fish>` prints a shell completion script (the shell
  is auto-detected from `$SHELL` when omitted). Completions are generated from
  the live command tree, so new commands and flags are completable without a
  hand-maintained list to keep in sync; regenerate after upgrading. The bash
  script works on the bash 3.2 that ships with macOS.

### Changed

- `kite login` now always prints the login URL to the console (not only when it
  can't open a browser), and while waiting for the callback you can press `c` to
  copy the URL to the clipboard. Pressing Ctrl-C during the wait now aborts on
  the first keypress instead of hanging until a second.
- Network-failure errors ("Could not reach Kite") now include the underlying
  cause (e.g. `ECONNRESET`, `ENOTFOUND`) instead of just the generic "fetch
  failed" text, so a dropped connection can actually be diagnosed.

## [0.3.0] - 2026-07-22

### Added

- `alerts create` now accepts a repeatable `--order` flag, so an ATO alert can
  place a basket of orders — each on its own instrument, independent of the
  watched one (e.g. watch `NSE:INDIGO`, fire an order on `NFO:INDIGO25AUGFUT`).
  Each leg is `EXCHANGE:SYMBOL:SIDE:QTY` followed by optional attributes (an
  order type, product, validity, a price, or `trigger=<n>`), parsed by content
  so field order does not matter. A leg that can't be parsed unambiguously is
  rejected rather than silently defaulted, the value cap sums every leg and
  fails closed if any one can't be priced, and `--order` cannot be mixed with
  the single-order flags. The existing `--side`/`--quantity` flags stay as a
  shorthand for a single order on the watched instrument.
- `mf` command group exposing the mutual-fund read endpoints: `mf holdings`
  (holdings with P&L), `mf orders` (orders from the last 7 days), and `mf sips`
  (your SIPs). Mutual funds remain read-only over Kite Connect.
- `margins` command group wrapping Kite's calculators (nothing is placed):
  `margins order` (required margin per order), `margins basket` (net margin for
  a set, with spread/hedge benefit and `--[no-]consider-positions`), and
  `margins charges` (itemised brokerage/tax breakdown — a virtual contract
  note). Orders are given as positional `EXCHANGE:SYMBOL:SIDE:QTY[:…]` specs.
  `margins charges` requires a non-zero price, since charges are a percentage of
  quantity × price and a zero would compute a plausible-looking ≈₹0.

## [0.2.1] - 2026-07-21

### Added

- A `docs/` directory: a safety-model deep dive, a full configuration
  reference, a troubleshooting guide, a generated CLI command reference
  (`npm run docs:commands`, checked in CI), and a library API reference.
- A documentation site published to
  [pungoyal.github.io/kite-cli](https://pungoyal.github.io/kite-cli/), built
  from `docs/` with VitePress and deployed to GitHub Pages. The site is an
  isolated workspace, so it adds nothing to the installed CLI package.

### Fixed

- README links now use absolute URLs, so they resolve on npmjs.com and anywhere
  the published package is read. The tarball ships only `dist/`, so the previous
  repo-relative links (to `docs/`, `LICENSE`, `SECURITY.md`, and others) pointed
  at files absent from the package and 404'd on the npm page.

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

[Unreleased]: https://github.com/pungoyal/kite-cli/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/pungoyal/kite-cli/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/pungoyal/kite-cli/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/pungoyal/kite-cli/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/pungoyal/kite-cli/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/pungoyal/kite-cli/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/pungoyal/kite-cli/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/pungoyal/kite-cli/releases/tag/v0.1.0
