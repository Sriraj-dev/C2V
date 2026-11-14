import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CashfreeError,
  CashfreeProvider,
  InvalidCustomerPhoneError,
  normalizeIndianPhone,
  paiseToRupees,
  toIstIso,
} from '../../../src/payments/cashfree/client.js';
import { testTenant } from '../../helpers/test-db.js';

const tenant = testTenant();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
function mockFetch(...responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const r = responses.shift() ?? json({});
    if (r instanceof Error) throw r;
    return r;
  });
  return { calls, impl: impl as unknown as typeof fetch };
}

const input = {
  linkId: 'c2v_ord_1',
  amountPaise: 48000,
  purpose: 'Order TS-1001',
  customerPhone: '919876543210',
  customerName: 'Asha',
  expiresAt: new Date('2026-11-14T05:00:00Z'),
  notifyUrl: 'https://bot.example.com/webhooks/cashfree',
};

beforeEach(() => {
  process.env.TEST_CF_APP_ID = 'app-id-123';
  process.env.TEST_CF_SECRET = 'cfsk_secret_456';
});
afterEach(() => {
  delete process.env.TEST_CF_APP_ID;
  delete process.env.TEST_CF_SECRET;
});

describe('helpers', () => {
  it('converts paise to rupees without float drift', () => {
    expect(paiseToRupees(48000)).toBe(480);
    expect(paiseToRupees(12345)).toBe(123.45);
    expect(paiseToRupees(1)).toBe(0.01);
    expect(paiseToRupees(29)).toBe(0.29);
    expect(() => paiseToRupees(10.5)).toThrow(CashfreeError);
    expect(() => paiseToRupees(0)).toThrow(CashfreeError);
  });
  it('formats expiry in IST', () => {
    expect(toIstIso(new Date('2026-11-14T05:00:00Z'))).toBe('2026-11-14T10:30:00+05:30');
  });
  it('normalises Indian phones', () => {
    for (const p of ['9876543210', '919876543210', '+919876543210', '09876543210', '+91 98765-43210']) {
      expect(normalizeIndianPhone(p)).toBe('9876543210');
    }
    for (const p of ['', '12345', '5876543210', '98765432101234', 'abc']) {
      expect(() => normalizeIndianPhone(p)).toThrow(InvalidCustomerPhoneError);
    }
  });
});

