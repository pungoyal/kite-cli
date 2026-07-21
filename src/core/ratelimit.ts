/**
 * Client-side rate limiting, per endpoint category.
 *
 * Kite's published limits (https://kite.trade/docs/connect/v3/exceptions/):
 *
 *   Quote            1 req/sec     <- the binding constraint in practice
 *   Historical       3 req/sec
 *   Order placement  10 req/sec, 400/min, 5000/day
 *   Everything else  10 req/sec
 *
 * The quote limit is what bites first: a naive per-symbol loop over a watchlist
 * is ~1000x slower than one batched /quote/ltp call, which accepts 1000
 * instruments. Batching is handled at the client layer; this module only
 * enforces pacing.
 */

import { KiteCliError, ExitCode } from './errors.js';

export type RateCategory = 'quote' | 'historical' | 'order' | 'default';

interface BucketConfig {
  /** Sustained requests per second. */
  perSecond: number;
}

const LIMITS: Record<RateCategory, BucketConfig> = {
  quote: { perSecond: 1 },
  historical: { perSecond: 3 },
  order: { perSecond: 10 },
  default: { perSecond: 10 },
};

/**
 * A token bucket that refills continuously.
 *
 * Deliberately sized at capacity 1 burst beyond the sustained rate: Kite
 * enforces its limits server-side with little tolerance, and a large burst
 * allowance just converts a clean local wait into a 429.
 */
class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly ratePerMs: number;
  private readonly capacity: number;
  private readonly now: () => number;
  private queue: Promise<void> = Promise.resolve();

  constructor(perSecond: number, now: () => number) {
    this.now = now;
    this.ratePerMs = perSecond / 1000;
    this.capacity = perSecond;
    this.tokens = perSecond;
    this.lastRefill = now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = t - this.lastRefill;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerMs);
      this.lastRefill = t;
    }
  }

  /** Milliseconds until a token is available. */
  private delayForToken(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil((1 - this.tokens) / this.ratePerMs);
  }

  /**
   * Wait until a token is available, then consume it.
   *
   * Calls are serialised through a promise chain so that N concurrent callers
   * are spaced correctly rather than all observing the same available token.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    const run = this.queue.then(async () => {
      for (;;) {
        const wait = this.delayForToken();
        if (wait === 0) break;
        await sleep(wait, signal);
      }
      this.tokens -= 1;
    });
    // Keep the chain alive even if this acquisition rejects (e.g. aborted).
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Counters for the order limits that are not per-second. */
interface OrderCounters {
  minuteWindowStart: number;
  minuteCount: number;
  dayKey: string;
  dayCount: number;
}

export const ORDER_LIMITS = {
  perMinute: 400,
  perDay: 5000,
  /** Kite rejects further modifications after this many on one order. */
  modificationsPerOrder: 25,
} as const;

export class RateLimiter {
  private readonly buckets: Map<RateCategory, TokenBucket> = new Map();
  private readonly orderCounters: OrderCounters;
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
    for (const [category, config] of Object.entries(LIMITS) as Array<[RateCategory, BucketConfig]>) {
      this.buckets.set(category, new TokenBucket(config.perSecond, now));
    }
    this.orderCounters = {
      minuteWindowStart: now(),
      minuteCount: 0,
      dayKey: istDayKey(now()),
      dayCount: 0,
    };
  }

  async acquire(category: RateCategory, signal?: AbortSignal): Promise<void> {
    // Enforce the documented order caps BEFORE consuming a token, so a runaway
    // loop inside a long-running process is stopped locally with a clear error
    // rather than firing an order Kite will reject with a 429 (which still
    // counts against the cap).
    if (category === 'order') this.assertOrderCapacity();
    const bucket = this.buckets.get(category) ?? this.buckets.get('default');
    await bucket!.acquire(signal);
    if (category === 'order') this.countOrder();
  }

  /**
   * Roll the per-minute and per-IST-day order windows forward if they have
   * elapsed. Shared by the pre-flight cap check and the post-acquire counter so
   * the two never disagree about which window an order falls in.
   */
  private rollOrderWindows(): void {
    const t = this.now();
    if (t - this.orderCounters.minuteWindowStart >= 60_000) {
      this.orderCounters.minuteWindowStart = t;
      this.orderCounters.minuteCount = 0;
    }
    const today = istDayKey(t);
    if (today !== this.orderCounters.dayKey) {
      this.orderCounters.dayKey = today;
      this.orderCounters.dayCount = 0;
    }
  }

  /**
   * Refuse to place another order once a documented cap is reached.
   *
   * These counters reset each process run, so they cannot be authoritative
   * across invocations of a short-lived CLI — this is a backstop against a
   * runaway loop inside ONE long-running process (`kite watch`, a scripted
   * batch, a library embedder), not a mirror of Zerodha's server-side
   * accounting.
   */
  private assertOrderCapacity(): void {
    this.rollOrderWindows();
    if (this.orderCounters.dayCount >= ORDER_LIMITS.perDay) {
      throw new KiteCliError(
        `This process has placed ${ORDER_LIMITS.perDay} orders — Kite's documented daily cap. It resets at the next IST trading day.`,
        ExitCode.RateLimit,
      );
    }
    if (this.orderCounters.minuteCount >= ORDER_LIMITS.perMinute) {
      throw new KiteCliError(
        `This process has placed ${ORDER_LIMITS.perMinute} orders in the last minute — Kite's documented per-minute cap. Slow down and retry shortly.`,
        ExitCode.RateLimit,
      );
    }
  }

  /**
   * Track the 400/min and 5000/day order caps (see {@link assertOrderCapacity},
   * which enforces them before the order is sent).
   */
  private countOrder(): void {
    this.rollOrderWindows();
    this.orderCounters.minuteCount += 1;
    this.orderCounters.dayCount += 1;
  }

  /** Orders placed by this process in the current minute / IST day. */
  orderUsage(): { minute: number; day: number } {
    return { minute: this.orderCounters.minuteCount, day: this.orderCounters.dayCount };
  }

  /** True if this process is approaching a documented order cap. */
  nearOrderLimit(): boolean {
    return (
      this.orderCounters.minuteCount >= ORDER_LIMITS.perMinute * 0.9 ||
      this.orderCounters.dayCount >= ORDER_LIMITS.perDay * 0.9
    );
  }
}

/** IST calendar day key (YYYY-MM-DD). Kite's day boundaries are IST, not UTC. */
function istDayKey(epochMs: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(epochMs));
}
