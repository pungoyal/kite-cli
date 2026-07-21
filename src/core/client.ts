import { Agent, fetch, interceptors, type Dispatcher } from 'undici';
import { z } from 'zod';
import {
  KiteApiError,
  NetworkError,
  KiteCliError,
  ExitCode,
  hintForApiError,
} from './errors.js';
import { EnvelopeSchema, ErrorEnvelopeSchema } from './schemas.js';
import { RateLimiter, type RateCategory } from './ratelimit.js';
import { redact, redactString, registerSecret } from './redact.js';
import type { Endpoints } from './config.js';

/**
 * HTTP client for the Kite Connect v3 API.
 *
 * Transport notes that shaped this file:
 *
 *  - Kite is form-encoded everywhere EXCEPT /margins/* and /charges/orders,
 *    which take JSON bodies. `json` vs `form` on RequestOptions selects.
 *  - `X-Kite-Version: 3` is mandatory on every request.
 *  - The sandbox serves all routes under an /oms prefix except /instruments.
 *  - GTT passes JSON-encoded strings *inside form fields*, not a JSON body.
 */

export interface RequestOptions<S extends z.ZodType> {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  category?: RateCategory;
  query?: Record<string, string | number | boolean | undefined | string[]>;
  /**
   * Form fields. An array value is encoded as a REPEATED field
   * (`isin=A&isin=B`), which is how Kite expects multi-valued form input —
   * notably the holdings authorisation endpoint.
   */
  form?: Record<string, string | number | boolean | string[] | undefined>;
  json?: unknown;
  schema: S;
  signal?: AbortSignal | undefined;
  /** Skip the /oms sandbox prefix. Only /instruments needs this. */
  noPrefix?: boolean;
  /** Per-request timeout override, milliseconds. */
  timeoutMs?: number;
}

export interface ClientOptions {
  apiKey: string;
  accessToken?: string | undefined;
  endpoints: Endpoints;
  limiter?: RateLimiter;
  /** Print redacted request/response diagnostics to stderr. */
  debug?: boolean;
  onDebug?: (message: string) => void;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** The concrete Response type returned by undici's `fetch`. */
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

/**
 * A shared dispatcher with sane timeouts.
 *
 * undici's defaults are far too permissive for a CLI: headersTimeout and
 * bodyTimeout both default to 300 seconds, which would leave a user staring at
 * a hung terminal.
 *
 * The retry policy is deliberately narrow. undici retries GET, HEAD, OPTIONS,
 * PUT, DELETE and TRACE by default — but in this API PUT is "modify order" and
 * DELETE is "cancel order". Kite caps modifications at 25 per order, and there
 * is no idempotency key anywhere in the API, so an automatic retry of a mutating
 * verb is a real-money bug. We retry reads only; every write is retried
 * deliberately by the caller, or not at all.
 */
function createDispatcher(): Dispatcher {
  return new Agent({
    connectTimeout: 5_000,
    headersTimeout: 15_000,
    bodyTimeout: 30_000,
    keepAliveTimeout: 10_000,
    connections: 8,
  }).compose(
    interceptors.retry({
      maxRetries: 3,
      minTimeout: 300,
      maxTimeout: 5_000,
      timeoutFactor: 2,
      retryAfter: true,
      methods: ['GET', 'HEAD'],
      statusCodes: [429, 500, 502, 503, 504],
      errorCodes: ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ENETDOWN', 'ENETUNREACH', 'EPIPE'],
    }),
  );
}

let sharedDispatcher: Dispatcher | undefined;
function dispatcher(): Dispatcher {
  sharedDispatcher ??= createDispatcher();
  return sharedDispatcher;
}

/** Test hook: swap the dispatcher, e.g. for an undici MockAgent. */
export function setDispatcher(d: Dispatcher | undefined): void {
  sharedDispatcher = d;
}

export class KiteClient {
  readonly apiKey: string;
  readonly endpoints: Endpoints;
  readonly limiter: RateLimiter;
  private accessToken: string | undefined;
  private readonly debug: boolean;
  private readonly onDebug: (message: string) => void;
  private readonly timeoutMs: number;

