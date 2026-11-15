import { Hono } from 'hono';
import { z } from 'zod';
import { sendAndLog } from '../../channels/whatsapp/sender.js';
import { textMsg } from '../../channels/whatsapp/builders.js';
import type { AppDeps } from '../../deps.js';
import { ApiError, parseBody, type AdminEnv } from '../http.js';
import { canReplyAt, getChatCustomer, lastInboundAt, listConversations, listMessages, messageView } from './queries.js';

const replyBody = z.object({ text: z.string().trim().min(1).max(4096) }).strict();

function idParam(raw: string): string {
  if (!z.string().uuid().safeParse(raw).success) throw new ApiError(404, 'not_found', 'Not found');
  return raw;
}

export function chatRoutes(deps: AppDeps): Hono<AdminEnv> {
  const r = new Hono<AdminEnv>();

  r.get('/chats', async (c) => c.json({ items: await listConversations(deps.db, c.get('tenant').id, deps.now()) }));

  r.get('/chats/:customerId/messages', async (c) => {
    const id = idParam(c.req.param('customerId'));
    const res = await listMessages(deps.db, c.get('tenant').id, id, deps.now());
    if (!res) throw new ApiError(404, 'not_found', 'Not found');
    return c.json(res);
  });

  r.post('/chats/:customerId/reply', async (c) => {
    const id = idParam(c.req.param('customerId'));
    const { text } = await parseBody(c, replyBody);
    const tenant = c.get('tenant');
    const customer = await getChatCustomer(deps.db, tenant.id, id);
    if (!customer) throw new ApiError(404, 'not_found', 'Not found');
    if (!canReplyAt(await lastInboundAt(deps.db, tenant.id, id), deps.now())) {
      throw new ApiError(409, 'outside_reply_window', 'The customer last messaged more than 24 hours ago');
    }
    const row = await sendAndLog(deps, tenant, customer, textMsg(text), text);
    return c.json({ message: messageView(row) }, 201);
  });

  return r;
}
