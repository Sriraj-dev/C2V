import { and, asc, count, eq, ne, sql } from 'drizzle-orm';
import { MAX_PRODUCT_SLOTS } from '../../channels/whatsapp/flows.js';
import type { Db } from '../../db/client.js';
import { products, tenants, type ProductRow } from '../../db/schema.js';
import { ApiError } from '../http.js';

export interface ProductView {
  id: string;
  sku: string;
  name: string;
  pricePaise: number;
  active: boolean;
  sortOrder: number;
  createdAt: string;
}

export interface ProductInput {
  sku: string;
  name: string;
  pricePaise: number;
  sortOrder?: number;
  active?: boolean;
}

export type ProductPatch = Partial<ProductInput>;

function toView(r: ProductRow): ProductView {
  return {
    id: r.id,
    sku: r.sku,
    name: r.name,
    pricePaise: r.pricePaise,
    active: r.active,
    sortOrder: r.sortOrder,
    createdAt: r.createdAt.toISOString(),
  };
}

const tooMany = () =>
  new ApiError(409, 'too_many_active_products', `At most ${MAX_PRODUCT_SLOTS} products can be active at once`);

export async function listProducts(db: Db, tenantId: string): Promise<ProductView[]> {
  const rows = await db
    .select()
    .from(products)
    .where(eq(products.tenantId, tenantId))
    .orderBy(asc(products.sortOrder), asc(products.createdAt), asc(products.id));
  return rows.map(toView);
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Serialises concurrent product writes for one tenant, so the active count below can't race. */
async function lockTenant(tx: Tx, tenantId: string): Promise<void> {
  await tx.execute(sql`select id from ${tenants} where ${tenants.id} = ${tenantId} for no key update`);
}

async function otherActiveCount(tx: Tx, tenantId: string, excludeId?: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(products)
    .where(
      and(
        eq(products.tenantId, tenantId),
        eq(products.active, true),
        excludeId ? ne(products.id, excludeId) : undefined,
      ),
    );
  return Number(row?.n ?? 0);
}

export async function createProduct(db: Db, tenantId: string, input: ProductInput): Promise<ProductView> {
  return db.transaction(async (tx) => {
    await lockTenant(tx, tenantId);
    const active = input.active ?? true;
    if (active && (await otherActiveCount(tx, tenantId)) >= MAX_PRODUCT_SLOTS) throw tooMany();
    let sortOrder = input.sortOrder;
    if (sortOrder === undefined) {
      const [m] = await tx
        .select({ max: sql<number>`coalesce(max(${products.sortOrder}), 0)` })
        .from(products)
        .where(eq(products.tenantId, tenantId));
      sortOrder = Number(m?.max ?? 0) + 1;
    }
    const [row] = await tx
      .insert(products)
      .values({ tenantId, sku: input.sku, name: input.name, pricePaise: input.pricePaise, sortOrder, active })
      .returning();
    return toView(row!);
  });
}

/** Null when the product doesn't exist for this tenant. */
export async function updateProduct(
  db: Db,
  tenantId: string,
  id: string,
  patch: ProductPatch,
): Promise<ProductView | null> {
  return db.transaction(async (tx) => {
    await lockTenant(tx, tenantId);
    const [current] = await tx
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.id, id)))
      .limit(1);
    if (!current) return null;
    if (patch.active === true && !current.active && (await otherActiveCount(tx, tenantId, id)) >= MAX_PRODUCT_SLOTS) {
      throw tooMany();
    }
    const [row] = await tx
      .update(products)
      .set(patch)
      .where(and(eq(products.tenantId, tenantId), eq(products.id, id)))
      .returning();
    return toView(row!);
  });
}
