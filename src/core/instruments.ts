import { readFile, writeFile } from 'node:fs/promises';
import type { KiteApi } from './api.js';
import { UsageError } from './errors.js';
import { cacheDir, ensurePrivateDir, instrumentsCacheFile } from './paths.js';
import type { Instrument } from './schemas.js';

/**
 * The instrument master.
 *
 * Kite publishes the full instrument list as a gzipped CSV, regenerated once a
 * day at around 08:30 IST. We cache it locally and refresh on that cadence.
 *
 * The critical correctness rule, quoted from Kite's docs:
 *
 *   "For storage, it is recommended to use a combination of exchange and
 *    tradingsymbol as the unique key, not the numeric instrument token.
 *    Exchanges may reuse instrument tokens for different derivative
 *    instruments after each expiry."
 *
 * So the cache is keyed on `EXCHANGE:TRADINGSYMBOL` throughout. A token-keyed
 * cache would silently resolve to the wrong contract after an expiry roll —
 * a bug that costs money and is nearly invisible in testing.
 *
 * Three identifiers, three uses, easily confused:
 *   instrument_token — the ONLY id accepted by WebSocket and historical data
 *   tradingsymbol    — the ONLY id accepted by order placement and /quote
 *   exchange_token   — the exchange's own id; rarely needed
 */

export interface InstrumentCache {
  fetchedAt: string;
  instruments: Instrument[];
}

/**
 * Minimal RFC-4180 CSV parser.
 *
 * Hand-rolled rather than pulled from npm: instrument names legitimately
 * contain commas inside quoted fields (e.g. "NIFTY 50"), so naive splitting
 * corrupts rows — but this is ~40 lines and adding a dependency to a tool that
 * holds trading credentials needs a better reason than that.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (char === '\r') {
      i += 1;
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function parseInstrumentsCsv(csv: string): Instrument[] {
  const rows = parseCsv(csv);
  if (rows.length < 2) return [];

  const header = rows[0]!.map((h) => h.trim());
  const index = (name: string) => header.indexOf(name);

  const idx = {
    instrument_token: index('instrument_token'),
    exchange_token: index('exchange_token'),
    tradingsymbol: index('tradingsymbol'),
    name: index('name'),
    last_price: index('last_price'),
    expiry: index('expiry'),
    strike: index('strike'),
    tick_size: index('tick_size'),
    lot_size: index('lot_size'),
    instrument_type: index('instrument_type'),
    segment: index('segment'),
    exchange: index('exchange'),
  };

  const out: Instrument[] = [];
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r]!;
    // Skip blank trailing lines and any truncated row.
    if (row.length < header.length) continue;

    const token = Number(row[idx.instrument_token]);
    const tradingsymbol = row[idx.tradingsymbol] ?? '';
    const exchange = row[idx.exchange] ?? '';
    if (!Number.isFinite(token) || tradingsymbol === '' || exchange === '') continue;

    out.push({
      instrument_token: token,
      exchange_token: numberOrUndefined(row[idx.exchange_token]),
      tradingsymbol,
      name: row[idx.name] || undefined,
      // last_price in the dump is a day-old snapshot. Kept for completeness,
      // but never surfaced as a quote.
      last_price: numberOrUndefined(row[idx.last_price]),
      expiry: row[idx.expiry] || undefined,
      strike: numberOrUndefined(row[idx.strike]),
      tick_size: numberOrUndefined(row[idx.tick_size]),
      lot_size: numberOrUndefined(row[idx.lot_size]),
      instrument_type: row[idx.instrument_type] || undefined,
      segment: row[idx.segment] || undefined,
      exchange,
    });
  }
  return out;
}

function numberOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** The instrument dump regenerates daily around 08:30 IST. */
function isStale(fetchedAt: string, now: Date = new Date()): boolean {
  const fetched = Date.parse(fetchedAt);
  if (Number.isNaN(fetched)) return true;

  const refreshHourIst = 8.5;
  const istOffsetMs = 5.5 * 3600 * 1000;

  const istNow = new Date(now.getTime() + istOffsetMs);
  const istFetched = new Date(fetched + istOffsetMs);

  // Most recent 08:30 IST boundary, as a UTC instant.
  let boundary = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(), 8, 30, 0);
  const istHour = istNow.getUTCHours() + istNow.getUTCMinutes() / 60;
  if (istHour < refreshHourIst) {
    boundary -= 24 * 3600 * 1000;
  }

  return istFetched.getTime() < boundary;
}

export class InstrumentStore {
  private instruments: Instrument[] = [];
  private bySymbol = new Map<string, Instrument>();
  private loaded = false;

  private readonly api: KiteApi;
  private readonly env: string;

  constructor(api: KiteApi, env: string) {
    this.api = api;
    this.env = env;
  }

  /** Load from cache, fetching from Kite if absent or stale. */
  async load(opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    if (this.loaded && !opts.force) return;

    if (!opts.force) {
      const cached = await this.readCache();
      if (cached && !isStale(cached.fetchedAt)) {
        this.hydrate(cached.instruments);
        return;
      }
    }

    const csv = await this.api.getInstrumentsCsv(undefined, opts.signal);
    const instruments = parseInstrumentsCsv(csv);
    this.hydrate(instruments);
    await this.writeCache({ fetchedAt: new Date().toISOString(), instruments });
  }

