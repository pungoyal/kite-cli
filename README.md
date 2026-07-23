# kite-cli

[![CI](https://github.com/pungoyal/kite-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/pungoyal/kite-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@pungoyal/kite-cli.svg)](https://www.npmjs.com/package/@pungoyal/kite-cli)
[![Release](https://img.shields.io/github/v/release/pungoyal/kite-cli?sort=semver&color=blue)](https://github.com/pungoyal/kite-cli/releases/latest)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A5%2022.12-brightgreen.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/pungoyal/kite-cli/blob/main/LICENSE)
[![Docs](https://img.shields.io/badge/docs-kite--cli-2496ed.svg)](https://pungoyal.github.io/kite-cli/)

An **unofficial**, secure, scriptable command-line interface for the [Zerodha Kite Connect](https://kite.trade/docs/connect/v3/) API.

Check your portfolio, stream live quotes, and place orders from the terminal — with credentials in your OS keyring, confirmations on anything that moves money, and clean JSON for piping into `jq`.

> **Unofficial, independent project.** Not affiliated with, endorsed by, or sponsored by Zerodha. "Kite" and "Kite Connect" are trademarks of Zerodha Broking Ltd., referenced here only to describe the third-party API this tool works with.

```console
$ kite holdings
╭──────────┬──────┬─────┬──────────┬──────────┬─────────────┬─────────────┬────────┬────────╮
│ Symbol   │ Exch │ Qty │      Avg │      LTP │       Value │         P&L │  P&L % │    Day │
├──────────┼──────┼─────┼──────────┼──────────┼─────────────┼─────────────┼────────┼────────┤
│ INFY     │ NSE  │  50 │ 1,402.30 │ 1,551.85 │   77,592.50 │  +₹7,477.50 │ +10.66% │ +0.82% │
│ TCS      │ NSE  │  20 │ 3,890.00 │ 3,802.40 │   76,048.00 │  -₹1,752.00 │  -2.25% │ -0.41% │
╰──────────┴──────┴─────┴──────────┴──────────┴─────────────┴─────────────┴────────┴────────╯

  Invested      ₹1,55,915.00
  Current       ₹1,53,640.50
  P&L           +₹5,725.50  +3.67%
  Day's change  +₹287.40
```

## Why you can trust it

It places real orders with real money, under an unofficial banner — so the safety
is built into the architecture, and every claim below is verifiable rather than
aspirational:

- **Try it risk-free first.** Every order command supports `--dry-run`, which
  resolves and previews the order — the actual contract, lot size and computed
  value — without sending anything to Kite.
- **It never silently moves money.** Every order previews the *resolved* order —
  the actual contract, lot size and computed value, not an echo of your flags —
  and waits for confirmation. There is deliberately no config key that turns that
  off ([Safety](#safety)).
- **It never blindly retries a write.** Kite has no idempotency key, so a
  timed-out order is genuinely ambiguous. Rather than retry, the CLI tags every
  order and reconciles against the orderbook to tell you what actually happened
  ([Safety](#safety)).
- **Your secrets stay put.** The API secret lives in your OS keyring (or an
  encrypted file), is never accepted as a command-line argument, and is scrubbed
  from every log, error and stack trace — with [tests](https://github.com/pungoyal/kite-cli/blob/main/test/redact.test.ts)
  that prove it ([Security](#security)).
- **Verifiable builds.** Published only from CI via [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
  (OIDC, no long-lived token). Check the provenance yourself with `npm audit signatures`.
- **A small, auditable surface.** ~10 direct dependencies, most of them
  zero-dependency, enforced by a dependency budget in CI.

## How it compares

Zerodha maintains excellent official SDKs — [`pykiteconnect`](https://github.com/zerodha/pykiteconnect)
and [`kiteconnectjs`](https://github.com/zerodha/kiteconnectjs). If you're building an
application, reach for those: they give you the full API, programmatically, and they're
the foundation the whole ecosystem is built on. `kite-cli` is complementary — the same
API as a ready-to-use tool, for when you'd rather not write code:

- **Zero code for everyday use.** `kite holdings`, `kite watch --holdings`,
  `kite orders place …` run straight from the shell — and from any language that can
  shell out.
- **An opinionated safety layer.** A kill switch, per-order value cap, resolved-order
  confirmation, and unique-tag reconciliation for ambiguous writes come built in —
  decisions the official SDKs deliberately leave open so each application can make its
  own.
- **Composable output.** Every command speaks `--json` on stdout, so it drops
  straight into `jq`, cron jobs, and pipelines.
- **A library too, when you need one.** The same client is [exported](#library-use),
  so you can start in the shell and drop into code without switching tools.

## Install

```bash
npm install -g @pungoyal/kite-cli
```

Requires **Node 22.12 or newer**.

## Getting started

You need a [Kite Connect](https://developers.kite.trade) app to get an API
key and secret. Set your app's redirect URL to:

```
http://127.0.0.1:51101/callback
```

Then:

```bash
kite login
```

This opens your browser, you log in to Zerodha normally (including your TOTP), and the CLI captures the callback on loopback. The login URL is also printed to the terminal — press `c` while it's waiting to copy it to your clipboard (handy if the browser didn't open, or you want to log in on another device). Your API secret goes into your OS keyring; the daily access token is stored alongside it.

**Running on a headless server (SSH, a container, CI)?** There's no browser to reach `127.0.0.1` on a remote box, so `kite login` detects the missing display and skips trying to launch one. You have two options:

- Just run `kite login` as usual and press `m` when it's waiting for the callback — that drops you into the manual flow below without starting over.
- Run `kite login --manual` directly. It prints the login URL to open on your phone or any other device; after you log in there, the browser lands on a page that fails to load (nothing is listening on that port on the server) — copy the *whole URL* from the address bar and paste it back into the terminal. Pasting just the `request_token` value still works too.

Either way, the API secret prompt still needs a TTY — set `KITE_API_SECRET` (and `KITE_API_KEY`, `KITE_ACCESS_TOKEN`) as environment variables instead if you're scripting this non-interactively.

**Running more than one Zerodha account?** See [Multiple accounts](#multiple-accounts).

## Usage

The highlights are below; every command's full flag list is in [the command reference](https://pungoyal.github.io/kite-cli/commands).

### Portfolio

```bash
kite holdings                    # long-term holdings with P&L
kite positions                   # open positions
kite positions --day             # intraday only
kite funds                       # available margin
kite convert NSE:INFY --quantity 10 --from MIS --to CNC
kite authorise                   # authorise demat holdings for selling
```

If a sell order fails with exit code 12 ("needs authorisation at depository"), run `kite authorise` — it requests a CDSL authorisation and opens the browser page that completes it. Pass specific ISINs to authorise only those instruments.

### Mutual funds

```bash
kite mf holdings                 # your MF holdings with P&L
kite mf orders                   # MF orders from the last 7 days
kite mf sips                     # your active SIPs
```

Mutual funds are read-only over Kite Connect — placing MF orders and managing
SIPs is not available via the API (a purchase needs a bank debit the API can't
authorise). `mf orders` only reaches back 7 days, so an empty list doesn't mean
you have no MF history.

### Market data

```bash
kite quote NSE:INFY NSE:TCS      # full quotes
kite quote NSE:INFY --depth      # with the 5-level order book
kite ltp NSE:INFY                # just the last traded price
kite ohlc NSE:RELIANCE

kite history NSE:INFY --from 90d
kite history NSE:INFY -i 5minute --from 7d --csv > infy.csv

kite instruments search "nifty bank"
kite instruments search INFY --exchange NFO --type CE
```

Date arguments accept `YYYY-MM-DD` or relative offsets like `30d`, `6m`, `1y`.

Long ranges are chunked automatically to respect Kite's per-interval limits, then merged and de-duplicated.

### Live streaming

```bash
kite watch NSE:INFY NSE:TCS      # self-updating table
kite watch --holdings            # stream your whole portfolio
kite watch --positions --orders  # positions plus live order updates
kite watch NSE:INFY --json | jq  # NDJSON for piping
```

### Trading

Every order previews the **resolved** order and asks for confirmation:

```console
$ kite orders place NSE:INFY --side BUY --quantity 10 --type LIMIT --price 1500

Place BUY order for 10 INFY
  Instrument  NSE:INFY
  Resolved    INFOSYS LIMITED (token 408065)
  Side        BUY
  Quantity    10
  Order type  LIMIT
  Price       ₹1,500.00
  Product     CNC
  Est. value  ₹15,000.00
  Tag         kcmrt88o648c1bce

◆  Place BUY order for 10 INFY?
│  ● Yes / ○ No
```

```bash
kite orders list                       # today's orderbook
kite orders list --open                # working orders only
kite orders get 250720000123456        # full state history and fills
kite orders modify <id> --price 1520
kite orders cancel <id>
kite orders reconcile <tag>            # did an order that seemed to fail actually reach Kite?
kite trades                            # today's fills

kite gtt list
kite gtt place NSE:INFY --side SELL --quantity 10 \
  --trigger 1400 --price 1395 \
  --trigger 1700 --price 1695          # two-leg OCO
kite gtt delete <id>

kite alerts list                       # your price alerts
kite alerts create "INDICES:NIFTY 50" --operator above --value 27000
kite alerts get <uuid>                 # detail, incl. any attached order
kite alerts history <uuid>             # when it has fired
kite alerts delete <uuid> [<uuid>...]
```

Alerts come in two kinds. A **simple** alert just notifies you when a price
condition is met — it moves no money, so the kill switch and value cap do not
apply. An **ATO** (Alert-Triggers-Order) alert places a real order when it fires,
so creating one goes through the same confirmation, value cap and kill switch as
`orders place`:

```bash
kite alerts create NSE:INFY --operator below --value 1400 \
  --type ato --side BUY --quantity 10 --order-type LIMIT --price 1400
```

The order an ATO fires need not be on the instrument you watch, and it can be a
**basket of several orders** across different instruments. Use `--order` — one
per leg, repeatable — where each leg is
`EXCHANGE:SYMBOL:SIDE:QTY` followed by optional attributes (an order type,
product, validity, a bare price, or `trigger=<n>`), in any order:

```bash
# Watch INDIGO's spot price; when it drops, buy the future and trim a hedge.
kite alerts create NSE:INDIGO --operator below --value 3850 --type ato \
  --order 'NFO:INDIGO25AUGFUT:BUY:150:MARKET:NRML' \
  --order 'NSE:RELIANCE:SELL:10:LIMIT:2900'
```

The value cap sums every leg and fails closed if any one cannot be priced. The
`--order` form and the single-order flags above (`--side`/`--quantity`/…) are
mutually exclusive.

`--operator` accepts the raw symbols (`>=`, `<=`, `>`, `<`, `==`) or the aliases
`above`, `below`, `ge`, `le`, `gt`, `lt`, `eq`. Compare against another instrument
instead of a constant with `--rhs-instrument EXCHANGE:SYMBOL`.

Add `--dry-run` to any of these to see exactly what would be sent, without sending it.

### Margins & charges

Work out what an order or a basket would cost before placing it. Nothing is
sent to the exchange — these only call Kite's calculators:

```bash
kite margins order NFO:NIFTY25AUGFUT:BUY:75:NRML       # required margin, per order
kite margins basket NFO:NIFTY25AUGFUT:BUY:75:NRML \
  NFO:NIFTY25AUGFUT:SELL:75:NRML                        # net margin, with hedge benefit
kite margins charges NSE:INFY:BUY:10:1500              # brokerage + taxes (contract note)
```

Each order is `EXCHANGE:SYMBOL:SIDE:QTY` followed by optional attributes (an
order type, product, variety, a bare price, or `trigger=<n>`), in any order;
product defaults to CNC and variety to regular. `margins basket` accepts
`--no-consider-positions` to ignore your existing positions when netting.
`margins charges` needs a real price (the execution price), since charges are a
percentage of quantity × price.

### Scripting

Every command supports `--json`, writes data to stdout and everything else to stderr, and returns a meaningful exit code.

```bash
kite positions --json | jq '.net[] | select(.pnl < 0) | .tradingsymbol'
kite holdings --json | jq '[.[] | .pnl] | add'

kite whoami --json || kite login       # exit code 3 means "no session"
```

| Code | Meaning |
|-----:|---------|
| 0 | Success |
| 1 | Unclassified failure |
| 2 | Bad usage — unknown flag, missing or invalid argument |
| 3 | Not logged in, or the session expired |
| 4 | Kite rejected the input |
| 5 | Order rejected by the exchange |
| 6 | Insufficient margin |
| 7 | Insufficient holdings to sell |
| 8 | Rate limited |
| 9 | Kite or its upstream OMS is unreachable |
| 10 | You declined a confirmation |
| 11 | Confirmation required but the terminal is not interactive |
| 12 | Holdings need depository authorisation — run `kite authorise` |
| 13 | Blocked by the local kill switch or order value cap |

`NO_COLOR` is honoured, and colour is disabled automatically when stdout is not a TTY.

### Agents (MCP)

`kite mcp` exposes Kite's **read-only** endpoints to an LLM agent over the
[Model Context Protocol](https://modelcontextprotocol.io), so Claude — or any MCP
client — can answer "how's my portfolio doing?" against live data. It can read
your profile, holdings, positions, funds, orders, trades, quotes and instruments;
it **cannot** place, modify or cancel anything. Trading stays at a
human-confirmed terminal, by design.

Point an MCP client at it:

```json
{
  "mcpServers": {
    "kite": {
      "command": "kite",
      "args": ["mcp"]
    }
  }
}
```

The server needs a live session, so `kite login` first.

## Multiple accounts

If you run more than one Zerodha account — your own, a family member's, an HUF — each
gets a named **profile** with its own Kite Connect app credentials and its own daily
session. Several accounts can be logged in at once; you choose which one a command
targets.

```bash
kite profiles add huf                 # register a profile (create its Kite app first)
kite --profile huf login              # log in to it (prompts for that app's key + secret)
kite --profile huf holdings           # run any command against it
kite profiles list                    # see every profile and its session status
kite profiles use huf                 # make it the default for commands without --profile
```

`profiles add` can take the account's settings up front so `login` doesn't have to
prompt for them: `--api-key <key>` and `--max-order-value <rupees>` (a per-profile
cap). The API secret is never a flag — `login` always prompts for it.

Selection is resolved fresh every run — there is no hidden "active account" that
persists silently between commands. The target is chosen by, in order:

1. `--profile <name>` on the command line
2. the `KITE_PROFILE` environment variable
3. the default set with `kite profiles use`
4. otherwise the `default` profile

`default` is your original single-account setup — nothing to migrate.

Because targeting the wrong account is the costly mistake here, every money-moving
confirmation shows the **verified account** it will hit — the user id returned by
Kite, not just the label you chose:

```
Place BUY order
  Account   Priya Sharma (XY9876) · profile huf
  Symbol    NSE:INFY
  …
```

Safety caps are per profile, inheriting the global setting when unset (an omitted cap
never means "no cap"):

```bash
kite --profile huf config set trading.maxOrderValue 50000
```

For scripts and CI, `KITE_API_KEY` / `KITE_API_SECRET` / `KITE_ACCESS_TOKEN` still
supply credentials directly. As a safeguard, naming a profile explicitly while those
are set is refused rather than silently overridden.

→ Full reference, including credential storage precedence and per-profile inheritance: [the configuration reference](https://pungoyal.github.io/kite-cli/configuration).

## Safety

This tool spends real money, so the defaults are conservative. → Full model, including the order-tag reconciliation flow and why cancels/converts are exempt from the value cap: [the safety model](https://pungoyal.github.io/kite-cli/safety).

**Confirmation.** Order commands render the resolved order — the actual instrument token, lot size, and computed value, not an echo of your flags — and wait for confirmation. That's deliberate: a flag echo can't catch "I typed the wrong symbol and it resolved to a different contract," which is the expensive mistake.

**Escalation.** Above ₹1,00,000 (configurable) a keystroke isn't enough; you have to type the trading symbol.

**Non-interactive means refuse.** With no TTY and no `--yes`, order commands exit non-zero rather than silently proceeding.

**`--yes` is call-site only.** There is deliberately no config setting to disable confirmations globally. Bypassing safety has to be an explicit act every time.

**Kill switch and cap.**

```bash
kite config set trading.enabled false        # refuse all order commands
kite config set trading.maxOrderValue 50000  # refuse orders above ₹50,000
```

**No blind retries.** Kite has no idempotency key, so a timed-out order placement is genuinely ambiguous — it may have executed. This CLI never retries a write. Instead it tags every order with a unique value, and on failure queries the orderbook for that tag to tell you what actually happened:

```console
$ kite orders place NSE:INFY -s BUY -q 10 --type LIMIT --price 1500 --yes
! The order request failed: Request timed out
· Checking whether it reached Kite anyway…
! The order DID reach Kite: 250720000123456 (COMPLETE).
· It was not placed twice. Do not re-run this command.
```

That reconciliation happens automatically, but only while the placing process is alive. If you lose it — a killed shell, a crashed script, a slept laptop — run it again on demand:

```console
$ kite orders reconcile kcmrt88o648c1bce
✓ Found an order for tag kcmrt88o648c1bce:
  … COMPLETE …
· If placing this order looked like it failed, it went through — do not place it again.
```

With no tag, `kite orders reconcile` lists the orders this CLI placed today, and `--json` carries a `placed` boolean for scripts.

Automatic retries are restricted to `GET`/`HEAD` at the transport layer. `POST`, `PUT` and `DELETE` are never retried — in this API those are place, modify and cancel.

## Security

**Credentials** are resolved in this order:

1. `KITE_API_SECRET` / `KITE_ACCESS_TOKEN` environment variables — for CI and containers, never persisted
2. OS keyring — macOS Keychain, Windows Credential Manager, Linux Secret Service
3. Encrypted file at `~/.config/kite/credentials.enc` — scrypt (N=2¹⁷) + AES-256-GCM, mode `0600`, with the KDF header bound as authenticated data so parameters can't be downgraded

Your API secret is never accepted as a command-line argument, because argv is visible to any local process via `ps` and lands in shell history. It's prompted for, or read from the environment.

**Redaction.** Access tokens are registered with a scrubber that runs over every log line, error message, and stack trace. The two paths that carry a token — the `Authorization` header and the WebSocket URL, where it's a query parameter — are covered explicitly and [tested](https://github.com/pungoyal/kite-cli/blob/main/test/redact.test.ts).

**TOTP.** This CLI will never ask for or store your 2FA seed. Storing it next to your API secret would collapse both authentication factors into one, which is exactly what the SEBI 2FA mandate exists to prevent. Login happens in your browser; the CLI only sees the resulting request token.

**Supply chain.** 10 direct runtime dependencies, most of them zero-dependency. Published from GitHub Actions via [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) with OIDC — no long-lived publish token exists. Provenance attestation is generated automatically; verify it with `npm audit signatures`. All CI actions are pinned to full commit SHAs, and dependency lifecycle scripts are disabled.

To report a vulnerability, see [SECURITY.md](https://github.com/pungoyal/kite-cli/blob/main/SECURITY.md).

## Configuration

```bash
kite config show
kite config set <key> <value>
kite config path
```

| Key | Description |
|---|---|
| `trading.enabled` | Master kill switch for all order commands |
| `trading.confirm` | Require confirmation before money-moving actions |
| `trading.maxOrderValue` | Refuse any single order above this rupee value |
| `trading.strictConfirmAbove` | Above this value, require typing the symbol |
| `output.color` | `auto`, `always`, or `never` |
| `output.compact` | Render tables without borders |
| `redirectPort` / `redirectPath` | Loopback callback URL for login |

Config lives at `~/.config/kite/config.json` (`0600`). Override the location with `KITE_CONFIG_DIR`.

`trading.*`, `apiKey`, and `env` can be set per profile by adding `--profile <name>`
(see [Multiple accounts](#multiple-accounts)); the remaining keys are global. The
account this invocation resolves to is selected by `--profile` / `KITE_PROFILE`.

→ Every key and environment variable, with precedence: [the configuration reference](https://pungoyal.github.io/kite-cli/configuration).

## Things worth knowing about Kite

- **Sessions expire at 6:00 AM IST daily.** This is a regulatory requirement and there's no way around it — you log in once per trading day. Refresh tokens exist in the API but are only issued to exchange-approved platforms, not individual subscribers.
- **Logging into Kite web invalidates your API session.** The CLI can't detect this until a request comes back 403.
- **Order acceptance is not execution.** A returned order ID means the OMS accepted the request. Check `kite orders get <id>` for what actually happened.
- **Rate limits are tight**: quotes 1/sec, historical 3/sec, orders 10/sec (plus 400/min and 5,000/day). The CLI paces requests for you and batches quotes automatically — one call handles up to 1,000 instruments.
- **Kite caps order modifications at 25** per order. After that you must cancel and re-place.
- **Instruments are cached by `exchange:tradingsymbol`, never by token.** Exchanges reuse numeric instrument tokens after expiry, so a token-keyed cache silently resolves to the wrong contract after a rollover.
- **Mutual funds are read-only** over the API — placing MF orders requires a bank debit that has no API path.

→ Hit one of these? See [the troubleshooting guide](https://pungoyal.github.io/kite-cli/troubleshooting) for the symptom-first version.

## Documentation

This README covers installation and everyday usage. The full reference is a
searchable site at **[pungoyal.github.io/kite-cli](https://pungoyal.github.io/kite-cli/)**:

- [Safety model](https://pungoyal.github.io/kite-cli/safety) — the full layered safety model (kill
  switch, value cap, confirmation escalation, order-tag reconciliation).
- [MCP server](https://pungoyal.github.io/kite-cli/mcp) — the read-only Model Context Protocol
  server for LLM agents: its tools, setup, and why it exposes no writes.
- [Configuration](https://pungoyal.github.io/kite-cli/configuration) — every config key and
  environment variable, with precedence.
- [Troubleshooting](https://pungoyal.github.io/kite-cli/troubleshooting) — symptom-first fixes
  for session expiry, rate limits, login issues, and more.
- [Command reference](https://pungoyal.github.io/kite-cli/commands) — full flag-by-flag reference for
  every command, generated from `--help`.
- [Library API](https://pungoyal.github.io/kite-cli/api) — the library/programmatic API surface.

The same pages are browsable as Markdown in [`docs/`](https://github.com/pungoyal/kite-cli/tree/main/docs).

## Library use

The client is exported if you want it without the CLI:

```ts
import { ENDPOINTS, KiteClient, KiteApi } from '@pungoyal/kite-cli';

const client = new KiteClient({
  apiKey: process.env.KITE_API_KEY!,
  accessToken: process.env.KITE_ACCESS_TOKEN!,
  endpoints: ENDPOINTS,
});

const api = new KiteApi(client);
console.log(await api.getHoldings());
```

You get the same rate limiting, response validation, redaction, and error taxonomy the CLI uses.

## Development

```bash
npm install
npm run dev -- holdings   # run from source
npm test
npm run typecheck
npm run build
```

## Contributing

Bug reports, ideas, and pull requests are welcome. See [CONTRIBUTING.md](https://github.com/pungoyal/kite-cli/blob/main/CONTRIBUTING.md) for the development workflow and the two non-negotiables (safety defaults and secret redaction), and [CHANGELOG.md](https://github.com/pungoyal/kite-cli/blob/main/CHANGELOG.md) for release history. Security issues go through [SECURITY.md](https://github.com/pungoyal/kite-cli/blob/main/SECURITY.md), never a public issue.

## Disclaimer

This is an unofficial, independent, community project. It is **not affiliated with, endorsed by, or sponsored by Zerodha**. "Kite", "Kite Connect", and "Zerodha" are trademarks of Zerodha Broking Ltd.; this project references them only to identify the third-party API it interoperates with (nominative use) and claims no rights to those marks.

Trading involves risk of financial loss. This software is provided as-is under the MIT licence — you are responsible for every order it places on your behalf. Test with `--dry-run` before trusting it with real money.

## Licence

[MIT](https://github.com/pungoyal/kite-cli/blob/main/LICENSE)
