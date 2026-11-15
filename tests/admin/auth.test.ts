import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/admin/auth/password.js';
import { createVendor, setVendorActive } from '../../src/admin/auth/vendor-repo.js';
import { vendorSessions } from '../../src/db/schema.js';
import { setupAdminTest, type AdminTest } from '../helpers/admin.js';

let t: AdminTest;
beforeEach(async () => {
  t = await setupAdminTest();
});

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

async function makeVendor(t: AdminTest, username = 'asha', password = 'passw0rd-long') {
  return createVendor(t.db, { tenantId: 'test', username, passwordHash: await hashPassword(password) });
}

describe('login', () => {
  it('logs in and returns token, expiry and user', async () => {
    await makeVendor(t);
    const res = await t.app.request('/admin/auth/login', json({ username: 'asha', password: 'passw0rd-long' }));
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.token).toHaveLength(43);
    expect(b.expiresAt).toBe(new Date(t.deps.now().getTime() + 30 * 86400_000).toISOString());
    expect(b.user).toEqual({ username: 'asha', tenantId: 'test', tenantName: 'Test Tenant' });
  });

  it('trims and lowercases the username', async () => {
    await makeVendor(t);
    const res = await t.app.request('/admin/auth/login', json({ username: ' AsHa ', password: 'passw0rd-long' }));
    expect(res.status).toBe(200);
  });

  it('stores usernames lowercased and trimmed on create', async () => {
    const v = await createVendor(t.db, { tenantId: 'test', username: '  Bob ', passwordHash: 'x' });
    expect(v.username).toBe('bob');
  });

  it('gives identical 401s for wrong password, unknown user and inactive user', async () => {
    const v = await makeVendor(t);
    await makeVendor(t, 'gone');
    const gone = (await t.db.query.vendorUsers.findFirst({ where: (u, { eq }) => eq(u.username, 'gone') }))!;
    await setVendorActive(t.db, gone.id, false);
    expect(v.active).toBe(true);
    const bodies = [];
    for (const [username, password] of [['asha', 'wrong-password'], ['nobody', 'passw0rd-long'], ['gone', 'passw0rd-long']] as const) {
      const res = await t.app.request('/admin/auth/login', json({ username, password }));
      expect(res.status).toBe(401);
      bodies.push(await res.json());
    }
    expect(bodies[0].error.code).toBe('invalid_credentials');
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  it('rejects a malformed login body with 400', async () => {
    const res = await t.app.request('/admin/auth/login', json({ username: 'a' }));
    expect(res.status).toBe(400);
  });
});

describe('/admin/me', () => {
  it('returns the user for a valid session', async () => {
    const a = await t.login();
    const res = await t.app.request('/admin/me', { headers: a.headers });
    expect(res.status).toBe(200);
    expect((await res.json()).user).toEqual({ username: a.vendor.username, tenantId: 'test', tenantName: 'Test Tenant' });
  });

  it('401s without header, with a garbage token, and for an expired session (deleted)', async () => {
    for (const headers of [{} as Record<string, string>, { authorization: 'Bearer garbage' }, { authorization: 'Basic abc' }]) {
      const res = await t.app.request('/admin/me', { headers });
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe('unauthorized');
    }
    const a = await t.login();
    await t.db.update(vendorSessions).set({ expiresAt: new Date(t.deps.now().getTime() - 1000) });
    const res = await t.app.request('/admin/me', { headers: a.headers });
    expect(res.status).toBe(401);
    expect(await t.db.select().from(vendorSessions).where(eq(vendorSessions.vendorUserId, a.vendor.id))).toHaveLength(0);
  });

  it('401s for a deactivated vendor', async () => {
    const a = await t.login();
    await setVendorActive(t.db, a.vendor.id, false);
    expect((await t.app.request('/admin/me', { headers: a.headers })).status).toBe(401);
  });
});

describe('bearer scheme and unknown paths', () => {
  it('accepts a lowercase scheme and rejects an empty token', async () => {
    const a = await t.login();
    expect((await t.app.request('/admin/me', { headers: { authorization: `bearer ${a.token}` } })).status).toBe(200);
    expect((await t.app.request('/admin/me', { headers: { authorization: 'Bearer ' } })).status).toBe(401);
  });

  it('returns JSON 404 for unknown paths when authenticated, 401 otherwise', async () => {
    const a = await t.login();
    const res = await t.app.request('/admin/nope', { headers: a.headers });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
    expect((await t.app.request('/admin/nope')).status).toBe(401);
  });
});

describe('logout', () => {
  it('ends the session', async () => {
    const a = await t.login();
    const other = await t.login();
    const res = await t.app.request('/admin/auth/logout', { method: 'POST', headers: a.headers });
    expect(res.status).toBe(204);
    expect((await t.app.request('/admin/me', { headers: a.headers })).status).toBe(401);
    expect((await t.app.request('/admin/me', { headers: other.headers })).status).toBe(200);
  });
});

describe('change-password', () => {
  it('rejects a wrong current password', async () => {
    const a = await t.login();
    const res = await t.app.request(
      '/admin/auth/change-password',
      json({ currentPassword: 'nope', newPassword: 'a-brand-new-password' }, a.headers),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('invalid_credentials');
  });

  it('rejects a 9-char new password', async () => {
    const a = await t.login();
    const res = await t.app.request(
      '/admin/auth/change-password',
      json({ currentPassword: a.password, newPassword: '123456789' }, a.headers),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_error');
  });

  it('revokes all sessions, returns a fresh token, and the new password logs in', async () => {
    const a = await t.login();
    const l2 = await t.app.request('/admin/auth/login', json({ username: a.vendor.username, password: a.password }));
    const second = { authorization: `Bearer ${(await l2.json()).token}` };
    const res = await t.app.request(
      '/admin/auth/change-password',
      json({ currentPassword: a.password, newPassword: 'a-brand-new-password' }, a.headers),
    );
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.user.username).toBe(a.vendor.username);
    expect((await t.app.request('/admin/me', { headers: a.headers })).status).toBe(401);
    expect((await t.app.request('/admin/me', { headers: second })).status).toBe(401);
    expect((await t.app.request('/admin/me', { headers: { authorization: `Bearer ${b.token}` } })).status).toBe(200);
    const l = await t.app.request('/admin/auth/login', json({ username: a.vendor.username, password: 'a-brand-new-password' }));
    expect(l.status).toBe(200);
    const old = await t.app.request('/admin/auth/login', json({ username: a.vendor.username, password: a.password }));
    expect(old.status).toBe(401);
  });
});
