import type { TenantConfig } from '../tenants/types.js';

export type LinkStatus = 'ACTIVE' | 'PAID' | 'EXPIRED' | 'CANCELLED' | 'PARTIALLY_PAID';

export interface CreatePaymentLinkInput {
  linkId: string;
  amountPaise: number;
  purpose: string;
  /** Required by Cashfree. Indian number in any common format; the adapter normalises it. */
  customerPhone: string;
  customerName: string | null;
  expiresAt: Date;
  notifyUrl: string;
}

export interface PaymentProvider {
  createPaymentLink(t: TenantConfig, i: CreatePaymentLinkInput): Promise<{ linkId: string; url: string }>;
  getPaymentLink(t: TenantConfig, linkId: string): Promise<{ status: LinkStatus; amountPaidPaise: number }>;
  cancelPaymentLink(t: TenantConfig, linkId: string): Promise<void>;
  /** Refunds against the link's first PAID underlying order. */
  refundPaymentLink(t: TenantConfig, linkId: string, amountPaise: number, refundId: string): Promise<void>;

  // Subscriptions (ON_DEMAND UPI AutoPay). Our subscription uuid is Cashfree's subscription_id; our payment uuid is its payment_id.
  createSubscription(t: TenantConfig, i: CreateSubscriptionInput): Promise<{ cfSubscriptionId: string; sessionId: string }>;
  /**
   * Cashfree statuses passed through, e.g. INITIALIZED, ACTIVE, CUSTOMER_PAUSED, CUSTOMER_CANCELLED.
   * `sessionId` is a fresh checkout session (Cashfree issues one per fetch) while the mandate awaits approval.
   */
  getSubscription(t: TenantConfig, subscriptionId: string): Promise<SubscriptionState>;
  /** `scheduleDate` is the IST collection day, YYYY-MM-DD. Repeating a raise for the same payment id is a no-op. */
  raiseCharge(t: TenantConfig, i: { subscriptionId: string; paymentId: string; amountPaise: number; scheduleDate: string }): Promise<void>;
  /** INITIALIZED | PENDING | SUCCESS | FAILED | CANCELLED. */
  getCharge(t: TenantConfig, subscriptionId: string, paymentId: string): Promise<{ status: string }>;
  /** Throws (ProviderError) when Cashfree refuses, e.g. already collected or in progress. */
  cancelCharge(t: TenantConfig, subscriptionId: string, paymentId: string): Promise<void>;
  cancelSubscription(t: TenantConfig, subscriptionId: string): Promise<void>;
}

export interface SubscriptionState {
  status: string;
  authorizationStatus: string | null;
  sessionId: string | null;
}

export interface CreateSubscriptionInput {
  subscriptionId: string;
  maxAmountPaise: number;
  expiresAt: Date;
  customer: { name: string; email: string; phone: string };
  /** Where Cashfree's checkout returns the customer after approving. */
  returnUrl: string;
}

/** Any failure talking to the payment provider. Messages must never contain credentials. */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}
