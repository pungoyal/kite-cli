import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { execa } from 'execa';
import { readFile, access, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Smoke tests against the real built binary.
 *
 * These deliberately spawn a child process, which means HTTP mocking cannot
 * reach them — so they only cover things that do not touch the network:
 * argument parsing, exit codes, and packaging. That is exactly the class of
 * breakage in-process tests miss, notably a lost shebang.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'dist', 'cli.js');

const env = {
  KITE_CONFIG_DIR: join(root, 'node_modules', '.tmp', 'smoke-config'),
  KITE_CACHE_DIR: join(root, 'node_modules', '.tmp', 'smoke-cache'),
  KITE_DISABLE_KEYRING: '1',
  NO_COLOR: '1',
};

beforeAll(async () => {
  try {
    await access(cli);
  } catch {
    throw new Error('dist/cli.js is missing. Run `npm run build` before the smoke tests.');
  }
});

// These tests mutate a real config file on disk. Without a wipe they depend on
// both the order they run in AND on state left by previous runs — e.g. the
// invalid-value test asserts `trading.enabled` is still true, which only holds
// if nothing earlier disabled it. That is a flake waiting to happen in CI.
beforeEach(async () => {
  await rm(env.KITE_CONFIG_DIR, { recursive: true, force: true });
  await rm(env.KITE_CACHE_DIR, { recursive: true, force: true });
});

function kite(args: string[]) {
  return execa(process.execPath, [cli, ...args], {
    env,
    reject: false,
    // A spawn that never returns must fail loudly rather than surface as a
    // confusing exit-code mismatch under CI load.
    timeout: 30_000,
  });
}

describe('packaging', () => {
  it('starts with a shebang', async () => {
    // Silent, total breakage if lost, and no unit test catches it.
    const first = (await readFile(cli, 'utf8')).split('\n')[0];
    expect(first).toBe('#!/usr/bin/env node');
  });

  it('declares the binary in package.json', async () => {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    expect(pkg.bin.kite).toBe('./dist/cli.js');
    expect(pkg.type).toBe('module');
  });
});

describe('basic invocation', () => {
  it('prints the version and exits 0', async () => {
    const result = await kite(['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('prints help and exits 0', async () => {
    const result = await kite(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('kite');
    // Grouped help keeps ~25 commands readable.
    expect(result.stdout).toContain('Trading:');
    expect(result.stdout).toContain('Market data:');
  });

  it('exits 2 on an unknown command', async () => {
    const result = await kite(['definitely-not-a-command']);
    expect(result.exitCode).toBe(2);
  });

  it('exits 2 on an unknown flag', async () => {
    const result = await kite(['quote', '--not-a-flag', 'NSE:INFY']);
    expect(result.exitCode).toBe(2);
  });

  it('exits 3 when a command needs a session and there is none', async () => {
    const result = await kite(['holdings']);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toMatch(/not logged in/i);
  });
});

describe('stream discipline', () => {
  it('keeps notes on stderr and data on stdout', async () => {
    const result = await kite(['whoami', '--json']);
    // Not logged in: the JSON document still belongs on stdout...
    expect(result.stdout.trim()).toBe('{"logged_in":false}');
    // ...and the exit code communicates the failure.
    expect(result.exitCode).toBe(3);
  });

  it('emits no ANSI escapes when NO_COLOR is set', async () => {
    const result = await kite(['config', 'show']);
    // eslint-disable-next-line no-control-regex
    expect(result.stdout).not.toMatch(/\[/);
  });
});

describe('config round-trip', () => {
  it('sets, reads back, and unsets a value', async () => {
    expect((await kite(['config', 'set', 'trading.maxOrderValue', '50000'])).exitCode).toBe(0);

    const shown = await kite(['config', 'show', '--json']);
    expect(JSON.parse(shown.stdout).trading.maxOrderValue).toBe(50000);

    expect((await kite(['config', 'unset', 'trading.maxOrderValue'])).exitCode).toBe(0);
    const after = await kite(['config', 'show', '--json']);
    expect(JSON.parse(after.stdout).trading.maxOrderValue).toBeUndefined();
  });

  it('rejects an invalid value without writing it', async () => {
    const result = await kite(['config', 'set', 'trading.enabled', 'perhaps']);
    expect(result.exitCode).toBe(2);

    const shown = await kite(['config', 'show', '--json']);
    // The bad write must not have landed.
    expect(JSON.parse(shown.stdout).trading.enabled).toBe(true);
  });

  it('rejects an unknown setting', async () => {
    const result = await kite(['config', 'set', 'not.a.real.setting', 'x']);
    expect(result.exitCode).toBe(2);
  });
});
