import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { handleInbound } from '../../src/bot/router.js';
import type { InboundMessage } from '../../src/channels/whatsapp/parse.js';
import type { Db } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import type { AppDeps } from '../../src/deps.js';
import { FakeWhatsAppSender, testDeps } from '../helpers/fakes.js';
import { createTestDb, seedTenantRow, testTenant } from '../helpers/test-db.js';

const IMG = 'https://example.com/eggs.jpg';
const tenant = testTenant();
let db: Db;
let wa: FakeWhatsAppSender;
let deps: AppDeps;
let n = 0;

function base() {
  return {
    phoneNumberId: tenant.waPhoneNumberId,
    waMessageId: `wamid.in.${++n}`,
    timestamp: 1,
    from: { waId: '919811112222', bsuid: null, profileName: 'Asha' },
    raw: {},
  };
}
const text = (t = 'hi'): InboundMessage => ({ ...base(), kind: 'text', text: t });
const button = (replyId: string): InboundMessage => ({ ...base(), kind: 'button', replyId, title: 'x' });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const interactive = (m: any) => m.interactive;

beforeEach(async () => {
  db = await createTestDb();
  await seedTenantRow(db, 'test', { welcomeImageUrl: IMG });
  wa = new FakeWhatsAppSender();
  deps = testDeps({ db, whatsapp: wa });
});

