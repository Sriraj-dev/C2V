import { pino } from 'pino';
import type { AppDeps } from '../../src/deps.js';

export function testDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    env: {
      NODE_ENV: 'test',
      PORT: 8080,
      DATABASE_URL: 'postgres://test',
      META_APP_SECRET: 'secret',
      META_VERIFY_TOKEN: 'verify',
      GRAPH_API_VERSION: 'v99.0',
      CASHFREE_ENV: 'sandbox',
      JOBS_SECRET: 'jobs',
      LOG_LEVEL: 'silent',
    },
    now: () => new Date('2026-01-01T00:00:00Z'),
    log: pino({ level: 'silent' }),
    db: undefined,
    whatsapp: undefined,
    payments: undefined,
    ...overrides,
  };
}
