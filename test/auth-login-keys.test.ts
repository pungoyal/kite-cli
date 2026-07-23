import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { listenForKeys } from '../src/commands/auth.js';
import type { Context } from '../src/context.js';

/**
 * The login key listener enters raw mode to catch a `c` (copy the URL), an `m`
 * (switch to the manual paste flow), and a Ctrl-C (abort) while waiting for the
 * browser callback. Raw mode makes us responsible for restoring the terminal
 * and for re-handling Ctrl-C (it arrives as a byte, not a SIGINT), so the
 * lifecycle — enter, restore, detach — is the part that must never regress. A
 * real TTY can't be driven under vitest, so we swap in a fake stdin and emit
 * the bytes ourselves.
 *
 * The `c`-copy path is deliberately not exercised here: it spawns a real
 * clipboard binary (pbcopy/wl-copy/…), and this suite is mock-free by design.
 */

class FakeStdin extends EventEmitter {
  isTTY = true;
  isRaw = false;
  resumed = false;
  paused = false;
  /** Every setRawMode argument, in order — the terminal-state trail we assert on. */
  rawCalls: boolean[] = [];

  setRawMode(value: boolean): this {
    this.rawCalls.push(value);
    this.isRaw = value;
    return this;
  }
  resume(): this {
    this.resumed = true;
    return this;
  }
  pause(): this {
    this.paused = true;
    return this;
  }
}

// Only ctx.io is touched, and only on the (untested) copy path; a stub keeps the
// unit pure without constructing a full context.
const ctx = { io: { success: () => {}, warn: () => {} } } as unknown as Context;
const URL = 'https://kite.zerodha.com/connect/login?v=3&api_key=abc&redirect_params=state%3Ddeadbeef';

const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');

function useStdin(fake: FakeStdin): void {
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true, writable: true });
}

afterEach(() => {
  if (originalStdin) Object.defineProperty(process, 'stdin', originalStdin);
});

describe('listenForKeys', () => {
  it('enters raw mode and starts listening on a TTY', () => {
    const fake = new FakeStdin();
    useStdin(fake);

    listenForKeys(ctx, URL, () => {});

    expect(fake.rawCalls).toEqual([true]);
    expect(fake.resumed).toBe(true);
    expect(fake.listenerCount('data')).toBe(1);
  });

  it('aborts on the first Ctrl-C byte and restores the terminal', () => {
    const fake = new FakeStdin();
    useStdin(fake);
    let interrupts = 0;

    listenForKeys(ctx, URL, () => interrupts++);
    fake.emit('data', Buffer.from([0x03]));

    expect(interrupts).toBe(1);
    // Raw mode is restored to its prior state and the listener is detached.
    expect(fake.rawCalls).toEqual([true, false]);
    expect(fake.listenerCount('data')).toBe(0);

    // A second Ctrl-C after cleanup must not fire the interrupt again.
    fake.emit('data', Buffer.from([0x03]));
    expect(interrupts).toBe(1);
  });

  it('ignores ordinary keys and keeps waiting', () => {
    const fake = new FakeStdin();
    useStdin(fake);
    let interrupts = 0;

    listenForKeys(ctx, URL, () => interrupts++);
    fake.emit('data', Buffer.from('x'));

    expect(interrupts).toBe(0);
    expect(fake.listenerCount('data')).toBe(1); // still listening
    expect(fake.rawCalls).toEqual([true]); // raw mode not yet restored
  });

  it('returns an idempotent cleanup that restores state exactly once', () => {
    const fake = new FakeStdin();
    useStdin(fake);

    const cleanup = listenForKeys(ctx, URL, () => {});
    cleanup();
    cleanup();

    expect(fake.rawCalls).toEqual([true, false]); // one restore despite two calls
    expect(fake.listenerCount('data')).toBe(0);
    expect(fake.paused).toBe(true);
  });

  it('switches to manual mode on an `m` keypress and restores the terminal', () => {
    const fake = new FakeStdin();
    useStdin(fake);
    let manuals = 0;

    listenForKeys(
      ctx,
      URL,
      () => {},
      () => manuals++,
    );
    fake.emit('data', Buffer.from('m'));

    expect(manuals).toBe(1);
    expect(fake.rawCalls).toEqual([true, false]);
    expect(fake.listenerCount('data')).toBe(0);
  });

  it('ignores `m` when no onManual callback is given', () => {
    const fake = new FakeStdin();
    useStdin(fake);

    listenForKeys(ctx, URL, () => {});
    fake.emit('data', Buffer.from('m'));

    expect(fake.rawCalls).toEqual([true]); // still waiting, raw mode untouched since
    expect(fake.listenerCount('data')).toBe(1);
  });

  it('is a no-op when stdin is not a TTY', () => {
    const fake = new FakeStdin();
    fake.isTTY = false;
    useStdin(fake);

    const cleanup = listenForKeys(ctx, URL, () => {});

    expect(fake.rawCalls).toEqual([]); // never touched raw mode
    expect(fake.resumed).toBe(false);
    expect(fake.listenerCount('data')).toBe(0);
    expect(() => cleanup()).not.toThrow();
  });
});
