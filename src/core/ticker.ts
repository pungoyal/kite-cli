import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { Endpoints } from './config.js';
import { redactUrl } from './redact.js';

/**
 * Kite streaming quotes over WebSocket.
 *
 * Frame layout (all integers BIG-endian):
 *
 *   [0..2)   int16  number of packets in this message
 *   [2..4)   int16  byte length of packet 1
 *   [4..N)          packet 1
 *   ...             (repeating int16 length prefix, then payload)
 *
 * A 1-byte message is a heartbeat.
 *
 * The single most important rule here: **dispatch on packet byte length, not on
 * the mode you subscribed with.** Indices and tradeable instruments share the
 * same subscription modes but have completely different layouts — and their
 * OHLC fields are even in a different order. Five valid sizes exist:
 *
 *   8    LTP mode, any instrument
 *   28   index, quote mode
 *   32   index, full mode
 *   44   tradeable, quote mode
 *   184  tradeable, full mode
 */

export type TickerMode = 'ltp' | 'quote' | 'full';

export interface Depth {
  price: number;
  quantity: number;
  orders: number;
}

export interface Tick {
  instrumentToken: number;
  tradable: boolean;
  mode: TickerMode;
  lastPrice: number;

  lastQuantity?: number;
  averagePrice?: number;
  volume?: number;
  buyQuantity?: number;
  sellQuantity?: number;

  ohlc?: { open: number; high: number; low: number; close: number };
  /** Percentage change against the previous close, computed client-side. */
  change?: number;

  lastTradeTime?: Date;
  exchangeTimestamp?: Date;
  oi?: number;
  oiDayHigh?: number;
  oiDayLow?: number;

  depth?: { buy: Depth[]; sell: Depth[] };
}

/**
 * Exchange segment is the low byte of the instrument token, and it determines
 * the price divisor.
 *
 * Kite's docs mention only the currency case ("divide by 10000000"), and omit
 * BSE currency entirely — that one divides by 10000. Getting this wrong yields
 * prices that are wrong by three orders of magnitude, silently.
 */
const Segment = {
  NseCM: 1,
  NseFO: 2,
  NseCD: 3,
  BseCM: 4,
  BseFO: 5,
  BseCD: 6,
  McxFO: 7,
  McxSX: 8,
  Indices: 9,
} as const;

export function divisorFor(instrumentToken: number): number {
  const segment = instrumentToken & 0xff;
  if (segment === Segment.NseCD) return 10_000_000;
  if (segment === Segment.BseCD) return 10_000;
  return 100;
}

export function isTradable(instrumentToken: number): boolean {
  return (instrumentToken & 0xff) !== Segment.Indices;
}

function toDate(epochSeconds: number): Date | undefined {
  // Kite sends 0 when a timestamp is not applicable.
  return epochSeconds > 0 ? new Date(epochSeconds * 1000) : undefined;
}

function percentChange(lastPrice: number, close: number): number | undefined {
  if (close === 0) return undefined;
  return ((lastPrice - close) * 100) / close;
}

/** Parse one packet. Returns null for a size we do not recognise. */
export function parsePacket(buf: Buffer): Tick | null {
  const token = buf.readUInt32BE(0);
  const divisor = divisorFor(token);
  const tradable = isTradable(token);

  // --- LTP mode: 8 bytes, any instrument ---------------------------------
  if (buf.length === 8) {
    return {
      instrumentToken: token,
      tradable,
      mode: 'ltp',
      lastPrice: buf.readUInt32BE(4) / divisor,
    };
  }

  // --- Index packets: 28 (quote) / 32 (full) ------------------------------
  // NOTE the field order is high/low/open/close here, NOT open/high/low/close
  // as in tradeable packets. Transposing these is an easy and silent bug.
  if (buf.length === 28 || buf.length === 32) {
    const lastPrice = buf.readUInt32BE(4) / divisor;
    const close = buf.readUInt32BE(20) / divisor;
    const tick: Tick = {
      instrumentToken: token,
      tradable: false,
      mode: buf.length === 28 ? 'quote' : 'full',
      lastPrice,
      ohlc: {
        high: buf.readUInt32BE(8) / divisor,
        low: buf.readUInt32BE(12) / divisor,
        open: buf.readUInt32BE(16) / divisor,
        close,
      },
      change: percentChange(lastPrice, close),
    };
    if (buf.length === 32) {
      tick.exchangeTimestamp = toDate(buf.readUInt32BE(28));
    }
    return tick;
  }

  // --- Tradeable packets: 44 (quote) / 184 (full) -------------------------
  if (buf.length === 44 || buf.length === 184) {
    const lastPrice = buf.readUInt32BE(4) / divisor;
    const close = buf.readUInt32BE(40) / divisor;

    const tick: Tick = {
      instrumentToken: token,
      tradable: true,
      mode: buf.length === 44 ? 'quote' : 'full',
      lastPrice,
      lastQuantity: buf.readUInt32BE(8),
      averagePrice: buf.readUInt32BE(12) / divisor,
      volume: buf.readUInt32BE(16),
      buyQuantity: buf.readUInt32BE(20),
      sellQuantity: buf.readUInt32BE(24),
      ohlc: {
        open: buf.readUInt32BE(28) / divisor,
        high: buf.readUInt32BE(32) / divisor,
        low: buf.readUInt32BE(36) / divisor,
        close,
      },
      change: percentChange(lastPrice, close),
    };

    if (buf.length === 184) {
      tick.lastTradeTime = toDate(buf.readUInt32BE(44));
      tick.oi = buf.readUInt32BE(48);
      tick.oiDayHigh = buf.readUInt32BE(52);
      tick.oiDayLow = buf.readUInt32BE(56);
      tick.exchangeTimestamp = toDate(buf.readUInt32BE(60));

      // Market depth: 10 entries of 12 bytes each, from offset 64.
      // Each entry: int32 quantity, int32 price, int16 orders, 2 bytes padding.
      const buy: Depth[] = [];
      const sell: Depth[] = [];
      for (let i = 0; i < 10; i += 1) {
        const offset = 64 + i * 12;
        const entry: Depth = {
          quantity: buf.readUInt32BE(offset),
          price: buf.readUInt32BE(offset + 4) / divisor,
          orders: buf.readUInt16BE(offset + 8),
          // bytes offset+10..offset+12 are padding
        };
        if (i < 5) buy.push(entry);
        else sell.push(entry);
      }
      tick.depth = { buy, sell };
    }

    return tick;
  }

  return null;
}

