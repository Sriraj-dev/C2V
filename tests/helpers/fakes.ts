import { pino } from 'pino';
import type { OutboundMessage } from '../../src/channels/whatsapp/builders.js';
import type { WhatsAppSender } from '../../src/channels/whatsapp/sender.js';
import type { Db } from '../../src/db/client.js';
import type { AppDeps } from '../../src/deps.js';
import type { CreatePaymentLinkInput, CreateSubscriptionInput, LinkStatus, PaymentProvider } from '../../src/payments/provider.js';
import type { TenantConfig } from '../../src/tenants/types.js';

export class FakeWhatsAppSender implements WhatsAppSender {
  sent: { to: string; message: OutboundMessage; replyTo?: string }[] = [];
  reads: { waMessageId: string; typing: boolean }[] = [];
  /** When set, the next send() rejects with this error (then clears). */
  failNext: Error | undefined;
  private n = 0;

  async send(
    _tenant: TenantConfig,
    to: string,
    message: OutboundMessage,
    opts?: { replyTo?: string },
  ): Promise<{ waMessageId: string }> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = undefined;
      throw e;
    }
    this.sent.push({ to, message, replyTo: opts?.replyTo });
    return { waMessageId: `wamid.fake.${++this.n}` };
  }

  async markRead(_tenant: TenantConfig, waMessageId: string, opts?: { typing?: boolean }): Promise<void> {
    this.reads.push({ waMessageId, typing: opts?.typing ?? false });
  }
}

export function testDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    env: {
      NODE_ENV: 'test',
      PORT: 8080,
      DATABASE_URL: 'postgres://test',
      META_APP_SECRET: 'secret',
      META_VERIFY_TOKEN: 'verify',
      GRAPH_API_VERSION: 'v99.0',
      CASHFREE_ENV: 'sandbox',
      PUBLIC_BASE_URL: 'https://bot.test',
      LOG_LEVEL: 'silent',
    },
    now: () => new Date('2026-01-01T00:00:00Z'),
    log: pino({ level: 'silent' }),
    db: undefined as unknown as Db,
    whatsapp: new FakeWhatsAppSender(),
    payments: new FakePaymentProvider(),
    ...overrides,
  };
}

export type FakePaymentCall =
  | { method: 'createPaymentLink'; input: CreatePaymentLinkInput }
  | { method: 'getPaymentLink'; linkId: string }
  | { method: 'cancelPaymentLink'; linkId: string }
  | { method: 'refundPaymentLink'; linkId: string; amountPaise: number; refundId: string }
  | { method: 'createSubscription'; input: CreateSubscriptionInput }
  | { method: 'getSubscription'; subscriptionId: string }
  | { method: 'raiseCharge'; input: { subscriptionId: string; paymentId: string; amountPaise: number; scheduleDate: string } }
  | { method: 'getCharge'; subscriptionId: string; paymentId: string }
  | { method: 'cancelCharge'; subscriptionId: string; paymentId: string }
  | { method: 'cancelSubscription'; subscriptionId: string };

export class FakePaymentProvider implements PaymentProvider {
  calls: FakePaymentCall[] = [];
  /** Per-link state returned by getPaymentLink; unset links are ACTIVE with nothing paid. */
  links = new Map<string, { status: LinkStatus; amountPaidPaise: number }>();
  /** When set, the next call rejects with this error (then clears). */
  failNext: Error | undefined;

  setLink(linkId: string, status: LinkStatus, amountPaidPaise = 0): void {
    this.links.set(linkId, { status, amountPaidPaise });
  }

