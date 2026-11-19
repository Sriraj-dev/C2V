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
  // Flows belong to a WABA, so each number's ids come from .env (+91 number since 2026-11-19).
  // Fallback order_v1 is the old +1 555 WABA's draft (publish blocked by Meta, 139000/4233020).
  // *_DRAFT=1 sends a Flow in draft mode until it is published.
  flows: {
    orderFlowId: process.env.NUTRIFARM_ORDER_FLOW_ID || '1140197861942511',
    orderFlowDraft: process.env.NUTRIFARM_ORDER_FLOW_DRAFT === '1',
    subscribeFlowId: process.env.NUTRIFARM_SUBSCRIBE_FLOW_ID || '',
    subscribeFlowDraft: process.env.NUTRIFARM_SUBSCRIBE_FLOW_DRAFT === '1',
  },
  orderCodePrefix: 'NF',
  paymentLinkExpiryMinutes: 30,
  subscriptionChargeLeadDays: 2,
  messageRetentionDays: 3,
  copy: nutrifarmCopy,
};
