import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';
import type { InboundMessage } from '../../src/channels/whatsapp/parse.js';
import { recordInbound, recordOutbound, purgeMessagesOlderThan } from '../../src/messages/message-store.js';
import { createTestDb, seedCustomer, seedTenantRow } from '../helpers/test-db.js';

let db: Db;
let customerId: string;
beforeEach(async () => {
  db = await createTestDb();
  await seedTenantRow(db, 't1');
  await seedTenantRow(db, 't2');
  customerId = (await seedCustomer(db, 't1')).id;
});

const base = {
  phoneNumberId: 'p',
  timestamp: 1,
  from: { waId: '1', bsuid: null, profileName: null },
};
const mk = (id: string, extra: object): InboundMessage =>
  ({ ...base, waMessageId: id, raw: { id, ...extra }, ...extra }) as InboundMessage;

describe('recordInbound', () => {
  it('dedupes by wa message id', async () => {
    const m = mk('wamid.1', { kind: 'text', text: 'hi' });
    expect(await recordInbound(db, 't1', customerId, m)).toBe(true);
    expect(await recordInbound(db, 't1', customerId, m)).toBe(false);
    const rows = await db.select().from(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ direction: 'in', type: 'text', text: 'hi', tenantId: 't1' });
    expect(rows[0]!.payload).toEqual(m.raw);
  });

  it('summarises each kind', async () => {
    const cases: [InboundMessage, string, string][] = [
      [mk('a', { kind: 'button', replyId: 'r', title: 'Order' }), 'button', 'Order'],
      [mk('b', { kind: 'flow_submit', flowToken: 't', response: {} }), 'flow_submit', '[flow submitted]'],
      [mk('c', { kind: 'location', lat: 12.5, lng: 77.1 }), 'location', '[location 12.5,77.1]'],
      [mk('d', { kind: 'other', waType: 'image' }), 'image', '[image]'],
    ];
    for (const [m, type, text] of cases) {
      await recordInbound(db, 't1', customerId, m);
      const [row] = await db.select().from(messages).where(eq(messages.waMessageId, m.waMessageId));
      expect(row).toMatchObject({ type, text });
    }
  });
});

describe('recordOutbound', () => {
  it('stores outbound row', async () => {
    await recordOutbound(db, {
      tenantId: 't1', customerId, waMessageId: null, type: 'text', text: 'yo', payload: { a: 1 },
    });
    const [row] = await db.select().from(messages);
    expect(row).toMatchObject({ direction: 'out', waMessageId: null, text: 'yo', payload: { a: 1 } });
  });
});

describe('purgeMessagesOlderThan', () => {
  it('deletes old rows for only that tenant', async () => {
    const now = new Date('2026-11-13T12:00:00Z');
    const day = 86_400_000;
    const c2 = (await seedCustomer(db, 't2')).id;
    const ins = (tenantId: string, cid: string, days: number) =>
      db.insert(messages).values({
        tenantId, customerId: cid, direction: 'in', type: 'text', text: 'x', payload: {},
        createdAt: new Date(now.getTime() - days * day),
      });
    await ins('t1', customerId, 4);
    await ins('t1', customerId, 2);
    await ins('t2', c2, 4);
    expect(await purgeMessagesOlderThan(db, 't1', 3, now)).toBe(1);
    const rows = await db.select().from(messages);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.tenantId === 't2')).toHaveLength(1);
  });
});