  private maybeFail(): void {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = undefined;
      throw e;
    }
  }

  async createPaymentLink(_t: TenantConfig, input: CreatePaymentLinkInput): Promise<{ linkId: string; url: string }> {
    this.calls.push({ method: 'createPaymentLink', input });
    this.maybeFail();
    if (!this.links.has(input.linkId)) this.setLink(input.linkId, 'ACTIVE', 0);
    return { linkId: input.linkId, url: `https://payments.test/links/${input.linkId}` };
  }

  async getPaymentLink(_t: TenantConfig, linkId: string): Promise<{ status: LinkStatus; amountPaidPaise: number }> {
    this.calls.push({ method: 'getPaymentLink', linkId });
    this.maybeFail();
    return this.links.get(linkId) ?? { status: 'ACTIVE', amountPaidPaise: 0 };
  }

  async cancelPaymentLink(_t: TenantConfig, linkId: string): Promise<void> {
    this.calls.push({ method: 'cancelPaymentLink', linkId });
    this.maybeFail();
    this.setLink(linkId, 'CANCELLED', this.links.get(linkId)?.amountPaidPaise ?? 0);
  }

  async refundPaymentLink(_t: TenantConfig, linkId: string, amountPaise: number, refundId: string): Promise<void> {
    this.calls.push({ method: 'refundPaymentLink', linkId, amountPaise, refundId });
    this.maybeFail();
  }

  /** Cashfree subscription state by subscription id; unset → INITIALIZED. */
  subscriptions = new Map<string, { status: string; authorizationStatus: string | null }>();
  /** Cashfree charge status by payment id; raised charges start INITIALIZED. */
  charges = new Map<string, string>();
  /** When set, cancelCharge rejects with this error (Cashfree refused) and leaves the charge as is. */
  refuseCancelCharge: Error | undefined;

  setSubscription(subscriptionId: string, status: string, authorizationStatus: string | null = null): void {
    this.subscriptions.set(subscriptionId, { status, authorizationStatus });
  }

  async createSubscription(_t: TenantConfig, input: CreateSubscriptionInput): Promise<{ cfSubscriptionId: string; sessionId: string }> {
    this.calls.push({ method: 'createSubscription', input });
    this.maybeFail();
    if (!this.subscriptions.has(input.subscriptionId)) this.setSubscription(input.subscriptionId, 'INITIALIZED');
    return { cfSubscriptionId: `cf-${input.subscriptionId}`, sessionId: `sess-${input.subscriptionId}` };
  }

  async getSubscription(_t: TenantConfig, subscriptionId: string): Promise<{ status: string; authorizationStatus: string | null }> {
    this.calls.push({ method: 'getSubscription', subscriptionId });
    this.maybeFail();
    return this.subscriptions.get(subscriptionId) ?? { status: 'INITIALIZED', authorizationStatus: null };
  }

  async raiseCharge(_t: TenantConfig, input: { subscriptionId: string; paymentId: string; amountPaise: number; scheduleDate: string }): Promise<void> {
    this.calls.push({ method: 'raiseCharge', input });
    this.maybeFail();
    if (!this.charges.has(input.paymentId)) this.charges.set(input.paymentId, 'INITIALIZED');
  }

  async getCharge(_t: TenantConfig, subscriptionId: string, paymentId: string): Promise<{ status: string }> {
    this.calls.push({ method: 'getCharge', subscriptionId, paymentId });
    this.maybeFail();
    return { status: this.charges.get(paymentId) ?? 'INITIALIZED' };
  }

  async cancelCharge(_t: TenantConfig, subscriptionId: string, paymentId: string): Promise<void> {
    this.calls.push({ method: 'cancelCharge', subscriptionId, paymentId });
    this.maybeFail();
    if (this.refuseCancelCharge) throw this.refuseCancelCharge;
    this.charges.set(paymentId, 'CANCELLED');
  }

  async cancelSubscription(_t: TenantConfig, subscriptionId: string): Promise<void> {
    this.calls.push({ method: 'cancelSubscription', subscriptionId });
    this.maybeFail();
    const cur = this.subscriptions.get(subscriptionId);
    this.setSubscription(subscriptionId, 'CANCELLED', cur?.authorizationStatus ?? null);
  }
}
