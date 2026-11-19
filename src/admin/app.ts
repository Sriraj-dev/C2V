import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';
import { loginRoutes, sessionAuthRoutes } from './auth/routes.js';
import { orderRoutes } from './orders/routes.js';
import { customerRoutes } from './customers/routes.js';
import { settingsRoutes } from './settings/routes.js';
import { catalogRoutes } from './catalog/routes.js';
import { partnerAdminRoutes } from './partners/routes.js';
import { chatRoutes } from './chats/routes.js';
import { subscriptionRoutes } from './subscriptions/routes.js';
import { ApiError, errorResponse, REQUEST_TIMEOUT_MS, requestTimeout, type AdminEnv } from './http.js';

/**
 * The vendor dashboard API, mounted at /admin. Later resource routers (orders, catalog, ...) are
 * added here behind `requireVendor(deps)`.
 */
export function adminRoutes(deps: AppDeps): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();
  app.onError((err, c) => errorResponse(c, err, deps.log));
  app.use('*', requestTimeout(REQUEST_TIMEOUT_MS));
  app.route('/', loginRoutes(deps));
  app.route('/', sessionAuthRoutes(deps));
  app.route('/', orderRoutes(deps));
  app.route('/', customerRoutes(deps));
  app.route('/', settingsRoutes(deps));
  app.route('/', catalogRoutes(deps));
  app.route('/', partnerAdminRoutes(deps));
  app.route('/', chatRoutes(deps));
  app.route('/', subscriptionRoutes(deps));
  // Keep last: unknown paths (after requireVendor, so unauthenticated callers still get 401).
  app.all('*', () => {
    throw new ApiError(404, 'not_found', 'Not found');
  });
  return app;
}
