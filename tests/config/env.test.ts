import { describe, it, expect } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

describe('loadEnv', () => {
  it('throws listing missing keys', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });
  it('applies defaults', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgres://x', META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v',
      GRAPH_API_VERSION: 'v99.0', CASHFREE_ENV: 'sandbox', JOBS_SECRET: 'j',
    });
    expect(env.PORT).toBe(8080);
    expect(env.LOG_LEVEL).toBe('info');
  });
  it('rejects an invalid LOG_LEVEL', () => {
    expect(() => loadEnv({
      DATABASE_URL: 'postgres://x', META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v',
      GRAPH_API_VERSION: 'v99.0', CASHFREE_ENV: 'sandbox', JOBS_SECRET: 'j',
      LOG_LEVEL: 'inf',
    })).toThrow(/LOG_LEVEL/);
  });
});
