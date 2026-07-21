import { confirm, text, isCancel } from '@clack/prompts';
import { randomBytes } from 'node:crypto';
import { KiteCliError, ExitCode, AbortedError } from './core/errors.js';
import { rupees } from './output/format.js';
import type { Context } from './context.js';

/**
 * Guard rails for money-moving commands.
 *
 * Layered, cheapest first:
 *
 *   1. Kill switch    — config `trading.enabled: false` refuses before any network call
 *   2. Value cap      — config `trading.maxOrderValue` refuses oversized orders
 *   3. --dry-run      — renders the resolved action and exits 0 without calling the API
 *   4. Confirmation   — y/N, escalating to type-the-symbol above a threshold
 *
 * Two rules that are easy to get wrong and important to get right:
 *
 *   - No TTY and no `--yes` means REFUSE, exit non-zero. Never silently proceed
 *     just because stdin is not interactive.
 *   - The prompt renders the RESOLVED action — the actual instrument token,
 *     the computed value — not an echo of the flags. A flag echo cannot catch
 *     "I typed the wrong symbol and it resolved to a different contract",
 *     which is precisely the expensive mistake.
 */

export interface ConfirmationDetail {
  label: string;
  value: string;
}

export interface ConfirmOptions {
  /** Short imperative summary, e.g. "Place BUY order". */
  action: string;
  /** The resolved facts shown to the user before they commit. */
  details: ConfirmationDetail[];
  /** Notional value in rupees, used for the cap and escalation checks. */
  notionalValue?: number | undefined;
  /**
   * Does this action create or increase market exposure?
   *
   * Only these are subject to `trading.maxOrderValue`, and only these fail
   * closed on an unknown value. Cancelling an order or converting a position
   * REDUCES or merely reshapes risk — blocking those because a cap could not
   * be evaluated would be exactly backwards, and would leave a user unable to
   * cancel their way out of a position.
   */
  increasesExposure?: boolean;
  /**
   * When escalation triggers, the user must type this string exactly.
   * Usually the trading symbol.
   */
  challengeToken?: string | undefined;
  /** Set for actions that place, modify or cancel orders. */
  mutatesOrders?: boolean;
}

/** Refuse early if the local kill switch is off. */
export function assertTradingEnabled(ctx: Context): void {
  if (!ctx.config.trading.enabled) {
    throw new KiteCliError(
      'Trading is disabled by the local kill switch.',
      ExitCode.TradingDisabled,
      'Re-enable it with `kite config set trading.enabled true`.',
    );
  }
}

/**
 * Refuse orders above the configured notional cap.
 *
 * Fails CLOSED when the value cannot be determined. An unknown notional is the
 * normal outcome of a failed quote lookup (the quote bucket is 1 req/sec, so a
 * 429 is easy to hit), and treating "unknown" as "within the cap" would mean
 * the one guard the user explicitly configured silently stops applying exactly
 * when the CLI is least sure what it is about to do.
 */
export function assertWithinValueCap(ctx: Context, notionalValue: number | undefined): void {
  const cap = ctx.config.trading.maxOrderValue;
  if (cap === undefined) return;

  if (notionalValue === undefined) {
    throw new KiteCliError(
      `Cannot verify this order against your configured cap of ${rupees(cap)} — its value is unknown.`,
      ExitCode.TradingDisabled,
      'Specify an explicit --price so the value can be computed, or unset the cap with `kite config unset trading.maxOrderValue`.',
    );
  }

  if (notionalValue > cap) {
    throw new KiteCliError(
      `Order value ${rupees(notionalValue)} exceeds your configured cap of ${rupees(cap)}.`,
      ExitCode.TradingDisabled,
      'Raise it with `kite config set trading.maxOrderValue <amount>`, or unset it to remove the cap.',
    );
  }
}

/**
 * Render the resolved action and obtain consent.
 *
 * Returns true to proceed. Throws rather than returning false, so a caller can
 * never accidentally treat a declined confirmation as approval.
 */
