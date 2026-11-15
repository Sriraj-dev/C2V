import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { customers, messages } from '../../db/schema.js';
import { toCustomerView } from '../customers/queries.js';

export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function canReplyAt(lastInboundAt: Date | null, now: Date): boolean {
  return lastInboundAt !== null && now.getTime() - lastInboundAt.getTime() < REPLY_WINDOW_MS;
}

export interface ChatCustomer {
  id: string;
  profileName: string | null;
  phone: string | null;
}

const chatCustomer = (c: typeof customers.$inferSelect): ChatCustomer => {
  const { id, profileName, phone } = toCustomerView(c);
  return { id, profileName, phone };
};

export interface ChatListItem {
  customer: ChatCustomer;
  lastMessage: { direction: 'in' | 'out'; text: string | null; createdAt: string };
  lastInboundAt: string | null;
  canReply: boolean;
}

/** One row per customer with messages, newest conversation first. Single query; every inner scan is tenant-scoped. */
export async function listConversations(db: Db, tenantId: string, now: Date): Promise<ChatListItem[]> {
  const latest = db
    .selectDistinctOn([messages.customerId], {
      customerId: messages.customerId,
      direction: messages.direction,
      text: messages.text,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.tenantId, tenantId))
    .orderBy(messages.customerId, desc(messages.createdAt), desc(messages.id))
    .as('latest');
  const inbound = db
    .select({
      customerId: messages.customerId,
      lastInboundAt: sql<Date | null>`max(${messages.createdAt})`.mapWith(messages.createdAt).as('last_inbound_at'),
    })
    .from(messages)
    .where(and(eq(messages.tenantId, tenantId), eq(messages.direction, 'in')))
    .groupBy(messages.customerId)
    .as('inbound');

  const rows = await db
    .select({
      customer: customers,
      direction: latest.direction,
      text: latest.text,
      createdAt: latest.createdAt,
      lastInboundAt: inbound.lastInboundAt,
    })
    .from(latest)
    .innerJoin(customers, and(eq(customers.id, latest.customerId), eq(customers.tenantId, tenantId)))
    .leftJoin(inbound, eq(inbound.customerId, latest.customerId))
    .orderBy(desc(latest.createdAt), desc(customers.id));

  return rows.map((r) => ({
    customer: chatCustomer(r.customer),
    lastMessage: { direction: r.direction, text: r.text, createdAt: r.createdAt.toISOString() },
    lastInboundAt: r.lastInboundAt ? r.lastInboundAt.toISOString() : null,
    canReply: canReplyAt(r.lastInboundAt, now),
  }));
}

export async function getChatCustomer(db: Db, tenantId: string, customerId: string) {
  const [c] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)));
  return c ?? null;
}

export async function lastInboundAt(db: Db, tenantId: string, customerId: string): Promise<Date | null> {
  const [r] = await db
    .select({ at: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.tenantId, tenantId), eq(messages.customerId, customerId), eq(messages.direction, 'in')))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return r?.at ?? null;
}

/** Oldest first; null when the customer is not in this tenant. */
export async function listMessages(db: Db, tenantId: string, customerId: string, now: Date) {
  const c = await getChatCustomer(db, tenantId, customerId);
  if (!c) return null;
  const [rows, inboundAt] = await Promise.all([
    db
      .select()
      .from(messages)
      .where(and(eq(messages.tenantId, tenantId), eq(messages.customerId, customerId)))
      .orderBy(asc(messages.createdAt), asc(messages.id)),
    lastInboundAt(db, tenantId, customerId),
  ]);
  return {
    customer: chatCustomer(c),
    canReply: canReplyAt(inboundAt, now),
    items: rows.map(messageView),
  };
}

export function messageView(m: typeof messages.$inferSelect) {
  return { id: m.id, direction: m.direction, type: m.type, text: m.text, createdAt: m.createdAt.toISOString() };
}
