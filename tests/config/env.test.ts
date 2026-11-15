import { describe, it, expect } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

describe('loadEnv', () => {
  it('throws listing missing keys', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });
  it('applies defaults', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgres://x', META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v',
      GRAPH_API_VERSION: 'v99.0', CASHFREE_ENV: 'sandbox', PUBLIC_BASE_URL: 'https://bot.example.com',
    });
    expect(env.PORT).toBe(8080);
    expect(env.LOG_LEVEL).toBe('info');
  });
  it('requires PUBLIC_BASE_URL to be a URL', () => {
    const base = {
      DATABASE_URL: 'postgres://x', META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v',
      GRAPH_API_VERSION: 'v99.0', CASHFREE_ENV: 'sandbox',
    };
    expect(() => loadEnv(base)).toThrow(/PUBLIC_BASE_URL/);
    expect(() => loadEnv({ ...base, PUBLIC_BASE_URL: 'not a url' })).toThrow(/PUBLIC_BASE_URL/);
  });
  it('rejects an invalid LOG_LEVEL', () => {
    expect(() => loadEnv({
      DATABASE_URL: 'postgres://x', META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v',
      GRAPH_API_VERSION: 'v99.0', CASHFREE_ENV: 'sandbox', PUBLIC_BASE_URL: 'https://bot.example.com',
      LOG_LEVEL: 'inf',
    })).toThrow(/LOG_LEVEL/);
  });
});