export async function confirmAction(ctx: Context, opts: ConfirmOptions): Promise<void> {
  if (opts.mutatesOrders) {
    assertTradingEnabled(ctx);
  }
  // The cap is about how much exposure you can take on, not about whether you
  // may unwind it.
  if (opts.increasesExposure) {
    assertWithinValueCap(ctx, opts.notionalValue);
  }

  const { io } = ctx;

  // Whether we will actually stop and ask. Computed up front because it
  // decides whether the preview may be suppressed.
  const willPrompt =
    !ctx.options.dryRun &&
    !ctx.options.yes &&
    (ctx.config.trading.confirm || opts.mutatesOrders === true);

  // Always show what is about to happen, even with --yes, so the record exists
  // in the terminal scrollback.
  //
  // `force` when we are about to prompt: --quiet and --json normally suppress
  // the preview, but asking someone to approve an order while showing them
  // none of the resolved facts is worse than printing in a mode they asked to
  // be quiet. A prompt without its preview is not informed consent.
  renderPreview(ctx, opts, willPrompt);

  if (ctx.options.dryRun) {
    io.note('');
    io.note(io.cyan('Dry run — nothing was sent to Kite.'));
    return;
  }

  // --yes is a call-site-only bypass. It is deliberately not readable from the
  // config file: disabling safety must be an explicit act every time.
  if (ctx.options.yes) return;

  if (!ctx.config.trading.confirm && opts.mutatesOrders !== true) return;

  if (!process.stdin.isTTY || !io.stderrIsTty) {
    throw new KiteCliError(
      `${opts.action} requires confirmation, but this is not an interactive terminal.`,
      ExitCode.ConfirmationRequired,
      'Pass --yes to confirm non-interactively, or --dry-run to preview without sending.',
    );
  }

  const threshold = ctx.config.trading.strictConfirmAbove;
  // An unknown value escalates rather than de-escalates. If we could not price
  // the order, we cannot claim it is small — and a mispriced market order is
  // precisely the case where typing the symbol is worth the friction.
  // Unknown value only escalates for exposure-increasing actions; demanding a
  // typed confirmation to unwind a position would be friction in the wrong
  // direction.
  const valueUnknown = opts.notionalValue === undefined && opts.increasesExposure === true;
  const needsChallenge =
    opts.challengeToken !== undefined &&
    (valueUnknown || (opts.notionalValue !== undefined && opts.notionalValue >= threshold));

  if (needsChallenge) {
    // Above the threshold a keystroke is too easy to fire by accident, so we
    // require the symbol to be typed out.
    const reason = valueUnknown
      ? 'This order value could not be determined'
      : `This is a large order (${rupees(opts.notionalValue!)})`;
    const answer = await text({
      message: `${reason}. Type ${opts.challengeToken} to confirm:`,
      validate: (value) =>
        value === opts.challengeToken ? undefined : `Type "${opts.challengeToken}" exactly, or press Ctrl-C to abort.`,
    });
    if (isCancel(answer) || answer !== opts.challengeToken) {
      throw new AbortedError('Aborted — confirmation did not match.');
    }
    return;
  }

  const answer = await confirm({
    message: `${opts.action}?`,
    initialValue: false,
  });
  if (isCancel(answer) || answer !== true) {
    throw new AbortedError();
  }
}

function renderPreview(ctx: Context, opts: ConfirmOptions, force = false): void {
  const { io } = ctx;
  if ((io.json || io.quiet) && !force) return;

  const width = Math.max(...opts.details.map((d) => d.label.length));
  const emit = force ? (text: string) => io.forceNote(text) : (text: string) => io.note(text);

  emit('');
  emit(io.bold(opts.action));
  for (const detail of opts.details) {
    emit(`  ${io.dim(detail.label.padEnd(width))}  ${detail.value}`);
  }
  if (ctx.env === 'sandbox') {
    emit(`  ${io.cyan('sandbox — no real money involved')}`);
  }
}

/**
 * Generate a unique order tag.
 *
 * This is the cornerstone of safe order placement. Kite has NO idempotency
 * key — the `guid` in the response is server-assigned — so a timed-out POST
 * /orders may or may not have executed. The only safe recovery is to search the
 * orderbook for a tag we chose ourselves.
 *
 * Kite caps `tag` at 20 alphanumeric characters.
 */
export function generateOrderTag(prefix = 'kc'): string {
  const random = randomBytes(6).toString('hex');
  const stamp = Date.now().toString(36);
  return `${prefix}${stamp}${random}`.slice(0, 20);
}

/**
 * Build the tag actually sent to Kite, guaranteeing uniqueness even when the
 * user supplied their own.
 *
 * A user tag is a label; the reconciliation key must be unique or the recovery
 * path actively lies. With a reused tag, a failed placement would find the
 * EARLIER order carrying that tag and report "it was placed, do not retry" —
 * when in fact nothing was placed. So the user's tag is kept as a prefix for
 * their own filtering, and a random suffix makes it unique.
 *
 * Kite caps `tag` at 20 alphanumeric characters, so the user prefix is
 * truncated to leave room for the suffix.
 */
export function buildOrderTag(userTag?: string): string {
  if (!userTag) return generateOrderTag();

  const suffix = randomBytes(4).toString('hex'); // 8 chars
  const prefix = userTag.slice(0, 20 - suffix.length);
  return `${prefix}${suffix}`;
}
