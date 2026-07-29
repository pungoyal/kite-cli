import { readFile, writeFile } from 'node:fs/promises';
import type { KiteApi } from './api.js';
import { isStale, parseCsv } from './instruments.js';
import { cacheDir, ensurePrivateDir, mfInstrumentsCacheFile } from './paths.js';
import type { MfInstrument } from './schemas.js';

/**
 * The mutual fund instrument master — every Coin-supported scheme/plan/
 * dividend-type combination Kite will let you hold, though not buy or sell
 * over the API (see `commands/mf.ts`).
 *
 * Kite's MF `tradingsymbol` is the scheme's ISIN, not a ticker, so this is
 * keyed and searched on the ISIN and fund name — there is no exchange to pair
 * it with, unlike the equity instrument master in instruments.ts.
 */

export interface MfInstrumentCache {
  fetchedAt: string;
  instruments: MfInstrument[];
}

export function parseMfInstrumentsCsv(csv: string): MfInstrument[] {
  const rows = parseCsv(csv);
  if (rows.length < 2) return [];

  const header = rows[0]!.map((h) => h.trim());
  const index = (name: string) => header.indexOf(name);

  const idx = {
    tradingsymbol: index('tradingsymbol'),
    amc: index('amc'),
    name: index('name'),
    purchase_allowed: index('purchase_allowed'),
    redemption_allowed: index('redemption_allowed'),
    minimum_purchase_amount: index('minimum_purchase_amount'),
    purchase_amount_multiplier: index('purchase_amount_multiplier'),
    minimum_additional_purchase_amount: index('minimum_additional_purchase_amount'),
    minimum_redemption_quantity: index('minimum_redemption_quantity'),
    redemption_quantity_multiplier: index('redemption_quantity_multiplier'),
    dividend_type: index('dividend_type'),
    scheme_type: index('scheme_type'),
    plan: index('plan'),
    settlement_type: index('settlement_type'),
    last_price: index('last_price'),
    last_price_date: index('last_price_date'),
  };

  const out: MfInstrument[] = [];
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r]!;
    if (row.length < header.length) continue;

    const tradingsymbol = row[idx.tradingsymbol] ?? '';
    if (tradingsymbol === '') continue;

    out.push({
      tradingsymbol,
      amc: row[idx.amc] || undefined,
      name: row[idx.name] || undefined,
      purchase_allowed: booleanOrUndefined(row[idx.purchase_allowed]),
      redemption_allowed: booleanOrUndefined(row[idx.redemption_allowed]),
      minimum_purchase_amount: numberOrUndefined(row[idx.minimum_purchase_amount]),
      purchase_amount_multiplier: numberOrUndefined(row[idx.purchase_amount_multiplier]),
      minimum_additional_purchase_amount: numberOrUndefined(row[idx.minimum_additional_purchase_amount]),
      minimum_redemption_quantity: numberOrUndefined(row[idx.minimum_redemption_quantity]),
      redemption_quantity_multiplier: numberOrUndefined(row[idx.redemption_quantity_multiplier]),
      dividend_type: row[idx.dividend_type] || undefined,
      scheme_type: row[idx.scheme_type] || undefined,
      plan: row[idx.plan] || undefined,
      settlement_type: row[idx.settlement_type] || undefined,
      last_price: numberOrUndefined(row[idx.last_price]),
      last_price_date: row[idx.last_price_date] || undefined,
    });
  }
  return out;
}

function numberOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** The CSV renders booleans as "1"/"0". */
function booleanOrUndefined(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return value === '1' || value.toLowerCase() === 'true';
}

export class MfInstrumentStore {
  private instruments: MfInstrument[] = [];
  private bySymbol = new Map<string, MfInstrument>();
  private loaded = false;

  private readonly api: KiteApi;

  constructor(api: KiteApi) {
    this.api = api;
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

    const csv = await this.api.getMfInstrumentsCsv(opts.signal);
    const instruments = parseMfInstrumentsCsv(csv);
    this.hydrate(instruments);
    await this.writeCache({ fetchedAt: new Date().toISOString(), instruments });
  }

  private hydrate(instruments: MfInstrument[]): void {
    this.instruments = instruments;
    this.bySymbol = new Map();
    for (const instrument of instruments) {
      this.bySymbol.set(instrument.tradingsymbol.toUpperCase(), instrument);
    }
    this.loaded = true;
  }

  private async readCache(): Promise<MfInstrumentCache | null> {
    try {
      const raw = await readFile(mfInstrumentsCacheFile(), 'utf8');
      const parsed = JSON.parse(raw) as MfInstrumentCache;
      if (!Array.isArray(parsed.instruments)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async writeCache(cache: MfInstrumentCache): Promise<void> {
    await ensurePrivateDir(cacheDir());
    await writeFile(mfInstrumentsCacheFile(), JSON.stringify(cache), 'utf8');
  }

  get size(): number {
    return this.instruments.length;
  }

  /** Look up by exact ISIN (Kite's MF `tradingsymbol`). */
  lookup(tradingsymbol: string): MfInstrument | undefined {
    return this.bySymbol.get(tradingsymbol.toUpperCase());
  }

  /**
   * Fuzzy search over fund name and ISIN.
   *
   * Ranked so exact and prefix matches on the fund name come first — nobody
   * searches a mutual fund by ISIN from memory, they search by name.
   */
  search(
    query: string,
    opts: { amc?: string | undefined; plan?: string | undefined; limit?: number } = {},
  ): MfInstrument[] {
    const needle = query.trim().toUpperCase();
    if (needle === '') return [];
    const limit = opts.limit ?? 25;

    const scored: Array<{ instrument: MfInstrument; score: number }> = [];

    for (const instrument of this.instruments) {
      if (opts.amc && instrument.amc?.toUpperCase() !== opts.amc.toUpperCase()) continue;
      if (opts.plan && instrument.plan?.toUpperCase() !== opts.plan.toUpperCase()) continue;

      const symbol = instrument.tradingsymbol.toUpperCase();
      const name = (instrument.name ?? '').toUpperCase();

      let score = 0;
      if (symbol === needle) score = 1000;
      else if (name === needle) score = 900;
      else if (name.startsWith(needle)) score = 700 - name.length;
      else if (name.includes(needle)) score = 400 - name.length;
      else continue;

      scored.push({ instrument, score });
    }

    scored.sort((a, b) => b.score - a.score || (a.instrument.name ?? '').localeCompare(b.instrument.name ?? ''));
    return scored.slice(0, limit).map((entry) => entry.instrument);
  }
}
