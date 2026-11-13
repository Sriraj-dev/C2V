import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // PGlite (WASM Postgres) takes ~1s to boot alone but up to ~6s when several
    // test files boot it in parallel; each file boots once (tests/helpers/test-db.ts).
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
