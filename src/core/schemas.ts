import { z } from 'zod';

/**
 * Runtime schemas for Kite API responses.
 *
 * Two rules govern everything here:
 *
 *  1. **Every object is loose.** Zerodha adds fields without notice; a strict
 *     schema would turn a benign API addition into a broken CLI for every user.
 *     We validate the fields we depend on and pass the rest through.
 *
 *  2. **`status` is never an enum.** The order docs list the known states and
 *     then say verbatim "There may be other values as well." An exhaustive
 *     union would reject real orders. We use `z.string()` plus named constants.
 *
 * Binary WebSocket frames are deliberately NOT validated here — they are
 * fixed-length structs, parsed by hand in ticker.ts. Running 3000 instruments
 * of full-mode ticks through a validator would be both the wrong tool and a
 * real cost on the hot path.
 */

/** Kite wraps every successful response as { status: "success", data: ... }. */
export const EnvelopeSchema = z.looseObject({
  status: z.string(),
  data: z.unknown().optional(),
  message: z.string().optional(),
  error_type: z.string().optional(),
});

export const ErrorEnvelopeSchema = z.looseObject({
  status: z.literal('error'),
  message: z.string().default('Unknown error'),
  error_type: z.string().default('GeneralException'),
});

// ---------------------------------------------------------------------------
// Session / user
// ---------------------------------------------------------------------------

export const SessionSchema = z.looseObject({
  user_id: z.string(),
  user_name: z.string().optional(),
  user_shortname: z.string().optional(),
  email: z.string().optional(),
  user_type: z.string().optional(),
  broker: z.string().optional(),
  exchanges: z.array(z.string()).default([]),
  products: z.array(z.string()).default([]),
  order_types: z.array(z.string()).default([]),
  access_token: z.string(),
  public_token: z.string().optional(),
  refresh_token: z.string().optional(),
  login_time: z.string().optional(),
});
export type Session = z.infer<typeof SessionSchema>;

export const ProfileSchema = z.looseObject({
  user_id: z.string(),
  user_name: z.string().optional(),
  user_shortname: z.string().optional(),
  email: z.string().optional(),
  user_type: z.string().optional(),
  broker: z.string().optional(),
  exchanges: z.array(z.string()).default([]),
  products: z.array(z.string()).default([]),
  order_types: z.array(z.string()).default([]),
});
export type Profile = z.infer<typeof ProfileSchema>;

const SegmentMarginSchema = z.looseObject({
  enabled: z.boolean().optional(),
  net: z.number().optional(),
  available: z
    .looseObject({
      cash: z.number().optional(),
      opening_balance: z.number().optional(),
      live_balance: z.number().optional(),
      intraday_payin: z.number().optional(),
      adhoc_margin: z.number().optional(),
      collateral: z.number().optional(),
    })
    .optional(),
  utilised: z
    .looseObject({
      debits: z.number().optional(),
      exposure: z.number().optional(),
      m2m_realised: z.number().optional(),
      m2m_unrealised: z.number().optional(),
      option_premium: z.number().optional(),
      payout: z.number().optional(),
      span: z.number().optional(),
      holding_sales: z.number().optional(),
      turnover: z.number().optional(),
      liquid_collateral: z.number().optional(),
      stock_collateral: z.number().optional(),
      delivery: z.number().optional(),
    })
    .optional(),
});

export const MarginsSchema = z.looseObject({
  equity: SegmentMarginSchema.optional(),
  commodity: SegmentMarginSchema.optional(),
});
export type Margins = z.infer<typeof MarginsSchema>;
export type SegmentMargin = z.infer<typeof SegmentMarginSchema>;

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/** Known terminal states. Not exhaustive — see the note at the top of this file. */
export const ORDER_STATUS = {
  Complete: 'COMPLETE',
  Cancelled: 'CANCELLED',
  Rejected: 'REJECTED',
  Open: 'OPEN',
  TriggerPending: 'TRIGGER PENDING',
} as const;

export const TERMINAL_ORDER_STATUSES = new Set<string>([
  ORDER_STATUS.Complete,
  ORDER_STATUS.Cancelled,
  ORDER_STATUS.Rejected,
]);

