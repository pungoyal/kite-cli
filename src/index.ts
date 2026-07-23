/**
 * Programmatic entry point.
 *
 * The CLI is the product, but the client underneath it is useful on its own —
 * these exports let you script against Kite with the same rate limiting,
 * validation, redaction and error taxonomy the CLI uses.
 */

export {
  type GttParams,
  KiteApi,
  type ModifyOrderParams,
  type PlaceOrderParams,
} from './core/api.js';
export {
  buildLoginUrl,
  computeChecksum,
  computePostbackChecksum,
  verifyPostbackChecksum,
} from './core/auth.js';
export {
  type ClientOptions,
  KiteClient,
  setDispatcher,
} from './core/client.js';
export {
  ENDPOINTS,
  type Endpoints,
} from './core/config.js';
export {
  AuthRequiredError,
  ExitCode,
  KiteApiError,
  KiteCliError,
  type KiteErrorType,
  NetworkError,
  UsageError,
} from './core/errors.js';
export {
  InstrumentStore,
  parseInstrumentKey,
  parseInstrumentsCsv,
} from './core/instruments.js';
export {
  McpServer,
  type McpServerOptions,
  type McpTool,
} from './core/mcp.js';
export {
  DEFAULT_PROFILE,
  getProfile,
  listProfileNames,
  type ResolvedProfile,
  resolveProfile,
  resolveTradingConfig,
  storagePrefixFor,
} from './core/profiles.js';
export {
  ORDER_LIMITS,
  type RateCategory,
  RateLimiter,
} from './core/ratelimit.js';
export {
  maskSecret,
  redact,
  redactString,
  redactUrl,
  registerSecret,
} from './core/redact.js';
export * from './core/schemas.js';
export {
  divisorFor,
  isTradable,
  parseBinaryMessage,
  parsePacket,
  type Tick,
  Ticker,
  type TickerMode,
  type TickerOptions,
} from './core/ticker.js';
