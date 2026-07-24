# Troubleshooting

Symptom-first fixes for the operational gotchas that come up running this
CLI against a real Kite Connect app. For the exit code a script can branch
on, see the [exit code table](scripting.md#exit-codes); this page
explains *why* each one happens and what to do about it.

Before digging through the sections below, run `kite doctor` — it makes no
network call and checks config file existence/permissions, OS keyring
reachability, whether an API secret is stored, the cached session's expiry,
and whether the login callback port is free. It's the fastest way to rule out
a local setup problem before treating something as a Kite-side issue.

## "Not logged in" / `whoami` fails, exit code 3

**Most likely: it's after 06:00 IST.** Kite Connect sessions die at 06:00
IST every day, regardless of when you logged in — this is a regulatory
requirement, not a bug, and there's no refresh-token path for individual
subscriber apps. Run `kite login` again.

**Or: you (or someone else) logged into Kite web on this account.** A
Kite-web login invalidates the API session for that account, and the CLI
cannot detect this proactively — it only shows up as a `403`/`TokenException`
on the next request. If `whoami` was working minutes ago and now fails,
this is more likely than expiry.

**Or: a stored token belongs to a different API key.** If you've rotated
your Kite Connect app's key, a session saved under the old key is treated
as absent (rather than sent and getting a confusing `403`) — just
`kite login` again for the new key.

## Historical data returns 403

This is **not** an expired session — it's a permission problem. Historical
Data is a paid Kite Connect add-on; a `403` here means your app isn't
subscribed to it, and re-running `kite login` will not fix it. Check your
subscription at [developers.kite.trade](https://developers.kite.trade).

(A `403` on any *other* endpoint usually does mean an expired/invalidated
session — see above. Historical data is the one endpoint where `403` means
something else.)

## An order placement timed out — did it execute?

Read the CLI's own output first — it already checked for you:

```
$ kite orders place NSE:INFY -s BUY -q 10 --type LIMIT --price 1500 --yes
! The order request failed: Request timed out
· Checking whether it reached Kite anyway…
! The order DID reach Kite: 250720000123456 (COMPLETE).
· It was not placed twice. Do not re-run this command.
```

Every order is tagged with a value unique to that placement attempt. On a
failed or ambiguous write, the CLI searches the orderbook for that exact
tag and reports the true outcome — "it reached Kite" (with the resulting
order ID and status) or "it was not placed, safe to retry." Trust that
message over guessing; see [safety.md](safety.md#no-blind-retries-order-tag-reconciliation)
for how the reconciliation works. If you interrupted the reconciliation
check itself (e.g. Ctrl-C), run `kite orders list` or `kite orders get <id>`
(if you have a suspected ID) to check manually.

## `kite login` hangs, or fails with an address-in-use error

The login flow starts a local loopback HTTP server on `redirectPort`
(default `51101`) to catch Kite's OAuth callback. Two common causes:

- **Something else is already listening on that port.** Either free the
  port, or change it: `kite config set redirectPort <port>` — but you must
  also update the redirect URL registered for your app at
  [developers.kite.trade](https://developers.kite.trade) to match exactly,
  or Kite will refuse the redirect.
- **You're on a remote shell / SSH session** with no browser able to reach
  `127.0.0.1` on your machine. Use `kite login --manual` instead: it prints
  the login URL for you to open anywhere, and you paste back the
  `request_token` from the resulting redirect URL.

## Keyring errors, or credentials silently falling back to a file

On headless Linux (no D-Bus / no Secret Service), or any platform where the
native keyring module has no prebuilt binary, the OS keyring is
unreachable. The CLI detects this and falls back to the encrypted file
store automatically — you'll need `KITE_CREDENTIALS_PASSPHRASE` set for
that fallback to work non-interactively. To skip the keyring probe
entirely (faster startup in CI, or to avoid noisy failures), set
`KITE_DISABLE_KEYRING=1`. See [configuration.md](configuration.md#credential-storage-precedence)
for the full precedence order.

## A command hit the wrong account

Check which profile actually resolved. Selection has no persistent "active
account" — it's recomputed every invocation from `--profile` /
`KITE_PROFILE` / the configured default, in that order (see
[configuration.md](configuration.md#profile-resolution)).
Run `kite whoami --all` to see every profile's session status, and always
check the **Account** line on a confirmation/dry-run preview before
approving — it shows the verified `user_id` Kite returned, not just the
profile label. If you named a profile explicitly and got an error instead
of the wrong account, that's the fail-closed guard working as intended: an
ambient `KITE_ACCESS_TOKEN`/`KITE_API_SECRET` is refused rather than
silently overriding an explicitly-chosen profile.

## Rate limited (exit code 8)

Kite's limits are tight: quotes 1/sec, historical data 3/sec, orders
10/sec (plus 400/min and 5,000/day). The CLI already paces its own
requests and batches quotes (up to 1,000 instruments per call), so a `429`
usually means either a very tight loop of your own around the CLI, or
several `kite` invocations running concurrently against the same account.
Space out repeated calls, or batch multiple instruments into a single
`kite quote`/`kite ltp` invocation instead of one call per symbol.

## `kite watch` shows nothing / disconnects

`watch` needs a live access token — the same session `whoami` uses. Kite
also caps a single WebSocket connection at 3,000 instruments (`kite watch`
refuses upfront with a clear error if you ask for more); splitting a
watchlist that large across multiple `kite watch` invocations is the
workaround. If output looks garbled or fields seem swapped between runs,
note that index instruments and tradeable instruments use different tick
packet layouts (including reordered OHLC fields) — this is a Kite wire
format quirk, not a data error; see the dispatch logic in
[`src/core/ticker.ts`](https://github.com/pungoyal/kite-cli/blob/main/src/core/ticker.ts) if you're consuming the
library API directly.
