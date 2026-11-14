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
      c.noItems(),
      c.invalidPincode('56003'),
      c.notServiceable('560001'),
      c.orderSummary({ orderCode: 'NF-ABC234', lines, total: '₹180', deliveryDate: 'Wed, 18 Nov' }),
      c.orderConfirmed({ orderCode: 'NF-ABC234', deliveryDate: 'Wed, 18 Nov' }),
      c.linkExpired({ orderCode: 'NF-ABC234' }),
      c.subscriptionSummary({ lines, perDelivery: '₹180', weekdayName: 'Wednesday', firstDelivery: 'Wed, 18 Nov' }),
      c.subscriptionActive({ firstDelivery: 'Wed, 18 Nov' }),
      c.myOrders([], []),
      c.myOrders(
        [{ orderCode: 'NF-ABC234', status: 'confirmed', deliveryDate: 'Wed, 18 Nov', total: '₹180' }],
        [{ perDelivery: '₹180', weekdayName: 'Wednesday', nextDelivery: 'Wed, 25 Nov' }],
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
