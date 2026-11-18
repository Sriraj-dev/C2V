import type { Env } from '../../config/env.js';
import type { Product } from '../../catalog/catalog-repo.js';
import type { Address } from '../../customers/customer-repo.js';
import { formatPaise } from '../../domain/money.js';
import type { TenantConfig } from '../../tenants/types.js';

export const MAX_PRODUCT_SLOTS = 8;
const FLOW_JSON_VERSION = '7.3';
const REQUEST_TIMEOUT_MS = 10_000;

const slots = Array.from({ length: MAX_PRODUCT_SLOTS }, (_, i) => i + 1);
const PREFILL_KEYS = ['name', 'line1', 'landmark', 'pincode', 'phone'] as const;
const PREFILL_EXAMPLES: Record<(typeof PREFILL_KEYS)[number], string> = {
  name: 'Example',
  line1: 'Example',
  landmark: 'Example',
  pincode: '560034',
  phone: '9876543210',
};
const QTY_OPTIONS = Array.from({ length: 11 }, (_, i) => ({ id: String(i), title: String(i) }));

export const SUBSCRIPTION_FREQUENCIES = [
  { id: 'weekly', title: 'Every week' },
  { id: 'biweekly', title: 'Every 2 weeks' },
  { id: 'monthly', title: 'Every 4 weeks' },
] as const;

/** Flow JSON is product-independent: labels/visibility arrive in the message's flow_action_payload.data. */
export function buildOrderFlowJson(): Record<string, unknown> {
  return buildFlowJson('order');
}

/**
 * Subscribe Flow: PRODUCTS (the order Flow's product screen) → FREQUENCY (required choice) → DETAILS
 * (address fields and a required email; Cashfree needs it for the mandate).
 */
export function buildSubscribeFlowJson(): Record<string, unknown> {
  return buildFlowJson('subscribe');
}

