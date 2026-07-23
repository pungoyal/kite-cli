import { z } from 'zod';
import type { KiteClient } from './client.js';
import { UsageError } from './errors.js';
import {
  AlertHistoryEntrySchema,
  AlertSchema,
  AuctionSchema,
  BasketMarginSchema,
  type Candle,
  CandlesSchema,
  GttCreateResultSchema,
  GttSchema,
  HoldingSchema,
  LtpMapSchema,
  MarginsSchema,
  MfHoldingSchema,
  MfOrderSchema,
  MfSipSchema,
  OhlcMapSchema,
  OrderMarginSchema,
  OrderSchema,
  PlaceOrderResultSchema,
  PositionsSchema,
  ProfileSchema,
  QuoteMapSchema,
  SessionSchema,
  TradeSchema,
} from './schemas.js';

/**
 * Typed wrappers over the Kite Connect v3 endpoints.
 *
 * Batching and range-chunking live here rather than in commands, so every
 * caller gets the rate-limit-aware behaviour automatically.
 */

export type Variety = 'regular' | 'amo' | 'co' | 'iceberg' | 'auction';
export type TransactionType = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';
export type Product = 'CNC' | 'NRML' | 'MIS' | 'MTF';
export type Validity = 'DAY' | 'IOC' | 'TTL';
export type Exchange = 'NSE' | 'BSE' | 'NFO' | 'CDS' | 'BCD' | 'MCX' | 'BFO';

export const VARIETIES: Variety[] = ['regular', 'amo', 'co', 'iceberg', 'auction'];
export const ORDER_TYPES: OrderType[] = ['MARKET', 'LIMIT', 'SL', 'SL-M'];
export const PRODUCTS: Product[] = ['CNC', 'NRML', 'MIS', 'MTF'];
export const VALIDITIES: Validity[] = ['DAY', 'IOC', 'TTL'];
export const EXCHANGES: Exchange[] = ['NSE', 'BSE', 'NFO', 'CDS', 'BCD', 'MCX', 'BFO'];

export interface PlaceOrderParams {
  variety: Variety;
  tradingsymbol: string;
  exchange: Exchange | string;
  transaction_type: TransactionType;
  order_type: OrderType;
  quantity: number;
  product: Product;
  price?: number | undefined;
  trigger_price?: number | undefined;
  disclosed_quantity?: number | undefined;
  validity?: Validity | undefined;
  validity_ttl?: number | undefined;
  iceberg_legs?: number | undefined;
  iceberg_quantity?: number | undefined;
  auction_number?: string | undefined;
  market_protection?: number | undefined;
  /**
   * Client correlation ID, max 20 alphanumeric chars. This CLI always sets one:
   * it is the only way to reconcile after a network failure, because Kite has
   * no idempotency key.
   */
  tag?: string | undefined;
}

export interface ModifyOrderParams {
  variety: Variety;
  order_id: string;
  quantity?: number | undefined;
  price?: number | undefined;
  trigger_price?: number | undefined;
  order_type?: OrderType | undefined;
  disclosed_quantity?: number | undefined;
  validity?: Validity | undefined;
}

export class KiteApi {
  private readonly client: KiteClient;

  constructor(client: KiteClient) {
    this.client = client;
  }

  // -------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------

  /** Exchange a request_token for an access_token. */
  async createSession(params: { requestToken: string; checksum: string }) {
    return this.client.request({
      method: 'POST',
      path: '/session/token',
      schema: SessionSchema,
      form: {
        api_key: this.client.apiKey,
        request_token: params.requestToken,
        checksum: params.checksum,
      },
    });
  }

  async invalidateSession(accessToken: string) {
    return this.client.request({
      method: 'DELETE',
      path: '/session/token',
      schema: z.unknown(),
      query: { api_key: this.client.apiKey, access_token: accessToken },
    });
  }

