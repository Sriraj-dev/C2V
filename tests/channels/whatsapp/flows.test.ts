import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildOrderFlowJson,
  decodeOrderFlowToken,
  encodeOrderFlowToken,
  getFlowPreviewUrl,
  MAX_PRODUCT_SLOTS,
  orderFlowData,
  publishExistingFlow,
  publishFlow,
} from '../../../src/channels/whatsapp/flows.js';
import type { Product } from '../../../src/catalog/catalog-repo.js';
import { testTenant } from '../../helpers/test-db.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const flow = buildOrderFlowJson() as any;
const screen = (id: string) => flow.screens.find((s: any) => s.id === id);
const prod = (n: number, name: string, pricePaise: number): Product =>
  ({ id: `00000000-0000-0000-0000-00000000000${n}`, name, pricePaise, sortOrder: n, active: true }) as Product;

function walk(node: unknown, visit: (n: any) => void): void {
  if (Array.isArray(node)) node.forEach((n) => walk(n, visit));
  else if (node && typeof node === 'object') {
    visit(node);
    Object.values(node).forEach((n) => walk(n, visit));
  }
}

describe('buildOrderFlowJson', () => {
  it('uses version 7.3, no data_api_version, ADDRESS terminal', () => {
    expect(flow.version).toBe('7.3');
    expect(flow.data_api_version).toBeUndefined();
    expect(flow.screens.map((s: any) => s.id)).toEqual(['PRODUCTS', 'ADDRESS']);
    expect(screen('ADDRESS').terminal).toBe(true);
  });

  it('has dropdowns qty_1..8 with visible bound and options 0..10', () => {
    const dd = screen('PRODUCTS').layout.children.filter((c: any) => c.type === 'Dropdown');
    expect(dd.map((d: any) => d.name)).toEqual(Array.from({ length: 8 }, (_, i) => `qty_${i + 1}`));
    dd.forEach((d: any, i: number) => {
      expect(d.visible).toBe(`\${data.show_${i + 1}}`);
      expect(d.label).toBe('Quantity');
      const tb = screen('PRODUCTS').layout.children.find((c: any) => c.type === 'TextBody' && c.text === `\${data.label_${i + 1}}`);
      expect(tb.visible).toBe(`\${data.show_${i + 1}}`);
      expect(d['init-value']).toBe('0');
      expect(d.required).toBe(false);
      expect(d['data-source']).toHaveLength(11);
      expect(d['data-source'][10]).toEqual({ id: '10', title: '10' });
    });
  });

  it('complete payload has qty_1..8, name, line1, landmark, pincode', () => {
    const footer = screen('ADDRESS').layout.children.find((c: any) => c.type === 'Footer');
    expect(footer['on-click-action'].name).toBe('complete');
    expect(Object.keys(footer['on-click-action'].payload).sort()).toEqual(
      [...Array.from({ length: 8 }, (_, i) => `qty_${i + 1}`), 'name', 'line1', 'landmark', 'pincode'].sort(),
    );
  });

  it('PRODUCTS navigate forwards every qty and prefill to ADDRESS', () => {
    const footer = screen('PRODUCTS').layout.children.find((c: any) => c.type === 'Footer');
    const a = footer['on-click-action'];
    expect(a.name).toBe('navigate');
    expect(a.next).toEqual({ type: 'screen', name: 'ADDRESS' });
    expect(a.payload.qty_3).toBe('${form.qty_3}');
    expect(a.payload.prefill_pincode).toBe('${data.prefill_pincode}');
    const addrKeys = Object.keys(screen('ADDRESS').data);
    for (const k of Object.keys(a.payload)) expect(addrKeys).toContain(k);
  });

  it.each(['PRODUCTS', 'ADDRESS'])('every ${data.x} on %s is declared with an __example__', (id) => {
    const s = screen(id);
    const used = new Set<string>();
    walk(s.layout, (n) => {
      for (const v of Object.values(n)) {
        if (typeof v === 'string') for (const m of v.matchAll(/\$\{data\.([a-z_0-9]+)\}/g)) used.add(m[1]!);
      }
    });
    expect(used.size).toBeGreaterThan(0);
    for (const k of used) {
      expect(s.data[k], `${id}.data.${k}`).toBeDefined();
      expect(s.data[k].__example__, `${id}.data.${k}.__example__`).toBeDefined();
    }
  });
});

