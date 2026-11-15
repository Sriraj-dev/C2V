import { createMiddleware } from 'hono/factory';
import type { AppDeps } from '../../deps.js';
import { tenantById } from '../../tenants/registry.js';
import { ApiError, type AdminEnv } from '../http.js';
import { deleteSession, findSessionByToken } from './session-repo.js';
import { sha256Hex } from './tokens.js';

const unauthorized = () => new ApiError(401, 'unauthorized', 'Missing or invalid session');

/** Resolves the Bearer session into c.get('tenant' | 'vendor' | 'session'). Tenant comes only from the session. */
export function requireVendor(deps: AppDeps) {
  return createMiddleware<AdminEnv>(async (c, next) => {
    const m = /^Bearer (\S+)$/i.exec(c.req.header('authorization') ?? '');
    if (!m) throw unauthorized();
    const found = await findSessionByToken(deps.db, sha256Hex(m[1]!));
    if (!found) throw unauthorized();
    const { session, vendor } = found;
    if (session.expiresAt.getTime() <= deps.now().getTime()) {
      await deleteSession(deps.db, session.id);
      throw unauthorized();
    }
    const tenant = tenantById(session.tenantId);
    if (!vendor.active || !tenant) throw unauthorized();
    c.set('tenant', tenant);
    c.set('vendor', vendor);
    c.set('session', session);
    await next();
  });
}
