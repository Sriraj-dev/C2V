/**
 * Builders for the Cloud API `POST /{phone-number-id}/messages` body, minus the
 * envelope fields the sender adds (`messaging_product`, `recipient_type`, `to`/`recipient`, `context`).
 * Limits are enforced here so a bad message fails loudly in our code, not with an opaque Graph error.
 */

export type OutboundMessage = { type: string } & Record<string, unknown>;

export type Header = { type: 'text'; text: string } | { type: 'image'; link: string };

const LIMITS = {
  text: 4096,
  interactiveBody: 1024,
  buttons: 3,
  buttonTitle: 20,
  ctaButton: 20,
  flowCta: 20,
  listButton: 20,
  sectionTitle: 24,
  rowTitle: 24,
  rowDescription: 72,
  rows: 10,
  headerText: 60,
  footer: 60,
  caption: 1024,
} as const;

function max(what: string, value: string, limit: number): void {
  if (value.length > limit) throw new Error(`${what} must be at most ${limit} characters (got ${value.length})`);
}

function nonEmpty(what: string, value: string): void {
  if (value.trim().length === 0) throw new Error(`${what} must not be empty`);
}

function interactiveBody(body: string): { text: string } {
  nonEmpty('body', body);
  max('interactive body', body, LIMITS.interactiveBody);
  return { text: body };
}

function headerOf(h: Header | undefined): { header: Record<string, unknown> } | Record<string, never> {
  if (!h) return {};
  if (h.type === 'text') {
    nonEmpty('header text', h.text);
    max('header text', h.text, LIMITS.headerText);
    return { header: { type: 'text', text: h.text } };
  }
  assertUrl('header image link', h.link);
  return { header: { type: 'image', image: { link: h.link } } };
}

function footerOf(f: string | undefined): { footer: { text: string } } | Record<string, never> {
  if (f === undefined) return {};
  nonEmpty('footer', f);
  max('footer', f, LIMITS.footer);
  return { footer: { text: f } };
}

function assertUrl(what: string, value: string, allowTel = false): void {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`${what} is not a valid url: ${value}`);
  }
  const okProto = u.protocol === 'https:' || u.protocol === 'http:' || (allowTel && u.protocol === 'tel:');
  if (!okProto) throw new Error(`${what} must be an http(s)${allowTel ? ' or tel:' : ''} url`);
}

export function textMsg(body: string, opts: { previewUrl?: boolean } = {}): OutboundMessage {
  nonEmpty('text body', body);
  max('text body', body, LIMITS.text);
  return {
    type: 'text',
    text: opts.previewUrl === undefined ? { body } : { preview_url: opts.previewUrl, body },
  };
}

export function replyButtonsMsg(
  body: string,
  buttons: { id: string; title: string }[],
  opts: { header?: Header; footer?: string } = {},
): OutboundMessage {
  if (buttons.length < 1 || buttons.length > LIMITS.buttons)
    throw new Error(`reply buttons: need 1-${LIMITS.buttons} buttons (got ${buttons.length})`);
  const titles = new Set<string>();
  for (const b of buttons) {
    nonEmpty('button title', b.title);
    max('button title', b.title, LIMITS.buttonTitle);
    max('button id', b.id, 256);
    if (titles.has(b.title)) throw new Error(`button titles must be unique (duplicate "${b.title}")`);
    titles.add(b.title);
  }
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      ...headerOf(opts.header),
      body: interactiveBody(body),
      ...footerOf(opts.footer),
      action: { buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
    },
  };
}

export function ctaUrlMsg(args: {
  body: string;
  buttonText: string;
  url: string;
  footer?: string;
  header?: Header;
}): OutboundMessage {
  nonEmpty('cta button text', args.buttonText);
  max('cta button text', args.buttonText, LIMITS.ctaButton);
  assertUrl('cta url', args.url, true);
  return {
    type: 'interactive',
    interactive: {
      type: 'cta_url',
      ...headerOf(args.header),
      body: interactiveBody(args.body),
      ...footerOf(args.footer),
      action: { name: 'cta_url', parameters: { display_text: args.buttonText, url: args.url } },
    },
  };
}

export function flowMsg(args: {
  body: string;
  flowId: string;
  flowToken: string;
  cta: string;
  screen: string;
  data: Record<string, unknown>;
}): OutboundMessage {
  nonEmpty('flow cta', args.cta);
  max('flow cta', args.cta, LIMITS.flowCta);
  return {
    type: 'interactive',
    interactive: {
      type: 'flow',
      body: interactiveBody(args.body),
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_token: args.flowToken,
          flow_id: args.flowId,
          flow_cta: args.cta,
          flow_action: 'navigate',
          flow_action_payload: { screen: args.screen, data: args.data },
        },
      },
    },
  };
}

/** Template message; `quickReplyPayloads[i]` is the payload returned when the template's i-th quick-reply button is tapped. */
export function templateMsg(
  name: string,
  lang: string,
  bodyParams: string[],
  opts: { quickReplyPayloads?: string[] } = {},
): OutboundMessage {
  const components: Record<string, unknown>[] = [];
  if (bodyParams.length) {
    components.push({ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) });
  }
  (opts.quickReplyPayloads ?? []).forEach((payload, i) => {
    components.push({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload }] });
  });
  return {
    type: 'template',
    template: { name, language: { code: lang }, ...(components.length ? { components } : {}) },
  };
}

