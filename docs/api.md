# Library API reference

The CLI is the product, but `@pungoyal/kite-cli` also exports the client
underneath it, so you can script against Kite Connect with the same rate
limiting, response validation, redaction, and error taxonomy the CLI uses.
See the README's [Library use](https://github.com/pungoyal/kite-cli#library-use) section for a
minimal example; this page covers the full exported surface from
[`src/index.ts`](https://github.com/pungoyal/kite-cli/blob/main/src/index.ts).

This reference is **hand-written by design**, not generated. `src/index.ts`
re-exports every schema in `core/schemas.ts` (`export * from './core/schemas.js'`)
— enumerating all of them here would be low-signal noise for a small,
curated surface. Revisit this decision (e.g. adopt TypeDoc) only if library
adoption grows enough to need per-symbol generated docs; until then, a
hand-maintained page for a surface this size is cheaper than a generator
dependency and build step.

## Installation & import

```bash
npm install @pungoyal/kite-cli
```

```ts
import { ENDPOINTS, KiteApi, KiteClient } from '@pungoyal/kite-cli';
```

## `KiteClient` — HTTP transport

The low-level transport: rate limiting, retries, redaction, and response
validation, all as one `request()` call.

```ts
import { ENDPOINTS, KiteClient } from '@pungoyal/kite-cli';

const client = new KiteClient({
  apiKey: process.env.KITE_API_KEY!,
  accessToken: process.env.KITE_ACCESS_TOKEN!,
  endpoints: ENDPOINTS,
});
```

`ClientOptions`: `apiKey`, `accessToken` (optional — omit to construct a
client before login), `endpoints`, `limiter` (a `RateLimiter` instance, one
is created for you if omitted), `debug`/`onDebug` (redacted diagnostics),
`timeoutMs`.

`ENDPOINTS` is the fixed `Endpoints` (`{ api, ws, login }`) used to build both
`KiteClient` and `Ticker`.

Notable methods:

- `client.request({ method, path, schema, ... })` — the one method every
  `KiteApi` call is built on. Validates the response against a Zod
  `schema`, applies the correct content type (Kite is form-encoded except
  `/margins/*` and `/charges/orders`, which take JSON), and paces itself
  per `category` (`'quote' | 'historical' | 'order' | 'default'`).
- `client.setAccessToken(token)` — swap the token after construction (e.g.
  once login completes).
- `client.hasSession()` — whether a token is currently set.

**Retries are transport-level and read-only by design**: only `GET`/`HEAD`
retry automatically (network errors and `429`/`5xx`, capped at 3 attempts
with backoff). `POST`/`PUT`/`DELETE` — place/modify/cancel in this API —
are never retried, because Kite has no idempotency key. See
[safety.md](safety.md#no-blind-retries-order-tag-reconciliation) for how
the CLI itself reconciles an ambiguous write; a library consumer placing
orders directly should adopt the same pattern (a unique client-side tag,
searched for on failure).

`setDispatcher(dispatcher)` swaps the shared undici dispatcher — a test
hook for injecting an `undici.MockAgent`, not meant for production use.

## `KiteApi` — typed endpoints

Wraps `KiteClient` with one method per Kite Connect endpoint, each
returning validated, typed data. Grouped by area (see
[`src/core/api.ts`](https://github.com/pungoyal/kite-cli/blob/main/src/core/api.ts) for exact signatures):

```ts
const api = new KiteApi(client);
```

- **Auth**: `createSession({ requestToken, checksum })`,
  `invalidateSession(accessToken)`, `getProfile()`.
- **Portfolio**: `getHoldings()`, `getPositions()`, `getMargins()`,
  `getAuctions()`, `convertPosition({ ... })`,
  `authoriseHoldings(isins?)`, `authorisationUrl(requestId)`.
- **Orders**: `getOrders()`, `getOrderHistory(orderId)`, `getTrades()`,
  `getOrderTrades(orderId)`, `placeOrder(params: PlaceOrderParams)`,
  `modifyOrder(params: ModifyOrderParams)`,
  `cancelOrder({ variety, order_id, parent_order_id? })`,
  `findOrderByTag(tag)` (the reconciliation lookup — see
  [safety.md](safety.md)).
- **GTT**: `getGtts()`, `getGtt(id)`, `placeGtt(params: GttParams)`,
  `modifyGtt(id, params)`, `deleteGtt(id)`.
- **Alerts**: `getAlerts()`, `getAlert(uuid)`, `getAlertHistory(uuid)`,
  `createAlert(params: AlertParams)`, `modifyAlert(uuid, params)`,
  `deleteAlerts(uuids)`.
- **Market data**: `getQuote(instruments)`, `getOhlc(instruments)`,
  `getLtp(instruments)`, `getHistorical({ instrumentToken, interval, from, to, ... })`,
  `getInstrumentsCsv(exchange?)`.
- **Margins & charges**: `orderMargins(orders)`,
  `basketMargins(orders, considerPositions?)`, `orderCharges(orders)`.
- **Mutual funds** (read-only over the API): `getMfHoldings()`,
  `getMfOrders()`, `getMfSips()`.

Every mutating method (`placeOrder`, `modifyOrder`, `cancelOrder`,
`placeGtt`, `modifyGtt`, `deleteGtt`, `createAlert`, `modifyAlert`,
`deleteAlerts`, `convertPosition`, `authoriseHoldings`) accepts an optional
trailing `AbortSignal`.

```ts
const holdings = await api.getHoldings();
const order = await api.placeOrder({
  variety: 'regular',
  exchange: 'NSE',
  tradingsymbol: 'INFY',
  transaction_type: 'BUY',
  order_type: 'LIMIT',
  quantity: 10,
  price: 1500,
  product: 'CNC',
  validity: 'DAY',
  tag: 'my-app-order-1',
});
```

`core/api.ts` also has internal helpers (`parseInterval`, `splitDateRange`,
`chunks`, `formatIstDateTime`) that the CLI's own commands use for interval
validation and date-range chunking — they are **not** re-exported from
`src/index.ts` and the package declares no subpath exports, so they are not
importable from outside this repo. `PlaceOrderParams`, `ModifyOrderParams`,
and `GttParams` (used above) are the only `core/api.ts` symbols on the
public surface besides `KiteApi` itself.

## `Ticker` — WebSocket streaming

```ts
import { ENDPOINTS, Ticker } from '@pungoyal/kite-cli';

const ticker = new Ticker({
  apiKey,
  accessToken,
  endpoints: ENDPOINTS,
});

ticker.on('connect', () => ticker.subscribe([408065], 'full')); // NSE:INFY
ticker.on('ticks', (ticks) => console.log(ticks));
ticker.on('error', (err) => console.error(err));
ticker.connect();
```

`TickerOptions`: `apiKey`, `accessToken`, `endpoints`, `maxRetries`,
`maxReconnectDelayMs`, `readTimeoutMs` (forces a reconnect if nothing —
including heartbeats — arrives for this long).

Methods: `connect()`, `subscribe(tokens, mode?)` (`mode` is the `TickerMode`
type — `'ltp' | 'quote' | 'full'`, default `'quote'`), `unsubscribe(tokens)`,
`setMode(mode, tokens)`, `close()`. Subscriptions are replayed
automatically on every reconnect — the server keeps no subscription state
across connections.

Events emitted (the shape is typed internally as `TickerEvents`, which is
not itself re-exported): `connect`, `ticks` (`Tick[]`), `orderUpdate`,
`message`, `error`, `close` (`{ code, reason }`), `reconnect`
(`{ attempt, delayMs }`), `noreconnect`.

Kite caps a single connection at 3,000 instruments and 3 connections per
API key — internal constants `MAX_INSTRUMENTS_PER_CONNECTION` and
`MAX_CONNECTIONS_PER_KEY` in `src/core/ticker.ts`, not re-exported from the
package entry (the CLI's own `watch` command imports them directly from
`core/ticker.js`, not from `src/index.ts`).

Lower-level parsing, if you're handling raw frames yourself:
`parsePacket(buf)` (one tick), `parseBinaryMessage(data)` (a full frame,
possibly several ticks), `isTradable(instrumentToken)`,
`divisorFor(instrumentToken)` (price divisor, which differs by segment).
Index instruments and tradeable instruments use different packet layouts,
including reordered OHLC fields — see the comments in
[`src/core/ticker.ts`](https://github.com/pungoyal/kite-cli/blob/main/src/core/ticker.ts) if you're parsing packets
directly rather than through `Ticker`.

## `McpServer` — embed the MCP server

The same JSON-RPC-over-stdio server `kite mcp` runs, if you want to host it
yourself (e.g. with a different tool set, or over a transport other than
stdio):

```ts
import { McpServer, type McpTool } from '@pungoyal/kite-cli';

const tools: McpTool[] = [
  {
    name: 'ping',
    description: 'Health check',
    schema: z.object({}),
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({ ok: true }),
  },
];

const server = new McpServer({ name: 'my-server', version: '1.0.0', tools });
await server.serve(process.stdin, process.stdout);
```

`McpServerOptions`: `name`, `version`, `tools` (`McpTool[]`), and an optional
`signal` — aborting it stops the serve loop after the in-flight message.
Each `McpTool` pairs a Zod `schema` (validates the arguments at the handler
boundary) with the `inputSchema` JSON Schema advertised in `tools/list`, plus
the `handler` itself. See [`src/commands/mcp.ts`](https://github.com/pungoyal/kite-cli/blob/main/src/commands/mcp.ts)
for the CLI's own read-only tool set built this way, and [the MCP server
page](mcp.md) for why writes are deliberately not exposed.

## Auth helpers

Building blocks for implementing the OAuth login flow yourself (the CLI's
own flow, in [`src/commands/auth.ts`](https://github.com/pungoyal/kite-cli/blob/main/src/commands/auth.ts), is built
from exactly these):

- `buildLoginUrl({ apiKey, endpoints, state })` — the Kite Connect login
  URL to redirect a user to. `state` is an opaque CSRF value you generate
  (see `generateState()` in `core/auth.ts`, not itself re-exported) and
  verify against `redirect_params` on the callback.
- `computeChecksum(apiKey, requestToken, apiSecret)` — the SHA-256 checksum
  required to exchange a `request_token` for a session
  (`KiteApi.createSession`).
- `computePostbackChecksum(orderId, orderTimestamp, apiSecret)` /
  `verifyPostbackChecksum(...)` — for verifying Kite's order postback
  webhooks, if you're consuming those independently of this CLI.

## Profiles — multi-account resolution

The same profile-resolution logic the CLI's `--profile`/`KITE_PROFILE`
handling uses, exposed for embedders building their own multi-account
tooling:

- `resolveProfile({ profileFlag }, config)` — resolve the effective profile
  (a `ResolvedProfile`: `name`, `apiKey`, per-profile `trading` overrides, and
  `explicit` — whether the caller named it directly rather than falling back
  to the default) for a set of selectors against a loaded config object.
- `resolveTradingConfig(config, profile)` — the trading config actually in
  force for a profile (global settings overlaid with per-profile
  overrides, fail-closed on unset fields).
- `getProfile(config, name)`, `listProfileNames(config)`,
  `storagePrefixFor(profile)` (the keyring/file namespace prefix for a
  profile's secrets), `DEFAULT_PROFILE` (the reserved profile name
  constant).

See [configuration.md](configuration.md#profiles) for the concepts these
implement.

## `InstrumentStore`

Loads and caches the Kite instrument master, and resolves
`EXCHANGE:TRADINGSYMBOL` keys to the numeric tokens the API and ticker need
— never the reverse, since exchanges reuse tokens after expiry.

```ts
const instruments = new InstrumentStore(api, 'production');
await instruments.load();
const infy = instruments.lookup('NSE', 'INFY');
const token = instruments.requireToken('NSE:INFY'); // throws if unresolved
```

`load({ force?, signal? })` fetches and caches the instrument master (daily
cache by default; `force` re-downloads). `loadCachedOnly()` loads only from
the on-disk cache, returning `false` rather than fetching if none exists.
`lookup(exchange, tradingsymbol)`, `lookupKey(instrumentKey)`,
`requireToken(instrumentKey)`.

Free functions: `parseInstrumentKey(value)` splits an
`EXCHANGE:TRADINGSYMBOL` string, `parseInstrumentsCsv(csv)` parses the raw
CSV Kite serves the instrument master as. (The reverse,
`formatInstrumentKey`, exists in `core/instruments.ts` but is not
re-exported from `src/index.ts`.)

## `RateLimiter`

The pacing Kite's per-endpoint-category limits require, applied
automatically to every `KiteApi` call. Construct your own instance to
share a limiter across multiple `KiteClient`s, or to inspect `ORDER_LIMITS`
(the documented request-count ceilings per `RateCategory`:
`'quote' | 'historical' | 'order' | 'default'`).

## Redaction

The same scrubber the CLI uses to keep tokens out of logs and errors:

- `registerSecret(value)` — register a string so `redact`/`redactString`
  scrub it from any subsequent output, even in an error path that doesn't
  know it's handling a secret.
- `redact(value)` — deep-redact an object (e.g. before logging a response).
- `redactString(text)` / `redactUrl(url)` — scrub a string or URL (the
  latter also strips token query parameters, notably in ticker WebSocket
  URLs).
- `maskSecret(value, visible?)` — partially mask a value for display
  (e.g. `"••••••••3f9a"`) rather than fully hiding it.

If you're embedding this library and logging your own diagnostics, call
`registerSecret` on any token you obtain (from `createSession`, an env var,
wherever) so it's covered everywhere, not just in this library's own
output.

## Errors

Every error this library raises deliberately extends `KiteCliError`
(`message`, `exitCode`, optional `hint`):

- `KiteApiError` — a structured error from Kite itself (`status`,
  `errorType: KiteErrorType | string`); the exit code is derived from both,
  since Kite pairs some distinct conditions (e.g. HTTP 428, depository
  authorisation) with a generic `error_type`.
- `AuthRequiredError` — no session, or it expired.
- `UsageError` — bad input, distinct from Kite rejecting valid-looking
  input.
- `NetworkError` — DNS/TCP/TLS/timeout failure below the HTTP layer.
- `ExitCode` — the full enum of process exit codes this library and CLI
  use, documented in the [exit code table](scripting.md#exit-codes).

## Response schemas

`src/index.ts` re-exports everything from
[`src/core/schemas.ts`](https://github.com/pungoyal/kite-cli/blob/main/src/core/schemas.ts) — the Zod schemas every API
response is validated against (loose objects by design, so new fields Kite
adds don't break parsing). Import a schema directly if you want to validate
or type a response yourself; there are too many to enumerate usefully here,
so treat `core/schemas.ts` as the reference.
