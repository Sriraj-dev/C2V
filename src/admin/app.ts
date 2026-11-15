import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';
import { loginRoutes, sessionAuthRoutes } from './auth/routes.js';
import { orderRoutes } from './orders/routes.js';
import { customerRoutes } from './customers/routes.js';
import { settingsRoutes } from './settings/routes.js';
import { ApiError, errorResponse, type AdminEnv } from './http.js';

/**
 * The vendor dashboard API, mounted at /admin. Later resource routers (orders, catalog, ...) are
 * added here behind `requireVendor(deps)`.
 */
export function adminRoutes(deps: AppDeps): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();
  app.onError((err, c) => errorResponse(c, err, deps.log));
  app.route('/', loginRoutes(deps));
  app.route('/', sessionAuthRoutes(deps));
  app.route('/', orderRoutes(deps));
  app.route('/', customerRoutes(deps));
  app.route('/', settingsRoutes(deps));
  // Keep last: unknown paths (after requireVendor, so unauthenticated callers still get 401).
  app.all('*', () => {
    throw new ApiError(404, 'not_found', 'Not found');
  });
  return app;
}
