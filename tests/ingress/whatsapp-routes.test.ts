import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { registerTenants, resetTenantsForTests } from '../../src/tenants/registry.js';
import { testDeps } from '../helpers/fakes.js';
import { testTenant } from '../helpers/test-db.js';

const deps = testDeps();
const fixture = (n: string) => readFileSync(`tests/fixtures/wa/${n}.json`, 'utf8');
const sign = (b: string) =>
  'sha256=' + createHmac('sha256', deps.env.META_APP_SECRET).update(b).digest('hex');
const post = (app: ReturnType<typeof buildApp>, body: string, sig: string | undefined = sign(body)) =>
  app.request('/webhooks/whatsapp', {
    method: 'POST',
    body,
    headers: sig ? { 'x-hub-signature-256': sig } : {},
  });

beforeEach(() => registerTenants([testTenant()]));
afterEach(() => resetTenantsForTests());

describe('GET /webhooks/whatsapp', () => {
  const app = buildApp(deps);
  it('echoes challenge with right token', async () => {
    const res = await app.request('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=12345');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('12345');
  });
  it('403 on wrong token or mode', async () => {
    expect((await app.request('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=1')).status).toBe(403);
    expect((await app.request('/webhooks/whatsapp?hub.mode=other&hub.verify_token=verify&hub.challenge=1')).status).toBe(403);
    expect((await app.request('/webhooks/whatsapp')).status).toBe(403);
  });
});

describe('POST /webhooks/whatsapp', () => {
  it('401 on bad signature, no onInbound', async () => {
    const onInbound = vi.fn();
    const app = buildApp(deps, { onInbound });
    expect((await post(app, fixture('text'), 'sha256=' + '0'.repeat(64))).status).toBe(401);
    expect((await post(app, fixture('text'), '')).status).toBe(401);
    expect(onInbound).not.toHaveBeenCalled();
  });
  it('400 on invalid JSON with valid signature', async () => {
    const onInbound = vi.fn();
    expect((await post(buildApp(deps, { onInbound }), 'not json')).status).toBe(400);
    expect(onInbound).not.toHaveBeenCalled();
  });
  it('statuses-only -> 200, no onInbound', async () => {
    const onInbound = vi.fn();
    const res = await post(buildApp(deps, { onInbound }), fixture('statuses-only'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(onInbound).not.toHaveBeenCalled();
  });
  it('text -> onInbound once with the resolved tenant', async () => {
    const onInbound = vi.fn().mockResolvedValue(undefined);
    const res = await post(buildApp(deps, { onInbound }), fixture('text'));
    expect(res.status).toBe(200);
    expect(onInbound).toHaveBeenCalledTimes(1);
    const [tenant, msg] = onInbound.mock.calls[0]!;
    expect(tenant.id).toBe('test');
    expect(msg.kind).toBe('text');
  });
  it('unknown phone_number_id -> 200, no onInbound', async () => {
    const onInbound = vi.fn();
    resetTenantsForTests();
    registerTenants([testTenant({ waPhoneNumberId: 'different' })]);
    const res = await post(buildApp(deps, { onInbound }), fixture('text'));
    expect(res.status).toBe(200);
    expect(onInbound).not.toHaveBeenCalled();
  });
  it('onInbound throwing still returns 200 and later messages are processed', async () => {
    const body = JSON.parse(fixture('text'));
    const v = body.entry[0].changes[0].value;
    v.messages.push({ ...v.messages[0], id: 'wamid.second', text: { body: 'again' } });
    const onInbound = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const res = await post(buildApp(deps, { onInbound }), JSON.stringify(body));
    expect(res.status).toBe(200);
    expect(onInbound).toHaveBeenCalledTimes(2);
  });
  it('multi-entry payload: only the known phone_number_id is dispatched', async () => {
    const body = JSON.parse(fixture('text'));
    const other = JSON.parse(fixture('text')).entry[0];
    other.changes[0].value.metadata.phone_number_id = 'unknown-pnid';
    body.entry.push(other);
    const onInbound = vi.fn().mockResolvedValue(undefined);
    const res = await post(buildApp(deps, { onInbound }), JSON.stringify(body));
    expect(res.status).toBe(200);
    expect(onInbound).toHaveBeenCalledTimes(1);
    expect(onInbound.mock.calls[0]![0].id).toBe('test');
  });
  it('default onInbound (no opts) works', async () => {
    expect((await post(buildApp(deps), fixture('text'))).status).toBe(200);
  });
});
