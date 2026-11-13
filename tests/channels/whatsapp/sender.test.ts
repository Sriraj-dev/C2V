import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { GraphWhatsAppSender, WhatsAppSendError, sendAndLog } from '../../../src/channels/whatsapp/sender.js';
import { textMsg } from '../../../src/channels/whatsapp/builders.js';
import type { Db } from '../../../src/db/client.js';
import type { Customer } from '../../../src/customers/customer-repo.js';
import { messages } from '../../../src/db/schema.js';
import { FakeWhatsAppSender, testDeps } from '../../helpers/fakes.js';
import { createTestDb, seedCustomer, seedTenantRow, testTenant } from '../../helpers/test-db.js';

const env = testDeps().env;
const tenant = testTenant();

function stubFetch(status: number, body: unknown) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
}
const ok = { messaging_product: 'whatsapp', messages: [{ id: 'wamid.ABC' }] };

describe('GraphWhatsAppSender', () => {
  beforeEach(() => {
    process.env.TEST_WA_TOKEN = 'tok-123';
  });
  afterEach(() => {
    delete process.env.TEST_WA_TOKEN;
  });

  it('POSTs to the right URL with bearer token and full body', async () => {
    const f = stubFetch(200, ok);
    const s = new GraphWhatsAppSender(env, f as unknown as typeof fetch);
    const res = await s.send(tenant, '919876543210', textMsg('hi'), { replyTo: 'wamid.IN' });
    expect(res).toEqual({ waMessageId: 'wamid.ABC' });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://graph.facebook.com/v99.0/1414838555047142/messages');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
    expect(JSON.parse(init!.body as string)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919876543210',
      context: { message_id: 'wamid.IN' },
      type: 'text',
      text: { body: 'hi' },
    });
  });

  it('sends BSUID recipients in the `recipient` field and omits context without replyTo', async () => {
    const f = stubFetch(200, ok);
    await new GraphWhatsAppSender(env, f as unknown as typeof fetch).send(tenant, 'IN.13491208655302741918', textMsg('hi'));
    const body = JSON.parse(f.mock.calls[0]![1]!.body as string);
    expect(body.recipient).toBe('IN.13491208655302741918');
    expect(body.to).toBeUndefined();
    expect(body.context).toBeUndefined();
  });

  it('maps a 400 to WhatsAppSendError without leaking the token', async () => {
    const f = stubFetch(400, { error: { message: 'Bad', code: 131009, error_data: { details: 'Parameter invalid' } } });
    const s = new GraphWhatsAppSender(env, f as unknown as typeof fetch);
    const err = await s.send(tenant, '919876543210', textMsg('hi')).catch((e) => e);
    expect(err).toBeInstanceOf(WhatsAppSendError);
    expect(err.status).toBe(400);
    expect(err.code).toBe(131009);
    expect(err.details).toBe('Parameter invalid');
    expect(err.message).toContain('Bad');
    expect(err.message).not.toContain('tok-123');
  });

  it('handles non-JSON error bodies', async () => {
    const f = vi.fn(async () => new Response('gateway down', { status: 502 }));
    const err = await new GraphWhatsAppSender(env, f as unknown as typeof fetch)
      .send(tenant, '919876543210', textMsg('hi'))
      .catch((e) => e);
    expect(err).toBeInstanceOf(WhatsAppSendError);
    expect(err.status).toBe(502);
  });

  it('envelope fields cannot be overridden by the message', async () => {
    const f = stubFetch(200, ok);
    const evil = { ...textMsg('hi'), to: 'evil', messaging_product: 'x', recipient_type: 'group', context: { message_id: 'z' } };
    await new GraphWhatsAppSender(env, f as unknown as typeof fetch).send(tenant, '919876543210', evil);
    const body = JSON.parse(f.mock.calls[0]![1]!.body as string);
    expect(body).toMatchObject({ to: '919876543210', messaging_product: 'whatsapp', recipient_type: 'individual' });
    expect(body.context).toBeUndefined();
  });

  it('passes an abort signal and maps timeouts and network errors', async () => {
    const f = stubFetch(200, ok);
    await new GraphWhatsAppSender(env, f as unknown as typeof fetch).send(tenant, '9', textMsg('x'));
    expect(f.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);

    const timeout = vi.fn(async () => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    const e1 = await new GraphWhatsAppSender(env, timeout as unknown as typeof fetch).send(tenant, '9', textMsg('x')).catch((e) => e);
    expect(e1).toBeInstanceOf(WhatsAppSendError);
    expect(e1.status).toBe(0);
    expect(e1.message).toContain('timeout');

    const abort = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError');
    });
    const e2 = await new GraphWhatsAppSender(env, abort as unknown as typeof fetch).markRead(tenant, 'w').catch((e) => e);
    expect(e2.message).toContain('timeout');

    const net = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const e3 = await new GraphWhatsAppSender(env, net as unknown as typeof fetch).send(tenant, '9', textMsg('x')).catch((e) => e);
    expect(e3).toBeInstanceOf(WhatsAppSendError);
    expect(e3.status).toBe(0);
    expect(e3.message).toContain('network error');
  });

  it('throws a clear error when the token env var is missing', async () => {
    delete process.env.TEST_WA_TOKEN;
    const f = stubFetch(200, ok);
    await expect(new GraphWhatsAppSender(env, f as unknown as typeof fetch).send(tenant, '9', textMsg('x'))).rejects.toThrow(
      /TEST_WA_TOKEN/,
    );
    expect(f).not.toHaveBeenCalled();
  });

  it('markRead posts read status, with optional typing indicator', async () => {
    const f = stubFetch(200, { success: true });
    const s = new GraphWhatsAppSender(env, f as unknown as typeof fetch);
    await s.markRead(tenant, 'wamid.IN');
    await s.markRead(tenant, 'wamid.IN', { typing: true });
    expect(f.mock.calls[0]![0]).toBe('https://graph.facebook.com/v99.0/1414838555047142/messages');
    expect(JSON.parse(f.mock.calls[0]![1]!.body as string)).toEqual({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.IN',
    });
    expect(JSON.parse(f.mock.calls[1]![1]!.body as string)).toEqual({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.IN',
      typing_indicator: { type: 'text' },
    });
  });

  it('markRead failure throws WhatsAppSendError', async () => {
    const f = stubFetch(400, { error: { message: 'nope', code: 100 } });
    await expect(
      new GraphWhatsAppSender(env, f as unknown as typeof fetch).markRead(tenant, 'wamid.IN'),
    ).rejects.toBeInstanceOf(WhatsAppSendError);
  });
});

