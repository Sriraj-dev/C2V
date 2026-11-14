import { parseArgs } from 'node:util';
import { loadEnv } from '../src/config/env.js';
import { CashfreeProvider } from '../src/payments/cashfree/client.js';
import { nutrifarm } from '../src/tenants/nutrifarm/config.js';

/**
 * Dev tool: manual sandbox check of the Cashfree adapter. Sandbox only.
 *
 *   pnpm cashfree:check create --phone 9XXXXXXXXX [--amount 2] [--notify https://...]
 *   pnpm cashfree:check status <linkId>
 */
const env = loadEnv(process.env);
if (env.CASHFREE_ENV !== 'sandbox') {
  console.error('Refusing to run: CASHFREE_ENV must be "sandbox".');
  process.exit(1);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    amount: { type: 'string', default: '2' },
    phone: { type: 'string' },
    notify: { type: 'string', default: 'https://example.com/webhooks/cashfree' },
  },
});
const [cmd, linkId] = positionals;
const provider = new CashfreeProvider(env);

if (cmd === 'create') {
  if (!values.phone) throw new Error('--phone is required');
  const rupees = Number(values.amount);
  if (!Number.isFinite(rupees) || rupees <= 0) throw new Error('--amount must be a positive number of rupees');
  const out = await provider.createPaymentLink(nutrifarm, {
    linkId: `c2v_check_${Date.now()}`,
    amountPaise: Math.round(rupees * 100),
    purpose: 'C2V sandbox check',
    customerPhone: values.phone,
    customerName: null,
    expiresAt: new Date(Date.now() + 30 * 60_000),
    notifyUrl: values.notify!,
  });
  console.log(`link_id: ${out.linkId}\nlink_url: ${out.url}`);
} else if (cmd === 'status' && linkId) {
  const s = await provider.getPaymentLink(nutrifarm, linkId);
  console.log(`status: ${s.status}\namount_paid_paise: ${s.amountPaidPaise}`);
} else {
  console.error('usage: cashfree:check create --phone <10-digit> [--amount 2] [--notify <url>] | status <linkId>');
  process.exit(1);
}