function buildFlowJson(kind: 'order' | 'subscribe'): Record<string, unknown> {
  const sub = kind === 'subscribe';
  const prefillData = Object.fromEntries(
    PREFILL_KEYS.map((k) => [`prefill_${k}`, { type: 'string', __example__: PREFILL_EXAMPLES[k] }]),
  );
  const emailData = sub ? { prefill_email: { type: 'string', __example__: 'name@example.com' } } : {};
  // BSUID-only customers have no phone on file; the Flow asks them for one (Cashfree links need it).
  const askPhoneData = { ask_phone: { type: 'boolean', __example__: false } };
  const qtyData = Object.fromEntries(slots.map((i) => [`qty_${i}`, { type: 'string', __example__: '0' }]));

  const productsScreen = {
    id: 'PRODUCTS',
    title: 'Choose your eggs',
    data: {
      ...Object.fromEntries(
        slots.flatMap((i) => [
          [`label_${i}`, { type: 'string', __example__: 'White Eggs – 6 pack — ₹90' }],
          [`show_${i}`, { type: 'boolean', __example__: true }],
        ]),
      ),
      ...prefillData,
      ...emailData,
      ...askPhoneData,
    },
    layout: {
      type: 'SingleColumnLayout',
      children: [
        { type: 'TextBody', text: sub ? 'Pick how many packs you want in each delivery.' : 'Pick how many packs of each you want.' },
        // Meta caps the Dropdown label at 20 characters, so the full product label ("name — price")
        // is shown in a TextBody and the Dropdown gets a short static label.
        ...slots.flatMap((i) => [
          { type: 'TextBody', text: `\${data.label_${i}}`, visible: `\${data.show_${i}}` },
          {
            type: 'Dropdown',
            name: `qty_${i}`,
            label: 'Quantity',
            required: false,
            'init-value': '0',
            visible: `\${data.show_${i}}`,
            'data-source': QTY_OPTIONS,
          },
        ]),
        {
          type: 'Footer',
          label: 'Next',
          'on-click-action': {
            name: 'navigate',
            next: { type: 'screen', name: sub ? 'FREQUENCY' : 'ADDRESS' },
            payload: {
              ...Object.fromEntries(slots.map((i) => [`qty_${i}`, `\${form.qty_${i}}`])),
              ...Object.fromEntries(PREFILL_KEYS.map((k) => [`prefill_${k}`, `\${data.prefill_${k}}`])),
              ...(sub ? { prefill_email: '${data.prefill_email}' } : {}),
              ask_phone: '${data.ask_phone}',
            },
          },
        },
      ],
    },
  };

  // Subscribe only: page 2 asks how often; everything from page 1 is carried through to DETAILS.
  const frequencyScreen = {
    id: 'FREQUENCY',
    title: 'How often?',
    data: { ...qtyData, ...prefillData, ...emailData, ...askPhoneData },
    layout: {
      type: 'SingleColumnLayout',
      children: [
        { type: 'TextBody', text: 'How often should we deliver? We message you 2 days before each delivery, and you can skip any one.' },
        {
          type: 'RadioButtonsGroup',
          name: 'frequency',
          label: 'Delivery frequency',
          required: true,
          'init-value': 'weekly',
          'data-source': SUBSCRIPTION_FREQUENCIES.map((f) => ({ ...f })),
        },
        {
          type: 'Footer',
          label: 'Next',
          'on-click-action': {
            name: 'navigate',
            next: { type: 'screen', name: 'DETAILS' },
            payload: {
              ...Object.fromEntries(slots.map((i) => [`qty_${i}`, `\${data.qty_${i}}`])),
              ...Object.fromEntries(PREFILL_KEYS.map((k) => [`prefill_${k}`, `\${data.prefill_${k}}`])),
              prefill_email: '${data.prefill_email}',
              ask_phone: '${data.ask_phone}',
              frequency: '${form.frequency}',
            },
          },
        },
      ],
    },
  };

  const addressScreen = {
    id: sub ? 'DETAILS' : 'ADDRESS',
    title: 'Delivery address',
    terminal: true,
    data: {
      ...qtyData,
      ...prefillData,
      ...emailData,
      ...askPhoneData,
      ...(sub ? { frequency: { type: 'string', __example__: 'weekly' } } : {}),
    },
    layout: {
      type: 'SingleColumnLayout',
      children: [
        {
          type: 'TextInput',
          name: 'name',
          label: 'Your name',
          'input-type': 'text',
          required: true,
          'init-value': '${data.prefill_name}',
        },
        {
          type: 'TextArea',
          name: 'line1',
          label: 'Address',
          'helper-text': 'House no, street, area',
          required: true,
          'init-value': '${data.prefill_line1}',
        },
        {
          type: 'TextInput',
          name: 'landmark',
          label: 'Landmark (optional)',
          'input-type': 'text',
          required: false,
          'init-value': '${data.prefill_landmark}',
        },
        {
          type: 'TextInput',
          name: 'pincode',
          label: 'Pincode',
          'input-type': 'number',
          required: true,
          'init-value': '${data.prefill_pincode}',
        },
        {
          type: 'TextInput',
          name: 'phone',
          label: 'Mobile number',
          'input-type': 'phone',
          'helper-text': '10-digit number for payment & delivery',
          required: false,
          'init-value': '${data.prefill_phone}',
          visible: '${data.ask_phone}',
        },
        ...(sub
          ? [
              {
                type: 'TextInput',
                name: 'email',
                label: 'Email',
                'input-type': 'email',
                'helper-text': 'For your AutoPay mandate receipts',
                required: true,
                'init-value': '${data.prefill_email}',
              },
            ]
          : []),
        {
          type: 'Footer',
          label: 'Continue',
          // Hidden slots may submit "0", "" or nothing: the submit handler must use only slotMap keys and treat a missing/empty qty as 0.
          'on-click-action': {
            name: 'complete',
            payload: {
              ...Object.fromEntries(slots.map((i) => [`qty_${i}`, `\${data.qty_${i}}`])),
              name: '${form.name}',
              line1: '${form.line1}',
              landmark: '${form.landmark}',
              pincode: '${form.pincode}',
              phone: '${form.phone}',
              ...(sub ? { frequency: '${data.frequency}', email: '${form.email}' } : {}),
            },
          },
        },
      ],
    },
  };

  return { version: FLOW_JSON_VERSION, screens: sub ? [productsScreen, frequencyScreen, addressScreen] : [productsScreen, addressScreen] };
}

