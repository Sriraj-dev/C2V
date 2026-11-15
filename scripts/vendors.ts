import { generatePassword, hashPassword } from '../src/admin/auth/password.js';
import { deleteVendorSessions } from '../src/admin/auth/session-repo.js';
import { createVendor, findVendorByUsername, setVendorActive, setVendorPassword } from '../src/admin/auth/vendor-repo.js';
import { errInfo } from '../src/bot/log.js';
import { loadEnv } from '../src/config/env.js';
import { createDb } from '../src/db/client.js';
import { nutrifarm } from '../src/tenants/nutrifarm/config.js';
import { registerTenants, tenantById } from '../src/tenants/registry.js';
import { printEnvBanner } from './lib/env-banner.js';

printEnvBanner();

/**
 * Ops tool for vendor dashboard logins.
 *
 *   pnpm vendors create <tenantId> <username> | reset-password <username> | deactivate <username> | activate <username>
 */
const USAGE =
  'Usage: pnpm vendors create <tenantId> <username> | reset-password <username> | deactivate <username> | activate <username>';
const [action, a, b] = process.argv.slice(2);
const validName = (u: string | undefined) => !!u && u.trim() !== '' && !/\s/.test(u.trim());
const ok =
  (action === 'create' && a && validName(b)) ||
  (['reset-password', 'deactivate', 'activate'].includes(action ?? '') && validName(a) && !b);
if (!ok) {
  console.error(USAGE);
  process.exit(1);
}

try {
  registerTenants([nutrifarm]);
  const db = createDb(loadEnv(process.env).DATABASE_URL);

  if (action === 'create') {
    const tenant = tenantById(a!);
    if (!tenant) throw new Error(`Unknown tenant: ${a}`);
    const password = generatePassword();
    const v = await createVendor(db, { tenantId: tenant.id, username: b!, passwordHash: await hashPassword(password) });
    console.log(`Created vendor "${v.username}" for ${tenant.id}.`);
    console.log(`Password (shown once): ${password}`);
  } else {
    const v = await findVendorByUsername(db, a!);
    if (!v) throw new Error(`No vendor with username "${a}"`);
    if (action === 'reset-password') {
      const password = generatePassword();
      await setVendorPassword(db, v.id, await hashPassword(password), new Date());
      await deleteVendorSessions(db, v.id);
      console.log(`Password reset for "${v.username}"; all sessions ended.`);
      console.log(`Password (shown once): ${password}`);
    } else if (action === 'deactivate') {
      await setVendorActive(db, v.id, false);
      await deleteVendorSessions(db, v.id);
      console.log(`Deactivated "${v.username}"; all sessions ended.`);
    } else {
      await setVendorActive(db, v.id, true);
      console.log(`Activated "${v.username}".`);
    }
  }
  process.exit(0);
} catch (e) {
  const code = (e as { code?: unknown; cause?: { code?: unknown } }).code ?? (e as { cause?: { code?: unknown } }).cause?.code;
  console.error(code === '23505' ? 'Error: username already exists' : `Error: ${errInfo(e).message ?? 'unexpected error'}`);
  process.exit(1);
}
