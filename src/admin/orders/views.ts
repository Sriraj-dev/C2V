import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  customers,
  deliveryPartners,
  orderItems,
  orders,
  payments,
  type Address,
  type GeoLocation,
} from '../../db/schema.js';

export type OrderRow = typeof orders.$inferSelect;
export type OrderStatus = OrderRow['status'];
export type PaymentStatus = (typeof payments.$inferSelect)['status'];

export interface OrderView {
  id: string;
  orderCode: string;
  status: OrderStatus;
  source: 'one_time' | 'subscription';
  deliveryDate: string;
  pincode: string;
  address: Address;
  location: GeoLocation | null;
  mapUrl: string | null;
  subtotalPaise: number;
  deliveryFeePaise: number;
  totalPaise: number;
  customer: { id: string; profileName: string | null; phone: string | null };
  partner: { id: string; name: string; phone: string } | null;
  paymentStatus: PaymentStatus | null;
  items: { productId: string; name: string; unitPricePaise: number; quantity: number; lineTotalPaise: number }[];
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
  deliveredAt: string | null;
}

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

/** Builds OrderViews for rows already scoped to the tenant. One query each for items, customers,
 * partners and link payments regardless of row count. Preserves row order. */
export async function toOrderViews(db: Db, tenantId: string, rows: OrderRow[]): Promise<OrderView[]> {
  if (rows.length === 0) return [];
  const orderIds = rows.map((r) => r.id);
  const customerIds = uniq(rows.map((r) => r.customerId));
  const partnerIds = uniq(rows.flatMap((r) => (r.assignedPartnerId ? [r.assignedPartnerId] : [])));

  const [itemRows, customerRows, partnerRows, paymentRows] = await Promise.all([
    db.select().from(orderItems).where(inArray(orderItems.orderId, orderIds)).orderBy(asc(orderItems.position), asc(orderItems.createdAt)),
    db.select().from(customers).where(and(eq(customers.tenantId, tenantId), inArray(customers.id, customerIds))),
    partnerIds.length
      ? db
          .select()
          .from(deliveryPartners)
          .where(and(eq(deliveryPartners.tenantId, tenantId), inArray(deliveryPartners.id, partnerIds)))
      : Promise.resolve([]),
    db
      .select()
      .from(payments)
      .where(and(eq(payments.tenantId, tenantId), eq(payments.kind, 'link'), inArray(payments.orderId, orderIds))),
  ]);

  const itemsByOrder = new Map<string, OrderView['items']>();
  for (const i of itemRows) {
    const list = itemsByOrder.get(i.orderId) ?? [];
    list.push({
      productId: i.productId,
      name: i.name,
      unitPricePaise: i.unitPricePaise,
      quantity: i.quantity,
      lineTotalPaise: i.lineTotalPaise,
    });
    itemsByOrder.set(i.orderId, list);
  }
  const customerById = new Map(customerRows.map((c) => [c.id, c]));
  const partnerById = new Map(partnerRows.map((p) => [p.id, p]));
  const payByOrder = new Map<string, PaymentStatus>();
  for (const p of paymentRows) if (p.orderId) payByOrder.set(p.orderId, p.status);

  return rows.map((r) => {
    const c = customerById.get(r.customerId);
    const p = r.assignedPartnerId ? partnerById.get(r.assignedPartnerId) : undefined;
    const phone = c?.waId ?? (r.address.phone ? `91${r.address.phone}` : null);
    return {
      id: r.id,
      orderCode: r.orderCode,
      status: r.status,
      source: r.source,
      deliveryDate: r.deliveryDate,
      pincode: r.pincode,
      address: r.address,
      location: r.location ?? null,
      mapUrl: r.location ? `https://maps.google.com/?q=${r.location.lat},${r.location.lng}` : null,
      subtotalPaise: r.subtotalPaise,
      deliveryFeePaise: r.deliveryFeePaise,
      totalPaise: r.totalPaise,
      customer: { id: r.customerId, profileName: c?.profileName ?? null, phone },
      partner: p ? { id: p.id, name: p.name, phone: p.phone } : null,
      paymentStatus: payByOrder.get(r.id) ?? null,
      items: itemsByOrder.get(r.id) ?? [],
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      paidAt: r.paidAt?.toISOString() ?? null,
      deliveredAt: r.deliveredAt?.toISOString() ?? null,
    };
  });
}
