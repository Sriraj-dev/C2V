import type { Logger } from 'pino';
import type { WhatsAppSender } from './channels/whatsapp/sender.js';
import type { Db } from './db/client.js';
import type { Env } from './config/env.js';

export interface AppDeps {
  env: Env;
  now: () => Date;
  log: Logger;
  // Placeholders; replaced by real types in later tasks.
  db: Db;
  whatsapp: WhatsAppSender;
  payments: unknown;
}
