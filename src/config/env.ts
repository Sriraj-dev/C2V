import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),
  META_APP_SECRET: z.string().min(1),
  META_VERIFY_TOKEN: z.string().min(1),
  GRAPH_API_VERSION: z.string().min(1),
  CASHFREE_ENV: z.enum(['sandbox', 'production']),
  /** Shared secret for POST /jobs/* (Cloud Scheduler sends it as x-jobs-secret); unset → jobs refuse. */
  JOBS_SECRET: z.string().min(1).optional(),
  /** Public https origin of this server (Cashfree webhook callbacks); trailing slash is stripped where used. */
  PUBLIC_BASE_URL: z.string().url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${problems}`);
  }
  return result.data;
}
