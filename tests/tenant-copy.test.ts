import { describe, expect, it } from 'vitest';
import { nutrifarmCopy as c } from '../src/tenants/nutrifarm/copy.js';

const lines = [{ name: 'White Eggs – 6 pack', qty: 2, lineTotal: '₹180' }];

describe('nutrifarm copy', () => {
  it('every function returns a non-empty string', () => {
    const outs = [
      c.welcome('Asha'),
      c.welcome(null),
      c.help(),
      c.orderFlowIntro(),
      c.subscribeFlowIntro(),
      c.subscribeComingSoon(),
      c.noItems(),
      c.invalidPincode('56003'),
      c.notServiceable('560001'),
      c.orderSummary({ orderCode: 'NF-ABC234', lines, total: '₹180', deliveryDate: 'Wed, 18 Nov' }),
      c.orderConfirmed({ orderCode: 'NF-ABC234', deliveryDate: 'Wed, 18 Nov' }),
      c.linkExpired({ orderCode: 'NF-ABC234' }),
      c.subscriptionSummary({ lines, perDelivery: '₹180', frequency: 'every Wednesday', firstDelivery: 'Wed, 18 Nov' }),
      c.subscriptionActive({ firstDelivery: 'Wed, 18 Nov', frequency: 'every Wednesday' }),
      c.subscriptionAuthFailed(),
      c.subscriptionCancelled(),
      c.myOrders([], []),
      c.myOrders(
        [{ orderCode: 'NF-ABC234', status: 'confirmed', deliveryDate: 'Wed, 18 Nov', total: '₹180' }],
        [{ perDelivery: '₹180', frequency: 'every Wednesday', nextDelivery: 'Wed, 25 Nov' }],
      ),
      c.invalidEmail(),
      c.genericError(),
      c.askLocation(),
      c.locationSaved(),
    ];
    for (const o of outs) expect(o.trim().length).toBeGreaterThan(0);
  });
  it('orderSummary ends with the pay line; orderFlowIntro lists areas', () => {
    expect(c.orderSummary({ orderCode: 'X', lines, total: '₹1', deliveryDate: 'd' })).toMatch(
      /Tap \*Pay\* below\. The link is valid for 30 minutes\.$/,
    );
    expect(c.orderFlowIntro()).toContain(
      'We deliver to Koramangala, HSR Layout, BTM Layout, Bommanahalli and Marathahalli.',
    );
  });
});

it('linkExpired text is exact', () => {
  expect(c.linkExpired({ orderCode: 'NF-ABC234' })).toBe(
    'Your payment link for order *NF-ABC234* has expired. Tap *Order Eggs* in the menu to order again.',
  );
});

describe('subscription copy', () => {
  it('summary and active name the frequency', () => {
    const sum = c.subscriptionSummary({ lines, perDelivery: '₹258', frequency: 'every 2 weeks on Wednesday', firstDelivery: 'Wed, 25 Nov' });
    expect(sum).toContain('*₹258* per delivery, every 2 weeks on Wednesday.');
    expect(sum).toContain('First delivery: Wed, 25 Nov');
    expect(sum).toContain('Set up AutoPay');
    expect(c.subscriptionActive({ firstDelivery: 'Wed, 25 Nov', frequency: 'every 2 weeks on Wednesday' })).toContain('Wed, 25 Nov');
  });
  it('skip replies', () => {
    expect(c.skipDone({ date: 'Wed, 25 Nov', next: 'Wed, 2 Dec' })).toBe(
      "Done. We won't charge or deliver on Wed, 25 Nov. Your next delivery is on Wed, 2 Dec.",
    );
    expect(c.skipAlreadyPaid({ orderCode: 'NF-ABC234', supportPhone: '+91 98000 00001' })).toBe(
      'This delivery is already paid and confirmed (order *NF-ABC234*). To cancel it, please contact us on +91 98000 00001.',
    );
    expect(c.skipAlreadyPaid({ orderCode: 'NF-ABC234', supportPhone: null })).toBe(
      'This delivery is already paid and confirmed (order *NF-ABC234*). To cancel it, please tap *Help* in the menu.',
    );
    expect(c.skipProcessing({ supportPhone: '+91 98000 00001' })).toBe(
      'Your payment for this delivery is already being processed. To cancel it, please contact us on +91 98000 00001.',
    );
    expect(c.skipProcessing({ supportPhone: null })).toContain('tap *Help* in the menu');
  });
  it('my orders lists subscriptions with the frequency', () => {
    expect(c.myOrders([], [{ perDelivery: '₹258', frequency: 'every 2 weeks on Wednesday', nextDelivery: 'Wed, 2 Dec' }])).toContain(
      '• ₹258 every 2 weeks on Wednesday (next: Wed, 2 Dec)',
    );
  });
});
