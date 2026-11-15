import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { messages } from '../../src/db/schema.js';
import { WhatsAppSendError } from '../../src/channels/whatsapp/sender.js';
import { setupAdminTest, type AdminLogin, type AdminTest } from '../helpers/admin.js';
import { seedCustomer } from '../helpers/test-db.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
let t: AdminTest;
let auth: AdminLogin;

beforeEach(async () => {
  t = await setupAdminTest();
  auth = await t.login();
});

const MIN = 60_000;
const ago = (ms: number) => new Date(t.deps.now().getTime() - ms);
const get = (path: string, headers: Record<string, string> = auth.headers) => t.app.request(path, { headers });
const post = (path: string, body: unknown, headers: Record<string, string> = auth.headers) =>
  t.app.request(path, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function msg(
  tenantId: string,
  customerId: string,
  direction: 'in' | 'out',
  createdAt: Date,
  text: string | null,
  type = 'text',
) {
  const [r] = await t.db
    .insert(messages)
    .values({ tenantId, customerId, direction, type, text, payload: {}, createdAt })
    .returning();
  return r!;
}

describe('GET /admin/chats', () => {
  it('requires auth', async () => {
    expect((await get('/admin/chats', {})).status).toBe(401);
  });

  it('lists one row per customer, latest first, with lastMessage, lastInboundAt, canReply; hides other tenants', async () => {
    const a = await seedCustomer(t.db, 'test', { waId: '919811100001', profileName: 'Anu' });
    const b = await seedCustomer(t.db, 'test', {
      waId: null,
      waKey: 'bsuid-b',
      bsuid: 'bsuid-b',
      profileName: null,
      defaultAddress: { name: 'B', line1: 'x', pincode: '560035', phone: '9876543210' } as any,
    });
    const o = await seedCustomer(t.db, 'other', { waId: '919811100009' });
    await seedCustomer(t.db, 'test', { profileName: 'NoMsgs' });
    await msg('test', a.id, 'in', ago(30 * 60 * MIN), 'hello');
    await msg('test', a.id, 'out', ago(29 * 60 * MIN), 'hi there');
    await msg('test', b.id, 'in', ago(23 * 60 * MIN + 59 * MIN), 'older in');
    await msg('test', b.id, 'out', ago(10 * MIN), null, 'template');
    await msg('other', o.id, 'in', ago(MIN), 'foreign');

    const r = await get('/admin/chats');
    expect(r.status).toBe(200);
    const { items } = (await r.json()) as any;
    expect(items.map((i: any) => i.customer.id)).toEqual([b.id, a.id]);
    expect(items[0].customer).toEqual({ id: b.id, profileName: null, phone: '919876543210' });
    expect(items[0].lastMessage).toEqual({ direction: 'out', text: null, createdAt: ago(10 * MIN).toISOString() });
    expect(items[0].lastInboundAt).toBe(ago(23 * 60 * MIN + 59 * MIN).toISOString());
    expect(items[0].canReply).toBe(true);
    expect(items[1].customer.phone).toBe('919811100001');
    expect(items[1].lastMessage.text).toBe('hi there');
    expect(items[1].lastInboundAt).toBe(ago(30 * 60 * MIN).toISOString());
    expect(items[1].canReply).toBe(false);
  });

  it('canReply flips at exactly 24h; outbound-only customer has null lastInboundAt', async () => {
    const edge = await seedCustomer(t.db, 'test');
    const inside = await seedCustomer(t.db, 'test');
    const out = await seedCustomer(t.db, 'test');
    await msg('test', edge.id, 'in', ago(24 * 60 * MIN), 'x');
    await msg('test', inside.id, 'in', ago(24 * 60 * MIN - 1), 'x');
    await msg('test', out.id, 'out', ago(MIN), 'x');
    const { items } = (await (await get('/admin/chats')).json()) as any;
    const by = (id: string) => items.find((i: any) => i.customer.id === id);
    expect(by(edge.id).canReply).toBe(false);
    expect(by(inside.id).canReply).toBe(true);
    expect(by(out.id).lastInboundAt).toBeNull();
    expect(by(out.id).canReply).toBe(false);
  });
});

describe('GET /admin/chats/:customerId/messages', () => {
  it('returns oldest first with customer and canReply, handling null text', async () => {
    const c = await seedCustomer(t.db, 'test', { waId: '919811100001', profileName: 'Anu' });
    await msg('test', c.id, 'out', ago(5 * MIN), null, 'image');
    await msg('test', c.id, 'in', ago(10 * MIN), 'first');
    const r = await get(`/admin/chats/${c.id}/messages`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.customer).toEqual({ id: c.id, profileName: 'Anu', phone: '919811100001' });
    expect(j.canReply).toBe(true);
    expect(j.items.map((m: any) => [m.direction, m.type, m.text])).toEqual([
      ['in', 'text', 'first'],
      ['out', 'image', null],
    ]);
    expect(Object.keys(j.items[0]).sort()).toEqual(['createdAt', 'direction', 'id', 'text', 'type']);
  });

  it('404s for other tenant, unknown and malformed ids', async () => {
    const o = await seedCustomer(t.db, 'other');
    for (const id of [o.id, '00000000-0000-4000-8000-000000000000', 'nope']) {
      const r = await get(`/admin/chats/${id}/messages`);
      expect(r.status).toBe(404);
      expect(((await r.json()) as any).error.code).toBe('not_found');
    }
  });
});

describe('POST /admin/chats/:customerId/reply', () => {
  it('sends inside the window, logs and returns the outbound row', async () => {
    const c = await seedCustomer(t.db, 'test', { waId: '919811100001' });
    await msg('test', c.id, 'in', ago(60 * MIN), 'hello');
    const r = await post(`/admin/chats/${c.id}/reply`, { text: '  On our way  ' });
    expect(r.status).toBe(201);
    const { message } = (await r.json()) as any;
    expect(message).toMatchObject({ direction: 'out', type: 'text', text: 'On our way' });
    expect(Object.keys(message).sort()).toEqual(['createdAt', 'direction', 'id', 'text', 'type']);
    expect(t.wa.sent).toHaveLength(1);
    expect(t.wa.sent[0]!.to).toBe('919811100001');
    expect((t.wa.sent[0]!.message as any).text.body).toBe('On our way');
    const rows = await t.db.select().from(messages).where(eq(messages.id, message.id));
    expect(rows[0]).toMatchObject({ direction: 'out', tenantId: 'test', customerId: c.id });
  });

  it('409 outside_reply_window at 24h + 1min, nothing sent', async () => {
    const c = await seedCustomer(t.db, 'test');
    await msg('test', c.id, 'in', ago(24 * 60 * MIN + MIN), 'old');
    const r = await post(`/admin/chats/${c.id}/reply`, { text: 'hi' });
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error.code).toBe('outside_reply_window');
    expect(t.wa.sent).toHaveLength(0);
  });

  it('409 for a customer with only outbound messages', async () => {
    const c = await seedCustomer(t.db, 'test');
    await msg('test', c.id, 'out', ago(MIN), 'hi');
    const r = await post(`/admin/chats/${c.id}/reply`, { text: 'hi' });
    expect(r.status).toBe(409);
    expect(t.wa.sent).toHaveLength(0);
  });

  it('502 provider_error on send failure; failed attempt is still logged', async () => {
    const c = await seedCustomer(t.db, 'test');
    await msg('test', c.id, 'in', ago(MIN), 'hello');
    t.wa.failNext = new WhatsAppSendError(500, undefined, 'boom', undefined);
    const r = await post(`/admin/chats/${c.id}/reply`, { text: 'hi' });
    expect(r.status).toBe(502);
    expect(((await r.json()) as any).error.code).toBe('provider_error');
    const out = (await t.db.select().from(messages).where(eq(messages.customerId, c.id))).filter((m) => m.direction === 'out');
    expect(out).toHaveLength(1);
  });

  it('404 for other tenant customer, nothing sent', async () => {
    const o = await seedCustomer(t.db, 'other');
    await msg('other', o.id, 'in', ago(MIN), 'hello');
    const r = await post(`/admin/chats/${o.id}/reply`, { text: 'hi' });
    expect(r.status).toBe(404);
    expect(t.wa.sent).toHaveLength(0);
  });

  it('validates body: blank, too long, unknown keys, bad JSON', async () => {
    const c = await seedCustomer(t.db, 'test');
    await msg('test', c.id, 'in', ago(MIN), 'hello');
    for (const body of [{ text: '   ' }, { text: 'a'.repeat(4097) }, {}, { text: 'x', extra: 1 }, { text: 5 }]) {
      const r = await post(`/admin/chats/${c.id}/reply`, body);
      expect(r.status).toBe(400);
    }
    expect((await post(`/admin/chats/${c.id}/reply`, { text: 'a'.repeat(4096) })).status).toBe(201);
    expect(t.wa.sent).toHaveLength(1);
  });

  it('requires auth', async () => {
    expect((await post('/admin/chats/x/reply', { text: 'hi' }, {})).status).toBe(401);
  });
});
