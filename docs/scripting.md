# Scripting and automation

Every command is designed to be called by something other than a human: data on
stdout, everything else on stderr, `--json` everywhere, and an exit code that
says *what* went wrong rather than just *that* it did.

This page is the contract that a cron job, a CI step, or a shell pipeline can
rely on. For the flags of any individual command, see the
[command reference](commands.md).

## The output contract

- **stdout carries data only.** Tables, JSON, CSV — nothing else.
- **stderr carries everything else.** Prompts, spinners, warnings, hints, errors.
  Redirecting stdout to a file never swallows a diagnostic, and never mixes one
  into your data.
- **`--json` is universal.** Every command accepts it. Output is pretty-printed
  when stdout is a TTY and minified when it is piped, so `| jq` and
  `> file.json` both do the right thing.
- **Secrets never appear.** JSON output passes through the same redactor as logs
  and errors, so an access token cannot ride out on a piped payload.
- **`kite watch --json` streams NDJSON** — one JSON object per line, one per
  tick, each carrying an `instrument` key. It also switches to NDJSON
  automatically when stdout is not a TTY, so the live dashboard never lands in a
  log file.

```bash
kite positions --json | jq '.[] | select(.pnl < 0) | .tradingsymbol'
kite holdings --json | jq '[.[] | .pnl] | add'
kite ltp NSE:INFY --json | jq '."NSE:INFY".last_price'
kite history NSE:INFY -i 5minute --from 7d --csv > infy.csv
kite watch --holdings --json >> ticks.ndjson
```

A command's JSON payload is the data it displays — `kite positions --json` emits
the array of positions being shown, not a `{net, day}` envelope, so a consumer
never has to branch on the flag that was passed.

## Exit codes

| Code | Name | Meaning |
|-----:|---|---|
| 0 | `Ok` | Success |
| 1 | `Failure` | Unclassified failure |
| 2 | `Usage` | Bad usage — unknown flag, missing or invalid argument |
| 3 | `Auth` | Not logged in, or the session expired |
| 4 | `Input` | Kite rejected the input |
| 5 | `Order` | Order rejected by the exchange's OMS |
| 6 | `Margin` | Insufficient margin |
| 7 | `Holding` | Insufficient holdings to sell |
| 8 | `RateLimit` | Rate limited (HTTP 429) |
| 9 | `Upstream` | Kite or its upstream OMS is unreachable or erroring |
| 10 | `Aborted` | You declined a confirmation |
| 11 | `ConfirmationRequired` | Confirmation required, but the terminal is not interactive |
| 12 | `AuthorisationRequired` | Holdings need depository authorisation — run `kite authorise` |
| 13 | `TradingDisabled` | Blocked by the local kill switch or order value cap |

Source of truth: `ExitCode` in
[`src/core/errors.ts`](https://github.com/pungoyal/kite-cli/blob/main/src/core/errors.ts).

The codes are worth branching on, because they distinguish problems your script
can fix from ones it cannot:

```bash
kite whoami --json || kite login          # 3 means "no session"

kite orders place NSE:INFY -s BUY -q 10 --yes
case $? in
  0)  echo "placed" ;;
  6)  echo "not enough margin — skipping" ;;
  8)  sleep 60 ;;                         # rate limited; back off
  13) echo "kill switch or value cap is on" >&2; exit 1 ;;
esac
```

## Running without a terminal

Order commands confirm interactively by default. With no TTY and no `--yes` they
exit `11` rather than proceeding silently — a script that forgot to opt in fails
loudly instead of trading.

```bash
kite orders place NSE:INFY -s BUY -q 10 --yes
```

`--yes` is deliberately call-site only: there is no config key that disables
confirmations globally, so bypassing the prompt is an explicit act every time.
Pair it with the kill switch and the value cap, which still apply:

```bash
kite config set trading.maxOrderValue 50000   # refuse anything larger
kite config set trading.enabled false         # refuse everything
```

Use `--dry-run` to exercise a script end to end without sending anything —
it resolves the order, applies every safety check, and stops before the write.

See [the safety model](safety.md) for what `--yes` does *not* switch off.

## Never retry a write

Kite has no idempotency key, so a timed-out placement is genuinely ambiguous: it
may have executed. Nothing in this CLI retries `POST`/`PUT`/`DELETE`, and your
script should not either. Reconcile instead:

```bash
tag="job$(date +%s)"
kite orders place NSE:INFY -s BUY -q 10 --tag "$tag" --yes || \
  kite orders reconcile "$tag" --json | jq -e .placed
```

`orders reconcile` returns a `placed` boolean and the matching orders, so a
recovering script can tell "it never reached Kite" from "it went through, do not
send it again". Retrying safe reads is fine — `GET`/`HEAD` are retried for you at
the transport layer, with rate limits paced automatically.

## Credentials in CI and containers

Environment variables bypass the keyring entirely and are never persisted:

```bash
export KITE_API_KEY=...
export KITE_ACCESS_TOKEN=...     # obtained interactively, valid until 6:00 AM IST
export KITE_DISABLE_KEYRING=1    # skip the keyring probe on a headless box
```

The daily session expiry is a Kite requirement, not a CLI limitation: an access
token cannot be minted non-interactively, so a long-lived job needs a human
login once per trading day. Have the job fail on exit code `3` rather than
retrying blindly.

Naming a profile explicitly (`--profile` or `KITE_PROFILE`) while
`KITE_ACCESS_TOKEN`/`KITE_API_SECRET` is set is refused rather than silently
overridden — see [profile resolution](configuration.md#profile-resolution).

## Terminal and colour behaviour

| Variable | Effect |
|---|---|
| `NO_COLOR` | Disables colour whenever set and non-empty |
| `FORCE_COLOR` | Forces colour on even when stdout is not a TTY |
| `COLUMNS` | Table width when stdout reports no column count (default `80`) |
| `TERM=dumb` | Disables colour |

Colour is off automatically when stdout is not a TTY, so piped output is plain
without any flag. `--color never` and `--quiet` (suppress informational messages)
make it explicit; `--color always` keeps colour through a pager.

## Recipes

```bash
# Alert on any holding down more than 5% today
kite holdings --json |
  jq -r '.[] | select(.day_change_percentage < -5) | "\(.tradingsymbol) \(.day_change_percentage)%"'

# Cancel every working order
kite orders list --open --json | jq -r '.[].order_id' | xargs -n1 kite orders cancel -y

# Daily P&L into a CSV, from cron (after login for the day)
printf '%s,%s\n' "$(date +%F)" "$(kite positions --json | jq '[.[].pnl] | add')" >> pnl.csv

# Cost a basket before placing it — nothing is sent to the exchange
kite margins basket NFO:NIFTY25AUG24500CE:SELL:75:MARKET:NRML \
                    NFO:NIFTY25AUG24700CE:BUY:75:MARKET:NRML --json
```

## See also

- [Command reference](commands.md) — every command and flag, with worked examples.
- [Safety model](safety.md) — what confirmation, the kill switch and the value cap do.
- [Configuration](configuration.md) — every config key and environment variable.
- [Troubleshooting](troubleshooting.md) — symptom-first fixes, including rate limits and session expiry.