/** Product k (by sort order) goes to slot k+1; slotMap records slot -> productId for the submit handler. */
export function orderFlowData(
  products: Product[],
  prefill: Address | null,
  opts: { askPhone?: boolean } = {},
): { data: Record<string, string | boolean>; slotMap: Record<string, string> } {
  if (products.length > MAX_PRODUCT_SLOTS)
    throw new Error(`Order flow supports at most ${MAX_PRODUCT_SLOTS} active products (got ${products.length})`);
  const data: Record<string, string | boolean> = {};
  const slotMap: Record<string, string> = {};
  for (const i of slots) {
    const p = products[i - 1];
    if (p) {
      data[`label_${i}`] = `${p.name} — ${formatPaise(p.pricePaise)}`;
      data[`show_${i}`] = true;
      slotMap[String(i)] = p.id;
    } else {
      // Dropdown label is required, so hidden slots carry a placeholder.
      data[`label_${i}`] = '-';
      data[`show_${i}`] = false;
    }
  }
  data.prefill_name = prefill?.name ?? '';
  data.prefill_line1 = prefill?.line1 ?? '';
  data.prefill_landmark = prefill?.landmark ?? '';
  data.prefill_pincode = prefill?.pincode ?? '';
  data.prefill_phone = prefill?.phone ?? '';
  data.ask_phone = opts.askPhone ?? false;
  return { data, slotMap };
}

export function encodeOrderFlowToken(customerId: string, slotMap: Record<string, string>): string {
  return encodeFlowToken('order', customerId, slotMap);
}

export function decodeOrderFlowToken(token: string): { customerId: string; slotMap: Record<string, string> } | null {
  return decodeFlowToken('order', token);
}

export function encodeSubscribeFlowToken(customerId: string, slotMap: Record<string, string>): string {
  return encodeFlowToken('subscribe', customerId, slotMap);
}

export function decodeSubscribeFlowToken(token: string): { customerId: string; slotMap: Record<string, string> } | null {
  return decodeFlowToken('subscribe', token);
}

function encodeFlowToken(prefix: 'order' | 'subscribe', customerId: string, slotMap: Record<string, string>): string {
  return `${prefix}:${customerId}:${Buffer.from(JSON.stringify(slotMap), 'utf8').toString('base64url')}`;
}

function decodeFlowToken(
  prefix: 'order' | 'subscribe',
  token: string,
): { customerId: string; slotMap: Record<string, string> } | null {
  const m = new RegExp(`^${prefix}:([^:]+):([A-Za-z0-9_-]*)$`).exec(token);
  if (!m) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(m[2]!, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const slotMap: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (!/^[1-8]$/.test(k) || typeof v !== 'string') return null;
      slotMap[k] = v;
    }
    return { customerId: m[1]!, slotMap };
  } catch {
    return null;
  }
}

export class FlowPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlowPublishError';
  }
}

export function tokenFor(tenant: TenantConfig): string {
  const token = process.env[tenant.waTokenEnv];
  if (!token) throw new FlowPublishError(`Missing WhatsApp token: env var ${tenant.waTokenEnv} is not set`);
  return token;
}

export async function graph(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  let res: Response;
  let text: string;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    text = await res.text();
  } catch (e) {
    const name = (e as { name?: string })?.name;
    throw new FlowPublishError(name === 'TimeoutError' || name === 'AbortError' ? 'Graph request timed out' : 'Graph network error');
  }
  let json: Record<string, unknown> = {};
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    json =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { raw: text.slice(0, 200) };
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { ok: res.ok, status: res.status, json };
}

/** Creates and publishes a Flow on the tenant's WABA; returns the flow id. Throws with validation errors if any. */
export function publishFlow(
  env: Pick<Env, 'GRAPH_API_VERSION'>,
  tenant: TenantConfig,
  name: string,
  flowJson: object,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  return createFlow(env, tenant, name, flowJson, { publish: true }, fetchImpl);
}

