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
╭────────┬──────┬─────┬──────────┬──────────┬────────────┬────────────┬─────────┬────────╮
│ Symbol │ Exch │ Qty │      Avg │      LTP │      Value │        P&L │   P&L % │    Day │
├────────┼──────┼─────┼──────────┼──────────┼────────────┼────────────┼─────────┼────────┤
│ INFY   │ NSE  │  50 │ 1,402.30 │ 1,551.85 │  77,592.50 │ +₹7,477.50 │ +10.66% │ +0.82% │
│ TCS    │ NSE  │  20 │ 3,890.00 │ 3,802.40 │  76,048.00 │ -₹1,752.00 │  -2.25% │ -0.41% │
╰────────┴──────┴─────┴──────────┴──────────┴────────────┴────────────┴─────────┴────────╯

  Invested      ₹1,55,915.00
  Current       ₹1,53,640.50
  P&L           +₹5,725.50  +3.67%
  Day's change  +₹287.40
```

**Documentation:** [command reference](https://pungoyal.github.io/kite-cli/commands) · [safety model](https://pungoyal.github.io/kite-cli/safety) · [configuration](https://pungoyal.github.io/kite-cli/configuration) · [troubleshooting](https://pungoyal.github.io/kite-cli/troubleshooting) · [library API](https://pungoyal.github.io/kite-cli/api)

## Why you can trust it

It places real orders with real money, under an unofficial banner — so the safety
is built into the architecture, and every claim is verifiable rather than
aspirational:

- **Try it risk-free first.** Every order command supports `--dry-run`, which resolves and previews the order — the actual contract, lot size and computed value — without sending anything to Kite.
- **It never silently moves money.** Orders preview the *resolved* order and wait for confirmation. There is deliberately no config key that turns that off ([Safety](#safety)).
- **It never blindly retries a write.** Kite has no idempotency key, so a timed-out order is genuinely ambiguous. Rather than retry, the CLI tags every order and reconciles against the orderbook ([Safety](#safety)).
- **Your secrets stay put.** The API secret lives in your OS keyring (or an encrypted file), is never accepted as a command-line argument, and is scrubbed from every log, error and stack trace — with [tests](https://github.com/pungoyal/kite-cli/blob/main/test/redact.test.ts) that prove it ([Security](#security)).
- **Verifiable builds.** Published only from CI via [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC, no long-lived token). Check the provenance yourself with `npm audit signatures`.
- **A small, auditable surface.** ~10 direct dependencies, most of them zero-dependency, enforced by a dependency budget in CI.

## How it compares

Zerodha maintains excellent official SDKs — [`pykiteconnect`](https://github.com/zerodha/pykiteconnect)
and [`kiteconnectjs`](https://github.com/zerodha/kiteconnectjs). If you're building an
application, reach for those. `kite-cli` is complementary — the same API as a
ready-to-use tool, for when you'd rather not write code:

- **Zero code for everyday use.** `kite holdings`, `kite watch --holdings`, `kite orders place …` run straight from the shell — and from any language that can shell out.
- **An opinionated safety layer.** A kill switch, per-order value cap, resolved-order confirmation, and unique-tag reconciliation come built in — decisions the official SDKs deliberately leave to each application.
- **Composable output.** Every command speaks `--json` on stdout, so it drops straight into `jq`, cron jobs, and pipelines.
- **A library too, when you need one.** The same client is [exported](#library-use), so you can start in the shell and drop into code without switching tools.

## Install

```bash
npm install -g @pungoyal/kite-cli
```

Requires **Node 22.12 or newer**.

## Getting started

You need a [Kite Connect](https://developers.kite.trade) app for its API key and
secret. Set the app's redirect URL to `http://127.0.0.1:51101/callback`, then:

```bash
kite login
```

Your browser opens, you log in to Zerodha normally (including your TOTP), and the
CLI captures the callback on loopback. The API secret goes into your OS keyring;
the daily access token is stored alongside it.

**On a headless server?** There's no browser to reach `127.0.0.1` on a remote box,
so login detects the missing display and skips launching one. Run `kite login --manual`
(or press `m` while the callback is waiting): it prints a URL to open on any other
device, and you paste the redirected URL back into the terminal. The API secret
prompt still needs a TTY — set `KITE_API_SECRET` instead when scripting.