  constructor(opts: ClientOptions) {
    this.apiKey = opts.apiKey;
    this.accessToken = opts.accessToken;
    this.endpoints = opts.endpoints;
    this.limiter = opts.limiter ?? new RateLimiter();
    this.debug = opts.debug ?? false;
    this.onDebug = opts.onDebug ?? ((m) => process.stderr.write(`${m}\n`));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Register here rather than relying on the credential store to have done
    // it. A token can reach the client by other routes — a library consumer
    // constructing it directly, or a future code path — and an unregistered
    // token survives redaction if it turns up somewhere no pattern matches
    // (notably a Kite error message that echoes our input back).
    registerSecret(this.accessToken);
  }

  setAccessToken(token: string | undefined): void {
    this.accessToken = token;
    registerSecret(token);
  }

  hasSession(): boolean {
    return Boolean(this.accessToken);
  }

  private buildUrl(path: string, query: RequestOptions<z.ZodType>['query'], noPrefix: boolean): URL {
    const prefix = noPrefix ? '' : this.endpoints.routePrefix;
    const url = new URL(`${this.endpoints.api}${prefix}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          // Repeated params, e.g. ?i=NSE:INFY&i=NSE:TCS
          for (const item of value) url.searchParams.append(key, item);
        } else {
          url.searchParams.append(key, String(value));
        }
      }
    }
    return url;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      'X-Kite-Version': '3',
      Accept: 'application/json',
      'User-Agent': 'kite-cli',
      ...extra,
    };
    if (this.accessToken) {
      // NEVER log this header. It is `token <api_key>:<access_token>` and is
      // attached to every request, making it the single likeliest leak path.
      headers['Authorization'] = `token ${this.apiKey}:${this.accessToken}`;
    }
    return headers;
  }

  /** Perform a request and validate the `data` payload against `schema`. */
  async request<S extends z.ZodType>(opts: RequestOptions<S>): Promise<z.infer<S>> {
    const category = opts.category ?? 'default';
    await this.limiter.acquire(category, opts.signal);

    const url = this.buildUrl(opts.path, opts.query, opts.noPrefix ?? false);

    let body: string | undefined;
    const extraHeaders: Record<string, string> = {};

    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      extraHeaders['Content-Type'] = 'application/json';
    } else if (opts.form) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(opts.form)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) params.append(key, item);
        } else {
          params.append(key, String(value));
        }
      }
      body = params.toString();
      extraHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const timeout = AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs);
    // Compose the user's Ctrl-C signal with our deadline so both work.
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

    if (this.debug) {
      this.onDebug(
        `→ ${opts.method} ${redactString(url.toString())}${body ? ` body=${redactString(body)}` : ''}`,
      );
    }

    let response: FetchResponse;
    try {
      // Use undici's own `fetch`, not the global one. The global fetch only
      // began honouring the per-request `dispatcher` option in recent Node
      // releases; on older supported versions it silently ignores it and uses
      // the default agent — which would drop our timeouts and retry policy at
      // runtime, and bypass MockAgent in tests. undici's fetch always honours
      // it, so behaviour is identical on every supported Node version.
      response = await fetch(url, {
        method: opts.method,
        headers: this.headers(extraHeaders),
        body,
        signal,
        dispatcher: dispatcher(),
      });
    } catch (err) {
      throw this.toNetworkError(err, opts.method, url);
    }

    const text = await response.text();

    if (this.debug) {
      this.onDebug(`← ${response.status} ${redactString(text.slice(0, 2000))}`);
    }

    return this.handleResponse(response, text, opts.schema, url);
  }

  private toNetworkError(err: unknown, method: string, url: URL): Error {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return new NetworkError(
        `Request timed out: ${method} ${redactString(url.pathname)}`,
        method === 'POST'
          ? 'The order may still have been received. Run `kite orders list` to check before retrying.'
          : 'Check your connection and retry.',
      );
    }
    if (err instanceof Error && err.name === 'AbortError') {
      return new KiteCliError('Cancelled.', ExitCode.Aborted);
    }
    const message = err instanceof Error ? err.message : String(err);
    return new NetworkError(
      `Could not reach Kite: ${redactString(message)}`,
      'Check your network connection.',
    );
  }

  private handleResponse<S extends z.ZodType>(
    response: FetchResponse,
    text: string,
    schema: S,
    url: URL,
  ): z.infer<S> {
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      // A non-JSON body means an infrastructure error page, not the API.
      if (!response.ok) {
        throw new KiteApiError({
          message: `Kite returned HTTP ${response.status} with a non-JSON body.`,
          status: response.status,
          errorType: 'GeneralException',
          hint: hintForApiError(response.status, 'GeneralException'),
        });
      }
      throw new KiteApiError({
        message: `Could not parse Kite's response for ${redactString(url.pathname)}.`,
        status: response.status,
        errorType: 'DataException',
      });
    }

