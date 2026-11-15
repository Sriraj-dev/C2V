import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../../deps.js';
import { tenantById } from '../../tenants/registry.js';
import { ApiError, parseBody, type AdminEnv } from '../http.js';
import { hashPassword, verifyPassword } from './password.js';
import { requireVendor } from './middleware.js';
import { createSession, deleteSession, deleteVendorSessions } from './session-repo.js';
import { findVendorByUsername, setVendorPassword } from './vendor-repo.js';

const loginBody = z.object({ username: z.string().min(1).max(200), password: z.string().min(1).max(1000) });
const changeBody = z.object({
  currentPassword: z.string().min(1).max(1000),
  newPassword: z.string().min(10).max(128),
});

// Verified against when the user is unknown, so response time doesn't reveal which usernames exist.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword('dummy-password-for-timing'));

const invalidCredentials = () => new ApiError(401, 'invalid_credentials', 'Invalid username or password');

const userView = (v: { username: string }, tenant: { id: string; name: string }) => ({
  username: v.username,
  tenantId: tenant.id,
  tenantName: tenant.name,
});

/** Public login route (mounted without requireVendor). */
export function loginRoutes(deps: AppDeps): Hono<AdminEnv> {
  const r = new Hono<AdminEnv>();
  r.post('/auth/login', async (c) => {
    const { username, password } = await parseBody(c, loginBody);
    const vendor = await findVendorByUsername(deps.db, username);
    const ok = await verifyPassword(password, vendor ? vendor.passwordHash : await getDummyHash());
    if (!vendor || !ok || !vendor.active) throw invalidCredentials();
    const tenant = tenantById(vendor.tenantId);
    if (!tenant) throw invalidCredentials();
    const s = await createSession(deps.db, { vendorUserId: vendor.id, tenantId: tenant.id, now: deps.now() });
    return c.json({ token: s.token, expiresAt: s.expiresAt.toISOString(), user: userView(vendor, tenant) });
  });
  return r;
}

/** Session-protected auth routes (mounted behind requireVendor). */
export function sessionAuthRoutes(deps: AppDeps): Hono<AdminEnv> {
  const r = new Hono<AdminEnv>();
  r.use('*', requireVendor(deps));
  r.get('/me', (c) => c.json({ user: userView(c.get('vendor'), c.get('tenant')) }));
  r.post('/auth/logout', async (c) => {
    await deleteSession(deps.db, c.get('session').id);
    return c.body(null, 204);
  });
  r.post('/auth/change-password', async (c) => {
    const { currentPassword, newPassword } = await parseBody(c, changeBody);
    const vendor = c.get('vendor');
    const tenant = c.get('tenant');
    if (!(await verifyPassword(currentPassword, vendor.passwordHash))) throw invalidCredentials();
    await setVendorPassword(deps.db, vendor.id, await hashPassword(newPassword), deps.now());
    await deleteVendorSessions(deps.db, vendor.id);
    const s = await createSession(deps.db, { vendorUserId: vendor.id, tenantId: tenant.id, now: deps.now() });
    return c.json({ token: s.token, expiresAt: s.expiresAt.toISOString(), user: userView(vendor, tenant) });
  });
  return r;
}