describe('handleInbound', () => {
  it('text -> welcome image then list menu with 4 ids, and logs rows', async () => {
    await handleInbound(deps, tenant, text());
    expect(wa.sent.map((s) => s.message.type)).toEqual(['image', 'interactive']);
    const list = interactive(wa.sent[1]!.message);
    expect(list.type).toBe('list');
    expect(list.action.button).toBe('Menu');
    expect(list.action.sections[0].rows.map((r: { id: string }) => r.id)).toEqual([
      'menu:order',
      'menu:subscribe',
      'menu:my_orders',
      'menu:help',
    ]);
    const rows = await db.select().from(messages);
    expect(rows.filter((r) => r.direction === 'in')).toHaveLength(1);
    expect(rows.filter((r) => r.direction === 'out')).toHaveLength(2);
  });

  it('without welcome image -> list only, welcome in body', async () => {
    await db.update((await import('../../src/db/schema.js')).tenants).set({ welcomeImageUrl: null }).where(
      eq((await import('../../src/db/schema.js')).tenants.id, 'test'),
    );
    await handleInbound(deps, tenant, text());
    expect(wa.sent).toHaveLength(1);
    expect(interactive(wa.sent[0]!.message).body.text).toContain('Welcome to NutriFarm');
  });

  it('duplicate delivery -> one reply, markRead once with typing', async () => {
    const m = text();
    await handleInbound(deps, tenant, m);
    await handleInbound(deps, tenant, m);
    expect(wa.sent).toHaveLength(2); // image + list, once
    expect(wa.reads).toEqual([{ waMessageId: m.waMessageId, typing: true }]);
  });

  it('markRead failure does not block the reply', async () => {
    wa.markRead = async () => {
      throw new Error('boom');
    };
    await handleInbound(deps, tenant, text());
    expect(wa.sent).toHaveLength(2);
  });

  it('menu:subscribe without a subscribe flow id -> coming-soon text, logged', async () => {
    await handleInbound(deps, testTenant({ flows: { orderFlowId: 'flow-order', subscribeFlowId: '' } }), button('menu:subscribe'));
    expect(wa.sent).toHaveLength(1);
    expect((wa.sent[0]!.message as any).text.body).toBe(tenant.copy.subscribeComingSoon());
    const out = (await db.select().from(messages)).filter((r) => r.direction === 'out');
    expect(out.map((r) => r.text)).toEqual([tenant.copy.subscribeComingSoon()]);
  });

  it('menu:help -> CTA with tel url', async () => {
    await handleInbound(deps, tenant, button('menu:help'));
    const i = interactive(wa.sent[0]!.message);
    expect(i.type).toBe('cta_url');
    expect(i.action.parameters.url).toBe('tel:+910000000000');
  });

  it('help with null supportPhone -> plain text', async () => {
    const { tenants } = await import('../../src/db/schema.js');
    await db.update(tenants).set({ supportPhone: null }).where(eq(tenants.id, 'test'));
    await handleInbound(deps, tenant, button('menu:help'));
    expect(wa.sent).toHaveLength(1);
    expect(wa.sent[0]!.message.type).toBe('text');
  });

  it('image message -> menu', async () => {
    await handleInbound(deps, tenant, { ...base(), kind: 'other', waType: 'image' });
    expect(wa.sent.map((s) => s.message.type)).toEqual(['image', 'interactive']);
  });

  it('stub targets fall back to menu; a location is saved and acknowledged', async () => {
    await handleInbound(deps, tenant, button('menu:order'));
    await handleInbound(deps, tenant, { ...base(), kind: 'flow_submit', flowToken: 'order:c:r', response: {} });
    await handleInbound(deps, tenant, { ...base(), kind: 'location', lat: 1, lng: 2 });
    expect(wa.sent).toHaveLength(5);
    expect((wa.sent[4]!.message as any).text.body).toBe(tenant.copy.locationSaved());
  });

  it('image send fails -> list still sent with welcome text, no generic error', async () => {
    wa.failNext = new Error('image rejected');
    await handleInbound(deps, tenant, text());
    expect(wa.sent).toHaveLength(1);
    const i = interactive(wa.sent[0]!.message);
    expect(i.type).toBe('list');
    expect(i.body.text).toContain('Welcome to NutriFarm');
    expect(JSON.stringify(wa.sent)).not.toContain('went wrong');
  });

  it('invalid welcome image url -> list still sent', async () => {
    const { tenants } = await import('../../src/db/schema.js');
    await db.update(tenants).set({ welcomeImageUrl: 'www.farm.com/x.jpg' }).where(eq(tenants.id, 'test'));
    await handleInbound(deps, tenant, text());
    expect(wa.sent.map((s) => s.message.type)).toEqual(['interactive']);
  });

  it('caption and list body do not repeat the prompt', async () => {
    await handleInbound(deps, tenant, text());
    const caption = (wa.sent[0]!.message as unknown as { image: { caption: string } }).image.caption;
    expect(caption).not.toContain('What would you like to do?');
    expect(interactive(wa.sent[1]!.message).body.text).toBe('What would you like to do?');
  });

  it('support phone is normalised to digits', async () => {
    const { tenants } = await import('../../src/db/schema.js');
    await db.update(tenants).set({ supportPhone: '+91 83109-01383' }).where(eq(tenants.id, 'test'));
    await handleInbound(deps, tenant, button('menu:help'));
    expect(interactive(wa.sent[0]!.message).action.parameters.url).toBe('tel:+918310901383');
  });

  it('too-short support phone -> plain text help', async () => {
    const { tenants } = await import('../../src/db/schema.js');
    await db.update(tenants).set({ supportPhone: '12345' }).where(eq(tenants.id, 'test'));
    await handleInbound(deps, tenant, button('menu:help'));
    expect(wa.sent[0]!.message.type).toBe('text');
  });

  it('list send fails too -> generic error sent, resolves', async () => {
    const orig = wa.send.bind(wa);
    wa.send = async (t, to, m, o) => {
      if (m.type === 'interactive') throw new Error('send failed');
      return orig(t, to, m, o);
    };
    await expect(handleInbound(deps, tenant, text())).resolves.toBeUndefined();
    expect(JSON.stringify(wa.sent.at(-1)!.message)).toContain('went wrong');
  });

  it('error reply failure is swallowed', async () => {
    wa.send = async () => {
      throw new Error('down');
    };
    await expect(handleInbound(deps, tenant, text())).resolves.toBeUndefined();
  });
});