    if (!response.ok) {
      const parsed = ErrorEnvelopeSchema.safeParse(payload);
      const message = parsed.success ? parsed.data.message : `HTTP ${response.status}`;
      const errorType = parsed.success ? parsed.data.error_type : 'GeneralException';
      throw new KiteApiError({
        message: redactString(message),
        status: response.status,
        errorType,
        hint: hintForApiError(response.status, errorType),
      });
    }

    const envelope = EnvelopeSchema.safeParse(payload);
    if (!envelope.success) {
      throw new KiteApiError({
        message: `Unexpected response shape from ${redactString(url.pathname)}.`,
        status: response.status,
        errorType: 'DataException',
      });
    }

    // Kite can return HTTP 200 with status:"error" in the envelope.
    if (envelope.data.status === 'error') {
      const errorType = envelope.data.error_type ?? 'GeneralException';
      throw new KiteApiError({
        message: redactString(envelope.data.message ?? 'Unknown error'),
        status: response.status,
        errorType,
        hint: hintForApiError(response.status, errorType),
      });
    }

    const result = schema.safeParse(envelope.data.data);
    if (!result.success) {
      throw new KiteApiError({
        message:
          `Kite's response did not match the expected shape for ${redactString(url.pathname)}.\n` +
          z.prettifyError(result.error),
        status: response.status,
        errorType: 'DataException',
        hint: 'This usually means the API changed. Please open an issue at https://github.com/pungoyal/kite-cli/issues',
      });
    }
    return result.data;
  }

  /**
   * Fetch a raw (non-JSON) body. Used only for the instrument dump, which is a
   * gzipped CSV rather than an API envelope.
   */
  async requestText(opts: {
    path: string;
    signal?: AbortSignal | undefined;
    noPrefix?: boolean;
    timeoutMs?: number;
  }): Promise<string> {
    await this.limiter.acquire('default', opts.signal);
    const url = this.buildUrl(opts.path, undefined, opts.noPrefix ?? false);

    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 120_000);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

    let response: FetchResponse;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: this.headers(),
        signal,
        // undici's fetch (see request()) so the dispatcher is always honoured.
        dispatcher: dispatcher(),
      });
    } catch (err) {
      throw this.toNetworkError(err, 'GET', url);
    }

    if (!response.ok) {
      throw new KiteApiError({
        message: `Could not download ${redactString(url.pathname)} (HTTP ${response.status}).`,
        status: response.status,
        errorType: 'GeneralException',
        hint: hintForApiError(response.status, 'GeneralException'),
      });
    }
    // fetch transparently decompresses gzip via Content-Encoding.
    return response.text();
  }

  /** Redacted diagnostics for `--debug`. Never includes the Authorization header. */
  describe(): Record<string, unknown> {
    return redact({
      apiKey: this.apiKey,
      hasSession: this.hasSession(),
      endpoints: this.endpoints,
    }) as Record<string, unknown>;
  }
}
