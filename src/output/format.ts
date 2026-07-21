/**
 * Number, currency and date formatting.
 *
 * Everything is rendered in the Indian locale and IST, because that is the only
 * frame of reference Kite operates in. Rupee amounts use the Indian digit
 * grouping (lakh/crore), which `en-IN` gives us for free.
 */

const INR = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const INR_COMPACT = new Intl.NumberFormat('en-IN', {
  maximumFractionDigits: 0,
});

const QTY = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** A rupee amount, e.g. "12,34,567.89". No symbol — callers add it. */
export function money(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  return INR.format(value);
}

/** A rupee amount with the symbol, e.g. "₹12,34,567.89". */
export function rupees(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  return `₹${INR.format(value)}`;
}

/** A signed rupee amount, e.g. "+₹1,200.00" / "-₹340.50". */
export function signedRupees(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}₹${INR.format(Math.abs(value))}`;
}

/** Large rupee amounts abbreviated as L / Cr, the conventional Indian units. */
export function compactRupees(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 10_000_000) return `${sign}₹${(abs / 10_000_000).toFixed(2)}Cr`;
  if (abs >= 100_000) return `${sign}₹${(abs / 100_000).toFixed(2)}L`;
  return `${sign}₹${INR_COMPACT.format(abs)}`;
}

export function percent(value: number | undefined | null, digits = 2): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

export function quantity(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  return QTY.format(value);
}

/** Compact volume, e.g. "1.2M". */
export function compactNumber(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${abs}`;
}

const IST_DATETIME = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const IST_TIME = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const IST_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function dateTime(value: Date | string | undefined | null): string {
  const date = toDate(value);
  return date ? IST_DATETIME.format(date) : '—';
}

export function timeOnly(value: Date | string | undefined | null): string {
  const date = toDate(value);
  return date ? IST_TIME.format(date) : '—';
}

export function dateOnly(value: Date | string | undefined | null): string {
  const date = toDate(value);
  return date ? IST_DATE.format(date) : '—';
}

function toDate(value: Date | string | undefined | null): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  // Kite returns "YYYY-MM-DD HH:MM:SS" without a zone in most responses
  // (implicitly IST), but ISO-8601 with +0530 for historical candles.
  const normalised = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}+05:30` : value;
  const parsed = new Date(normalised);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Parse a user-supplied date for historical queries.
 *
 * Accepts YYYY-MM-DD, "YYYY-MM-DD HH:MM:SS", and relative offsets like "7d",
 * "3m", "1y" meaning "N units ago".
 */
export function parseUserDate(value: string, now: Date = new Date()): Date | null {
  const trimmed = value.trim();

  const relative = /^(\d+)\s*([dwmy])$/i.exec(trimmed);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]!.toLowerCase();
    const result = new Date(now);
    if (unit === 'd') result.setDate(result.getDate() - amount);
    else if (unit === 'w') result.setDate(result.getDate() - amount * 7);
    else if (unit === 'm') result.setMonth(result.getMonth() - amount);
    else result.setFullYear(result.getFullYear() - amount);
    return result;
  }

  if (trimmed.toLowerCase() === 'today') {
    return now;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    // Interpret a bare date as IST midnight, not UTC.
    const parsed = new Date(`${trimmed}T00:00:00+05:30`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(trimmed)) {
    const withSeconds = trimmed.length === 16 ? `${trimmed}:00` : trimmed;
    const parsed = new Date(`${withSeconds.replace(' ', 'T')}+05:30`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const fallback = new Date(trimmed);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

/** Truncate to a display width, appending an ellipsis. */
export function truncate(value: string, max: number): string {
  if (max <= 1) return value.slice(0, Math.max(0, max));
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
