/** Defined in Task 6; `unknown` until then. */
export type TenantCopy = unknown;

export interface TenantConfig {
  id: string;
  name: string;
  waPhoneNumberId: string;
  wabaId: string;
  /** Name of the env var holding this tenant's WhatsApp access token. */
  waTokenEnv: string;
  cashfree: { appIdEnv: string; secretEnv: string };
  flows: { orderFlowId: string; subscribeFlowId: string };
  orderCodePrefix: string;
  paymentLinkExpiryMinutes: number;
  subscriptionChargeLeadDays: number;
  messageRetentionDays: number;
  copy: TenantCopy;
}
