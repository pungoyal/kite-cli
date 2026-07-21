# kite-cli

[![CI](https://github.com/pungoyal/kite-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/pungoyal/kite-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@pungoyal/kite-cli.svg)](https://www.npmjs.com/package/@pungoyal/kite-cli)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A5%2022.12-brightgreen.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

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

## Install

```bash
npm install -g @pungoyal/kite-cli
```

Requires **Node 22.12 or newer**.

## Getting started

You need a [Kite Connect](https://developers.kite.trade) app to get an API key and secret. Set your app's redirect URL to:

```
http://127.0.0.1:51101/callback
```

Then:

```bash
kite login
```

This opens your browser, you log in to Zerodha normally (including your TOTP), and the CLI captures the callback on loopback. Your API secret goes into your OS keyring; the daily access token is stored alongside it.

**Want to try it without a subscription or real money?** Zerodha runs a public sandbox:

```bash
kite login --env sandbox
kite --env sandbox holdings
```

## Usage

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
kite trades                            # today's fills

kite gtt list
kite gtt place NSE:INFY --side SELL --quantity 10 \
  --trigger 1400 --price 1395 \
  --trigger 1700 --price 1695          # two-leg OCO
kite gtt delete <id>
```

Add `--dry-run` to any of these to see exactly what would be sent, without sending it.

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

## Safety

This tool spends real money, so the defaults are conservative.

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

Automatic retries are restricted to `GET`/`HEAD` at the transport layer. `POST`, `PUT` and `DELETE` are never retried — in this API those are place, modify and cancel.

## Security

**Credentials** are resolved in this order:

1. `KITE_API_SECRET` / `KITE_ACCESS_TOKEN` environment variables — for CI and containers, never persisted
2. OS keyring — macOS Keychain, Windows Credential Manager, Linux Secret Service
3. Encrypted file at `~/.config/kite/credentials.enc` — scrypt (N=2¹⁷) + AES-256-GCM, mode `0600`, with the KDF header bound as authenticated data so parameters can't be downgraded

Your API secret is never accepted as a command-line argument, because argv is visible to any local process via `ps` and lands in shell history. It's prompted for, or read from the environment.

**Redaction.** Access tokens are registered with a scrubber that runs over every log line, error message, and stack trace. The two paths that carry a token — the `Authorization` header and the WebSocket URL, where it's a query parameter — are covered explicitly and [tested](test/redact.test.ts).

**TOTP.** This CLI will never ask for or store your 2FA seed. Storing it next to your API secret would collapse both authentication factors into one, which is exactly what the SEBI 2FA mandate exists to prevent. Login happens in your browser; the CLI only sees the resulting request token.

**Supply chain.** 10 direct runtime dependencies, most of them zero-dependency. Published from GitHub Actions via [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) with OIDC — no long-lived publish token exists. Provenance attestation is generated automatically; verify it with `npm audit signatures`. All CI actions are pinned to full commit SHAs, and dependency lifecycle scripts are disabled.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

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

## Things worth knowing about Kite

- **Sessions expire at 6:00 AM IST daily.** This is a regulatory requirement and there's no way around it — you log in once per trading day. Refresh tokens exist in the API but are only issued to exchange-approved platforms, not individual subscribers.
- **Logging into Kite web invalidates your API session.** The CLI can't detect this until a request comes back 403.
- **Order acceptance is not execution.** A returned order ID means the OMS accepted the request. Check `kite orders get <id>` for what actually happened.
- **Rate limits are tight**: quotes 1/sec, historical 3/sec, orders 10/sec (plus 400/min and 5,000/day). The CLI paces requests for you and batches quotes automatically — one call handles up to 1,000 instruments.
- **Kite caps order modifications at 25** per order. After that you must cancel and re-place.
- **Instruments are cached by `exchange:tradingsymbol`, never by token.** Exchanges reuse numeric instrument tokens after expiry, so a token-keyed cache silently resolves to the wrong contract after a rollover.
- **Mutual funds are read-only** over the API — placing MF orders requires a bank debit that has no API path.

## Library use

The client is exported if you want it without the CLI:

```ts
import { KiteClient, KiteApi, endpointsFor } from '@pungoyal/kite-cli';

const client = new KiteClient({
  apiKey: process.env.KITE_API_KEY!,
  accessToken: process.env.KITE_ACCESS_TOKEN!,
  endpoints: endpointsFor('production'),
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

Bug reports, ideas, and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and the two non-negotiables (safety defaults and secret redaction), and [CHANGELOG.md](CHANGELOG.md) for release history. Security issues go through [SECURITY.md](SECURITY.md), never a public issue.

## Disclaimer

This is an unofficial, independent, community project. It is **not affiliated with, endorsed by, or sponsored by Zerodha**. "Kite", "Kite Connect", and "Zerodha" are trademarks of Zerodha Broking Ltd.; this project references them only to identify the third-party API it interoperates with (nominative use) and claims no rights to those marks.

Trading involves risk of financial loss. This software is provided as-is under the MIT licence — you are responsible for every order it places on your behalf. Test with `--env sandbox` and `--dry-run` before trusting it with real money.

## Licence

[MIT](LICENSE)
