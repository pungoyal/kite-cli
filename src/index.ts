/**
 * Programmatic entry point.
 *
 * The CLI is the product, but the client underneath it is useful on its own —
 * these exports let you script against Kite with the same rate limiting,
 * validation, redaction and error taxonomy the CLI uses.
 */

export { KiteClient, setDispatcher, type ClientOptions } from './core/client.js';
export { KiteApi, type PlaceOrderParams, type ModifyOrderParams, type GttParams } from './core/api.js';
export {
  Ticker,
  parsePacket,
  parseBinaryMessage,
  divisorFor,
  isTradable,
  type Tick,
  type TickerMode,
  type TickerOptions,
} from './core/ticker.js';
export { InstrumentStore, parseInstrumentsCsv, parseInstrumentKey } from './core/instruments.js';
export { RateLimiter, ORDER_LIMITS, type RateCategory } from './core/ratelimit.js';
export {
  computeChecksum,
  computePostbackChecksum,
  verifyPostbackChecksum,
  buildLoginUrl,
} from './core/auth.js';
export { redact, redactString, redactUrl, registerSecret, maskSecret } from './core/redact.js';
export {
  KiteCliError,
  KiteApiError,
  AuthRequiredError,
  NetworkError,
  UsageError,
  ExitCode,
  type KiteErrorType,
} from './core/errors.js';
export { endpointsFor, SANDBOX_CREDENTIALS, type Environment, type Endpoints } from './core/config.js';
export * from './core/schemas.js';