/**
 * Split a binary message into ticks.
 *
 * Every read is bounds-checked. A truncated or malformed frame must not throw
 * inside the tick loop — a single bad frame should drop that message, not kill
 * a running dashboard.
 */
export function parseBinaryMessage(data: Buffer): Tick[] {
  // 1-byte messages are heartbeats.
  if (data.length < 2) return [];

  const ticks: Tick[] = [];
  const packetCount = data.readInt16BE(0);
  let offset = 2;

  for (let i = 0; i < packetCount; i += 1) {
    if (offset + 2 > data.length) break;
    const length = data.readInt16BE(offset);
    offset += 2;
    if (length <= 0 || offset + length > data.length) break;

    const packet = data.subarray(offset, offset + length);
    offset += length;

    try {
      const tick = parsePacket(packet);
      if (tick) ticks.push(tick);
    } catch {
      // Unrecognised layout; skip this packet and keep the stream alive.
    }
  }

  return ticks;
}

// ---------------------------------------------------------------------------
// Connection management
// ---------------------------------------------------------------------------

export interface TickerOptions {
  apiKey: string;
  accessToken: string;
  endpoints: Endpoints;
  /** Required by the sandbox WebSocket, which the official SDKs omit. */
  userId?: string | undefined;
  maxRetries?: number;
  maxReconnectDelayMs?: number;
  /** Force a reconnect if no data (including heartbeats) arrives for this long. */
  readTimeoutMs?: number;
}

export interface TickerEvents {
  connect: [];
  ticks: [Tick[]];
  orderUpdate: [unknown];
  message: [unknown];
  error: [Error];
  close: [{ code: number; reason: string }];
  reconnect: [{ attempt: number; delayMs: number }];
  noreconnect: [];
}

/** Kite caps a single connection at 3000 instruments, and 3 connections per key. */
export const MAX_INSTRUMENTS_PER_CONNECTION = 3000;
export const MAX_CONNECTIONS_PER_KEY = 3;

export class Ticker extends EventEmitter<TickerEvents> {
  private ws: WebSocket | undefined;
  private readonly opts: Required<Omit<TickerOptions, 'userId'>> & {
    userId?: string | undefined;
  };

  /** Desired subscription state, replayed on every reconnect. */
  private readonly subscriptions = new Set<number>();
  private readonly modes = new Map<number, TickerMode>();

  private attempt = 0;
  private closedByUser = false;
  private watchdog: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;

  constructor(options: TickerOptions) {
    super();
    this.opts = {
      apiKey: options.apiKey,
      accessToken: options.accessToken,
      endpoints: options.endpoints,
      userId: options.userId,
      maxRetries: options.maxRetries ?? 50,
      maxReconnectDelayMs: options.maxReconnectDelayMs ?? 60_000,
      readTimeoutMs: options.readTimeoutMs ?? 10_000,
    };
  }

