import { rm } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { meetsFloor } from '../src/commands/doctor.js';
import { ExitCode } from '../src/core/errors.js';
import { configDir } from '../src/core/paths.js';
import { run } from '../src/run.js';

/**
 * doctor is offline, so no network mock is needed. The suite disables the
 * keyring and sandboxes the config dir (see test/setup.ts), so a fresh run has
 * no config, no keyring, and no session — every soft check warns, and the
 * command must still exit 0 because warnings are advisory, not failures.
 */

describe('meetsFloor', () => {
  it('accepts equal and newer versions, rejects older', () => {
    expect(meetsFloor('22.12.0', '22.12.0')).toBe(true);
    expect(meetsFloor('24.3.1', '22.12.0')).toBe(true);
    expect(meetsFloor('22.13.0', '22.12.0')).toBe(true);
    expect(meetsFloor('22.11.9', '22.12.0')).toBe(false);
    expect(meetsFloor('20.19.0', '22.12.0')).toBe(false);
  });
});

describe('kite doctor', () => {
  let stdout: PassThrough;
  let stderr: PassThrough;
  let out: string;

  beforeEach(async () => {
    stdout = new PassThrough();
    stderr = new PassThrough();
    out = '';
    stdout.on('data', (chunk) => (out += chunk));
    await rm(configDir(), { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(configDir(), { recursive: true, force: true });
  });

  const invoke = (args: string[]) => run({ argv: ['node', 'kite', ...args], streams: { stdout, stderr } });

  it('exits 0 on a fresh setup even though soft checks warn', async () => {
    const code = await invoke(['doctor', '--json']);
    expect(code).toBe(ExitCode.Ok);

    const doc = JSON.parse(out);
    expect(doc.ok).toBe(true);
    const byName = Object.fromEntries(doc.checks.map((c: { name: string }) => [c.name, c]));
    // Every check the report promises is present.
    expect(Object.keys(byName)).toEqual(
      expect.arrayContaining([
        'Node runtime',
        'Config file',
        'Credential store',
        'API secret',
        'Session',
        'Login callback port',
      ]),
    );
    // On a fresh, keyring-disabled, logged-out box these are the expected states.
    expect(byName['Node runtime'].status).toBe('ok');
    expect(byName['Credential store'].status).toBe('warn');
    expect(byName['Session'].status).toBe('warn');
    expect(byName['Session'].detail).toMatch(/not logged in/i);
  });

  it('renders a human table with status markers', async () => {
    const code = await invoke(['doctor']);
    expect(code).toBe(ExitCode.Ok);
    expect(out).toContain('Node runtime');
    expect(out).toContain('Login callback port');
  });
});