describe('createPaymentLink', () => {
  it('posts the documented body to sandbox /links and maps the response', async () => {
    const { calls, impl } = mockFetch(json({ link_id: 'c2v_ord_1', link_url: 'https://payments-test.cashfree.com/links/x' }));
    const out = await new CashfreeProvider({ CASHFREE_ENV: 'sandbox' }, impl).createPaymentLink(tenant, input);
    expect(out).toEqual({ linkId: 'c2v_ord_1', url: 'https://payments-test.cashfree.com/links/x' });
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe('https://sandbox.cashfree.com/pg/links');
    expect(c.method).toBe('POST');
    expect(c.headers).toMatchObject({ 'x-client-id': 'app-id-123', 'x-client-secret': 'cfsk_secret_456', 'x-api-version': '2026-01-01' });
    expect(c.body).toEqual({
      link_id: 'c2v_ord_1',
      link_amount: 480,
      link_currency: 'INR',
      link_purpose: 'Order TS-1001',
      customer_details: { customer_phone: '9876543210', customer_name: 'Asha' },
      link_expiry_time: '2026-11-14T10:30:00+05:30',
      link_notify: { send_sms: false, send_email: false },
      link_auto_reminders: false,
      link_partial_payments: false,
      link_meta: { notify_url: 'https://bot.example.com/webhooks/cashfree', upi_intent: true },
    });
  });
  it('uses the production base URL, omits null name, truncates purpose', async () => {
    const { calls, impl } = mockFetch(json({ link_url: 'https://u' }));
    await new CashfreeProvider({ CASHFREE_ENV: 'production' }, impl).createPaymentLink(tenant, {
      ...input,
      customerName: null,
      purpose: 'p'.repeat(600),
    });
    expect(calls[0]!.url).toBe('https://api.cashfree.com/pg/links');
    expect(calls[0]!.body.customer_details).toEqual({ customer_phone: '9876543210' });
    expect(calls[0]!.body.link_purpose).toHaveLength(500);
  });
  it('rejects an invalid phone before any network call', async () => {
    const { calls, impl } = mockFetch();
    await expect(new CashfreeProvider({ CASHFREE_ENV: 'sandbox' }, impl).createPaymentLink(tenant, { ...input, customerPhone: '12345' })).rejects.toBeInstanceOf(InvalidCustomerPhoneError);
    expect(calls).toHaveLength(0);
  });
  it('maps non-2xx to CashfreeError with status and code, without secrets', async () => {
    const { impl } = mockFetch(json({ code: 'link_already_exists', message: 'link exists', type: 'invalid_request_error' }, 409));
    const err = await new CashfreeProvider({ CASHFREE_ENV: 'sandbox' }, impl).createPaymentLink(tenant, input).catch((e) => e);
    expect(err).toBeInstanceOf(CashfreeError);
    expect(err).toMatchObject({ status: 409, code: 'link_already_exists' });
    expect(err.message).not.toContain('cfsk_secret_456');
    expect(err.message).not.toContain('9876543210');
  });
  it('maps timeouts and network failures', async () => {
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    const p1 = new CashfreeProvider({ CASHFREE_ENV: 'sandbox' }, mockFetch(timeout).impl);
    await expect(p1.createPaymentLink(tenant, input)).rejects.toMatchObject({ code: 'timeout', status: 0 });
    const p2 = new CashfreeProvider({ CASHFREE_ENV: 'sandbox' }, mockFetch(new TypeError('fetch failed')).impl);
    await expect(p2.createPaymentLink(tenant, input)).rejects.toMatchObject({ code: 'network_error', status: 0 });
  });
  it('sends an idempotency key', async () => {
    const { calls, impl } = mockFetch(json({ link_url: 'https://u' }));
    await new CashfreeProvider({ CASHFREE_ENV: 'sandbox' }, impl).createPaymentLink(tenant, input);
    expect(calls[0]!.headers['x-idempotency-key']).toBe('link:c2v_ord_1');
  });
  it('on 409 link_already_exists returns the existing ACTIVE link with the same amount', async () => {
    const { calls, impl } = mockFetch(
      json({ code: 'link_already_exists', message: 'x' }, 409),
      json({ link_status: 'ACTIVE', link_amount: 480, link_url: 'https://existing' }),
    );
    const out = await new CashfreeProvider({ CASHFREE_ENV: 'sandbox' }, impl).createPaymentLink(tenant, input);
    expect(out).toEqual({ linkId: 'c2v_ord_1', url: 'https://existing' });
    expect(calls[1]).toMatchObject({ url: 'https://sandbox.cashfree.com/pg/links/c2v_ord_1', method: 'GET' });
    expect(calls[1]!.headers['content-type']).toBeUndefined();
  });
  it('on 409 throws when the existing link is not ACTIVE or the amount differs', async () => {
    for (const existing of [
      { link_status: 'PAID', link_amount: 480, link_url: 'u' },
      { link_status: 'ACTIVE', link_amount: 100, link_url: 'u' },
    ]) {
      const { impl } = mockFetch(json({ code: 'link_already_exists', message: 'x' }, 409), json(existing));
      await expect(new CashfreeProvider({ CASHFREE_ENV: 'sandbox' }, impl).createPaymentLink(tenant, input)).rejects.toMatchObject({ status: 409, code: 'link_already_exists' });
    }
  });
  it('trims and caps customer_name, omitting it when blank', async () => {
    const a = mockFetch(json({ link_url: 'u' }));
    await new CashfreeProvider({ CASHFREE_ENV: 'sandbox' }, a.impl).createPaymentLink(tenant, { ...input, customerName: '  ' + 'n'.repeat(150) });
    expect(a.calls[0]!.body.customer_details.customer_name).toHaveLength(100);
    const b = mockFetch(json({ link_url: 'u' }));
    await new CashfreeProvider({ CASHFREE_ENV: 'sandbox' }, b.impl).createPaymentLink(tenant, { ...input, customerName: '   ' });
    expect(b.calls[0]!.body.customer_details).not.toHaveProperty('customer_name');
  });
  it('truncates and masks Cashfree messages in errors', async () => {
    const { impl } = mockFetch(json({ code: 'customer_phone_invalid', message: 'bad phone 9876543210 ' + 'z'.repeat(400) }, 400));
    const err = await new CashfreeProvider({ CASHFREE_ENV: 'sandbox' }, impl).createPaymentLink(tenant, input).catch((e) => e);
    expect(err.message).not.toContain('9876543210');
    expect(err.message.length).toBeLessThan(260);
  });
  it('fails clearly when credentials are missing', async () => {
    delete process.env.TEST_CF_SECRET;
    const { calls, impl } = mockFetch();
    await expect(new CashfreeProvider({ CASHFREE_ENV: 'sandbox' }, impl).createPaymentLink(tenant, input)).rejects.toThrow('credentials not configured');
    expect(calls).toHaveLength(0);
  });
});

