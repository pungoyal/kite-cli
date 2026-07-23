# The safety model

This CLI places real orders with real money, so every money-moving command
goes through the same layered guard, cheapest check first. This page is the
deep dive; see the README's [Safety](https://github.com/pungoyal/kite-cli#safety) section for the
short version.

The guard lives in [`src/safety.ts`](https://github.com/pungoyal/kite-cli/blob/main/src/safety.ts) and is exercised by
`orders place/modify/cancel`, `gtt place/delete`, `convert`, and ATO
`alerts create` (see [Alerts: simple vs ATO](#alerts-simple-vs-ato) below).

## The four layers

1. **Kill switch** — `trading.enabled` (default `true`). Checked before any
   network call. `kite config set trading.enabled false` refuses every
   order-mutating command outright:

   ```
   $ kite orders place NSE:INFY -s BUY -q 10 --type MARKET
   ✗ Trading is disabled by the local kill switch.
     Re-enable it with `kite config set trading.enabled true`.
   ```

2. **Value cap** — `trading.maxOrderValue` (rupees, unset by default).
   Applies only to orders that **increase exposure** (see below). Refuses
   any single order whose notional value exceeds the cap:

   ```
   $ kite orders place NSE:INFY -s BUY -q 1000 --type LIMIT --price 1500
   ✗ Order value ₹15,00,000.00 exceeds your configured cap of ₹5,00,000.00.
     Raise it with `kite config set trading.maxOrderValue <amount>`, or unset it to remove the cap.
   ```

3. **`--dry-run`** — renders the full resolved preview and exits `0`
   without sending anything to Kite. The preview shown is identical to the
   confirmation preview below, so `--dry-run` is a reliable way to check
   what a command *would* do.

4. **Confirmation** — a y/N prompt, escalating to a typed challenge above
   `trading.strictConfirmAbove` (default ₹1,00,000) or whenever the order's
   value could not be determined. `--yes` skips the prompt; it is a
   **call-site flag only** — there is no config key to disable
   confirmations globally, so bypassing safety must be an explicit act on
   every invocation. See [Configuration](configuration.md) for how these
   keys are set and how per-profile overrides inherit them.

The preview always renders the **resolved** facts — the actual instrument
that was matched, the computed value, the verified account — never an echo
of the flags you typed. A flag echo cannot catch "I typed the wrong symbol
and it resolved to a different contract," which is precisely the mistake
that costs money. In the normal (non-`--quiet`, non-`--json`) case the
preview is printed regardless of `--yes`, so an unattended terminal run
still keeps a record in the scrollback. Under `--quiet`/`--json` the
preview is normally suppressed, *except* when a prompt is actually about to
be shown — asking someone to approve an order while showing them none of
the resolved facts would not be informed consent, so a prompt is never
shown without its preview, even in quiet/JSON mode.

## `increasesExposure`: why cancels and converts are treated differently

The value cap and the "unknown value escalates" rule apply **only** to
actions that add or increase market exposure — placing a new order,
modifying one to a larger quantity, or an ATO alert that will place an
order. They do **not** apply to cancelling an order or converting a
position between products.

This is deliberate: cancelling or converting *reduces or merely reshapes*
risk, it never creates new exposure. Blocking a cancel because its notional
value couldn't be computed would be exactly backwards — it would leave you
unable to cancel your way out of a position at the one moment (a stale
quote, a rate-limited quote lookup) that a value cannot be verified.

## Fail-closed on an unknown value

If an exposure-increasing order's notional value cannot be computed —
typically because a quote lookup failed or was rate-limited (the quote
bucket is 1 request/second, so a `429` is easy to hit) — the CLI treats
that as **worse than a large order**, not as within the cap:

- Against the value cap: refused outright, with a hint to pass an explicit
  `--price` or unset the cap.
- Against the confirmation escalation: an unknown value always triggers the
  typed challenge, even below `strictConfirmAbove` — because "we don't know
  what this will cost" is exactly the case where a single keystroke isn't
  enough friction.

Treating "unknown" as "safe" would mean the one guard you explicitly
configured silently stops applying at precisely the moment the CLI is
least sure what it's about to do.

## Non-interactive terminals refuse, they don't proceed

If confirmation is required (`trading.confirm: true`, the default) and
stdin is not a TTY, the command refuses with `ExitCode.ConfirmationRequired`
(`11`) rather than silently going ahead. This applies even if the command
is piped or run from a script:

```
$ echo | kite orders place NSE:INFY -s BUY -q 10 --type MARKET
✗ Place BUY order for 10 INFY requires confirmation, but this is not an interactive terminal.
  Pass --yes to confirm non-interactively, or --dry-run to preview without sending.
```

Pass `--yes` explicitly for scripted/CI use, or `--dry-run` to validate
without sending.

## No blind retries: order-tag reconciliation

Kite Connect has no idempotency key: a `POST /orders` that times out is
genuinely ambiguous, it may or may not have reached the OMS. This CLI never
retries a write (`POST`/`PUT`/`DELETE` — place, modify, cancel — are excluded
from the transport's retry policy; only `GET`/`HEAD` retry automatically).

Instead, every order is tagged with a value unique to that placement
(`buildOrderTag` in [`src/safety.ts`](https://github.com/pungoyal/kite-cli/blob/main/src/safety.ts)), built by taking any
`--tag` you supplied as a prefix and appending a random suffix so it can
never collide with an earlier order carrying the same user-chosen tag. A
reused tag would let the reconciliation path find the *earlier* order and
wrongly report "already placed" when nothing new was sent — the suffix is
what makes the tag a reliable placement key rather than just a label.

On a failed or timed-out placement, the CLI searches the day's orderbook for
that exact tag and reports what actually happened, rather than guessing:

```
$ kite orders place NSE:INFY -s BUY -q 10 --type LIMIT --price 1500 --yes
! The order request failed: Request timed out
· Checking whether it reached Kite anyway…
! The order DID reach Kite: 250720000123456 (COMPLETE).
· It was not placed twice. Do not re-run this command.
```

If reconciliation finds nothing, the CLI reports that the order was **not**
placed and it is safe to retry — never leaves you to guess.

## Alerts: simple vs. ATO

`kite alerts create` supports two kinds of alert, and only one of them is
subject to the safety model above:

- **Simple** (`--type simple`, the default) — notifies you when a price
  condition is met. It moves no money, so the kill switch, value cap, and
  confirmation escalation do not apply.
- **ATO** (`--type ato`, Alert-Triggers-Order) — places a real order when
  the condition fires. Creating one goes through exactly the same
  `assertTradingEnabled` / `assertWithinValueCap` / confirmation path as
  `orders place`, because the money-moving event is the alert *firing*, not
  just its creation — by the time it fires, no one is there to confirm it.

An ATO can carry a **basket** of orders (`--order`, repeatable), each on its own
instrument and independent of the watched one. The value cap applies to the
basket *total*: every leg is priced and summed, and if any single leg cannot be
priced the whole total is treated as unknown, so the cap escalates rather than
waving the alert through. A leg specification that cannot be parsed
unambiguously is rejected outright — a silently mis-parsed leg would be a real
order with the wrong parameters.

`kite alerts enable`/`disable`/`delete` all go through the same
`assertTradingEnabled` / confirmation gate whenever a target is an ATO alert —
`enable`/`disable` because toggling one changes whether its basket can fire,
and `delete` because removing one cancels a live order-arming trigger, the
same reasoning `orders cancel` and `gtt delete` already apply to their own
"only unwinds risk" actions. `delete` treats an alert it could not verify as
though it might be ATO rather than assuming simple, so an unreachable lookup
fails closed onto the kill switch rather than skipping it. `enable`/`disable`
do **not** re-check the value cap: the basket was already priced and capped at
`create` time, and `enable` re-arms it as-is rather than re-quoting every leg —
if `trading.maxOrderValue` was tightened since creation, `enable` can still
re-arm a basket above the *current* cap.

Kite's alerts API does not document a `status` parameter or a dedicated
toggle endpoint — the CLI sends the request anyway, but verifies with a fresh
`GET` afterwards before reporting success — not the PUT response itself,
since an undocumented field could be echoed straight back from the request
without ever being persisted. If Kite silently ignores the field, the command
exits non-zero instead of claiming the alert is disabled while it is still
fully live.

## Account identity in every preview

Every confirmation and dry-run preview shows the **verified account** —
the `user_id` Kite's API actually returned for the active session — not
just the `--profile` label you passed. With more than one profile logged
in, this is the primary defence against the wrong-account mistake: a
`--profile` flag is just a local label, but the account line is fetched
from Kite itself. See [Configuration](configuration.md#profiles) for how
profiles and their per-profile trading overrides are resolved.

## What this model doesn't cover

This page is about the client-side guards this CLI adds on top of the Kite
Connect API. It intentionally does not re-describe the broader security
posture (threat model, what's out of scope, TOTP/2FA handling) — see
[SECURITY.md](https://github.com/pungoyal/kite-cli/blob/main/SECURITY.md) for that.
