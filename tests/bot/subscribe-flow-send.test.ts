/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it } from 'vitest';
import { sendSubscribeFlow } from '../../src/bot/subscribe-flow-handler.js';
import { decodeSubscribeFlowToken } from '../../src/channels/whatsapp/flows.js';
import type { Db } from '../../src/db/client.js';
import type { AppDeps } from '../../src/deps.js';
import { FakeWhatsAppSender, testDeps } from '../helpers/fakes.js';
import { createTestDb, seedCustomer, seedProduct, seedTenantRow, testTenant } from '../helpers/test-db.js';

let db: Db;
let wa: FakeWhatsAppSender;
let deps: AppDeps;
beforeEach(async () => {
  db = await createTestDb();
  await seedTenantRow(db, 'test');
  wa = new FakeWhatsAppSender();
  deps = testDeps({ db, whatsapp: wa });
});

const params = () => (wa.sent[0]!.message as any).interactive.action.parameters;

describe('sendSubscribeFlow', () => {
  it('sends the subscribe flow with products, saved address and email prefilled', async () => {
    const p1 = await seedProduct(db, 'test', { name: 'White Eggs – 6 pack', pricePaise: 9000, sortOrder: 1 });
    const customer = await seedCustomer(db, 'test', {
      waId: '919811112222',
      email: 'asha@example.com',
      defaultAddress: { name: 'Asha', line1: '12 MG Rd', pincode: '560034' },
    } as any);
    const tenant = testTenant();
    await sendSubscribeFlow(deps, tenant, customer);
    expect(wa.sent).toHaveLength(1);
    const p = params();
    expect(p.flow_id).toBe('flow-sub');
    expect(p.flow_cta).toBe('Subscribe');
    expect(p.mode).toBeUndefined();
    expect(decodeSubscribeFlowToken(p.flow_token)).toEqual({ customerId: customer.id, slotMap: { '1': p1.id } });
    const { screen, data } = p.flow_action_payload;
    expect(screen).toBe('PRODUCTS');
    expect(data.label_1).toBe('White Eggs – 6 pack — ₹90');
    expect(data.prefill_name).toBe('Asha');
    expect(data.prefill_email).toBe('asha@example.com');
    expect(data.ask_phone).toBe(false);
    expect((wa.sent[0]!.message as any).interactive.body.text).toBe(tenant.copy.subscribeFlowIntro());
  });

  it('a BSUID-only customer is asked for a phone; no email → empty prefill', async () => {
    await seedProduct(db, 'test');
    const customer = await seedCustomer(db, 'test', { waId: null, waKey: 'bsuid-1', bsuid: 'bsuid-1' } as any);
    await sendSubscribeFlow(deps, testTenant(), customer);
    const { data } = params().flow_action_payload;
    expect(data.ask_phone).toBe(true);
    expect(data.prefill_email).toBe('');
  });

  it('sends a draft flow in draft mode', async () => {
    await seedProduct(db, 'test');
    const customer = await seedCustomer(db, 'test', { waId: '919811112222' });
    await sendSubscribeFlow(deps, testTenant({ flows: { orderFlowId: 'o', subscribeFlowId: 'flow-sub', subscribeFlowDraft: true } }), customer);
    expect(params().mode).toBe('draft');
  });

  it('empty subscribe flow id → coming-soon text', async () => {
    await seedProduct(db, 'test');
    const customer = await seedCustomer(db, 'test', { waId: '919811112222' });
    const tenant = testTenant({ flows: { orderFlowId: 'o', subscribeFlowId: '' } });
    await sendSubscribeFlow(deps, tenant, customer);
    expect((wa.sent[0]!.message as any).text.body).toBe(tenant.copy.subscribeComingSoon());
  });

  it('no active products → menu', async () => {
    const customer = await seedCustomer(db, 'test', { waId: '919811112222' });
    await sendSubscribeFlow(deps, testTenant(), customer);
    expect((wa.sent[0]!.message as any).interactive.type).toBe('list');
  });
});
