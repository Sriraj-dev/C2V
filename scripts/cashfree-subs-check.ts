import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadEnv } from '../src/config/env.js';
import { CashfreeProvider } from '../src/payments/cashfree/client.js';
import { nutrifarm } from '../src/tenants/nutrifarm/config.js';

/**
 * Dev tool: manual sandbox check of the Cashfree subscription adapter. Sandbox only.
 *
 *   pnpm cashfree:subs-check create --phone 9XXXXXXXXX --email a@b.c [--max 10] [--html <file>]
 *   pnpm cashfree:subs-check status <subscriptionId>
 *   pnpm cashfree:subs-check charge <subscriptionId> --date YYYY-MM-DD [--amount 2]
 *   pnpm cashfree:subs-check charge-status <subscriptionId> <paymentId>
 *   pnpm cashfree:subs-check cancel-charge <subscriptionId> <paymentId>
 *   pnpm cashfree:subs-check cancel <subscriptionId>
 *
 * `create --html` writes a local page that opens Cashfree's sandbox checkout for the new mandate.
 */
const env = loadEnv(process.env);
if (env.CASHFREE_ENV !== 'sandbox') {
  console.error('Refusing to run: CASHFREE_ENV must be "sandbox".');
  process.exit(1);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    phone: { type: 'string' },
    email: { type: 'string' },
    max: { type: 'string', default: '10' },
    amount: { type: 'string', default: '2' },
    date: { type: 'string' },
    html: { type: 'string' },
  },
});
const [cmd, subId, payId] = positionals;
const provider = new CashfreeProvider(env);
const paise = (s: string) => {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) throw new Error('amount must be a positive number of rupees');
  return Math.round(n * 100);
};
const need = (v: string | undefined, what: string): string => {
  if (!v) throw new Error(`${what} is required`);
  return v;
};

switch (cmd) {
  case 'create': {
    const subscriptionId = randomUUID();
    const out = await provider.createSubscription(nutrifarm, {
      subscriptionId,
      maxAmountPaise: paise(values.max!),
      expiresAt: new Date(Date.now() + 365 * 86_400_000),
      customer: { name: 'Sandbox Check', email: need(values.email, '--email'), phone: need(values.phone, '--phone') },
      returnUrl: 'https://example.com/subscribe/done',
    });
    console.log(`subscription id: ${subscriptionId}\ncf id: ${out.cfSubscriptionId}\nsession: ${out.sessionId}`);
    if (values.html) {
      writeFileSync(
        values.html,
        `<!doctype html><meta charset="utf-8"><script src="https://sdk.cashfree.com/js/v3/cashfree.js"></script>
<button id="b" style="font-size:20px;padding:12px">Set up AutoPay (sandbox)</button>
<script>document.getElementById('b').onclick=()=>Cashfree({mode:'sandbox'}).subscriptionsCheckout({subsSessionId:${JSON.stringify(out.sessionId)},redirectTarget:'_self'});</script>`,
      );
      console.log(`checkout page: ${values.html}`);
    }
    break;
  }
  case 'status':
    console.log(await provider.getSubscription(nutrifarm, need(subId, 'subscriptionId')));
    break;
  case 'charge': {
    const paymentId = randomUUID();
    await provider.raiseCharge(nutrifarm, {
      subscriptionId: need(subId, 'subscriptionId'),
      paymentId,
      amountPaise: paise(values.amount!),
      scheduleDate: need(values.date, '--date'),
    });
    console.log(`payment id: ${paymentId}`);
    console.log(await provider.getCharge(nutrifarm, subId!, paymentId));
    break;
  }
  case 'charge-status':
    console.log(await provider.getCharge(nutrifarm, need(subId, 'subscriptionId'), need(payId, 'paymentId')));
    break;
  case 'cancel-charge':
    await provider.cancelCharge(nutrifarm, need(subId, 'subscriptionId'), need(payId, 'paymentId'));
    console.log(await provider.getCharge(nutrifarm, subId!, payId!));
    break;
  case 'cancel':
    await provider.cancelSubscription(nutrifarm, need(subId, 'subscriptionId'));
    console.log(await provider.getSubscription(nutrifarm, subId!));
    break;
  default:
    console.error('Usage: pnpm cashfree:subs-check create|status|charge|charge-status|cancel-charge|cancel ...');
    process.exit(1);
}