export const OrderSchema = z.looseObject({
  order_id: z.string(),
  parent_order_id: z.string().nullish(),
  exchange_order_id: z.string().nullish(),
  status: z.string(),
  status_message: z.string().nullish(),
  status_message_raw: z.string().nullish(),
  order_timestamp: z.string().nullish(),
  exchange_timestamp: z.string().nullish(),
  exchange_update_timestamp: z.string().nullish(),
  variety: z.string().optional(),
  exchange: z.string().optional(),
  tradingsymbol: z.string().optional(),
  instrument_token: z.number().optional(),
  transaction_type: z.string().optional(),
  order_type: z.string().optional(),
  product: z.string().optional(),
  validity: z.string().optional(),
  price: z.number().optional(),
  quantity: z.number().optional(),
  trigger_price: z.number().optional(),
  average_price: z.number().optional(),
  pending_quantity: z.number().optional(),
  filled_quantity: z.number().optional(),
  disclosed_quantity: z.number().optional(),
  cancelled_quantity: z.number().optional(),
  tag: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  placed_by: z.string().optional(),
  guid: z.string().nullish(),
});
export type Order = z.infer<typeof OrderSchema>;

export const TradeSchema = z.looseObject({
  trade_id: z.string(),
  order_id: z.string(),
  exchange_order_id: z.string().nullish(),
  tradingsymbol: z.string().optional(),
  exchange: z.string().optional(),
  instrument_token: z.number().optional(),
  transaction_type: z.string().optional(),
  product: z.string().optional(),
  average_price: z.number().optional(),
  quantity: z.number().optional(),
  fill_timestamp: z.string().nullish(),
  exchange_timestamp: z.string().nullish(),
  order_timestamp: z.string().nullish(),
});
export type Trade = z.infer<typeof TradeSchema>;

/**
 * Place-order response.
 *
 * With `autoslice=true` the shape changes from an object to an ARRAY of up to
 * 10 entries, where success and failure can coexist in a single response. This
 * union models that; callers must handle both.
 */
export const PlaceOrderResultSchema = z.union([
  z.looseObject({ order_id: z.string() }),
  z.array(
    z.union([
      z.looseObject({ order_id: z.string() }),
      z.looseObject({
        error: z.looseObject({
          code: z.number().optional(),
          error_type: z.string().optional(),
          message: z.string().optional(),
        }),
      }),
    ]),
  ),
]);
export type PlaceOrderResult = z.infer<typeof PlaceOrderResultSchema>;

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

export const HoldingSchema = z.looseObject({
  tradingsymbol: z.string(),
  exchange: z.string(),
  instrument_token: z.number().optional(),
  isin: z.string().optional(),
  product: z.string().optional(),
  quantity: z.number().default(0),
  t1_quantity: z.number().default(0),
  realised_quantity: z.number().default(0),
  opening_quantity: z.number().default(0),
  collateral_quantity: z.number().default(0),
  authorised_quantity: z.number().default(0),
  average_price: z.number().default(0),
  last_price: z.number().default(0),
  close_price: z.number().default(0),
  pnl: z.number().default(0),
  day_change: z.number().default(0),
  day_change_percentage: z.number().default(0),
});
export type Holding = z.infer<typeof HoldingSchema>;

export const PositionSchema = z.looseObject({
  tradingsymbol: z.string(),
  exchange: z.string(),
  instrument_token: z.number().optional(),
  product: z.string().optional(),
  quantity: z.number().default(0),
  overnight_quantity: z.number().default(0),
  multiplier: z.number().default(1),
  average_price: z.number().default(0),
  close_price: z.number().default(0),
  last_price: z.number().default(0),
  value: z.number().default(0),
  pnl: z.number().default(0),
  m2m: z.number().default(0),
  unrealised: z.number().default(0),
  realised: z.number().default(0),
  buy_quantity: z.number().default(0),
  buy_price: z.number().default(0),
  buy_value: z.number().default(0),
  sell_quantity: z.number().default(0),
  sell_price: z.number().default(0),
  sell_value: z.number().default(0),
  day_buy_quantity: z.number().default(0),
  day_sell_quantity: z.number().default(0),
});
export type Position = z.infer<typeof PositionSchema>;

export const PositionsSchema = z.looseObject({
  net: z.array(PositionSchema).default([]),
  day: z.array(PositionSchema).default([]),
});
export type Positions = z.infer<typeof PositionsSchema>;

export const AuctionSchema = z.looseObject({
  tradingsymbol: z.string(),
  exchange: z.string(),
  instrument_token: z.number().optional(),
  auction_number: z.string().optional(),
  quantity: z.number().optional(),
  last_price: z.number().optional(),
});

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

const DepthEntrySchema = z.looseObject({
  price: z.number().default(0),
  quantity: z.number().default(0),
  orders: z.number().default(0),
});

export const OhlcSchema = z.looseObject({
  open: z.number().default(0),
  high: z.number().default(0),
  low: z.number().default(0),
  close: z.number().default(0),
});

