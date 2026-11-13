import type { Db } from '../../db/client.js';
import type { Env } from '../../config/env.js';
import type { Customer } from '../../customers/customer-repo.js';
import { recipientOf } from '../../customers/customer-repo.js';
import { recordOutbound } from '../../messages/message-store.js';
import type { AppDeps } from '../../deps.js';
import type { TenantConfig } from '../../tenants/types.js';
import type { OutboundMessage } from './builders.js';

export interface WhatsAppSender {
  send(
    tenant: TenantConfig,
    to: string,
    message: OutboundMessage,
    opts?: { replyTo?: string },
  ): Promise<{ waMessageId: string }>;
  /** Blue ticks for an inbound message; `typing` also shows the typing indicator (auto-dismissed after 25s). */
  markRead(tenant: TenantConfig, waMessageId: string, opts?: { typing?: boolean }): Promise<void>;
}

export class WhatsAppSendError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    readonly metaMessage: string,
    readonly details: string | undefined,
  ) {
    super(
      `WhatsApp API error: HTTP ${status}${code !== undefined ? ` code ${code}` : ''}: ${metaMessage}${
        details ? ` (${details})` : ''
      }`,
    );
    this.name = 'WhatsAppSendError';
  }
}

/** BSUIDs look like `IN.13491208655302741918` (ISO country, dot, id); phone ids are all digits. */
const BSUID_RE = /^[A-Z]{2}\./;

const REQUEST_TIMEOUT_MS = 10_000;

export class GraphWhatsAppSender implements WhatsAppSender {
  constructor(
    private readonly env: Pick<Env, 'GRAPH_API_VERSION'>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(
    tenant: TenantConfig,
    to: string,
    message: OutboundMessage,
    opts: { replyTo?: string } = {},
  ): Promise<{ waMessageId: string }> {
    // Envelope fields are owned by the sender; drop any the message tries to carry.
    const { messaging_product: _mp, recipient_type: _rt, to: _to, recipient: _r, context: _c, ...rest } =
      message as Record<string, unknown>;
    const body = {
      ...rest,
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      ...(BSUID_RE.test(to) ? { recipient: to } : { to }),
      ...(opts.replyTo ? { context: { message_id: opts.replyTo } } : {}),
    };
    const json = (await this.post(tenant, body)) as { messages?: { id?: string }[] };
    const id = json.messages?.[0]?.id;
    if (!id) throw new WhatsAppSendError(200, undefined, 'response had no message id', undefined);
    return { waMessageId: id };
  }

  async markRead(tenant: TenantConfig, waMessageId: string, opts: { typing?: boolean } = {}): Promise<void> {
    await this.post(tenant, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: waMessageId,
      ...(opts.typing ? { typing_indicator: { type: 'text' } } : {}),
    });
  }

  private async post(tenant: TenantConfig, body: unknown): Promise<unknown> {
    const token = process.env[tenant.waTokenEnv];
    if (!token) throw new Error(`Missing WhatsApp token: env var ${tenant.waTokenEnv} is not set`);
    const url = `https://graph.facebook.com/${this.env.GRAPH_API_VERSION}/${tenant.waPhoneNumberId}/messages`;
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      text = await res.text();
    } catch (e) {
      const name = (e as { name?: string })?.name;
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      throw new WhatsAppSendError(0, undefined, timedOut ? 'timeout' : 'network error', undefined);
    }
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: number; message?: string; error_data?: { details?: string } } } | undefined)
        ?.error;
      throw new WhatsAppSendError(
        res.status,
        err?.code,
        err?.message ?? (text.slice(0, 200) || res.statusText),
        err?.error_data?.details,
      );
    }
    return json ?? {};
  }
}

/** Sends to the customer and logs an outbound row; on failure logs a row with no wa id, then rethrows. */
export async function sendAndLog(
  deps: Pick<AppDeps, 'whatsapp'> & { db: Db },
  tenant: TenantConfig,
  customer: Customer,
  message: OutboundMessage,
  summaryText: string,
  opts?: { replyTo?: string },
): Promise<void> {
  const base = {
    tenantId: tenant.id,
    customerId: customer.id,
    type: message.type,
    text: summaryText,
    payload: message,
  };
  let waMessageId: string;
  try {
    ({ waMessageId } = await deps.whatsapp.send(tenant, recipientOf(customer), message, opts));
  } catch (e) {
    try {
      await recordOutbound(deps.db, { ...base, waMessageId: null });
    } catch {
      // Logging the failure must not mask the original send error.
    }
    throw e;
  }
  await recordOutbound(deps.db, { ...base, waMessageId });
}
