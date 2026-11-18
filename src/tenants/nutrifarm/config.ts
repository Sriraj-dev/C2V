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
  // order_v1 created 2026-11-13 on WABA 2294321858083581; still DRAFT (publish blocked by Meta, 139000/4233020).
  // Subscribe Flow: set in .env while it is a draft on the test number; production id added when published.
  flows: {
    orderFlowId: '1140197861942511',
    subscribeFlowId: process.env.NUTRIFARM_SUBSCRIBE_FLOW_ID || '',
    subscribeFlowDraft: process.env.NUTRIFARM_SUBSCRIBE_FLOW_DRAFT === '1',
  },
  orderCodePrefix: 'NF',
  paymentLinkExpiryMinutes: 30,
  subscriptionChargeLeadDays: 2,
  messageRetentionDays: 3,
  copy: nutrifarmCopy,
};
