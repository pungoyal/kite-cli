# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is `0.x`, minor releases may contain breaking changes.

## [Unreleased]

### Added

- **Worked examples on every command.** `kite <command> --help` now ends in an
  `Examples:` block showing the flags actually combined — how a stop-loss order
  differs from a stop-loss GTT, what an OCO's four price flags mean together,
  which shape an ATO alert takes, how an order spec is spelled for `margins`.
  A flag list alone did not show that, and the commands where it mattered most
  (`gtt place`, `alerts create`) were effectively unusable from their option
  names.

  The examples live with the command definitions, so
  [docs/commands.md](docs/commands.md) — generated from `--help` — carries them
  too, with nothing to keep in sync. `gtt place` and `alerts create` also gain a
  short note on their two mutually exclusive shapes.

- **A scripting and automation reference**, at
  [docs/scripting.md](docs/scripting.md): the stdout/stderr contract, what
  `--json` guarantees (including `watch`'s NDJSON), the full exit-code table,
  how `--yes` and the non-interactive refusal interact, why a script reconciles
  by tag instead of retrying a write, credentials in CI, and colour/TTY
  environment variables.

  The exit-code table previously lived only in the README, which meant the
  library API page, the troubleshooting guide and the generated command
  reference all linked *out* of the docs site to find it. Those are now in-site
  links, so a rename fails the docs build instead of rotting silently.

### Changed

- **The README is an introduction again, not a second copy of the reference.**
  It had grown a full config-key table, the multi-account walkthrough and
  per-command prose for alerts, GTT and margins — all of it duplicated on the
  documentation site, where it is searchable and versioned with the code. What
  remains is what a reader needs before trusting the tool: why it is safe, how
  it compares to the official SDKs, install, login, and one everyday-commands
  block. Every heading the docs pages link into is kept, trimmed to a short
  section with a pointer.

### Fixed

- **`kite --help` and the README documented the wrong JSON shape for
  `positions`.** Both piped `--json` through `jq '.net[]…'`, but the command
  emits the array it displays, not the `{net, day}` envelope, so the filter
  matched nothing. Both now read `jq '.[]…'`.

## [0.7.0] - 2026-07-24

### Added

- **`kite gtt place --order-type MARKET`.** A GTT can now place a market order
  when its trigger fires, not only a limit order — the same Limit/Market choice
  Kite web offers. `LIMIT` is inferred whenever a limit price is given, so the
  flag is only needed to ask for `MARKET`; it is never inferred from a *missing*
  price, because a mistyped price flag turning into a market order is the one
  failure this command must not have.

  A market order has no limit price, so the **trigger** price is what prices it
  for `trading.maxOrderValue` and the typed-confirmation threshold. Using the
  `0` that goes on the wire would make an arbitrarily large order read as tiny
  to both guards. The confirmation labels the figure `Est. value` rather than
  `Max value` and says outright that it fills at whatever the book offers, and
  `kite gtt get` renders such a leg as `at market` rather than `₹0.00`.

  Zerodha's public GTT documentation only ever shows `LIMIT`, and one support
  article states market GTTs cannot be placed at all. Both are out of date: the
  wire format used here (`order_type: MARKET`, `price: 0`,
  `market_protection: -1`) was verified by placing a market GTT through
  `POST /gtt/triggers` and reading it back.

- **Percentage triggers.** `--stoploss 2%` and `--target 2%` are measured from
  `--last-price`, mirroring the `% of LTP` field in Kite web's own dialog. The
  percentage is unsigned — which way to move follows from the leg and the side,
  so there is no sign to get backwards.

### Changed

- **An OCO is now described by naming its legs: `--stoploss` and `--target`**,
  each with its own `--stoploss-price` / `--target-price`. Kite only accepts a
  two-leg GTT with one trigger either side of the current price, and which is
  which follows from `--side`: a `BUY` OCO closes a short, so its stoploss sits
  above the price and its target below; a `SELL` OCO closes a long and the two
  swap. Because the legs are named, the CLI sorts `trigger_values` into the
  ascending order Kite index-matches to `orders`, so the array order never
  reaches the caller. Where `--last-price` is supplied, a leg on the wrong side
  of it is refused up front rather than coming back from Kite as the
  uninformative `Condition already met.`

- **`--product` is required on `NFO`, `MCX`, `BFO`, `CDS`, `BCD` and `NCO`.**
  It defaults to `CNC`, an equity-delivery product that is never right on a
  derivatives contract, and a forgotten flag silently sent one that way.

### Fixed

- **`kite gtt place` no longer needs market-data permission, or any network
  call of its own.** It used to fetch a quote purely to populate
  `condition.last_price`, which meant an API key without a market-data
  subscription could not place a GTT at all — the command died with
  "Insufficient permission for that call." before reaching any placement logic.
  Kite does not require that field and evaluates the condition against its own
  feed regardless, so it is no longer sent. `--last-price` survives as an
  optional reference for percentage triggers and the leg-direction check, and
  is labelled in the confirmation as supplied rather than observed.

### Breaking

- Two `--trigger` values no longer describe an OCO; use `--stoploss` and
  `--target`. The error names the replacement.
- `--product` is required on derivatives exchanges rather than defaulting to
  `CNC` there.
- `GttParams.condition.last_price` is now optional, and
  `GttParams.orders[].order_type` widens from `'LIMIT'` to `'LIMIT' | 'MARKET'`,
  with an optional `market_protection`. Library callers passing a `last_price`
  are unaffected; it is simply no longer sent by the CLI.

## [0.6.0] - 2026-07-23

### Added

- **Better `kite login` UX on headless servers.** `kite login` now detects when
  no browser can plausibly be launched (no `DISPLAY`/`WAYLAND_DISPLAY` on
  Linux) and skips the doomed `xdg-open` attempt with a clearer message. While
  waiting for the loopback callback, press `m` to drop into the manual flow
  without restarting the command. `kite login --manual` (and the `m` handoff)
  now accept pasting the *whole* redirect URL — the page your browser lands on
  after login, which fails to load on a headless server — instead of requiring
  you to pick `request_token` out of it by hand; the CSRF `state` is verified
  when a full URL is pasted, closing a gap where the manual flow previously
  skipped that check entirely.
- `kite alerts enable`/`kite alerts disable` pause or resume an alert without
  deleting it. Kite's alerts API documents no `status` parameter on modify and
  no dedicated toggle endpoint, so the CLI sends the request optimistically and
  then re-reads it with a fresh `GET` (never trusting the PUT response's own
  `status`, which could just echo the request back without persisting it)
  before reporting success — if Kite silently ignores the field, the command
  fails loudly (exit code 1) instead of claiming an alert is disabled while
  it's still fully live. That matters most for `ato` alerts, which place a
  real order when they fire, so re-enabling or disabling one goes through the
  same kill-switch/confirmation gate as `alerts modify`. An alert already in
  the requested state is a no-op.

### Fixed

- `kite alerts delete` now goes through the kill-switch/confirmation gate when
  any target is an `ato` alert (or couldn't be verified before deleting), the
  same way `alerts enable`/`disable`, `orders cancel`, and `gtt delete` already
  gate their own "only unwinds risk" actions. Previously it was the one
  order-adjacent delete/cancel command left ungated regardless of alert type —
  with the kill switch off, you could delete an order-arming alert outright
  even though merely disabling the same alert was correctly refused.

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

[Unreleased]: https://github.com/pungoyal/kite-cli/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/pungoyal/kite-cli/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/pungoyal/kite-cli/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/pungoyal/kite-cli/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/pungoyal/kite-cli/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/pungoyal/kite-cli/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/pungoyal/kite-cli/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/pungoyal/kite-cli/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/pungoyal/kite-cli/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/pungoyal/kite-cli/releases/tag/v0.1.0
