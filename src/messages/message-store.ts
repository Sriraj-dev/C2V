import { and, eq, lt } from 'drizzle-orm';
import type { InboundMessage } from '../channels/whatsapp/parse.js';
import type { Db } from '../db/client.js';
import { messages, type MessageRow } from '../db/schema.js';

function describeInbound(msg: InboundMessage): { type: string; text: string } {
  switch (msg.kind) {
    case 'text':
      return { type: 'text', text: msg.text };
    case 'button':
      return { type: 'button', text: msg.title };
    case 'flow_submit':
      return { type: 'flow_submit', text: '[flow submitted]' };
    case 'location':
      return { type: 'location', text: `[location ${msg.lat},${msg.lng}]` };
    case 'other':
      return { type: msg.waType, text: `[${msg.waType}]` };
  }
}

/** Returns false when this WhatsApp message id was already recorded (duplicate delivery). */
export async function recordInbound(
  db: Db,
  tenantId: string,
  customerId: string,
  msg: InboundMessage,
): Promise<boolean> {
  const { type, text } = describeInbound(msg);
  const rows = await db
    .insert(messages)
    .values({
      tenantId,
      customerId,
      direction: 'in',
      waMessageId: msg.waMessageId,
      type,
      text,
      payload: msg.raw ?? {},
    })
    .onConflictDoNothing({ target: messages.waMessageId })
    .returning({ id: messages.id });
  return rows.length > 0;
}

export async function recordOutbound(
  db: Db,
  args: {
    tenantId: string;
    customerId: string;
    waMessageId: string | null;
    type: string;
    text: string | null;
    payload: unknown;
  },
): Promise<MessageRow> {
  const [row] = await db.insert(messages).values({
    tenantId: args.tenantId,
    customerId: args.customerId,
    direction: 'out',
    waMessageId: args.waMessageId,
    type: args.type,
    text: args.text,
    payload: args.payload ?? {},
  }).returning();
  return row!;
}

export async function purgeMessagesOlderThan(
  db: Db,
  tenantId: string,
  days: number,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const rows = await db
    .delete(messages)
    .where(and(eq(messages.tenantId, tenantId), lt(messages.createdAt, cutoff)))
    .returning({ id: messages.id });
  return rows.length;
}