export function locationRequestMsg(body: string): OutboundMessage {
  nonEmpty('body', body);
  max('location request body', body, LIMITS.interactiveBody);
  return {
    type: 'interactive',
    interactive: { type: 'location_request_message', body: { text: body }, action: { name: 'send_location' } },
  };
}

export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

export function listMsg(args: {
  body: string;
  buttonText: string;
  sections: { title?: string; rows: ListRow[] }[];
  header?: Header;
  footer?: string;
}): OutboundMessage {
  nonEmpty('list button text', args.buttonText);
  max('list button text', args.buttonText, LIMITS.listButton);
  if (args.sections.length < 1 || args.sections.length > 10) throw new Error('list: need 1-10 sections');
  if (args.header && args.header.type !== 'text') throw new Error('list header must be text');
  let total = 0;
  for (const s of args.sections) {
    if (args.sections.length > 1 && !s.title) throw new Error('list: every section needs a title when there are several');
    if (s.title !== undefined) max('section title', s.title, LIMITS.sectionTitle);
    if (s.rows.length < 1) throw new Error('list: each section needs at least one row');
    for (const r of s.rows) {
      nonEmpty('row title', r.title);
      max('row title', r.title, LIMITS.rowTitle);
      max('row id', r.id, 200);
      if (r.description !== undefined) max('row description', r.description, LIMITS.rowDescription);
      total++;
    }
  }
  if (total > LIMITS.rows) throw new Error(`list: at most ${LIMITS.rows} rows in total (got ${total})`);
  return {
    type: 'interactive',
    interactive: {
      type: 'list',
      ...headerOf(args.header),
      body: interactiveBody(args.body),
      ...footerOf(args.footer),
      action: {
        button: args.buttonText,
        sections: args.sections.map((s) => ({
          ...(s.title !== undefined ? { title: s.title } : {}),
          rows: s.rows.map((r) => ({
            id: r.id,
            title: r.title,
            ...(r.description !== undefined ? { description: r.description } : {}),
          })),
        })),
      },
    },
  };
}

export function imageMsg(args: { link: string; caption?: string }): OutboundMessage {
  assertUrl('image link', args.link);
  if (args.caption !== undefined) max('image caption', args.caption, LIMITS.caption);
  return {
    type: 'image',
    image: { link: args.link, ...(args.caption !== undefined ? { caption: args.caption } : {}) },
  };
}

export function documentMsg(args: { link: string; filename?: string; caption?: string }): OutboundMessage {
  assertUrl('document link', args.link);
  if (args.caption !== undefined) max('document caption', args.caption, LIMITS.caption);
  return {
    type: 'document',
    document: {
      link: args.link,
      ...(args.caption !== undefined ? { caption: args.caption } : {}),
      ...(args.filename !== undefined ? { filename: args.filename } : {}),
    },
  };
}

export function audioMsg(args: { link: string }): OutboundMessage {
  assertUrl('audio link', args.link);
  return { type: 'audio', audio: { link: args.link } };
}

export function locationMsg(args: { lat: number; lng: number; name?: string; address?: string }): OutboundMessage {
  if (!(args.lat >= -90 && args.lat <= 90)) throw new Error(`latitude out of range: ${args.lat}`);
  if (!(args.lng >= -180 && args.lng <= 180)) throw new Error(`longitude out of range: ${args.lng}`);
  return {
    type: 'location',
    location: {
      latitude: args.lat,
      longitude: args.lng,
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.address !== undefined ? { address: args.address } : {}),
    },
  };
}

export interface ContactCard {
  name: { formatted_name: string; first_name?: string; last_name?: string };
  phones?: { phone: string; type?: string; wa_id?: string }[];
  emails?: { email: string; type?: string }[];
  org?: { company?: string; department?: string; title?: string };
}

export function contactsMsg(contacts: ContactCard[]): OutboundMessage {
  if (contacts.length < 1) throw new Error('contacts: need at least one contact');
  for (const c of contacts) nonEmpty('contact name.formatted_name', c.name.formatted_name);
  return { type: 'contacts', contacts };
}

export function reactionMsg(messageId: string, emoji: string): OutboundMessage {
  nonEmpty('reaction message id', messageId);
  // An empty emoji removes the reaction.
  return { type: 'reaction', reaction: { message_id: messageId, emoji } };
}

export interface AddressValues {
  name?: string;
  phone_number?: string;
  in_pin_code?: string;
  house_number?: string;
  floor_number?: string;
  tower_number?: string;
  building_name?: string;
  address?: string;
  landmark_area?: string;
  city?: string;
  state?: string;
}

export function addressMsg(args: { body: string; values?: AddressValues }): OutboundMessage {
  if (args.values?.in_pin_code !== undefined) max('in_pin_code', args.values.in_pin_code, 6);
  return {
    type: 'interactive',
    interactive: {
      type: 'address_message',
      body: interactiveBody(args.body),
      action: {
        name: 'address_message',
        parameters: { country: 'IN', ...(args.values ? { values: args.values } : {}) },
      },
    },
  };
}
