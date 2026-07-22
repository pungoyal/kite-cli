import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Endpoints } from './config.js';
import { ExitCode, KiteCliError, UsageError } from './errors.js';
import { registerSecret } from './redact.js';

/**
 * The Kite Connect login handshake.
 *
 *   1. Open https://kite.zerodha.com/connect/login?v=3&api_key=...
 *   2. User authenticates in their browser (including mandatory TOTP 2FA).
 *   3. Kite redirects to the registered URL with ?request_token=...
 *   4. POST /session/token with checksum = SHA256(api_key + request_token + api_secret)
 *
 * The CLI never sees the user's password or TOTP. We deliberately do not offer
 * to store a TOTP seed: holding the 2FA secret alongside the API secret would
 * collapse both factors into one, which is precisely what the SEBI 2FA mandate
 * exists to prevent.
 */

/** checksum = SHA256(api_key + request_token + api_secret), hex. */
export function computeChecksum(apiKey: string, requestToken: string, apiSecret: string): string {
  return createHash('sha256').update(`${apiKey}${requestToken}${apiSecret}`).digest('hex');
}

/**
 * Postback checksum — note this is a DIFFERENT concatenation from the login
 * checksum: SHA256(order_id + order_timestamp + api_secret).
 */
export function computePostbackChecksum(orderId: string, orderTimestamp: string, apiSecret: string): string {
  return createHash('sha256').update(`${orderId}${orderTimestamp}${apiSecret}`).digest('hex');
}

export function verifyPostbackChecksum(
  received: string,
  orderId: string,
  orderTimestamp: string,
  apiSecret: string,
): boolean {
  return safeCompare(received, computePostbackChecksum(orderId, orderTimestamp, apiSecret));
}

/**
 * Constant-time string comparison that cannot throw.
 *
 * `timingSafeEqual` requires equal BYTE lengths and throws RangeError
 * otherwise, so the length guard must be on the encoded buffers — not on
 * `String.length`, which counts UTF-16 code units and can match while the byte
 * lengths differ. Both call sites compare attacker-influenced input.
 */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface LoginUrlOptions {
  apiKey: string;
  endpoints: Endpoints;
  /** Opaque CSRF value echoed back by Kite via redirect_params. */
  state: string;
}

export function buildLoginUrl(opts: LoginUrlOptions): string {
  const url = new URL(opts.endpoints.login);
  // v=3 is required for a v3 session.
  url.searchParams.set('v', '3');
  url.searchParams.set('api_key', opts.apiKey);
  // redirect_params is echoed back verbatim on the redirect, which gives us a
  // CSRF state parameter even though Kite has no first-class `state`.
  url.searchParams.set('redirect_params', `state=${opts.state}`);
  return url.toString();
}

export function generateState(): string {
  return randomBytes(16).toString('hex');
}

export interface CallbackResult {
  requestToken: string;
}

export interface CallbackServerOptions {
  port: number;
  path: string;
  state: string;
  timeoutMs?: number;
}

/**
 * Run a one-shot loopback HTTP server to capture the request_token.
 *
 * Kite's developer console requires HTTPS for redirect URLs but explicitly
 * permits plain http:// for localhost and 127.0.0.1, which is the standard
 * pattern for native apps. We bind to 127.0.0.1 specifically (never 0.0.0.0),
 * so the callback is not reachable from the network.
 */
