import type { CopyLine, TenantCopy } from '../types.js';

const lineText = (l: CopyLine) => `• ${l.name} × ${l.qty} — ${l.lineTotal}`;
const contactUs = (supportPhone: string | null) =>
  supportPhone ? `please contact us on ${supportPhone}` : 'please tap *Help* in the menu';

export const nutrifarmCopy: TenantCopy = {
  welcome: (name) =>
    `Hi${name ? ` ${name}` : ''}! 👋 Welcome to NutriFarm Eggs — fresh farm eggs delivered to your door.`,
  help: () =>
    'Need help with an order? Our team is happy to help — reach us using the details below.',
  menuPrompt: () => 'What would you like to do?',
  menuRows: () => ({
    order: 'Pick packs and get them delivered',
    subscribe: 'Regular deliveries, never run out',
    myOrders: 'Track your orders and subscriptions',
    help: 'Talk to the farm',
  }),
  orderFlowIntro: () =>
    'Let\'s get your eggs ordered 🥚 Tap below to pick your packs and delivery address.\n\nWe deliver to Koramangala, HSR Layout, BTM Layout, Bommanahalli and Marathahalli.',
  subscribeFlowIntro: () =>
    'Set up a regular delivery 🥚 Tap below to choose your packs, how often (every week, every 2 weeks or every 4 weeks) and your address. You will never run out of eggs again.',
  subscribeComingSoon: () =>
    'Weekly subscriptions are under development and coming soon! 🚧 Meanwhile, tap *Order Eggs* in the menu to place a one-time order.',
  noItems: () => 'It looks like no eggs were selected. Please pick at least one pack and try again.',
  invalidPincode: (raw) =>
    `Sorry, "${raw}" doesn't look like a valid 6-digit pincode. Please check and try again.`,
  notServiceable: (pincode) =>
    `Sorry, we don't deliver to ${pincode} yet. We deliver to Koramangala, HSR Layout, BTM Layout, Bommanahalli and Marathahalli.`,
  invalidAddress: () => 'Please enter your name and address and try again.',
  invalidPhone: () =>
    'Please enter a valid 10-digit mobile number so we can send your payment link and reach you for delivery.',
  belowMinimum: (min) => `Our minimum order is ${min}. Please add a few more packs and try again.`,
  orderSummary: (o) =>
    `Here is your order *${o.orderCode}*:\n\n${o.lines.map(lineText).join('\n')}\n\n*Total: ${o.total}*\nDelivery: ${o.deliveryDate}\n\nTap *Pay* below. The link is valid for 30 minutes.`,
  orderConfirmed: (o) =>
    `Payment received, thank you! 🎉 Your order *${o.orderCode}* is confirmed and will arrive on ${o.deliveryDate}.`,
  linkExpired: (o) =>
    `Your payment link for order *${o.orderCode}* has expired. Tap *Order Eggs* in the menu to order again.`,
  subscriptionSummary: (o) =>
    `Your egg subscription:\n\n${o.lines.map(lineText).join('\n')}\n\n*${o.perDelivery}* per delivery, ${o.frequency}.\nFirst delivery: ${o.firstDelivery}\n\nTap *Set up AutoPay* below to approve UPI AutoPay. Two days before each delivery we'll message you, and you can skip that delivery.`,
  subscriptionActive: (o) =>
    `Your subscription is active! 🎉 Deliveries ${o.frequency}, starting ${o.firstDelivery}. We'll message you two days before each delivery.`,
  subscriptionAuthFailed: () =>
    "AutoPay wasn't set up, so your subscription hasn't started. Tap *Subscribe* in the menu to try again.",
  subscriptionCancelled: () =>
    'Your egg subscription has been cancelled. No more payments will be collected. Tap *Subscribe* in the menu any time to start again.',
  skipDone: (o) => `Done. We won't charge or deliver on ${o.date}. Your next delivery is on ${o.next}.`,
  skipAlreadyPaid: (o) =>
    `This delivery is already paid and confirmed (order *${o.orderCode}*). To cancel it, ${contactUs(o.supportPhone)}.`,
  skipProcessing: (o) =>
    `Your payment for this delivery is already being processed. To cancel it, ${contactUs(o.supportPhone)}.`,
  myOrders: (rows, subs) => {
    if (rows.length === 0 && subs.length === 0) return 'No orders yet. Tap *Order Eggs* in the menu below to place your first order.';
    const parts: string[] = [];
    if (rows.length)
      parts.push(
        `*Recent orders*\n${rows.map((r) => `• ${r.orderCode} — ${r.status} — ${r.deliveryDate} — ${r.total}`).join('\n')}`,
      );
    if (subs.length)
      parts.push(
        `*Subscriptions*\n${subs.map((s) => `• ${s.perDelivery} ${s.frequency} (next: ${s.nextDelivery})`).join('\n')}`,
      );
    return parts.join('\n\n');
  },
  invalidEmail: () => 'That email doesn\'t look right. Please send it again, like name@example.com.',
  genericError: () => 'Sorry, something went wrong on our side. Please try again in a moment.',
  askLocation: () => 'Help our delivery partner find you 📍 — share your location (optional).',
  locationSaved: () => 'Thanks, your location is saved. ✅',
  pendingPaymentNote: () =>
    'Already paid but it still shows *Payment pending*? It can take a few minutes to update. If it doesn’t, tap *Help* in the menu and we’ll sort it out.',
};
