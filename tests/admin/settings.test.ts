import { beforeEach, describe, expect, it } from 'vitest';
import { getTenantSettings } from '../../src/tenants/settings-repo.js';
import { setupAdminTest, type AdminLogin, type AdminTest } from '../helpers/admin.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
let t: AdminTest;
let auth: AdminLogin;

beforeEach(async () => {
  t = await setupAdminTest();
  auth = await t.login();
});

const patch = (body: unknown, headers: Record<string, string> = auth.headers) =>
  t.app.request('/admin/settings', {
    method: 'PATCH',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('/admin/settings', () => {
  it('requires auth', async () => {
    expect((await t.app.request('/admin/settings')).status).toBe(401);
    expect((await patch({ minOrderPaise: 1 }, {})).status).toBe(401);
  });

  it('GET returns the contract shape', async () => {
    const res = await t.app.request('/admin/settings', { headers: auth.headers });
    expect(res.status).toBe(200);
    const { settings } = (await res.json()) as any;
    expect(Object.keys(settings).sort()).toEqual(['deliveryFeePaise', 'minOrderPaise', 'supportPhone', 'welcomeImageUrl']);
  });

  it('partial PATCH persists and leaves other fields', async () => {
    await patch({ deliveryFeePaise: 2000 });
    const res = await patch({ minOrderPaise: 30000, welcomeImageUrl: 'https://x.example/a.jpg' });
    expect(res.status).toBe(200);
    const { settings } = (await res.json()) as any;
    expect(settings).toMatchObject({ deliveryFeePaise: 2000, minOrderPaise: 30000, welcomeImageUrl: 'https://x.example/a.jpg' });
    expect(await getTenantSettings(t.db, 'test')).toEqual(settings);
  });

  it('trims whitespace before validating', async () => {
    const res = await patch({ welcomeImageUrl: '  https://x.example/y.jpg ', supportPhone: ' 9398651343 ' });
    expect(res.status).toBe(200);
    expect(await getTenantSettings(t.db, 'test')).toMatchObject({
      welcomeImageUrl: 'https://x.example/y.jpg',
      supportPhone: '919398651343',
    });
  });

  it('normalizes supportPhone and allows null to clear', async () => {
    const res = await patch({ supportPhone: '9398651343' });
    expect(((await res.json()) as any).settings.supportPhone).toBe('919398651343');
    expect((await getTenantSettings(t.db, 'test')).supportPhone).toBe('919398651343');
    const cleared = await patch({ supportPhone: null, welcomeImageUrl: null });
    expect(((await cleared.json()) as any).settings.supportPhone).toBeNull();
  });

  it.each([
    [{ supportPhone: '12345' }],
    [{ welcomeImageUrl: 'http://x.example/a.jpg' }],
    [{ welcomeImageUrl: 'not a url' }],
    [{ deliveryFeePaise: -1 }],
    [{ minOrderPaise: 10_000_001 }],
    [{ deliveryFeePaise: 1.5 }],
    [{}],
    [{ tenantId: 'other' }],
    [{ minOrderPaise: 1, bogus: 1 }],
  ])('rejects %j with 400', async (body) => {
    const res = await patch(body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe('validation_error');
  });

  it("a test PATCH doesn't change other's row", async () => {
    const before = await getTenantSettings(t.db, 'other');
    await patch({ deliveryFeePaise: 9999, supportPhone: '9398651343' });
    expect(await getTenantSettings(t.db, 'other')).toEqual(before);
  });
});