  async getProfile(signal?: AbortSignal) {
    return this.client.request({
      method: 'GET',
      path: '/user/profile',
      schema: ProfileSchema,
      signal,
    });
  }

  async getMargins(signal?: AbortSignal) {
    return this.client.request({
      method: 'GET',
      path: '/user/margins',
      schema: MarginsSchema,
      signal,
    });
  }

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  async getOrders(signal?: AbortSignal) {
    return this.client.request({
      method: 'GET',
      path: '/orders',
      schema: z.array(OrderSchema),
      signal,
    });
  }

  /** Returns the full state history of one order, oldest first. */
  async getOrderHistory(orderId: string, signal?: AbortSignal) {
    return this.client.request({
      method: 'GET',
      path: `/orders/${encodeURIComponent(orderId)}`,
      schema: z.array(OrderSchema),
      signal,
    });
  }

  async getTrades(signal?: AbortSignal) {
    return this.client.request({
      method: 'GET',
      path: '/trades',
      schema: z.array(TradeSchema),
      signal,
    });
  }

  async getOrderTrades(orderId: string, signal?: AbortSignal) {
    return this.client.request({
      method: 'GET',
      path: `/orders/${encodeURIComponent(orderId)}/trades`,
      schema: z.array(TradeSchema),
      signal,
    });
  }

  /**
   * Place an order.
   *
   * This is never retried automatically anywhere in the stack. If it fails at
   * the network level the caller must reconcile via `findOrderByTag`, because
   * a timed-out request may still have been executed.
   */
  async placeOrder(params: PlaceOrderParams, signal?: AbortSignal) {
    const { variety, ...rest } = params;
    return this.client.request({
      method: 'POST',
      path: `/orders/${variety}`,
      category: 'order',
      schema: PlaceOrderResultSchema,
      form: rest as Record<string, string | number | boolean | undefined>,
      signal,
    });
  }

  async modifyOrder(params: ModifyOrderParams, signal?: AbortSignal) {
    const { variety, order_id, ...rest } = params;
    return this.client.request({
      method: 'PUT',
      path: `/orders/${variety}/${encodeURIComponent(order_id)}`,
      category: 'order',
      schema: z.looseObject({ order_id: z.string() }),
      form: rest as Record<string, string | number | boolean | undefined>,
      signal,
    });
  }

  async cancelOrder(params: { variety: Variety; order_id: string; parent_order_id?: string }, signal?: AbortSignal) {
    return this.client.request({
      method: 'DELETE',
      path: `/orders/${params.variety}/${encodeURIComponent(params.order_id)}`,
      category: 'order',
      schema: z.looseObject({ order_id: z.string() }),
      query: params.parent_order_id ? { parent_order_id: params.parent_order_id } : undefined,
      signal,
    });
  }

  /**
   * Reconciliation helper for the no-idempotency problem.
   *
   * Kite has no client-suppliable idempotency key (the `guid` field in the
   * response is server-assigned, despite its confusing description). Zerodha's
   * own guidance for a failed/timed-out placement is: do NOT retry — fetch the
   * orderbook and look for your tag. Only place again if it is absent.
   */
  async findOrderByTag(tag: string, signal?: AbortSignal) {
    const orders = await this.getOrders(signal);
    return orders.filter((order) => order.tag === tag || order.tags?.includes(tag));
  }

  // -------------------------------------------------------------------------
  // GTT
  // -------------------------------------------------------------------------

  async getGtts(signal?: AbortSignal) {
    return this.client.request({
      method: 'GET',
      path: '/gtt/triggers',
      schema: z.array(GttSchema),
      signal,
    });
  }

  async getGtt(id: number, signal?: AbortSignal) {
    return this.client.request({
      method: 'GET',
      path: `/gtt/triggers/${id}`,
      schema: GttSchema,
      signal,
    });
  }

  async placeGtt(params: GttParams, signal?: AbortSignal) {
    return this.client.request({
      method: 'POST',
      path: '/gtt/triggers',
      schema: GttCreateResultSchema,
      form: serialiseGtt(params),
      signal,
    });
  }

