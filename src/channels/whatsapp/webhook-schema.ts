import { z } from 'zod';

// Permissive: validate only what we read; everything else passes through.
const contact = z.looseObject({
  wa_id: z.string().optional(),
  user_id: z.string().optional(),
  profile: z.looseObject({ name: z.string().optional(), username: z.string().optional() }).optional(),
});

const message = z.looseObject({
  from: z.string().optional(),
  from_user_id: z.string().optional(),
  id: z.string(),
  timestamp: z.union([z.string(), z.number()]).optional(),
  type: z.string(),
  text: z.looseObject({ body: z.string() }).optional(),
  interactive: z
    .looseObject({
      type: z.string().optional(),
      button_reply: z.looseObject({ id: z.string(), title: z.string() }).optional(),
      list_reply: z.looseObject({ id: z.string(), title: z.string() }).optional(),
      nfm_reply: z.looseObject({ response_json: z.string().optional() }).optional(),
    })
    .optional(),
  location: z.looseObject({ latitude: z.number(), longitude: z.number() }).optional(),
  /** Template quick-reply tap. */
  button: z.looseObject({ payload: z.string(), text: z.string() }).optional(),
});

export const changeValueSchema = z.looseObject({
  metadata: z.looseObject({ phone_number_id: z.string() }),
  contacts: z.array(contact).optional(),
  messages: z.array(z.unknown()).optional(),
});

export const webhookSchema = z.looseObject({
  entry: z.array(
    z.looseObject({
      changes: z.array(z.looseObject({ field: z.string().optional(), value: z.unknown() })).optional(),
    }),
  ),
});

export { message as messageSchema, contact as contactSchema };
export type WaMessage = z.infer<typeof message>;
export type WaContact = z.infer<typeof contact>;
