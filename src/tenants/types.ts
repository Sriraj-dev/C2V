export interface CopyLine {
  name: string;
  qty: number;
  /** Already formatted, e.g. '₹180'. */
  lineTotal: string;
}

/** All customer-facing text for a tenant. Money and dates are passed in already formatted. */
export interface TenantCopy {
  welcome(name: string | null): string;
  help(): string;
  menuPrompt(): string;
  menuRows(): { order: string; subscribe: string; myOrders: string; help: string };
  orderFlowIntro(): string;
  subscribeFlowIntro(): string;
  /** Reply to the Subscribe menu item while subscriptions are not available. */
  subscribeComingSoon(): string;
  noItems(): string;
  invalidPincode(raw: string): string;
  notServiceable(pincode: string): string;
  invalidAddress(): string;
  invalidPhone(): string;
  /** `min` already formatted, e.g. '₹90'. */
  belowMinimum(min: string): string;
  orderSummary(o: { orderCode: string; lines: CopyLine[]; total: string; deliveryDate: string }): string;
  orderConfirmed(o: { orderCode: string; deliveryDate: string }): string;
  linkExpired(o: { orderCode: string }): string;
  /** `frequency` from `frequencyLabel`, e.g. 'every 2 weeks on Wednesday'. */
  subscriptionSummary(o: {
    lines: CopyLine[];
    perDelivery: string;
    frequency: string;
    firstDelivery: string;
  }): string;
  subscriptionActive(o: { firstDelivery: string; frequency: string }): string;
  /** The customer did not approve the AutoPay mandate (failed or link expired). */
  subscriptionAuthFailed(): string;
  /** Subscription cancelled (by the vendor or from the customer's UPI app). */
  subscriptionCancelled(): string;
  skipDone(o: { date: string; next: string }): string;
  /** Skip tapped after the charge was collected. `supportPhone` null → point to Help. */
  skipAlreadyPaid(o: { orderCode: string; supportPhone: string | null }): string;
  /** Skip tapped while the bank is processing the charge. */
  skipProcessing(o: { supportPhone: string | null }): string;
  myOrders(
    rows: { orderCode: string; status: string; deliveryDate: string; total: string }[],
    subs: { perDelivery: string; frequency: string; nextDelivery: string }[],
  ): string;
  invalidEmail(): string;
  genericError(): string;
  askLocation(): string;
  locationSaved(): string;
  /** Appended to My Orders when an order is still awaiting payment. */
  pendingPaymentNote(): string;
}

export interface TenantConfig {
  id: string;
  name: string;
  waPhoneNumberId: string;
  wabaId: string;
  /** Name of the env var holding this tenant's WhatsApp access token. */
  waTokenEnv: string;
  cashfree: { appIdEnv: string; secretEnv: string };
  /** `subscribeFlowDraft` sends the subscribe Flow in draft mode (dev testing before it is published). */
  flows: { orderFlowId: string; subscribeFlowId: string; subscribeFlowDraft?: boolean };
  orderCodePrefix: string;
  paymentLinkExpiryMinutes: number;
  subscriptionChargeLeadDays: number;
  messageRetentionDays: number;
  copy: TenantCopy;
}