  /** Load from cache only; returns false when there is no usable cache. */
  async loadCachedOnly(): Promise<boolean> {
    const cached = await this.readCache();
    if (!cached) return false;
    this.hydrate(cached.instruments);
    return true;
  }

  private hydrate(instruments: Instrument[]): void {
    this.instruments = instruments;
    this.bySymbol = new Map();
    for (const instrument of instruments) {
      this.bySymbol.set(key(instrument.exchange, instrument.tradingsymbol), instrument);
    }
    this.loaded = true;
  }

  private async readCache(): Promise<InstrumentCache | null> {
    try {
      const raw = await readFile(instrumentsCacheFile(this.env), 'utf8');
      const parsed = JSON.parse(raw) as InstrumentCache;
      if (!Array.isArray(parsed.instruments)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async writeCache(cache: InstrumentCache): Promise<void> {
    await ensurePrivateDir(cacheDir());
    await writeFile(instrumentsCacheFile(this.env), JSON.stringify(cache), 'utf8');
  }

  get size(): number {
    return this.instruments.length;
  }

  get all(): readonly Instrument[] {
    return this.instruments;
  }

  /** Look up by "EXCHANGE:TRADINGSYMBOL" or by exchange + symbol. */
  lookup(exchange: string, tradingsymbol: string): Instrument | undefined {
    return this.bySymbol.get(key(exchange, tradingsymbol));
  }

  lookupKey(instrumentKey: string): Instrument | undefined {
    const parsed = parseInstrumentKey(instrumentKey);
    return this.lookup(parsed.exchange, parsed.tradingsymbol);
  }

  /**
   * Resolve a key to an instrument token, for the WebSocket and historical
   * endpoints (which accept nothing else).
   */
  requireToken(instrumentKey: string): number {
    const instrument = this.lookupKey(instrumentKey);
    if (!instrument) {
      throw new UsageError(
        `Unknown instrument "${instrumentKey}".`,
        'Search for it with `kite instruments search <query>`, or refresh the list with `kite instruments refresh`.',
      );
    }
    return instrument.instrument_token;
  }

  /**
   * Fuzzy search over tradingsymbol and name.
   *
   * Ranked so that exact and prefix matches on the trading symbol come first —
   * searching "INFY" should not bury the equity under fifty option contracts.
   */
  search(
    query: string,
    opts: {
      exchange?: string | undefined;
      type?: string | undefined;
      limit?: number;
    } = {},
  ): Instrument[] {
    const needle = query.trim().toUpperCase();
    if (needle === '') return [];
    const limit = opts.limit ?? 25;

    const scored: Array<{ instrument: Instrument; score: number }> = [];

    for (const instrument of this.instruments) {
      if (opts.exchange && instrument.exchange !== opts.exchange) continue;
      if (opts.type && instrument.instrument_type !== opts.type) continue;

      const symbol = instrument.tradingsymbol.toUpperCase();
      const name = (instrument.name ?? '').toUpperCase();

      let score = 0;
      if (symbol === needle) score = 1000;
      else if (name === needle) score = 900;
      else if (symbol.startsWith(needle)) score = 800 - symbol.length;
      else if (name.startsWith(needle)) score = 700 - name.length;
      else if (symbol.includes(needle)) score = 500 - symbol.length;
      else if (name.includes(needle)) score = 400 - name.length;
      else continue;

      // Prefer plain equity over derivatives for an otherwise equal match.
      if (instrument.segment === 'NSE' || instrument.segment === 'BSE') score += 50;

      scored.push({ instrument, score });
    }

    scored.sort((a, b) => b.score - a.score || a.instrument.tradingsymbol.localeCompare(b.instrument.tradingsymbol));
    return scored.slice(0, limit).map((entry) => entry.instrument);
  }
}

function key(exchange: string, tradingsymbol: string): string {
  return `${exchange.toUpperCase()}:${tradingsymbol.toUpperCase()}`;
}

export interface ParsedInstrumentKey {
  exchange: string;
  tradingsymbol: string;
}

/**
 * Parse "NSE:INFY". Defaults to NSE when no exchange is given, since that is
 * overwhelmingly what a bare symbol means.
 */
export function parseInstrumentKey(value: string): ParsedInstrumentKey {
  const trimmed = value.trim();
  const colon = trimmed.indexOf(':');
  if (colon === -1) {
    return { exchange: 'NSE', tradingsymbol: trimmed.toUpperCase() };
  }
  const exchange = trimmed.slice(0, colon).toUpperCase();
  const tradingsymbol = trimmed.slice(colon + 1).toUpperCase();
  if (exchange === '' || tradingsymbol === '') {
    throw new UsageError(`Malformed instrument "${value}". Expected EXCHANGE:SYMBOL, e.g. NSE:INFY.`);
  }
  return { exchange, tradingsymbol };
}

export function formatInstrumentKey(exchange: string, tradingsymbol: string): string {
  return `${exchange.toUpperCase()}:${tradingsymbol.toUpperCase()}`;
}
