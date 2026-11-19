import { beforeEach, describe, expect, it } from 'vitest';
import { sendOrderFlow } from '../../src/bot/order-flow-handler.js';
import { decodeOrderFlowToken } from '../../src/channels/whatsapp/flows.js';
import type { Db } from '../../src/db/client.js';
import type { AppDeps } from '../../src/deps.js';
import { FakeWhatsAppSender, testDeps } from '../helpers/fakes.js';
import { createTestDb, seedCustomer, seedProduct, seedTenantRow, testTenant } from '../helpers/test-db.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: Db;
let wa: FakeWhatsAppSender;
let deps: AppDeps;
beforeEach(async () => {
  db = await createTestDb();
  await seedTenantRow(db, 'test');
  wa = new FakeWhatsAppSender();
  deps = testDeps({ db, whatsapp: wa });
});

describe('sendOrderFlow', () => {
  it('sends the flow with live products, prefill and a decodable token', async () => {
    const p1 = await seedProduct(db, 'test', { name: 'White Eggs – 6 pack', pricePaise: 9000, sortOrder: 1 });
    await seedProduct(db, 'test', { name: 'White Eggs – 12 pack', pricePaise: 16800, sortOrder: 2 });
    const customer = await seedCustomer(db, 'test', {
      waId: '919811112222',
      defaultAddress: { name: 'Asha', line1: '12 MG Rd', pincode: '560034' },
    });
    const tenant = testTenant();
    await sendOrderFlow(deps, tenant, customer);
    expect(wa.sent).toHaveLength(1);
    const params = (wa.sent[0]!.message as any).interactive.action.parameters;
    expect(params.flow_id).toBe(tenant.flows.orderFlowId);
    expect(params.flow_cta).toBe('Order now');
    expect(params.flow_token.startsWith(`order:${customer.id}:`)).toBe(true);
    expect(decodeOrderFlowToken(params.flow_token)?.slotMap['1']).toBe(p1.id);
    const { screen, data } = params.flow_action_payload;
    expect(screen).toBe('PRODUCTS');
    expect(data.label_1).toBe('White Eggs – 6 pack — ₹90');
    expect(data.show_2).toBe(true);
    expect(data.show_3).toBe(false);
    expect(data.prefill_name).toBe('Asha');
    expect(data.prefill_pincode).toBe('560034');
    expect(data.prefill_landmark).toBe('');
  });

  it('sends a draft order flow in draft mode, a published one without mode', async () => {
    await seedProduct(db, 'test');
    const customer = await seedCustomer(db, 'test', { waId: '919811112222' });
    await sendOrderFlow(deps, testTenant({ flows: { orderFlowId: 'flow-order', orderFlowDraft: true, subscribeFlowId: '' } }), customer);
    await sendOrderFlow(deps, testTenant(), customer);
    expect((wa.sent[0]!.message as any).interactive.action.parameters.mode).toBe('draft');
    expect((wa.sent[1]!.message as any).interactive.action.parameters.mode).toBeUndefined();
  });

  it('falls back to the menu when orderFlowId is empty', async () => {
    await seedProduct(db, 'test');
    const customer = await seedCustomer(db, 'test', { waId: '919811112222' });
    await sendOrderFlow(deps, testTenant({ flows: { orderFlowId: '', subscribeFlowId: '' } }), customer);
    expect(wa.sent).toHaveLength(1);
    expect((wa.sent[0]!.message as any).interactive.type).toBe('list');
  });

  it('falls back to the menu when there are no active products', async () => {
    const customer = await seedCustomer(db, 'test', { waId: '919811112222' });
    await sendOrderFlow(deps, testTenant(), customer);
    expect((wa.sent[0]!.message as any).interactive.type).toBe('list');
  });

  it('falls back to the menu when there are more than 8 products', async () => {
    for (let i = 0; i < 9; i++) await seedProduct(db, 'test');
    const customer = await seedCustomer(db, 'test', { waId: '919811112222' });
    await sendOrderFlow(deps, testTenant(), customer);
    expect((wa.sent[0]!.message as any).interactive.type).toBe('list');
  });

  it('prefills the name from the profile name when no saved address', async () => {
    await seedProduct(db, 'test');
    const customer = await seedCustomer(db, 'test', { waId: '919811112222', profileName: 'Ravi' });
    await sendOrderFlow(deps, testTenant(), customer);
    const data = (wa.sent[0]!.message as any).interactive.action.parameters.flow_action_payload.data;
    expect(data.prefill_name).toBe('Ravi');
    expect(data.prefill_line1).toBe('');
  });
});