  async modifyGtt(id: number, params: GttParams, signal?: AbortSignal) {
    return this.client.request({
      method: 'PUT',
      path: `/gtt/triggers/${id}`,
      schema: GttCreateResultSchema,
      form: serialiseGtt(params),
      signal,
    });
  }

  async deleteGtt(id: number, signal?: AbortSignal) {
    return this.client.request({
      method: 'DELETE',
      path: `/gtt/triggers/${id}`,
      schema: GttCreateResultSchema,
      signal,
    });
  }

  // -------------------------------------------------------------------------
  // Alerts
  // -------------------------------------------------------------------------

  async getAlerts(signal?: AbortSignal) {
    return this.client.request({
      method: 'GET',
      path: '/alerts',
      schema: z.array(AlertSchema),
      signal,
    });
  }

  async getAlert(uuid: string, signal?: AbortSignal) {
    return this.client.request({
      method: 'GET',
      path: `/alerts/${encodeURIComponent(uuid)}`,
      schema: AlertSchema,
      signal,
    });
  }

  async getAlertHistory(uuid: string, signal?: AbortSignal) {
    return this.client.request({
      method: 'GET',
      path: `/alerts/${encodeURIComponent(uuid)}/history`,
      schema: z.array(AlertHistoryEntrySchema),
      signal,
    });
  }

  async createAlert(params: AlertParams, signal?: AbortSignal) {
    return this.client.request({
      method: 'POST',
      path: '/alerts',
      schema: AlertSchema,
      form: serialiseAlert(params),
      signal,
    });
  }

  async modifyAlert(uuid: string, params: AlertParams, signal?: AbortSignal) {
    return this.client.request({
      method: 'PUT',
      path: `/alerts/${encodeURIComponent(uuid)}`,
      schema: AlertSchema,
      form: serialiseAlert(params),
      signal,
    });
  }

  /**
   * Delete one or more alerts.
   *
   * Kite takes the uuids as *repeated query parameters* (`?uuid=a&uuid=b`) on a
   * DELETE, not a path segment or a form body — an easy thing to carry over
   * wrongly from the GTT delete, which is path-keyed by a numeric id.
   */
  async deleteAlerts(uuids: string[], signal?: AbortSignal) {
    return this.client.request({
      method: 'DELETE',
      path: '/alerts',
      query: { uuid: uuids },
      schema: z.unknown(),
      signal,
    });
  }

  // -------------------------------------------------------------------------
  // Portfolio
  // -------------------------------------------------------------------------

  async getHoldings(signal?: AbortSignal) {
    return this.client.request({
      method: 'GET',
      path: '/portfolio/holdings',
      schema: z.array(HoldingSchema),
      signal,
    });
  }

  async getPositions(signal?: AbortSignal) {
    return this.client.request({
      method: 'GET',
      path: '/portfolio/positions',
      schema: PositionsSchema,
      signal,
    });
  }

  async getAuctions(signal?: AbortSignal) {
    return this.client.request({
      method: 'GET',
      path: '/portfolio/holdings/auctions',
      schema: z.array(AuctionSchema),
      signal,
    });
  }

  /** Convert a position between products. Note this is PUT, not POST. */
  async convertPosition(
    params: {
      tradingsymbol: string;
      exchange: string;
      transaction_type: TransactionType;
      position_type: 'overnight' | 'day';
      quantity: number;
      old_product: Product;
      new_product: Product;
    },
    signal?: AbortSignal,
  ) {
    return this.client.request({
      method: 'PUT',
      path: '/portfolio/positions',
      schema: z.boolean().or(z.unknown()),
      form: params,
      signal,
    });
  }

