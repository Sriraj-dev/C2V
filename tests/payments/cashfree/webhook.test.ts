import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCashfreeEvent, verifyCashfreeSignature } from '../../../src/payments/cashfree/webhook.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const sign = (ts: string, body: string, secret: string) => createHmac('sha256', secret).update(ts + body).digest('base64');

describe('verifyCashfreeSignature', () => {
  const body = fixture('payment-link-paid');
  const ts = '1763100000000';
  it('accepts a valid signature', () => {
    expect(verifyCashfreeSignature(body, ts, sign(ts, body, 's3cret'), 's3cret')).toBe(true);
  });
  it('rejects wrong secret, tampered body and wrong timestamp', () => {
    const sig = sign(ts, body, 's3cret');
    expect(verifyCashfreeSignature(body, ts, sig, 'other')).toBe(false);
    expect(verifyCashfreeSignature(body + ' ', ts, sig, 's3cret')).toBe(false);
    expect(verifyCashfreeSignature(body, '1', sig, 's3cret')).toBe(false);
  });
  it('returns false (never throws) for missing, short, long or garbage input', () => {
    const sig = sign(ts, body, 's3cret');
    expect(verifyCashfreeSignature(body, undefined, sig, 's3cret')).toBe(false);
    expect(verifyCashfreeSignature(body, ts, undefined, 's3cret')).toBe(false);
    expect(verifyCashfreeSignature(body, ts, '', 's3cret')).toBe(false);
    expect(verifyCashfreeSignature(body, ts, 'abc', 's3cret')).toBe(false);
    expect(verifyCashfreeSignature(body, ts, sig + sig, 's3cret')).toBe(false);
    expect(verifyCashfreeSignature(body, ts, '!!!not base64!!!', 's3cret')).toBe(false);
    expect(verifyCashfreeSignature(body, ts, sig, '')).toBe(false);
  });
});

describe('parseCashfreeEvent', () => {
  it('PAID link event -> link_paid', () => {
    expect(parseCashfreeEvent(JSON.parse(fixture('payment-link-paid')))).toEqual({ type: 'link_paid', linkId: 'c2v_ord_8f3a', linkStatus: 'PAID' });
  });
  it('EXPIRED link event (order null) -> link_status', () => {
    expect(parseCashfreeEvent(JSON.parse(fixture('payment-link-expired')))).toEqual({ type: 'link_status', linkId: 'c2v_ord_8f3a', linkStatus: 'EXPIRED' });
  });
  it('subscription status change', () => {
    expect(parseCashfreeEvent(JSON.parse(fixture('subscription-status-changed')))).toEqual({
      type: 'subscription_status',
      subscriptionId: 'sub_unique_id',
      status: 'ACTIVE',
    });
  });
  it('subscription charge success and failure', () => {
    const mk = (type: string) => ({ type, data: { subscription_id: 'sub1', payment_id: 'pay1' } });
    expect(parseCashfreeEvent(mk('SUBSCRIPTION_PAYMENT_SUCCESS'))).toEqual({ type: 'subscription_charge', subscriptionId: 'sub1', paymentId: 'pay1', success: true });
    expect(parseCashfreeEvent(mk('SUBSCRIPTION_PAYMENT_FAILED'))).toMatchObject({ type: 'subscription_charge', success: false });
    expect(parseCashfreeEvent(mk('SUBSCRIPTION_PAYMENT_CANCELLED'))).toMatchObject({ type: 'subscription_charge', paymentId: 'pay1', success: false });
  });
  it('unknown or malformed input is ignored with a short raw and never throws', () => {
    const inputs: unknown[] = [
      { type: 'PAYMENT_SUCCESS_WEBHOOK', data: {} },
      { type: 'PAYMENT_LINK_EVENT', data: {} },
      { type: 'PAYMENT_LINK_EVENT' },
      null,
      undefined,
      'str',
      42,
      [],
      { type: 'x'.repeat(1000), data: {} },
    ];
    for (const i of inputs) {
      const e = parseCashfreeEvent(i);
      expect(e.type).toBe('ignored');
      if (e.type === 'ignored') expect(e.raw.length).toBeLessThanOrEqual(80);
    }
  });
});
