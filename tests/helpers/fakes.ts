import { pino } from 'pino';
import type { OutboundMessage } from '../../src/channels/whatsapp/builders.js';
import type { WhatsAppSender } from '../../src/channels/whatsapp/sender.js';
import type { Db } from '../../src/db/client.js';
import type { AppDeps } from '../../src/deps.js';
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
      JOBS_SECRET: 'jobs',
      LOG_LEVEL: 'silent',
    },
    now: () => new Date('2026-01-01T00:00:00Z'),
    log: pino({ level: 'silent' }),
    db: undefined as unknown as Db,
    whatsapp: new FakeWhatsAppSender(),
    payments: undefined,
    ...overrides,
  };
}
