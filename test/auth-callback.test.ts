import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateState, redirectUrlFor, waitForCallback } from '../src/core/auth.js';
import { ExitCode } from '../src/core/errors.js';

/**
 * The login loopback callback server.
 *
 * A real 127.0.0.1 server is bound and driven with real requests — the CSRF
 * state check is security-critical and worth exercising against the actual
 * socket. Each test uses a fresh port to avoid TIME_WAIT collisions, and the
 * handle is force-closed in afterEach as a backstop.
 */

const PATH = '/callback';
let port = 51870;
let handle: ReturnType<typeof waitForCallback> | undefined;

beforeEach(() => {
  port += 1;
});

afterEach(() => {
  handle?.close();
  handle = undefined;
});

/** Hit the callback, retrying until the server has finished binding. */
async function hit(params: Record<string, string>): Promise<Response> {
  const url = `http://127.0.0.1:${port}${PATH}?${new URLSearchParams(params).toString()}`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await fetch(url);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error('callback server never accepted a connection');
}

describe('waitForCallback', () => {
  it('resolves with the request token when the CSRF state matches', async () => {
    const state = generateState();
    handle = waitForCallback({ port, path: PATH, state, timeoutMs: 5000 });
    // Attach the settlement handler synchronously, before the request settles it.
    const settled = handle.promise;

    await hit({ status: 'success', request_token: 'reqtok123', state });

    await expect(settled).resolves.toEqual({ requestToken: 'reqtok123' });
  });

  it('rejects a callback whose state does not match, with an auth-level CSRF error', async () => {
    handle = waitForCallback({ port, path: PATH, state: generateState(), timeoutMs: 5000 });
    // Capture the rejection now; the callback rejects during hit(), and a handler
    // attached afterwards would leave a window Node flags as an unhandled rejection.
    const settled = handle.promise.catch((e) => e);

    const res = await hit({ status: 'success', request_token: 'x', state: 'forged-state' });
    expect(res.status).toBe(400);

    const err = await settled;
    expect(err.exitCode).toBe(ExitCode.Auth);
    expect(err.message).toMatch(/csrf|state/i);
  });

  it('rejects when the state matches but no request token comes back', async () => {
    const state = generateState();
    handle = waitForCallback({ port, path: PATH, state, timeoutMs: 5000 });
    const settled = handle.promise.catch((e) => e);

    const res = await hit({ status: 'failure', state });
    expect(res.status).toBe(400);

    const err = await settled;
    expect(err.exitCode).toBe(ExitCode.Auth);
  });
});

describe('helpers', () => {
  it('builds the loopback redirect URL from a port and path', () => {
    expect(redirectUrlFor(51101, '/callback')).toBe('http://127.0.0.1:51101/callback');
  });

  it('generates unique 32-character hex state', () => {
    const a = generateState();
    const b = generateState();
    expect(a).toMatch(/^[a-f0-9]{32}$/);
    expect(a).not.toBe(b);
  });
});
