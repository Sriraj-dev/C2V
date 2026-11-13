import type { TenantConfig } from '../../src/tenants/types.js';

/**
 * Meta's test number on NutriFarm's portfolio ("Test Messaging Account", owned by organic_nutri_farm).
 * Dev-only: used to preview bot messages on a real phone while the bot number is send-limited.
 */
export const META_TEST_NUMBER = {
  phoneNumberId: '1444268992103737', // +1 555-189-6159
  wabaId: '1170580189253457',
};

export function viaTestNumber(tenant: TenantConfig, orderFlowId = ''): TenantConfig {
  return {
    ...tenant,
    waPhoneNumberId: META_TEST_NUMBER.phoneNumberId,
    wabaId: META_TEST_NUMBER.wabaId,
    flows: { ...tenant.flows, orderFlowId },
  };
}