  /**
   * Initiate CDSL authorisation for selling holdings — the HTTP 428 recovery
   * path.
   *
   * With no ISINs this authorises the whole demat account; with ISINs it
   * authorises only those instruments. The client encodes an array as repeated
   * `isin` form fields, which is the shape Kite expects.
   */
  async authoriseHoldings(isins?: string[], signal?: AbortSignal) {
    return this.client.request({
      method: 'POST',
      path: '/portfolio/holdings/authorise',
      schema: z.looseObject({ request_id: z.string() }),
      form: isins?.length ? { isin: isins } : {},
      signal,
    });
  }

  /** Browser URL the user must visit to complete a holdings authorisation. */
  authorisationUrl(requestId: string): string {
    return `https://kite.zerodha.com/connect/portfolio/authorise/holdings/${encodeURIComponent(
      this.client.apiKey,
    )}/${encodeURIComponent(requestId)}`;
  }

  // -------------------------------------------------------------------------
  // Market data
  // -------------------------------------------------------------------------

  /**
   * Full quotes. Kite caps this at 500 instruments per call and 1 request per
   * second, so large lists are chunked and paced by the limiter.
   */
  async getQuote(instruments: string[], signal?: AbortSignal) {
    return this.batchedQuote(instruments, 500, '/quote', QuoteMapSchema, signal);
  }

  /** OHLC + last price. Caps at 1000 instruments per call. */
  async getOhlc(instruments: string[], signal?: AbortSignal) {
    return this.batchedQuote(instruments, 1000, '/quote/ohlc', OhlcMapSchema, signal);
  }

  /** Last traded price only. Caps at 1000 instruments per call. */
  async getLtp(instruments: string[], signal?: AbortSignal) {
    return this.batchedQuote(instruments, 1000, '/quote/ltp', LtpMapSchema, signal);
  }

  private async batchedQuote<S extends z.ZodType<Record<string, unknown>>>(
    instruments: string[],
    chunkSize: number,
    path: string,
    schema: S,
    signal?: AbortSignal,
  ): Promise<z.infer<S>> {
    if (instruments.length === 0) return {} as z.infer<S>;
    const merged: Record<string, unknown> = {};
    for (const chunk of chunks(instruments, chunkSize)) {
      const result = await this.client.request({
        method: 'GET',
        path,
        category: 'quote',
        schema,
        query: { i: chunk },
        signal,
      });
      Object.assign(merged, result);
    }
    return merged as z.infer<S>;
  }

