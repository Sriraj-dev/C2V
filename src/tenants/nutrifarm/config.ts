import type { TenantConfig } from '../types.js';
import { nutrifarmCopy } from './copy.js';

export const nutrifarm: TenantConfig = {
  id: 'nutrifarm',
  name: 'NutriFarm Eggs',
  // Dev/testing may point the bot at Meta's test number via .env; production uses the defaults.
  waPhoneNumberId: process.env.NUTRIFARM_WA_PHONE_NUMBER_ID || '1414838555047142',
  wabaId: process.env.NUTRIFARM_WABA_ID || '2294321858083581',
  waTokenEnv: 'NUTRIFARM_WA_TOKEN',
  cashfree: { appIdEnv: 'NUTRIFARM_CF_APP_ID', secretEnv: 'NUTRIFARM_CF_SECRET' },
  // Filled in by Task 8 once the flows are published.
  flows: { orderFlowId: '', subscribeFlowId: '' },
  orderCodePrefix: 'NF',
  paymentLinkExpiryMinutes: 30,
  subscriptionChargeLeadDays: 2,
  messageRetentionDays: 3,
  copy: nutrifarmCopy,
};
