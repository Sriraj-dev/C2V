import type { CopyLine, TenantCopy } from '../types.js';

const lineText = (l: CopyLine) => `• ${l.name} × ${l.qty} — ${l.lineTotal}`;

export const nutrifarmCopy: TenantCopy = {
  welcome: (name) =>
    `Hi${name ? ` ${name}` : ''}! 👋 Welcome to NutriFarm Eggs — fresh farm eggs delivered to your door.`,
  help: () =>
    'Need help with an order? Our team is happy to help — reach us using the details below.',
  menuPrompt: () => 'What would you like to do?',
  menuRows: () => ({
    order: 'Pick packs and get them delivered',
    subscribe: 'Weekly deliveries, never run out',
    myOrders: 'Track your orders and subscriptions',
    help: 'Talk to the farm',
  }),
  orderFlowIntro: () =>
    'Let\'s get your eggs ordered 🥚 Tap below to pick your packs and delivery address.\n\nWe deliver to Koramangala, HSR Layout, BTM Layout, Bommanahalli and Marathahalli.',
  subscribeFlowIntro: () =>
    'Set up a weekly delivery 🥚 Tap below to choose your packs and address. You will never run out of eggs again.',
  noItems: () => 'It looks like no eggs were selected. Please pick at least one pack and try again.',
  invalidPincode: (raw) =>
    `Sorry, "${raw}" doesn't look like a valid 6-digit pincode. Please check and try again.`,
  notServiceable: (pincode) =>
    `Sorry, we don't deliver to ${pincode} yet. We deliver to Koramangala, HSR Layout, BTM Layout, Bommanahalli and Marathahalli.`,
  invalidAddress: () => 'Please enter your name and address and try again.',
  belowMinimum: (min) => `Our minimum order is ${min}. Please add a few more packs and try again.`,
  orderSummary: (o) =>
    `Here is your order *${o.orderCode}*:\n\n${o.lines.map(lineText).join('\n')}\n\n*Total: ${o.total}*\nDelivery: ${o.deliveryDate}\n\nTap *Pay* below. The link is valid for 30 minutes.`,
  orderConfirmed: (o) =>
    `Payment received, thank you! 🎉 Your order *${o.orderCode}* is confirmed and will arrive on ${o.deliveryDate}.`,
  subscriptionSummary: (o) =>
    `Your weekly subscription:\n\n${o.lines.map(lineText).join('\n')}\n\n*${o.perDelivery}* per delivery, every ${o.weekdayName}.\nFirst delivery: ${o.firstDelivery}\n\nTap below to authorise the payment mandate.`,
  subscriptionActive: (o) =>
    `Your subscription is active! 🎉 Your first delivery is on ${o.firstDelivery}.`,
  myOrders: (rows, subs) => {
    if (rows.length === 0 && subs.length === 0) return 'You have no orders yet. Type *menu* to place one.';
    const parts: string[] = [];
    if (rows.length)
      parts.push(
        `*Recent orders*\n${rows.map((r) => `• ${r.orderCode} — ${r.status} — ${r.deliveryDate} — ${r.total}`).join('\n')}`,
      );
    if (subs.length)
      parts.push(
        `*Subscriptions*\n${subs.map((s) => `• ${s.perDelivery} every ${s.weekdayName} (next: ${s.nextDelivery})`).join('\n')}`,
      );
    return parts.join('\n\n');
  },
  invalidEmail: () => 'That email doesn\'t look right. Please send it again, like name@example.com.',
  genericError: () => 'Sorry, something went wrong on our side. Please try again in a moment.',
  askLocation: () => 'Help our delivery partner find you 📍 — share your location (optional).',
  locationSaved: () => 'Thanks, your location is saved. ✅',
};
