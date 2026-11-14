import type { Logger } from 'pino';
import type { WhatsAppSender } from './channels/whatsapp/sender.js';
import type { Db } from './db/client.js';
import type { Env } from './config/env.js';
import type { PaymentProvider } from './payments/provider.js';

export interface AppDeps {
  env: Env;
  now: () => Date;
  log: Logger;
  db: Db;
  whatsapp: WhatsAppSender;
  payments: PaymentProvider;
}
