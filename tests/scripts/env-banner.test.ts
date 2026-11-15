import { describe, expect, it } from 'vitest';
import { envBanner } from '../../scripts/lib/env-banner.js';

describe('envBanner', () => {
  it('defaults to dev', () => {
    expect(envBanner(undefined)).toBe('Environment: dev (.env.dev)');
  });
  it('flags prod prominently', () => {
    const b = envBanner('prod');
    expect(b).toContain('⚠');
    expect(b).toContain('Environment: prod (.env.prod)');
    expect(b).toContain('PRODUCTION');
  });
});
