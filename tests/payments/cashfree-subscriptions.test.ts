/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CashfreeError, CashfreeProvider } from '../../src/payments/cashfree/client.js';
import { testTenant } from '../helpers/test-db.js';

const tenant = testTenant();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const SB = 'https://sandbox.cashfree.com/pg';
const SUB = '0b9c6a52-8f1e-4c3a-9d2b-5e7f1a2b3c4d';
const PAY = '7d1e2f3a-4b5c-4d6e-8f9a-0b1c2d3e4f5a';

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
  return { calls, provider: new CashfreeProvider({ CASHFREE_ENV: 'sandbox' }, impl as unknown as typeof fetch) };
}

const createInput = {
  subscriptionId: SUB,
  maxAmountPaise: 51600,
  expiresAt: new Date('2036-11-18T04:30:00Z'),
  customer: { name: 'Asha Rao', email: 'asha@example.com', phone: '919876543210' },
  returnUrl: 'https://bot.test/subscribe/tok/done',
};

beforeEach(() => {
  process.env.TEST_CF_APP_ID = 'app-id-123';
  process.env.TEST_CF_SECRET = 'cfsk_secret_456';
});
afterEach(() => {
  delete process.env.TEST_CF_APP_ID;
  delete process.env.TEST_CF_SECRET;
});