describe('sendAndLog', () => {
  it('rethrows the original send error even if logging the failure also fails', async () => {
    const whatsapp = new FakeWhatsAppSender();
    whatsapp.failNext = new Error('send boom');
    const brokenDb = { insert: () => { throw new Error('db down'); } } as unknown as Db;
    const customer = { id: 'c1', waId: '919876543210', bsuid: null } as unknown as Customer;
    await expect(sendAndLog(testDeps({ db: brokenDb, whatsapp }), tenant, customer, textMsg('x'), 'x')).rejects.toThrow('send boom');
  });

  it('sends to the customer and records one outbound row', async () => {
    const db = await createTestDb();
    await seedTenantRow(db, 'test');
    const customer = await seedCustomer(db, 'test', { waId: '919876543210' });
    const whatsapp = new FakeWhatsAppSender();
    await sendAndLog(testDeps({ db, whatsapp }), tenant, customer, textMsg('hello'), 'hello');
    expect(whatsapp.sent).toHaveLength(1);
    expect(whatsapp.sent[0]!.to).toBe('919876543210');
    const rows = await db.select().from(messages).where(and(eq(messages.tenantId, 'test'), eq(messages.direction, 'out')));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ waMessageId: 'wamid.fake.1', type: 'text', text: 'hello', customerId: customer.id });
    expect(rows[0]!.payload).toEqual(textMsg('hello'));
  });

  it('falls back to bsuid when no waId', async () => {
    const db = await createTestDb();
    await seedTenantRow(db, 'test');
    const customer = await seedCustomer(db, 'test', { waId: null, bsuid: 'IN.abc' });
    const whatsapp = new FakeWhatsAppSender();
    await sendAndLog(testDeps({ db, whatsapp }), tenant, customer, textMsg('x'), 'x');
    expect(whatsapp.sent[0]!.to).toBe('IN.abc');
  });

  it('records a null-id row and rethrows when sending fails', async () => {
    const db = await createTestDb();
    await seedTenantRow(db, 'test');
    const customer = await seedCustomer(db, 'test', { waId: '919876543210' });
    const whatsapp = new FakeWhatsAppSender();
    whatsapp.failNext = new Error('boom');
    await expect(sendAndLog(testDeps({ db, whatsapp }), tenant, customer, textMsg('x'), 'x')).rejects.toThrow('boom');
    const rows = await db.select().from(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ direction: 'out', waMessageId: null, text: 'x' });
  });
});
