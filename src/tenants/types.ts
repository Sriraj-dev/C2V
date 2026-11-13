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
  noItems(): string;
  invalidPincode(raw: string): string;
  notServiceable(pincode: string): string;
  orderSummary(o: { orderCode: string; lines: CopyLine[]; total: string; deliveryDate: string }): string;
  orderConfirmed(o: { orderCode: string; deliveryDate: string }): string;
  subscriptionSummary(o: {
    lines: CopyLine[];
    perDelivery: string;
    weekdayName: string;
    firstDelivery: string;
  }): string;
  subscriptionActive(o: { firstDelivery: string }): string;
  myOrders(
    rows: { orderCode: string; status: string; deliveryDate: string; total: string }[],
    subs: { perDelivery: string; weekdayName: string; nextDelivery: string }[],
  ): string;
  invalidEmail(): string;
  genericError(): string;
  askLocation(): string;
  locationSaved(): string;
}

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
