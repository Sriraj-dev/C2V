import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiError, errorResponse, pageParams, paged, parseBody, parseQuery } from '../../src/admin/http.js';
import { WhatsAppSendError } from '../../src/channels/whatsapp/sender.js';
import { InvalidTransitionError, NotSupportedError, OrderNotFoundError } from '../../src/orders/order-status.js';
import { testDeps } from '../helpers/fakes.js';
import { setupAdminTest, type AdminTest } from '../helpers/admin.js';

function appThrowing(err: unknown) {
  const log = testDeps().log;
  const app = new Hono();
  app.onError((e, c) => errorResponse(c, e, log));
  app.get('/boom', () => {
    throw err;
  });
  app.post('/body', async (c) => c.json(await parseBody(c, z.object({ n: z.number() }))));
  app.get('/q', (c) => c.json(parseQuery(c, pageParams)));
  return app;
}

describe('errorResponse', () => {
  it('maps unknown errors to a generic 500 without leaking details', async () => {
    const res = await appThrowing(new Error('secret db detail')).request('/boom');
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe('internal');
    expect(text).not.toContain('secret db detail');
    expect(text).not.toContain('at ');
  });

  it.each([
    [new OrderNotFoundError(), 404, 'not_found'],
    [new InvalidTransitionError('nope'), 409, 'invalid_transition'],
    [new NotSupportedError('nope'), 422, 'not_supported'],
    [new WhatsAppSendError(500, 1, 'x', undefined), 502, 'provider_error'],
    [Object.assign(new Error('dup'), { code: '23505' }), 409, 'conflict'],
    [new Error('wrapped', { cause: { code: '23505' } }), 409, 'conflict'],
    [new ApiError(404, 'not_found', 'Nothing', [1]), 404, 'not_found'],
  ])('maps %# to %i %s', async (err, status, code) => {
    const res = await appThrowing(err).request('/boom');
    expect(res.status).toBe(status);
    expect((await res.json()).error.code).toBe(code);
  });

  it('rejects invalid JSON and bad bodies with 400 validation_error', async () => {
    const app = appThrowing(null);
    const bad = await app.request('/body', { method: 'POST', body: '{nope' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe('validation_error');
    const wrong = await app.request('/body', { method: 'POST', body: JSON.stringify({ n: 'x' }) });
    expect(wrong.status).toBe(400);
    const j = await wrong.json();
    expect(j.error.details[0]).toMatchObject({ path: 'n' });
  });

  it('parses paging with defaults and bounds', async () => {
    const app = appThrowing(null);
    expect(await (await app.request('/q')).json()).toEqual({ page: 1, pageSize: 25 });
    expect(await (await app.request('/q?page=2&pageSize=100')).json()).toEqual({ page: 2, pageSize: 100 });
    expect((await app.request('/q?pageSize=101')).status).toBe(400);
    expect((await app.request('/q?page=0')).status).toBe(400);
    expect(paged(['a'], 2, 25, 26)).toEqual({ items: ['a'], page: 2, pageSize: 25, total: 26 });
  });
});

describe('admin app', () => {
  let t: AdminTest;
  beforeEach(async () => {
    t = await setupAdminTest();
  });


  it('returns 400 for invalid JSON on login', async () => {
    const res = await t.app.request('/admin/auth/login', { method: 'POST', body: '{bad' });
    expect(res.status).toBe(400);
  });
});
