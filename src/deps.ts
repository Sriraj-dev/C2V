import type { Logger } from 'pino';
import type { Env } from './config/env.js';

export interface AppDeps {
  env: Env;
  now: () => Date;
  log: Logger;
  // Placeholders; replaced by real types in later tasks.
  db: unknown;
  whatsapp: unknown;
  payments: unknown;
}