  private url(): string {
    const url = new URL(this.opts.endpoints.ws);
    url.searchParams.set('api_key', this.opts.apiKey);
    url.searchParams.set('access_token', this.opts.accessToken);
    // The sandbox ticker will not authenticate without this; production ignores it.
    if (this.opts.userId) url.searchParams.set('user_id', this.opts.userId);
    return url.toString();
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.closedByUser = false;

    const target = this.url();
    const socket = new WebSocket(target, { handshakeTimeout: 10_000 });
    socket.binaryType = 'nodebuffer';
    this.ws = socket;

    socket.on('open', () => {
      this.attempt = 0;
      this.armWatchdog();
      this.emit('connect');
      // The server keeps no subscription state across connections, so the full
      // desired state must be replayed every time.
      this.replaySubscriptions();
    });

    socket.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      this.armWatchdog();
      if (isBinary) {
        const buf = toBuffer(data);
        // A 1-byte payload is a heartbeat: liveness only, no ticks.
        if (buf.length === 1) return;
        const ticks = parseBinaryMessage(buf);
        if (ticks.length > 0) this.emit('ticks', ticks);
        return;
      }
      this.handleTextMessage(toBuffer(data).toString('utf8'));
    });

    // Kite sends a heartbeat frame; treat any ping as liveness too.
    socket.on('ping', () => this.armWatchdog());
    socket.on('pong', () => this.armWatchdog());

    socket.on('error', (err: Error) => {
      // The ws error message can embed the full URL, which carries the access
      // token as a query parameter. Never emit it unredacted.
      this.emit('error', new Error(`${redactUrl(this.opts.endpoints.ws)}: ${redactMessage(err.message, target)}`));
    });

    socket.on('close', (code: number, reason: Buffer) => {
      // Guard against a stale socket's close event racing a newer connection.
      if (this.ws !== socket) return;
      this.clearWatchdog();
      this.emit('close', { code, reason: reason.toString('utf8') });
      if (!this.closedByUser) this.scheduleReconnect();
    });
  }

  private handleTextMessage(raw: string): void {
    let payload: { type?: string; data?: unknown };
    try {
      payload = JSON.parse(raw) as { type?: string; data?: unknown };
    } catch {
      return;
    }
    switch (payload.type) {
      case 'order':
        // Same payload shape as an HTTP postback. For a single-user CLI this is
        // the recommended way to receive order updates — no public URL needed.
        this.emit('orderUpdate', payload.data);
        break;
      case 'error':
        this.emit('error', new Error(String(payload.data ?? 'Ticker error')));
        break;
      default:
        this.emit('message', payload.data);
        break;
    }
  }

  /**
   * Watchdog: a TCP connection can die without a close event, leaving the
   * dashboard silently frozen. Kite sends heartbeats continuously, so silence
   * beyond the timeout means the connection is dead.
   */
  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      this.ws?.terminate();
    }, this.opts.readTimeoutMs);
    this.watchdog.unref?.();
  }

  private clearWatchdog(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = undefined;
    }
  }

  private scheduleReconnect(): void {
    if (this.attempt >= this.opts.maxRetries) {
      this.emit('noreconnect');
      return;
    }
    this.attempt += 1;

    // Exponential backoff with jitter. Jitter matters: without it, several
    // ticker processes restarted together would reconnect in lockstep.
    const base = Math.min(2 ** this.attempt * 1000, this.opts.maxReconnectDelayMs);
    const delayMs = Math.round(base / 2 + Math.random() * (base / 2));

    this.emit('reconnect', { attempt: this.attempt, delayMs });
    this.reconnectTimer = setTimeout(() => this.connect(), delayMs);
    this.reconnectTimer.unref?.();
  }

  private send(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private replaySubscriptions(): void {
    if (this.subscriptions.size === 0) return;
    this.send({ a: 'subscribe', v: [...this.subscriptions] });

    // Group tokens by mode so we send one message per mode rather than per token.
    const byMode = new Map<TickerMode, number[]>();
    for (const [token, mode] of this.modes) {
      if (!this.subscriptions.has(token)) continue;
      const list = byMode.get(mode) ?? [];
      list.push(token);
      byMode.set(mode, list);
    }
    for (const [mode, tokens] of byMode) {
      this.send({ a: 'mode', v: [mode, tokens] });
    }
  }

  subscribe(tokens: number[], mode: TickerMode = 'quote'): void {
    for (const token of tokens) {
      this.subscriptions.add(token);
      this.modes.set(token, mode);
    }
    this.send({ a: 'subscribe', v: tokens });
    this.send({ a: 'mode', v: [mode, tokens] });
  }

  unsubscribe(tokens: number[]): void {
    for (const token of tokens) {
      this.subscriptions.delete(token);
      this.modes.delete(token);
    }
    this.send({ a: 'unsubscribe', v: tokens });
  }

  setMode(mode: TickerMode, tokens: number[]): void {
    for (const token of tokens) this.modes.set(token, mode);
    this.send({ a: 'mode', v: [mode, tokens] });
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.closedByUser = true;
    this.clearWatchdog();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = undefined;
  }
}

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

/** Strip the connection URL (and therefore the access token) out of an error. */
function redactMessage(message: string, url: string): string {
  return message.split(url).join(redactUrl(url));
}