export const QuoteSchema = z.looseObject({
  instrument_token: z.number(),
  timestamp: z.string().nullish(),
  last_trade_time: z.string().nullish(),
  last_price: z.number().default(0),
  last_quantity: z.number().optional(),
  buy_quantity: z.number().optional(),
  sell_quantity: z.number().optional(),
  volume: z.number().optional(),
  average_price: z.number().optional(),
  oi: z.number().optional(),
  oi_day_high: z.number().optional(),
  oi_day_low: z.number().optional(),
  net_change: z.number().optional(),
  lower_circuit_limit: z.number().optional(),
  upper_circuit_limit: z.number().optional(),
  ohlc: OhlcSchema.optional(),
  depth: z
    .looseObject({
      buy: z.array(DepthEntrySchema).default([]),
      sell: z.array(DepthEntrySchema).default([]),
    })
    .optional(),
});
export type Quote = z.infer<typeof QuoteSchema>;

export const LtpQuoteSchema = z.looseObject({
  instrument_token: z.number(),
  last_price: z.number().default(0),
});
export type LtpQuote = z.infer<typeof LtpQuoteSchema>;

export const OhlcQuoteSchema = z.looseObject({
  instrument_token: z.number(),
  last_price: z.number().default(0),
  ohlc: OhlcSchema.optional(),
});
export type OhlcQuote = z.infer<typeof OhlcQuoteSchema>;

/**
 * Quote endpoints return a map keyed by "EXCHANGE:TRADINGSYMBOL". Instruments
 * with no data — expired, invalid, or never traded — are simply ABSENT from the
 * map rather than present with nulls. Callers must never assume presence.
 */
export const QuoteMapSchema = z.record(z.string(), QuoteSchema);
export const LtpMapSchema = z.record(z.string(), LtpQuoteSchema);
export const OhlcMapSchema = z.record(z.string(), OhlcQuoteSchema);

/**
 * Historical candles: [timestamp, open, high, low, close, volume] with an
 * optional 7th open-interest element when oi=1 was requested.
 */
export const CandleSchema = z.tuple(
  [z.string(), z.number(), z.number(), z.number(), z.number(), z.number()],
  z.number(),
);
export type Candle = z.infer<typeof CandleSchema>;

export const CandlesSchema = z.looseObject({
  candles: z.array(CandleSchema).default([]),
});

// ---------------------------------------------------------------------------
// GTT
// ---------------------------------------------------------------------------