describe('Meta limits', () => {
  it('respects label, footer and title limits on static strings', () => {
    const isStatic = (v: unknown): v is string => typeof v === 'string' && !v.includes('${');
    for (const sc of flow.screens) {
      if (isStatic(sc.title)) expect(sc.title.length, `title ${sc.id}`).toBeLessThanOrEqual(30);
      walk(sc.layout, (n) => {
        if (!isStatic(n.label)) return;
        const max = n.type === 'Footer' ? 35 : 20;
        expect(n.label.length, `${n.type} "${n.label}"`).toBeLessThanOrEqual(max);
      });
      walk(sc.layout, (n) => {
        if (isStatic(n['helper-text'])) expect(n['helper-text'].length).toBeLessThanOrEqual(80);
      });
    }
  });
});

describe('orderFlowData', () => {
  const three = [prod(1, 'White Eggs – 6 pack', 9000), prod(2, 'White Eggs – 12 pack', 16800), prod(3, 'Brown', 39000)];

  it('maps products to slots, hides unused with placeholder label', () => {
    const { data, slotMap } = orderFlowData(three, null);
    expect(data.label_1).toBe('White Eggs – 6 pack — ₹90');
    for (const i of [1, 2, 3]) expect(data[`show_${i}`]).toBe(true);
    for (const i of [4, 5, 6, 7, 8]) {
      expect(data[`show_${i}`]).toBe(false);
      expect(data[`label_${i}`]).toBe('-');
    }
    expect(slotMap['1']).toBe(three[0]!.id);
    expect(Object.keys(slotMap)).toEqual(['1', '2', '3']);
    expect(data.prefill_name).toBe('');
    expect(data.prefill_pincode).toBe('');
  });

  it('prefills from the saved address', () => {
    const { data } = orderFlowData(three, { name: 'Asha', line1: '12 MG Rd', landmark: 'Temple', pincode: '560034' });
    expect(data).toMatchObject({ prefill_name: 'Asha', prefill_line1: '12 MG Rd', prefill_landmark: 'Temple', prefill_pincode: '560034' });
  });

  it('throws for more than 8 products', () => {
    const nine = Array.from({ length: MAX_PRODUCT_SLOTS + 1 }, (_, i) => prod(i + 1, 'P', 100));
    expect(() => orderFlowData(nine, null)).toThrow(/at most 8/);
  });
});

describe('flow token', () => {
  it('round-trips', () => {
    const slotMap = { '1': 'a-b', '2': 'c-d' };
    const t = encodeOrderFlowToken('cust-1', slotMap);
    expect(t.startsWith('order:cust-1:')).toBe(true);
    expect(decodeOrderFlowToken(t)).toEqual({ customerId: 'cust-1', slotMap });
  });

  it.each([
    ['not order', 'subscribe:x:e30'],
    ['no slotmap', 'order:cust'],
    ['bad base64 json', 'order:cust:!!!'],
    ['non-json', `order:cust:${Buffer.from('nope').toString('base64url')}`],
    ['array', `order:cust:${Buffer.from('[1]').toString('base64url')}`],
    ['bad slot key', `order:cust:${Buffer.from('{"9":"x"}').toString('base64url')}`],
    ['non-string value', `order:cust:${Buffer.from('{"1":5}').toString('base64url')}`],
    ['empty', ''],
  ])('returns null for %s', (_n, tok) => {
    expect(decodeOrderFlowToken(tok)).toBeNull();
  });
});

