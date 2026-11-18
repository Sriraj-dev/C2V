/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import {
  buildOrderFlowJson,
  buildSubscribeFlowJson,
  decodeOrderFlowToken,
  decodeSubscribeFlowToken,
  encodeOrderFlowToken,
  encodeSubscribeFlowToken,
} from '../../../src/channels/whatsapp/flows.js';

const json = buildSubscribeFlowJson() as any;
const [products, frequency, details] = json.screens;
const child = (screen: any, pred: (c: any) => boolean) => screen.layout.children.find(pred);
const footer = (screen: any) => child(screen, (c) => c.type === 'Footer');

describe('buildSubscribeFlowJson', () => {
  it('has PRODUCTS, FREQUENCY, then a terminal DETAILS screen', () => {
    expect(json.version).toBe('7.3');
    expect(json.screens.map((s: any) => s.id)).toEqual(['PRODUCTS', 'FREQUENCY', 'DETAILS']);
    expect(child(products, (c) => c.type === 'RadioButtonsGroup')).toBeUndefined();
    expect(footer(products)['on-click-action'].next).toEqual({ type: 'screen', name: 'FREQUENCY' });
    expect(details.terminal).toBe(true);
    expect(products.terminal).toBeUndefined();
  });

  it('asks for the frequency with the three options, weekly by default, and passes it on', () => {
    const radio = child(frequency, (c) => c.type === 'RadioButtonsGroup');
    expect(radio).toMatchObject({ name: 'frequency', required: true, 'init-value': 'weekly' });
    expect(radio['data-source']).toEqual([
      { id: 'weekly', title: 'Every week' },
      { id: 'biweekly', title: 'Every 2 weeks' },
      { id: 'monthly', title: 'Every 4 weeks' },
    ]);
    const nav = footer(frequency)['on-click-action'];
    expect(nav.next).toEqual({ type: 'screen', name: 'DETAILS' });
    expect(nav.payload.frequency).toBe('${form.frequency}');
    expect(nav.payload.qty_3).toBe('${data.qty_3}');
    expect(nav.payload.prefill_email).toBe('${data.prefill_email}');
    expect(footer(products)['on-click-action'].payload.qty_3).toBe('${form.qty_3}');
    expect(details.data.frequency).toEqual({ type: 'string', __example__: 'weekly' });
  });

  it('DETAILS has the address fields and a required email, and completes with frequency and email', () => {
    const names = details.layout.children.filter((c: any) => c.name).map((c: any) => c.name);
    expect(names).toEqual(['name', 'line1', 'landmark', 'pincode', 'phone', 'email']);
    expect(child(details, (c) => c.name === 'email')).toMatchObject({ 'input-type': 'email', required: true, 'init-value': '${data.prefill_email}' });
    expect(child(details, (c) => c.name === 'phone').visible).toBe('${data.ask_phone}');
    const done = footer(details)['on-click-action'];
    expect(done.name).toBe('complete');
    expect(done.payload).toMatchObject({ frequency: '${data.frequency}', email: '${form.email}', pincode: '${form.pincode}', qty_1: '${data.qty_1}' });
  });

  it('every ${data.x} reference on a screen is declared in that screen data', () => {
    for (const screen of json.screens) {
      const refs = [...JSON.stringify(screen.layout).matchAll(/\$\{data\.([a-z_0-9]+)\}/g)].map((m) => m[1]);
      for (const r of refs) expect(screen.data, `${screen.id}.${r}`).toHaveProperty(r!);
    }
  });

  it('order Flow is unchanged in shape (no frequency, no email)', () => {
    const order = JSON.stringify(buildOrderFlowJson());
    expect(order).not.toContain('frequency');
    expect(order).not.toContain('email');
    expect((buildOrderFlowJson() as any).screens.map((s: any) => s.id)).toEqual(['PRODUCTS', 'ADDRESS']);
  });
});

describe('subscribe flow token', () => {
  it('round-trips and does not decode as an order token (or vice versa)', () => {
    const t = encodeSubscribeFlowToken('cust-1', { '1': 'p1', '2': 'p2' });
    expect(t.startsWith('subscribe:cust-1:')).toBe(true);
    expect(decodeSubscribeFlowToken(t)).toEqual({ customerId: 'cust-1', slotMap: { '1': 'p1', '2': 'p2' } });
    expect(decodeOrderFlowToken(t)).toBeNull();
    expect(decodeSubscribeFlowToken(encodeOrderFlowToken('cust-1', { '1': 'p1' }))).toBeNull();
  });
});
