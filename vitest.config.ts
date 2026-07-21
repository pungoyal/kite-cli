import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Process isolation: tests mutate process.env and the global undici
    // dispatcher, which must not leak between files.
    pool: 'forks',
    setupFiles: ['./test/setup.ts'],
    env: {
      // Determinism for snapshot tests. TZ is non-negotiable: Kite timestamps
      // are IST, and a UTC CI runner would diverge from a local machine.
      TZ: 'Asia/Kolkata',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      COLUMNS: '80',
      TERM: 'dumb',
      CI: 'true',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
