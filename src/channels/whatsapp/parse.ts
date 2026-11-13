import {
  changeValueSchema,
  contactSchema,
  messageSchema,
  webhookSchema,
  type WaContact,
  type WaMessage,
} from './webhook-schema.js';

export type InboundBase = {
  phoneNumberId: string;
  waMessageId: string;
  timestamp: number;
  from: { waId: string | null; bsuid: string | null; profileName: string | null };
  raw: unknown;
};

export type InboundMessage = InboundBase &
  (
    | { kind: 'text'; text: string }
    | { kind: 'button'; replyId: string; title: string }
    | { kind: 'flow_submit'; flowToken: string; response: Record<string, unknown> }
    | { kind: 'location'; lat: number; lng: number }
    | { kind: 'other'; waType: string }
  );

type Body = Record<string, unknown>;

function mapBody(m: WaMessage): { kind: 'text'; text: string } | { kind: 'button'; replyId: string; title: string } | { kind: 'flow_submit'; flowToken: string; response: Record<string, unknown> } | { kind: 'location'; lat: number; lng: number } | { kind: 'other'; waType: string } {
  const other = { kind: 'other' as const, waType: m.type };
  if (m.type === 'text' && m.text) return { kind: 'text', text: m.text.body };
  if (m.type === 'location' && m.location) {
    return { kind: 'location', lat: m.location.latitude, lng: m.location.longitude };
  }
  if (m.type === 'interactive' && m.interactive) {
    const reply = m.interactive.button_reply ?? m.interactive.list_reply;
    if (reply) return { kind: 'button', replyId: reply.id, title: reply.title };
    const json = m.interactive.nfm_reply?.response_json;
    if (json !== undefined) {
      try {
        const parsed: unknown = JSON.parse(json);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const response = parsed as Body;
          const token = response.flow_token;
          if (typeof token === 'string') return { kind: 'flow_submit', flowToken: token, response };
        }
      } catch {
        // fall through: malformed flow payloads must not break the webhook
      }
    }
  }
  return other;
}

function pickContact(
  contacts: WaContact[],
  waId: string | undefined,
  userId: string | undefined,
): WaContact | undefined {
  return (
    (waId ? contacts.find((c) => c.wa_id === waId) : undefined) ??
    (userId ? contacts.find((c) => c.user_id === userId) : undefined) ??
    contacts[0]
  );
}

export type DropInfo = { waMessageId?: string; type?: string };

export function parseWebhook(
  body: unknown,
  onDrop?: (info: DropInfo) => void,
): InboundMessage[] {
  const top = webhookSchema.safeParse(body);
  if (!top.success) return [];
  const out: InboundMessage[] = [];
  for (const entry of top.data.entry) {
    for (const change of entry.changes ?? []) {
      if (change.field !== undefined && change.field !== 'messages') continue;
      const value = changeValueSchema.safeParse(change.value);
      if (!value.success) continue;
      const contacts = (value.data.contacts ?? []).flatMap((c) => {
        const r = contactSchema.safeParse(c);
        return r.success ? [r.data] : [];
      });
      for (const rawMsg of value.data.messages ?? []) {
        const msg = messageSchema.safeParse(rawMsg);
        if (!msg.success) {
          const r = rawMsg as { id?: unknown; type?: unknown } | null;
          onDrop?.({
            waMessageId: typeof r?.id === 'string' ? r.id : undefined,
            type: typeof r?.type === 'string' ? r.type : undefined,
          });
          continue;
        }
        const m = msg.data;
        const contact = pickContact(contacts, m.from, m.from_user_id);
        const ts = Number(m.timestamp);
        out.push({
          phoneNumberId: value.data.metadata.phone_number_id,
          waMessageId: m.id,
          timestamp: Number.isFinite(ts) ? ts : 0,
          from: {
            waId: m.from ?? contact?.wa_id ?? null,
            bsuid: contact?.user_id ?? null,
            profileName: contact?.profile?.name ?? null,
          },
          raw: rawMsg,
          ...mapBody(m),
        });
      }
    }
  }
  return out;
}