describe('getPaymentLink / cancelPaymentLink', () => {
  it('maps status and rupees to paise', async () => {
    const { calls, impl } = mockFetch(json({ link_status: 'PAID', link_amount_paid: 480.1 }));
    const out = await new CashfreeProvider({ CASHFREE_ENV: 'sandbox' }, impl).getPaymentLink(tenant, 'c2v_ord_1');
    expect(out).toEqual({ status: 'PAID', amountPaidPaise: 48010 });
    expect(calls[0]).toMatchObject({ url: 'https://sandbox.cashfree.com/pg/links/c2v_ord_1', method: 'GET' });
  });
  it('accepts string amounts and encodes link ids', async () => {
    const { calls, impl } = mockFetch(json({ link_status: 'PAID', link_amount_paid: '480.00' }));
    const out = await new CashfreeProvider({ CASHFREE_ENV: 'sandbox' }, impl).getPaymentLink(tenant, 'a/b c');
    expect(out.amountPaidPaise).toBe(48000);
    expect(calls[0]!.url).toBe('https://sandbox.cashfree.com/pg/links/a%2Fb%20c');
    expect(calls[0]!.headers['content-type']).toBeUndefined();
  });
  it('throws on missing or non-numeric link_amount_paid', async () => {
    for (const v of [undefined, 'abc', null]) {
      const { impl } = mockFetch(json({ link_status: 'PAID', link_amount_paid: v }));
      await expect(new CashfreeProvider({ CASHFREE_ENV: 'sandbox' }, impl).getPaymentLink(tenant, 'x')).rejects.toMatchObject({ code: 'bad_response' });
    }
  });
  it('rejects an unknown status', async () => {
    const { impl } = mockFetch(json({ link_status: 'WEIRD', link_amount_paid: 0 }));
    await expect(new CashfreeProvider({ CASHFREE_ENV: 'sandbox' }, impl).getPaymentLink(tenant, 'x')).rejects.toBeInstanceOf(CashfreeError);
  });
  it('cancels via POST /links/{id}/cancel', async () => {
    const { calls, impl } = mockFetch(json({ link_status: 'CANCELLED' }));
    await new CashfreeProvider({ CASHFREE_ENV: 'sandbox' }, impl).cancelPaymentLink(tenant, 'c2v_ord_1');
    expect(calls[0]).toMatchObject({ url: 'https://sandbox.cashfree.com/pg/links/c2v_ord_1/cancel', method: 'POST' });
  });
});

describe('refundPaymentLink', () => {
  it('finds the PAID order then refunds it', async () => {
    const { calls, impl } = mockFetch(json([{ order_id: 'CFPay_1' }]), json({ refund_status: 'PENDING' }));
    await new CashfreeProvider({ CASHFREE_ENV: 'sandbox' }, impl).refundPaymentLink(tenant, 'c2v_ord_1', 12345, 'ref_1');
    expect(calls[0]).toMatchObject({ url: 'https://sandbox.cashfree.com/pg/links/c2v_ord_1/orders?status=PAID', method: 'GET' });
    expect(calls[1]).toMatchObject({ url: 'https://sandbox.cashfree.com/pg/orders/CFPay_1/refunds', method: 'POST' });
    expect(calls[1]!.body).toEqual({ refund_amount: 123.45, refund_id: 'ref_1' });
  });
  it('accepts the {data:[...]} list shape', async () => {
    const { calls, impl } = mockFetch(json({ data: [{ order_id: 'CFPay_9' }] }), json({}));
    await new CashfreeProvider({ CASHFREE_ENV: 'sandbox' }, impl).refundPaymentLink(tenant, 'l', 100, 'ref_9');
    expect(calls[1]!.url).toBe('https://sandbox.cashfree.com/pg/orders/CFPay_9/refunds');
  });
  it('with several PAID orders picks the one whose amount matches, else throws', async () => {
    const list = [{ order_id: 'A', order_amount: '100.00' }, { order_id: 'B', order_amount: '480.00' }];
    const ok = mockFetch(json(list), json({}));
    await new CashfreeProvider({ CASHFREE_ENV: 'sandbox' }, ok.impl).refundPaymentLink(tenant, 'l', 48000, 'ref_1');
    expect(ok.calls[1]!.url).toContain('/orders/B/refunds');
    const bad = mockFetch(json(list));
    await expect(new CashfreeProvider({ CASHFREE_ENV: 'sandbox' }, bad.impl).refundPaymentLink(tenant, 'l', 5000, 'ref_1')).rejects.toMatchObject({ code: 'ambiguous_paid_orders' });
    expect(bad.calls).toHaveLength(1);
  });
  it('validates refund_id length before any call', async () => {
    const { calls, impl } = mockFetch();
    for (const id of ['ab', 'x'.repeat(41), 'bad id!']) {
      await expect(new CashfreeProvider({ CASHFREE_ENV: 'sandbox' }, impl).refundPaymentLink(tenant, 'l', 100, id)).rejects.toMatchObject({ code: 'invalid_refund_id' });
    }
    expect(calls).toHaveLength(0);
  });
  it('passes through refund_id_already_exists', async () => {
    const { impl } = mockFetch(json([{ order_id: 'A' }]), json({ code: 'refund_id_already_exists', message: 'dup' }, 400));
    await expect(new CashfreeProvider({ CASHFREE_ENV: 'sandbox' }, impl).refundPaymentLink(tenant, 'l', 100, 'ref_1')).rejects.toMatchObject({ status: 400, code: 'refund_id_already_exists' });
  });
  it('throws when there is no PAID order and does not post a refund', async () => {
    const { calls, impl } = mockFetch(json([]));
    await expect(new CashfreeProvider({ CASHFREE_ENV: 'sandbox' }, impl).refundPaymentLink(tenant, 'l', 100, 'ref_r')).rejects.toMatchObject({ code: 'no_paid_order' });
    expect(calls).toHaveLength(1);
  });
});
