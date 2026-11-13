import type { TenantConfig } from '../types.js';
import { nutrifarmCopy } from './copy.js';

export const nutrifarm: TenantConfig = {
  id: 'nutrifarm',
  name: 'NutriFarm Eggs',
  waPhoneNumberId: '1414838555047142',
  wabaId: '2294321858083581',
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
