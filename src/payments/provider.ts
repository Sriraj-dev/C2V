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
  // subscription methods are added in Task 13
}

/** Any failure talking to the payment provider. Messages must never contain credentials. */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}
