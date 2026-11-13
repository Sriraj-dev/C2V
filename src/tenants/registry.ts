import type { TenantConfig } from './types.js';

let tenants: TenantConfig[] = [];

/** Replaces the whole registry with `list` (not additive); throws on duplicate id or waPhoneNumberId. */
export function registerTenants(list: TenantConfig[]): void {
  const ids = new Set<string>();
  const phoneIds = new Set<string>();
  for (const t of list) {
    if (ids.has(t.id)) throw new Error(`Duplicate tenant id: ${t.id}`);
    if (phoneIds.has(t.waPhoneNumberId)) {
      throw new Error(`Duplicate tenant waPhoneNumberId: ${t.waPhoneNumberId}`);
    }
    ids.add(t.id);
    phoneIds.add(t.waPhoneNumberId);
  }
  tenants = [...list];
}

export function tenantByPhoneNumberId(id: string): TenantConfig | null {
  return tenants.find((t) => t.waPhoneNumberId === id) ?? null;
}

export function tenantById(id: string): TenantConfig | null {
  return tenants.find((t) => t.id === id) ?? null;
}

export function allTenants(): TenantConfig[] {
  return [...tenants];
}

/** Test-only: clears module-level registry state. */
export function resetTenantsForTests(): void {
  tenants = [];
}
