import stripAnsi from 'strip-ansi';
import { afterEach, beforeEach, expect } from 'vitest';

/**
 * Global test setup.
 *
 * Two structural guarantees live here rather than in individual tests:
 *
 *  1. No test may touch the real config directory or OS keyring.
 *  2. No test may run with real-looking credentials present. A mistyped test
 *     must not be able to place a real order.
 */

const REAL_CREDENTIAL_VARS = ['KITE_API_SECRET', 'KITE_ACCESS_TOKEN', 'KITE_API_KEY'];

beforeEach(() => {
  // Sandbox all filesystem state into a per-run temp directory.
  process.env['KITE_CONFIG_DIR'] = `${process.env['VITEST_TMP'] ?? '/tmp'}/kite-cli-test-${process.pid}/config`;
  process.env['KITE_CACHE_DIR'] = `${process.env['VITEST_TMP'] ?? '/tmp'}/kite-cli-test-${process.pid}/cache`;
  // Never read or write the developer's actual keychain.
  process.env['KITE_DISABLE_KEYRING'] = '1';

  for (const key of REAL_CREDENTIAL_VARS) {
    const value = process.env[key];
    // A short obviously-fake value is fine; anything long enough to be a real
    // credential is not.
    if (value && value.length > 12 && !value.startsWith('test')) {
      throw new Error(
        `${key} looks like a real credential and is set during a test run. ` +
          'Unset it before running the test suite.',
      );
    }
  }
});

afterEach(() => {
  delete process.env['KITE_CREDENTIALS_PASSPHRASE'];
});

// Strip ANSI in snapshots globally rather than per-assertion, so a forgotten
// call cannot commit escape codes into a snapshot file.
expect.addSnapshotSerializer({
  test: (value) => typeof value === 'string' && value.includes('['),
  print: (value) => JSON.stringify(stripAnsi(value as string)),
});