export const GttSchema = z.looseObject({
  id: z.number(),
  user_id: z.string().optional(),
  parent_trigger: z.unknown().nullish(),
  type: z.string(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  expires_at: z.string().optional(),
  status: z.string(),
  condition: z.looseObject({
    exchange: z.string(),
    tradingsymbol: z.string(),
    trigger_values: z.array(z.number()).default([]),
    last_price: z.number().optional(),
    instrument_token: z.number().optional(),
  }),
  orders: z
    .array(
      z.looseObject({
        exchange: z.string().optional(),
        tradingsymbol: z.string().optional(),
        product: z.string().optional(),
        order_type: z.string().optional(),
        transaction_type: z.string().optional(),
        quantity: z.number().optional(),
        price: z.number().optional(),
        result: z.unknown().nullish(),
      }),
    )
    .default([]),
});
export type Gtt = z.infer<typeof GttSchema>;

export const GttCreateResultSchema = z.looseObject({ trigger_id: z.number() });

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

/**
 * An ATO (Alert-Triggers-Order) alert carries a basket — a full order spec that
 * is placed when the alert fires. Every field is optional and the object is
 * loose: we only *read* baskets on existing alerts, and Kite's basket shape is
 * richer than we display, so anything we don't touch must pass through
 * untouched rather than fail parsing (invariant #5).
 */
export const AlertBasketItemSchema = z.looseObject({
  type: z.string().optional(),
  tradingsymbol: z.string().optional(),
  exchange: z.string().optional(),
  instrument_token: z.number().optional(),
  weight: z.number().optional(),
  params: z.looseObject({}).optional(),
});

export const AlertBasketSchema = z.looseObject({
  name: z.string().optional(),
  type: z.string().optional(),
  tags: z.array(z.unknown()).optional(),
  items: z.array(AlertBasketItemSchema).default([]),
});

export const AlertSchema = z.looseObject({
  uuid: z.string(),
  user_id: z.string().optional(),
  type: z.string(),
  name: z.string().optional(),
  status: z.string(),
  disabled_reason: z.string().optional(),
  lhs_attribute: z.string().optional(),
  lhs_exchange: z.string().optional(),
  lhs_tradingsymbol: z.string().optional(),
  operator: z.string().optional(),
  rhs_type: z.string().optional(),
  rhs_attribute: z.string().optional(),
  rhs_exchange: z.string().optional(),
  rhs_tradingsymbol: z.string().optional(),
  rhs_constant: z.number().optional(),
  alert_count: z.number().optional(),
  basket: AlertBasketSchema.optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type Alert = z.infer<typeof AlertSchema>;

/** One entry in an alert's trigger history. `meta`/`order_meta` are large and
 * only shown verbatim in `--json`, so they pass through unvalidated. */
export const AlertHistoryEntrySchema = z.looseObject({
  uuid: z.string().optional(),
  type: z.string().optional(),
  condition: z.string().optional(),
  created_at: z.string().optional(),
  meta: z.unknown().optional(),
  order_meta: z.unknown().nullish(),
});
export type AlertHistoryEntry = z.infer<typeof AlertHistoryEntrySchema>;

// ---------------------------------------------------------------------------
// Margins / charges calculator
// ---------------------------------------------------------------------------

export const OrderMarginSchema = z.looseObject({
  type: z.string().optional(),
  tradingsymbol: z.string().optional(),
  exchange: z.string().optional(),
  span: z.number().optional(),
  exposure: z.number().optional(),
  option_premium: z.number().optional(),
  additional: z.number().optional(),
  bo: z.number().optional(),
  cash: z.number().optional(),
  var: z.number().optional(),
  total: z.number().optional(),
  leverage: z.number().optional(),
  charges: z
    .looseObject({
      transaction_tax: z.number().optional(),
      transaction_tax_type: z.string().optional(),
      exchange_turnover_charge: z.number().optional(),
      sebi_turnover_charge: z.number().optional(),
      brokerage: z.number().optional(),
      stamp_duty: z.number().optional(),
      total: z.number().optional(),
      gst: z
        .looseObject({
          igst: z.number().optional(),
          cgst: z.number().optional(),
          sgst: z.number().optional(),
          total: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
  pnl: z
    .looseObject({
      realised: z.number().optional(),
      unrealised: z.number().optional(),
    })
    .optional(),
});
export type OrderMargin = z.infer<typeof OrderMarginSchema>;

export const BasketMarginSchema = z.looseObject({
  initial: OrderMarginSchema.optional(),
  final: OrderMarginSchema.optional(),
  orders: z.array(OrderMarginSchema).default([]),
  charges: z.unknown().optional(),
});

// ---------------------------------------------------------------------------
// Mutual funds (read-only: the current docs state order placement is not
// available over the API, since it needs a bank debit)
// ---------------------------------------------------------------------------

export const MfHoldingSchema = z.looseObject({
  folio: z.string().nullish(),
  fund: z.string().optional(),
  tradingsymbol: z.string(),
  average_price: z.number().default(0),
  last_price: z.number().default(0),
  last_price_date: z.string().optional(),
  pnl: z.number().default(0),
  quantity: z.number().default(0),
});
export type MfHolding = z.infer<typeof MfHoldingSchema>;

export const MfOrderSchema = z.looseObject({
  order_id: z.string(),
  fund: z.string().optional(),
  tradingsymbol: z.string().optional(),
  status: z.string().optional(),
  status_message: z.string().nullish(),
  folio: z.string().nullish(),
  order_timestamp: z.string().nullish(),
  transaction_type: z.string().optional(),
  quantity: z.number().nullish(),
  amount: z.number().nullish(),
  average_price: z.number().nullish(),
});

export const MfSipSchema = z.looseObject({
  sip_id: z.string(),
  tradingsymbol: z.string().optional(),
  fund: z.string().optional(),
  status: z.string().optional(),
  instalment_amount: z.number().optional(),
  instalments: z.number().optional(),
  frequency: z.string().optional(),
  next_instalment: z.string().nullish(),
});

// ---------------------------------------------------------------------------
// Instruments (parsed from the daily CSV dump)
// ---------------------------------------------------------------------------

export const InstrumentSchema = z.looseObject({
  instrument_token: z.number(),
  exchange_token: z.number().optional(),
  tradingsymbol: z.string(),
  name: z.string().optional(),
  last_price: z.number().optional(),
  expiry: z.string().optional(),
  strike: z.number().optional(),
  tick_size: z.number().optional(),
  lot_size: z.number().optional(),
  instrument_type: z.string().optional(),
  segment: z.string().optional(),
  exchange: z.string(),
});
export type Instrument = z.infer<typeof InstrumentSchema>;
