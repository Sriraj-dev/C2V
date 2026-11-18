import type { Env } from '../../config/env.js';
import type { TenantConfig } from '../../tenants/types.js';
import { FlowPublishError, graph, tokenFor } from './flows.js';

export const UPCOMING_CHARGE_TEMPLATE = 'subscription_upcoming_charge';
export const CHARGE_FAILED_TEMPLATE = 'subscription_charge_failed';
export const SUBSCRIPTION_TEMPLATE_LANG = 'en';

export interface TemplateDef {
  name: string;
  language: string;
  category: 'UTILITY';
  components: Record<string, unknown>[];
}

/** Subscription templates, wording from spec §10. */
export function subscriptionTemplates(): TemplateDef[] {
  return [
    {
      name: UPCOMING_CHARGE_TEMPLATE,
      language: SUBSCRIPTION_TEMPLATE_LANG,
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text: "Your egg subscription: ₹{{1}} will be collected tomorrow for your delivery on {{2}}. Won't be available? Tap Skip this delivery below — we won't charge or deliver this time.",
          example: { body_text: [['258', 'Wed, 25 Nov']] },
        },
        { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Skip this delivery' }] },
      ],
    },
    {
      name: CHARGE_FAILED_TEMPLATE,
      language: SUBSCRIPTION_TEMPLATE_LANG,
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text: "We couldn't collect payment for your egg delivery on {{1}}. This week's delivery is skipped. Your subscription stays active.",
          example: { body_text: [['Wed, 25 Nov']] },
        },
      ],
    },
  ];
}

/** Creates the template on the tenant's WABA unless one with that name and language exists; returns its status. */
export async function ensureTemplate(
  env: Pick<Env, 'GRAPH_API_VERSION'>,
  tenant: TenantConfig,
  def: TemplateDef,
  fetchImpl: typeof fetch = fetch,
): Promise<{ created: boolean; status: string }> {
  const base = `https://graph.facebook.com/${env.GRAPH_API_VERSION}/${tenant.wabaId}/message_templates`;
  const headers = { Authorization: `Bearer ${tokenFor(tenant)}`, 'Content-Type': 'application/json' };
  const list = await graph(`${base}?name=${encodeURIComponent(def.name)}&fields=name,language,status`, { headers }, fetchImpl);
  if (!list.ok) throw new FlowPublishError(`Template lookup failed: HTTP ${list.status}`);
  const rows = Array.isArray(list.json.data) ? (list.json.data as { name?: string; language?: string; status?: string }[]) : [];
  const found = rows.find((r) => r.name === def.name && r.language === def.language);
  if (found) return { created: false, status: found.status ?? 'UNKNOWN' };
  const res = await graph(base, { method: 'POST', headers, body: JSON.stringify(def) }, fetchImpl);
  if (!res.ok) {
    const err = res.json.error as { message?: string; error_user_msg?: string } | undefined;
    throw new FlowPublishError(`Template create failed: HTTP ${res.status}: ${err?.error_user_msg ?? err?.message ?? 'unknown error'}`);
  }
  return { created: true, status: typeof res.json.status === 'string' ? res.json.status : 'PENDING' };
}