/** Creates a Flow on the tenant's WABA (published, or left as DRAFT for testing); returns the flow id. */
export async function createFlow(
  env: Pick<Env, 'GRAPH_API_VERSION'>,
  tenant: TenantConfig,
  name: string,
  flowJson: object,
  opts: { publish: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const url = `https://graph.facebook.com/${env.GRAPH_API_VERSION}/${tenant.wabaId}/flows`;
  const { ok, status, json } = await graph(
    url,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenFor(tenant)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        categories: ['SHOPPING'],
        flow_json: JSON.stringify(flowJson),
        publish: opts.publish,
      }),
    },
    fetchImpl,
  );
  const errors = json.validation_errors;
  if (Array.isArray(errors) && errors.length > 0) {
    throw new FlowPublishError(`Flow validation failed (draft flow id ${typeof json.id === 'string' ? json.id : 'unknown'}):\n${JSON.stringify(errors, null, 2)}`);
  }
  if (!ok) {
    const err = json.error as { message?: string; code?: number; error_user_msg?: string } | undefined;
    throw new FlowPublishError(
      `Flow publish failed: HTTP ${status}${err?.code !== undefined ? ` code ${err.code}` : ''}: ${
        err?.error_user_msg ?? err?.message ?? 'unknown error'
      }`,
    );
  }
  if (typeof json.id !== 'string' || !json.id) throw new FlowPublishError('Flow publish response had no id');
  return json.id;
}

export async function getFlowPreviewUrl(
  env: Pick<Env, 'GRAPH_API_VERSION'>,
  tenant: TenantConfig,
  flowId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const url = `https://graph.facebook.com/${env.GRAPH_API_VERSION}/${encodeURIComponent(flowId)}?fields=${encodeURIComponent('preview.invalidate(false)')}`;
  const { ok, status, json } = await graph(
    url,
    { method: 'GET', headers: { Authorization: `Bearer ${tokenFor(tenant)}` } },
    fetchImpl,
  );
  const preview = (json.preview as { preview_url?: string } | undefined)?.preview_url;
  if (!ok || !preview) throw new FlowPublishError(`Could not get flow preview url (HTTP ${status})`);
  return preview;
}

/** Publishes an existing DRAFT Flow (e.g. one whose create-and-publish was refused). */
export async function publishExistingFlow(
  env: Pick<Env, 'GRAPH_API_VERSION'>,
  tenant: TenantConfig,
  flowId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = `https://graph.facebook.com/${env.GRAPH_API_VERSION}/${encodeURIComponent(flowId)}/publish`;
  const { ok, status, json } = await graph(
    url,
    { method: 'POST', headers: { Authorization: `Bearer ${tokenFor(tenant)}` } },
    fetchImpl,
  );
  if (!ok || json.success !== true) {
    const err = json.error as { message?: string; code?: number; error_user_msg?: string } | undefined;
    throw new FlowPublishError(
      `Flow ${flowId} publish failed: HTTP ${status}${err?.code !== undefined ? ` code ${err.code}` : ''}: ${
        err?.error_user_msg ?? err?.message ?? 'unknown error'
      }`,
    );
  }
}

/** Uploads `flowJson` to an existing DRAFT Flow (not published). Throws FlowPublishError on any failure or validation error. */
export async function updateFlowJson(
  env: Pick<Env, 'GRAPH_API_VERSION'>,
  tenant: TenantConfig,
  flowId: string,
  flowJson: object,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = `https://graph.facebook.com/${env.GRAPH_API_VERSION}/${encodeURIComponent(flowId)}/assets`;
  const form = new FormData();
  form.append('name', 'flow.json');
  form.append('asset_type', 'FLOW_JSON');
  form.append('file', new Blob([JSON.stringify(flowJson)], { type: 'application/json' }), 'flow.json');
  // No Content-Type header: fetch sets the multipart boundary itself.
  const { ok, status, json } = await graph(
    url,
    { method: 'POST', headers: { Authorization: `Bearer ${tokenFor(tenant)}` }, body: form },
    fetchImpl,
  );
  const errors = json.validation_errors;
  if (Array.isArray(errors) && errors.length > 0) {
    throw new FlowPublishError(`Flow validation failed (flow id ${flowId}):\n${JSON.stringify(errors, null, 2)}`);
  }
  if (!ok) {
    const err = json.error as { message?: string; code?: number; error_user_msg?: string } | undefined;
    throw new FlowPublishError(
      `Flow ${flowId} update failed: HTTP ${status}${err?.code !== undefined ? ` code ${err.code}` : ''}: ${
        err?.error_user_msg ?? err?.message ?? 'unknown error'
      }`,
    );
  }
}
