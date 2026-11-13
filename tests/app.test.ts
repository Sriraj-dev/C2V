import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { testDeps } from './helpers/fakes.js';

describe('app', () => {
  it('GET /health -> 200 {ok:true}', async () => {
    const res = await buildApp(testDeps()).request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