export function waitForCallback(opts: CallbackServerOptions): {
  promise: Promise<CallbackResult>;
  close: () => void;
} {
  let server: Server | undefined;
  let settled = false;
  let timer: NodeJS.Timeout | undefined;

  const close = () => {
    if (timer) clearTimeout(timer);
    server?.close();
    server?.closeAllConnections?.();
  };

  const promise = new Promise<CallbackResult>((resolve, reject) => {
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      close();
      fn();
    };

    const handler = (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${opts.port}`);

      if (url.pathname !== opts.path) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      const status = url.searchParams.get('status');
      const requestToken = url.searchParams.get('request_token');
      const receivedState = url.searchParams.get('state');

      // Constant-time state comparison. A mismatch means this callback did not
      // originate from the login we started.
      //
      // The length guard compares BYTE lengths, not string lengths: a string of
      // 32 multi-byte characters has the same `.length` as our 32-char hex
      // state but a different Buffer size, and timingSafeEqual throws
      // RangeError on mismatched buffers. That would crash the callback server
      // on input an attacker fully controls.
      const stateOk = receivedState !== null && safeCompare(receivedState, opts.state);

      if (!stateOk) {
        respondHtml(
          res,
          400,
          'Login failed',
          'State mismatch — this callback did not come from the login this CLI started.',
        );
        settle(() =>
          reject(
            new KiteCliError(
              'Login callback failed a CSRF state check.',
              ExitCode.Auth,
              'Run `kite login` again, and complete it in a single browser session.',
            ),
          ),
        );
        return;
      }

      if (status !== 'success' || !requestToken) {
        respondHtml(res, 400, 'Login failed', 'Kite did not return a request token.');
        settle(() => reject(new KiteCliError('Kite did not return a request token.', ExitCode.Auth)));
        return;
      }

      registerSecret(requestToken);
      respondHtml(res, 200, 'Logged in', 'You can close this tab and return to your terminal.');
      settle(() => resolve({ requestToken }));
    };

    server = createServer(handler);

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        settle(() =>
          reject(
            new UsageError(
              `Port ${opts.port} is already in use.`,
              'Set a different port with `kite config set redirectPort <port>`, and update the redirect URL in your Kite developer console to match.',
            ),
          ),
        );
        return;
      }
      settle(() => reject(err));
    });

    server.listen(opts.port, '127.0.0.1');

    const timeoutMs = opts.timeoutMs ?? 300_000;
    timer = setTimeout(() => {
      settle(() =>
        reject(
          new KiteCliError(
            `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the browser callback.`,
            ExitCode.Auth,
            'Run `kite login --manual` to paste the request token by hand instead.',
          ),
        ),
      );
    }, timeoutMs);
    timer.unref?.();
  });

  return { promise, close };
}

function respondHtml(res: ServerResponse, status: number, title: string, detail: string): void {
  const body = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; display: grid;
         place-items: center; min-height: 100vh; margin: 0; background: #0f1115; color: #e6e8eb; }
  .card { text-align: center; padding: 2.5rem 3rem; border-radius: 12px; background: #171a21;
          box-shadow: 0 8px 32px rgba(0,0,0,.4); }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0; color: #9aa4b2; font-size: .925rem; }
</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></div></body>
</html>`;
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    // This page is generated locally and references nothing external.
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

export function redirectUrlFor(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

/**
 * Copy text to the OS clipboard, returning whether it succeeded.
 *
 * Like {@link openBrowser}, the text is piped to a fixed binary's stdin — never
 * through a shell and never as an argv element — so a URL's `&`/`=` cannot
 * become word-splitting or command injection. On Linux there is no single
 * clipboard tool, so we try the common ones in turn (Wayland first, then X11).
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  const candidates: Array<[string, string[]]> =
    process.platform === 'darwin'
      ? [['pbcopy', []]]
      : process.platform === 'win32'
        ? [['clip', []]]
        : [
            ['wl-copy', []],
            ['xclip', ['-selection', 'clipboard']],
            ['xsel', ['--clipboard', '--input']],
          ];

  for (const [command, args] of candidates) {
    if (await pipeToCommand(command, args, text)) return true;
  }
  return false;
}

/** Spawn `command`, write `text` to its stdin, resolve true on a clean exit. */
function pipeToCommand(command: string, args: string[], text: string): Promise<boolean> {
  return import('node:child_process').then(
    ({ spawn }) =>
      new Promise<boolean>((resolve) => {
        try {
          const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], shell: false });
          child.on('error', () => resolve(false));
          child.on('close', (code) => resolve(code === 0));
          child.stdin.on('error', () => resolve(false));
          child.stdin.end(text);
        } catch {
          resolve(false);
        }
      }),
  );
}

/**
 * Open a URL in the user's default browser.
 *
 * The URL is passed as an argv element to a fixed binary, never through a
 * shell, so a crafted URL cannot become command injection.
 */
export async function openBrowser(url: string): Promise<boolean> {
  const { spawn } = await import('node:child_process');

  let command: string;
  let args: string[];
  switch (process.platform) {
    case 'darwin':
      command = 'open';
      args = [url];
      break;
    case 'win32':
      // start is a cmd builtin; the empty string is the window-title argument,
      // without which a quoted URL is treated as the title.
      command = 'cmd';
      args = ['/c', 'start', '', url];
      break;
    default:
      command = 'xdg-open';
      args = [url];
      break;
  }

  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, {
        stdio: 'ignore',
        detached: true,
        shell: false,
      });
      child.on('error', () => resolve(false));
      child.unref();
      // spawn errors surface asynchronously; give it a moment before claiming success.
      setTimeout(() => resolve(true), 250).unref?.();
    } catch {
      resolve(false);
    }
  });
}