  /**
   * Historical candles, transparently chunked to respect per-interval range
   * limits, then merged and de-duplicated.
   */
  async getHistorical(
    params: {
      instrument_token: number;
      interval: HistoricalInterval;
      from: Date;
      to: Date;
      continuous?: boolean;
      oi?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<Candle[]> {
    const maxDays = MAX_DAYS_PER_REQUEST[params.interval];
    const ranges = splitDateRange(params.from, params.to, maxDays);
    const all: Candle[] = [];

    for (const range of ranges) {
      const result = await this.client.request({
        method: 'GET',
        path: `/instruments/historical/${params.instrument_token}/${params.interval}`,
        category: 'historical',
        schema: CandlesSchema,
        query: {
          from: formatIstDateTime(range.from),
          to: formatIstDateTime(range.to),
          continuous: params.continuous ? 1 : undefined,
          oi: params.oi ? 1 : undefined,
        },
        signal,
      });
      all.push(...result.candles);
    }

    // Chunk boundaries are inclusive on both ends, so adjacent ranges can
    // repeat a candle. De-duplicate on timestamp, preserving order.
    const seen = new Set<string>();
    return all.filter((candle) => {
      const key = candle[0];
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** The daily instrument dump as raw CSV. Not an API envelope. */
  async getInstrumentsCsv(exchange?: string, signal?: AbortSignal): Promise<string> {
    return this.client.requestText({
      path: exchange ? `/instruments/${exchange}` : '/instruments',
      signal,
    });
  }

  // -------------------------------------------------------------------------
  // Margins & charges (JSON bodies, unlike the rest of the API)
  // -------------------------------------------------------------------------

  async orderMargins(orders: unknown[], signal?: AbortSignal) {
    return this.client.request({
      method: 'POST',
      path: '/margins/orders',
      schema: z.array(OrderMarginSchema),
      json: orders,
      signal,
    });
  }

  async basketMargins(orders: unknown[], considerPositions = true, signal?: AbortSignal) {
    return this.client.request({
      method: 'POST',
      path: '/margins/basket',
      schema: BasketMarginSchema,
      query: { consider_positions: considerPositions },
      json: orders,
      signal,
    });
  }

  async orderCharges(orders: unknown[], signal?: AbortSignal) {
    return this.client.request({
      method: 'POST',
      path: '/charges/orders',
      schema: z.array(OrderMarginSchema),
      json: orders,
      signal,
    });
  }

  // -------------------------------------------------------------------------
  // Mutual funds (read-only — the current docs state that placing MF orders is
  // not available over the API because it requires a bank debit)
  // -------------------------------------------------------------------------

  async getMfHoldings(signal?: AbortSignal) {
    return this.client.request({
      method: 'GET',
      path: '/mf/holdings',
      schema: z.array(MfHoldingSchema),
      signal,
    });
  }

  /** Note: only returns the last 7 days of orders. */
  async getMfOrders(signal?: AbortSignal) {
    return this.client.request({
      method: 'GET',
      path: '/mf/orders',
      schema: z.array(MfOrderSchema),
      signal,
    });
  }

  async getMfSips(signal?: AbortSignal) {
    return this.client.request({
      method: 'GET',
      path: '/mf/sips',
      schema: z.array(MfSipSchema),
      signal,
    });
  }
}

// ---------------------------------------------------------------------------
// GTT serialisation
// ---------------------------------------------------------------------------

export interface GttParams {
  type: 'single' | 'two-leg';
  condition: {
    exchange: string;
    tradingsymbol: string;
    trigger_values: number[];
    last_price: number;
  };
  orders: Array<{
    exchange: string;
    tradingsymbol: string;
    transaction_type: TransactionType;
    quantity: number;
    order_type: 'LIMIT';
    product: Product;
    price: number;
  }>;
}

/**
 * GTT takes JSON-encoded strings inside form fields — not a JSON body, and not
 * plain form fields. An easy thing to get wrong.
 */
function serialiseGtt(params: GttParams): Record<string, string> {
  return {
    type: params.type,
    condition: JSON.stringify(params.condition),
    orders: JSON.stringify(params.orders),
  };
}

// ---------------------------------------------------------------------------
// Alert serialisation
// ---------------------------------------------------------------------------

export const ALERT_TYPES = ['simple', 'ato'] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

/** Kite's raw comparison operators. The CLI accepts friendlier aliases and
 * normalises to these before they reach the wire. */
export const ALERT_OPERATORS = ['<=', '>=', '<', '>', '=='] as const;
export type AlertOperator = (typeof ALERT_OPERATORS)[number];

export const ALERT_RHS_TYPES = ['constant', 'instrument'] as const;
export type AlertRhsType = (typeof ALERT_RHS_TYPES)[number];

/** The only left/right attribute Kite documents for alerts. */
export const ALERT_DEFAULT_ATTRIBUTE = 'LastTradedPrice';

export interface AlertBasketItem {
  type: 'insert';
  tradingsymbol: string;
  exchange: string;
  weight: number;
  params: Record<string, unknown>;
}

export interface AlertBasket {
  name: string;
  type: string;
  tags: string[];
  items: AlertBasketItem[];
}

export interface AlertParams {
  name: string;
  type: AlertType;
  lhs_exchange: string;
  lhs_tradingsymbol: string;
  lhs_attribute: string;
  operator: AlertOperator;
  rhs_type: AlertRhsType;
  rhs_constant?: number | undefined;
  rhs_exchange?: string | undefined;
  rhs_tradingsymbol?: string | undefined;
  rhs_attribute?: string | undefined;
  /** Present only for `ato` alerts; placed as an order when the alert fires. */
  basket?: AlertBasket | undefined;
  /**
   * Optimistic only: Kite's documented modify parameters do not include
   * `status`, and neither official SDK implements the alerts API at all. Sent
   * anyway since undocumented behaviour can lag the docs, but the caller must
   * verify the response's own `status` rather than trust this was honoured.
   */
  status?: 'enabled' | 'disabled' | undefined;
}

/**
 * Alert fields are plain form values — EXCEPT `basket`, which is a JSON-encoded
 * string inside a form field, the same asymmetry as `serialiseGtt`. The right
 * side is sent as either a constant or an instrument reference, never both.
 */
function serialiseAlert(params: AlertParams): Record<string, string | number | undefined> {
  const form: Record<string, string | number | undefined> = {
    name: params.name,
    type: params.type,
    lhs_exchange: params.lhs_exchange,
    lhs_tradingsymbol: params.lhs_tradingsymbol,
    lhs_attribute: params.lhs_attribute,
    operator: params.operator,
    rhs_type: params.rhs_type,
  };

  if (params.rhs_type === 'constant') {
    form.rhs_constant = params.rhs_constant;
  } else {
    form.rhs_exchange = params.rhs_exchange;
    form.rhs_tradingsymbol = params.rhs_tradingsymbol;
    form.rhs_attribute = params.rhs_attribute;
  }

  if (params.basket) {
    form.basket = JSON.stringify(params.basket);
  }
  if (params.status) {
    form.status = params.status;
  }
  return form;
}

// ---------------------------------------------------------------------------
// Historical helpers
// ---------------------------------------------------------------------------

export const HISTORICAL_INTERVALS = [
  'minute',
  '3minute',
  '5minute',
  '10minute',
  '15minute',
  '30minute',
  '60minute',
  'day',
] as const;

export type HistoricalInterval = (typeof HISTORICAL_INTERVALS)[number];

/**
 * Maximum date range per request, by interval.
 *
 * These limits are NOT in the official docs — they come from Zerodha staff on
 * the developer forum. The `day` value is 1900 rather than the 2000 quoted
 * there, because Zerodha's own sandbox chunking helper uses 1900 and the docs
 * note that larger `day` ranges error out.
 */
export const MAX_DAYS_PER_REQUEST: Record<HistoricalInterval, number> = {
  minute: 60,
  '3minute': 100,
  '5minute': 100,
  '10minute': 100,
  '15minute': 200,
  '30minute': 200,
  '60minute': 400,
  day: 1900,
};

export function parseInterval(value: string): HistoricalInterval {
  if ((HISTORICAL_INTERVALS as readonly string[]).includes(value)) {
    return value as HistoricalInterval;
  }
  throw new UsageError(`Unknown interval "${value}".`, `Supported intervals: ${HISTORICAL_INTERVALS.join(', ')}.`);
}

const DAY_MS = 86_400_000;

export function splitDateRange(from: Date, to: Date, maxDays: number): Array<{ from: Date; to: Date }> {
  if (from.getTime() > to.getTime()) {
    throw new UsageError('`--from` must be earlier than `--to`.');
  }
  const ranges: Array<{ from: Date; to: Date }> = [];
  let cursor = from.getTime();
  const end = to.getTime();
  const span = maxDays * DAY_MS;

  while (cursor <= end) {
    const chunkEnd = Math.min(cursor + span, end);
    ranges.push({ from: new Date(cursor), to: new Date(chunkEnd) });
    if (chunkEnd >= end) break;
    // Step one second past the chunk end so ranges do not overlap by a full day.
    cursor = chunkEnd + 1000;
  }
  return ranges;
}

/** Kite expects "yyyy-mm-dd hh:mm:ss" in IST. */
export function formatIstDateTime(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  // Intl can render midnight as hour "24" in some locales/engines.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}:${get('second')}`;
}

export function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}