describe('publishFlow / getFlowPreviewUrl', () => {
  const env = { GRAPH_API_VERSION: 'v99.0' };
  const tenant = testTenant();
  afterEach(() => {
    delete process.env.TEST_WA_TOKEN;
  });
  const resp = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it('posts the flow and returns the id', async () => {
    process.env.TEST_WA_TOKEN = 'tok';
    const f = vi.fn().mockResolvedValue(resp(200, { id: '123', success: true, validation_errors: [] }));
    const id = await publishFlow(env, tenant, 'order_v1', { version: '7.3' }, f as unknown as typeof fetch);
    expect(id).toBe('123');
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://graph.facebook.com/v99.0/waba-test/flows');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual({
      name: 'order_v1',
      categories: ['SHOPPING'],
      flow_json: JSON.stringify({ version: '7.3' }),
      publish: true,
    });
  });

  it('throws with validation errors', async () => {
    process.env.TEST_WA_TOKEN = 'tok';
    const f = vi.fn().mockResolvedValue(resp(200, { id: '1', success: true, validation_errors: [{ error: 'INVALID_PROPERTY', message: 'bad thing' }] }));
    await expect(publishFlow(env, tenant, 'x', {}, f as unknown as typeof fetch)).rejects.toThrow(/draft flow id 1.*bad thing/s);
  });

  it('throws on non-2xx without leaking the token', async () => {
    process.env.TEST_WA_TOKEN = 'secret-tok';
    const f = vi.fn().mockResolvedValue(resp(400, { error: { code: 100, message: 'nope' } }));
    const err = (await publishFlow(env, tenant, 'x', {}, f as unknown as typeof fetch).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/HTTP 400.*nope/);
    expect(err.message).not.toContain('secret-tok');
  });

  it('throws when the token env var is missing', async () => {
    await expect(publishFlow(env, tenant, 'x', {}, vi.fn() as unknown as typeof fetch)).rejects.toThrow(/TEST_WA_TOKEN/);
  });

  it('rejects a null body with FlowPublishError', async () => {
    process.env.TEST_WA_TOKEN = 'tok';
    const f = vi.fn().mockResolvedValue(new Response('null', { status: 200 }));
    await expect(publishFlow(env, tenant, 'x', {}, f as unknown as typeof fetch)).rejects.toThrow(/no id/);
  });

  it('gets the preview url', async () => {
    process.env.TEST_WA_TOKEN = 'tok';
    const f = vi.fn().mockResolvedValue(resp(200, { preview: { preview_url: 'https://fb.com/p' }, id: '123' }));
    expect(await getFlowPreviewUrl(env, tenant, '123', f as unknown as typeof fetch)).toBe('https://fb.com/p');
    expect(decodeURIComponent(f.mock.calls[0]![0])).toBe('https://graph.facebook.com/v99.0/123?fields=preview.invalidate(false)');
  });
});

describe('publishExistingFlow', () => {
  const env = { GRAPH_API_VERSION: 'v23.0' } as const;
  const tenant = testTenant();
  const resp = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  afterEach(() => vi.unstubAllEnvs());

  it('POSTs /{flowId}/publish', async () => {
    vi.stubEnv(tenant.waTokenEnv, 'tok');
    const f = vi.fn().mockResolvedValue(resp(200, { success: true }));
    await publishExistingFlow(env, tenant, '999', f as unknown as typeof fetch);
    expect(f.mock.calls[0][0]).toBe('https://graph.facebook.com/v23.0/999/publish');
    expect(f.mock.calls[0][1].method).toBe('POST');
  });

  it('throws with the Graph error code', async () => {
    vi.stubEnv(tenant.waTokenEnv, 'tok');
    const f = vi.fn().mockResolvedValue(resp(400, { error: { code: 139002, message: 'Integrity requirements not met.' } }));
    await expect(publishExistingFlow(env, tenant, '999', f as unknown as typeof fetch)).rejects.toThrow(/139002/);
  });
});