Two more things worth knowing on day one: sessions expire at **6:00 AM IST daily**
(a Kite requirement — you log in once per trading day), and running more than one
Zerodha account is supported through [profiles](#multiple-accounts).

## Everyday commands

```bash
# Portfolio
kite holdings                          # long-term holdings with P&L
kite positions --day                   # intraday positions
kite funds                             # available margin
kite mf holdings                       # mutual funds (read-only over Kite Connect)

# Market data
kite quote NSE:INFY --depth            # full quote with the 5-level order book
kite ltp NSE:INFY NSE:TCS              # just last traded prices
kite history NSE:INFY -i 5minute --from 7d --csv > infy.csv
kite instruments search "nifty bank"   # find a tradingsymbol
kite watch --holdings                  # live, self-updating table

# Trading — every one of these previews and confirms first
kite orders place NSE:INFY -s BUY -q 10 -t LIMIT -p 1500
kite orders list --open                # working orders
kite orders get 250720000123456        # what actually happened
kite gtt place NSE:INFY -s SELL -q 10 --stoploss 1400 --target 1700 -t MARKET
kite alerts create NSE:INFY -o above --value 1800
kite margins basket NFO:NIFTY25AUGFUT:BUY:75:NRML   # cost it before placing it

# Housekeeping
kite doctor                            # offline health checks, no network call
kite completion fish > ~/.config/fish/completions/kite.fish
```

Add `--dry-run` to anything that would move money to see exactly what would be
sent, without sending it.

Every command carries worked examples of its own — `kite gtt place --help` shows
both GTT shapes, `kite alerts create --help` shows simple and order-placing
alerts, and so on. The same examples, flag by flag, are in the
**[command reference](https://pungoyal.github.io/kite-cli/commands)**.

## Safety

This tool spends real money, so the defaults are conservative. Order commands
render the **resolved** order — the actual instrument token, lot size and computed
value, not an echo of your flags — and wait for confirmation:

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

That's deliberate: a flag echo can't catch "I typed the wrong symbol and it
resolved to a different contract," which is the expensive mistake.

- **Escalation.** Above ₹1,00,000 (configurable) a keystroke isn't enough — you type the trading symbol.
- **Non-interactive means refuse.** With no TTY and no `--yes`, order commands exit non-zero rather than silently proceeding.
- **`--yes` is call-site only.** There is deliberately no config setting to disable confirmations globally.
- **No blind retries.** `POST`/`PUT`/`DELETE` — place, modify, cancel — are never retried. Each order carries a unique tag, and an ambiguous failure is reconciled against the orderbook: `kite orders reconcile <tag>` tells you whether it reached Kite, so you never place it twice.

```bash
kite config set trading.enabled false        # kill switch: refuse all order commands
kite config set trading.maxOrderValue 50000  # refuse orders above ₹50,000
```

→ The full model — all four layers, why cancels and converts are exempt from the
value cap, and how tag reconciliation recovers a lost placement:
[the safety model](https://pungoyal.github.io/kite-cli/safety).

## Multiple accounts

Running more than one Zerodha account — your own, a family member's, an HUF? Each
gets a named **profile** with its own Kite Connect credentials, its own daily
session, and its own safety caps.

```bash
kite profiles add huf          # register a profile (create its Kite app first)
kite --profile huf login       # log in to it
kite --profile huf holdings    # run any command against it
kite profiles use huf          # make it the default for commands without --profile
```

Selection is resolved fresh on every run — there is no hidden "active account."
Because targeting the wrong account is the costly mistake here, every money-moving
confirmation names the **verified** account it will hit: the user id Kite returned,
not just the label you chose.

→ Profile resolution order, per-profile caps and the environment-variable guard:
[the configuration reference](https://pungoyal.github.io/kite-cli/configuration#profiles).

## Scripting

Every command supports `--json`, writes data to stdout and everything else to
stderr, and returns a meaningful exit code.

```bash
kite positions --json | jq '.[] | select(.pnl < 0) | .tradingsymbol'
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

## Configuration

```bash
kite config show
kite config set trading.maxOrderValue 50000
kite config path
```

Config lives at `~/.config/kite/config.json` (`0600`); override the location with
`KITE_CONFIG_DIR`. `trading.*` and `apiKey` can be set per profile by adding
`--profile <name>`.

→ Every key and environment variable, with precedence:
[the configuration reference](https://pungoyal.github.io/kite-cli/configuration).

## Security

- **Credentials** resolve from `KITE_API_SECRET`/`KITE_ACCESS_TOKEN` (never persisted), then the OS keyring, then an encrypted file (scrypt + AES-256-GCM, mode `0600`). The API secret is never accepted as a command-line argument — argv is visible via `ps` and lands in shell history.
- **Redaction.** Access tokens are registered with a scrubber that runs over every log line, error and stack trace, covering both paths that carry one: the `Authorization` header and the WebSocket URL.
- **TOTP.** This CLI will never ask for or store your 2FA seed. Storing it next to your API secret would collapse both authentication factors into one — exactly what the SEBI 2FA mandate exists to prevent.
- **Supply chain.** Published from GitHub Actions via [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) with OIDC and provenance; CI actions pinned to commit SHAs; dependency lifecycle scripts disabled.

→ Full threat model and what it deliberately does *not* defend against:
[SECURITY.md](https://github.com/pungoyal/kite-cli/blob/main/SECURITY.md). Storage
precedence in detail: [the configuration reference](https://pungoyal.github.io/kite-cli/configuration#credential-storage-precedence).

## Agents (MCP)

`kite mcp` exposes Kite's **read-only** endpoints to an LLM agent over the
[Model Context Protocol](https://modelcontextprotocol.io), so Claude — or any MCP
client — can answer "how's my portfolio doing?" against live data. It can read your
profile, holdings, positions, funds, orders, trades, quotes and instruments; it
**cannot** place, modify or cancel anything. Trading stays at a human-confirmed
terminal, by design.

```json
{ "mcpServers": { "kite": { "command": "kite", "args": ["mcp"] } } }
```

→ Every tool, setup for other clients, and why there are no writes:
[the MCP reference](https://pungoyal.github.io/kite-cli/mcp).

## Things worth knowing about Kite

- **Sessions expire at 6:00 AM IST daily**, and logging into Kite *web* invalidates your API session — detectable only as a later 403.
- **Order acceptance is not execution.** A returned order ID means the OMS accepted the request; check `kite orders get <id>` for what actually happened.
- **Rate limits are tight**: quotes 1/sec, historical 3/sec, orders 10/sec (plus 400/min and 5,000/day). The CLI paces requests and batches quotes for you.
- **Historical data is a paid add-on** — a 403 there is a permission problem, not an expired session.
- **Mutual funds are read-only** over the API, and `mf orders` only reaches back 7 days.

→ Symptom-first fixes for all of these:
[the troubleshooting guide](https://pungoyal.github.io/kite-cli/troubleshooting).

## Documentation

This README covers installation and everyday usage. The full reference is a
searchable site at **[pungoyal.github.io/kite-cli](https://pungoyal.github.io/kite-cli/)**:

- [Command reference](https://pungoyal.github.io/kite-cli/commands) — every command and flag, with worked examples, generated from `--help`.
- [Safety model](https://pungoyal.github.io/kite-cli/safety) — kill switch, value cap, confirmation escalation, order-tag reconciliation.
- [Configuration](https://pungoyal.github.io/kite-cli/configuration) — every config key and environment variable, with precedence.
- [MCP server](https://pungoyal.github.io/kite-cli/mcp) — the read-only server for LLM agents: its tools, setup, and why it exposes no writes.
- [Troubleshooting](https://pungoyal.github.io/kite-cli/troubleshooting) — symptom-first fixes for session expiry, rate limits and login issues.
- [Library API](https://pungoyal.github.io/kite-cli/api) — the programmatic API surface.

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

You get the same rate limiting, response validation, redaction, and error taxonomy
the CLI uses. → [Library API reference](https://pungoyal.github.io/kite-cli/api).

## Development

```bash
npm install
npm run dev -- holdings   # run from source
npm test
npm run typecheck
npm run build
```

## Contributing

Bug reports, ideas, and pull requests are welcome. See [CONTRIBUTING.md](https://github.com/pungoyal/kite-cli/blob/main/CONTRIBUTING.md) for the development workflow and the three non-negotiables (safety defaults, secret redaction, no blind retries of writes), and [CHANGELOG.md](https://github.com/pungoyal/kite-cli/blob/main/CHANGELOG.md) for release history. Security issues go through [SECURITY.md](https://github.com/pungoyal/kite-cli/blob/main/SECURITY.md), never a public issue.

## Disclaimer

This is an unofficial, independent, community project. It is **not affiliated with, endorsed by, or sponsored by Zerodha**. "Kite", "Kite Connect", and "Zerodha" are trademarks of Zerodha Broking Ltd.; this project references them only to identify the third-party API it interoperates with (nominative use) and claims no rights to those marks.

Trading involves risk of financial loss. This software is provided as-is under the MIT licence — you are responsible for every order it places on your behalf. Test with `--dry-run` before trusting it with real money.

## Licence

[MIT](https://github.com/pungoyal/kite-cli/blob/main/LICENSE)
