import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureTemplate, subscriptionTemplates } from '../../../src/channels/whatsapp/templates.js';
import type { TenantConfig } from '../../../src/tenants/types.js';

const tenant = { id: 't', wabaId: 'W1', waTokenEnv: 'TPL_TEST_TOKEN' } as TenantConfig;
const env = { GRAPH_API_VERSION: 'v23.0' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => vi.stubEnv('TPL_TEST_TOKEN', 'tok'));
afterEach(() => vi.unstubAllEnvs());

describe('subscription templates', () => {
  it('upcoming charge has two body params and one Skip quick reply', () => {
    const [up, failed] = subscriptionTemplates();
    expect(up!.name).toBe('subscription_upcoming_charge');
    expect(JSON.stringify(up!.components)).toContain('{{2}}');
    expect(up!.components[1]).toEqual({ type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Skip this delivery' }] });
    expect(failed!.name).toBe('subscription_charge_failed');
  });

  it('returns the existing status without creating', async () => {
    const f = vi.fn(async () => json({ data: [{ name: 'subscription_charge_failed', language: 'en', status: 'APPROVED' }] }));
    const r = await ensureTemplate(env, tenant, subscriptionTemplates()[1]!, f as unknown as typeof fetch);
    expect(r).toEqual({ created: false, status: 'APPROVED' });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('creates when absent', async () => {
    const f = vi.fn(async (_u: string, init?: RequestInit) =>
      init?.method === 'POST' ? json({ id: '1', status: 'PENDING' }) : json({ data: [] }),
    );
    const r = await ensureTemplate(env, tenant, subscriptionTemplates()[0]!, f as unknown as typeof fetch);
    expect(r).toEqual({ created: true, status: 'PENDING' });
    const [url, init] = f.mock.calls[1]!;
    expect(url).toBe('https://graph.facebook.com/v23.0/W1/message_templates');
    expect(JSON.parse(init!.body as string)).toMatchObject({ name: 'subscription_upcoming_charge', category: 'UTILITY', language: 'en' });
  });

  it('throws on create failure', async () => {
    const f = vi.fn(async (_u: string, init?: RequestInit) =>
      init?.method === 'POST' ? json({ error: { message: 'bad' } }, 400) : json({ data: [] }),
    );
    await expect(ensureTemplate(env, tenant, subscriptionTemplates()[0]!, f as unknown as typeof fetch)).rejects.toThrow(/HTTP 400: bad/);
  });
});