describe('createSubscription', () => {
  it('posts an inline ON_DEMAND UPI plan with the max in rupees and returns the session', async () => {
    const { calls, provider } = mockFetch(json({ cf_subscription_id: 23639356, subscription_session_id: 'sess_1', subscription_status: 'INITIALIZED' }));
    const r = await provider.createSubscription(tenant, createInput);
    expect(r).toEqual({ cfSubscriptionId: '23639356', sessionId: 'sess_1' });
    const c = calls[0]!;
    expect(c.method).toBe('POST');
    expect(c.url).toBe(`${SB}/subscriptions`);
    expect(c.headers['x-api-version']).toBe('2026-01-01');
    expect(c.headers['x-idempotency-key']).toBe(`sub:${SUB}`);
    expect(c.body).toEqual({
      subscription_id: SUB,
      customer_details: { customer_name: 'Asha Rao', customer_email: 'asha@example.com', customer_phone: '9876543210' },
      plan_details: { plan_name: 'Egg subscription', plan_type: 'ON_DEMAND', plan_max_amount: 516, plan_currency: 'INR' },
      authorization_details: { authorization_amount: 1, authorization_amount_refund: true, payment_methods: ['upi'] },
      subscription_meta: { return_url: 'https://bot.test/subscribe/tok/done' },
      subscription_expiry_time: '2036-11-18T10:00:00+05:30',
    });
  });

  it('409 → re-fetches and reuses a still-initialized subscription', async () => {
    const { calls, provider } = mockFetch(
      json({ code: 'subscription_already_exists', message: 'exists' }, 409),
      json({ cf_subscription_id: '99', subscription_session_id: 'sess_2', subscription_status: 'INITIALIZED' }),
    );
    expect(await provider.createSubscription(tenant, createInput)).toEqual({ cfSubscriptionId: '99', sessionId: 'sess_2' });
    expect(calls[1]).toMatchObject({ method: 'GET', url: `${SB}/subscriptions/${SUB}` });
  });

  it('missing session id → bad_response', async () => {
    const { provider } = mockFetch(json({ cf_subscription_id: '1' }));
    await expect(provider.createSubscription(tenant, createInput)).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('errors never echo the customer phone', async () => {
    const { provider } = mockFetch(json({ code: 'request_invalid', message: 'bad phone 9876543210' }, 400));
    const err = (await provider.createSubscription(tenant, createInput).catch((e) => e)) as CashfreeError;
    expect(err).toBeInstanceOf(CashfreeError);
    expect(err.message).not.toContain('9876543210');
    expect(err.message).not.toContain('cfsk_secret_456');
  });
});

describe('getSubscription', () => {
  it('returns subscription and authorisation status', async () => {
    const { calls, provider } = mockFetch(
      json({ subscription_status: 'ACTIVE', authorization_details: { authorization_status: 'ACTIVE' }, subscription_session_id: 'sess_9' }),
    );
    expect(await provider.getSubscription(tenant, SUB)).toEqual({ status: 'ACTIVE', authorizationStatus: 'ACTIVE', sessionId: 'sess_9' });
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${SB}/subscriptions/${SUB}` });
  });
  it('unknown shape → bad_response', async () => {
    const { provider } = mockFetch(json({}));
    await expect(provider.getSubscription(tenant, SUB)).rejects.toMatchObject({ code: 'bad_response' });
  });
});

describe('raiseCharge', () => {
  it('posts a CHARGE in rupees scheduled for that IST day', async () => {
    const { calls, provider } = mockFetch(json({ payment_status: 'INITIALIZED', cf_payment_id: '1' }));
    await provider.raiseCharge(tenant, { subscriptionId: SUB, paymentId: PAY, amountPaise: 25800, scheduleDate: '2026-11-24' });
    expect(calls[0]!.url).toBe(`${SB}/subscriptions/pay`);
    expect(calls[0]!.headers['x-idempotency-key']).toBe(`charge:${PAY}`);
    expect(calls[0]!.body).toEqual({
      subscription_id: SUB,
      payment_id: PAY,
      payment_type: 'CHARGE',
      payment_amount: 258,
      payment_schedule_date: '2026-11-24T10:00:00+05:30',
      payment_remarks: 'Egg delivery',
    });
  });
  it('409 is treated as success after the charge is found', async () => {
    const { calls, provider } = mockFetch(json({ code: 'payment_already_exists', message: 'x' }, 409), json({ payment_status: 'INITIALIZED' }));
    await provider.raiseCharge(tenant, { subscriptionId: SUB, paymentId: PAY, amountPaise: 25800, scheduleDate: '2026-11-24' });
    expect(calls[1]).toMatchObject({ method: 'GET', url: `${SB}/subscriptions/${SUB}/payments/${PAY}` });
  });
  it('rejects a malformed schedule date before calling Cashfree', async () => {
    const { calls, provider } = mockFetch();
    await expect(provider.raiseCharge(tenant, { subscriptionId: SUB, paymentId: PAY, amountPaise: 100, scheduleDate: '24-11-2026' })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
  it('other errors propagate', async () => {
    const { provider } = mockFetch(json({ code: 'request_failed', message: 'cut-off' }, 400));
    await expect(provider.raiseCharge(tenant, { subscriptionId: SUB, paymentId: PAY, amountPaise: 100, scheduleDate: '2026-11-24' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('getCharge / cancelCharge / cancelSubscription', () => {
  it('getCharge returns payment_status', async () => {
    const { calls, provider } = mockFetch(json({ payment_status: 'SUCCESS' }));
    expect(await provider.getCharge(tenant, SUB, PAY)).toEqual({ status: 'SUCCESS' });
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${SB}/subscriptions/${SUB}/payments/${PAY}` });
  });
  it('cancelCharge posts the CANCEL action', async () => {
    const { calls, provider } = mockFetch(json({ payment_status: 'CANCELLED' }));
    await provider.cancelCharge(tenant, SUB, PAY);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${SB}/subscriptions/${SUB}/payments/${PAY}/manage`,
      body: { subscription_id: SUB, payment_id: PAY, action: 'CANCEL' },
    });
  });
  it('cancelSubscription posts the CANCEL action', async () => {
    const { calls, provider } = mockFetch(json({ subscription_status: 'CANCELLED' }));
    await provider.cancelSubscription(tenant, SUB);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${SB}/subscriptions/${SUB}/manage`,
      body: { subscription_id: SUB, action: 'CANCEL' },
    });
  });

  it('cancelCharge again on an already cancelled charge succeeds', async () => {
    const { provider } = mockFetch(
      json({ code: 'payment_status_invalid_for_action', message: 'Invalid payment status' }, 400),
      json({ payment_status: 'CANCELLED' }),
    );
    await expect(provider.cancelCharge(tenant, SUB, PAY)).resolves.toBeUndefined();
  });
  it('cancelCharge refused on a collected charge throws', async () => {
    const { provider } = mockFetch(
      json({ code: 'payment_status_invalid_for_action', message: 'Invalid payment status' }, 400),
      json({ payment_status: 'SUCCESS' }),
    );
    await expect(provider.cancelCharge(tenant, SUB, PAY)).rejects.toMatchObject({ code: 'payment_status_invalid_for_action' });
  });
  it('cancelSubscription again on a cancelled subscription succeeds', async () => {
    const { provider } = mockFetch(
      json({ code: 'subscription_status_invalid_for_action', message: 'invalid' }, 400),
      json({ subscription_status: 'CUSTOMER_CANCELLED' }),
    );
    await expect(provider.cancelSubscription(tenant, SUB)).resolves.toBeUndefined();
  });
  it('cancelSubscription refused on an active subscription throws', async () => {
    const { provider } = mockFetch(
      json({ code: 'subscription_status_invalid_for_action', message: 'invalid' }, 400),
      json({ subscription_status: 'ACTIVE' }),
    );
    await expect(provider.cancelSubscription(tenant, SUB)).rejects.toBeInstanceOf(CashfreeError);
  });
});
