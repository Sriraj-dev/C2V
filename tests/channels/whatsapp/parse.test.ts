import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parseWebhook } from '../../../src/channels/whatsapp/parse.js';

const fx = (name: string): unknown =>
  JSON.parse(readFileSync(`tests/fixtures/wa/${name}.json`, 'utf8'));

describe('parseWebhook', () => {
  it('text', () => {
    const [m] = parseWebhook(fx('text'));
    expect(m).toMatchObject({
      kind: 'text',
      text: 'Hi, I want to order eggs',
      phoneNumberId: '1414838555047142',
      timestamp: 1762934400,
      from: { waId: '919876543210', bsuid: 'IN.13491208655302741918', profileName: 'Asha Rao' },
    });
    expect(m!.waMessageId).toMatch(/^wamid\./);
    expect(m!.raw).toBeDefined();
  });
  it('button_reply', () => {
    expect(parseWebhook(fx('button-reply'))[0]).toMatchObject({
      kind: 'button', replyId: 'order_now', title: 'Order now',
    });
  });
  it('list_reply', () => {
    expect(parseWebhook(fx('list-reply'))[0]).toMatchObject({
      kind: 'button', replyId: 'sku_6_eggs', title: '6 eggs',
    });
  });
  it('nfm_reply', () => {
    const m = parseWebhook(fx('flow-nfm-reply'))[0]!;
    expect(m.kind).toBe('flow_submit');
    if (m.kind === 'flow_submit') {
      expect(m.flowToken).toBe('ft_abc123');
      expect(m.response).toEqual({ flow_token: 'ft_abc123', pincode: '560001', quantity: '2' });
    }
  });
  it('malformed response_json maps to other without throwing', () => {
    expect(parseWebhook(fx('flow-nfm-reply-malformed'))[0]).toMatchObject({
      kind: 'other', waType: 'interactive',
    });
  });
  it('statuses-only -> []', () => {
    expect(parseWebhook(fx('statuses-only'))).toEqual([]);
  });
  it('username-only user has bsuid and no waId', () => {
    const m = parseWebhook(fx('text-username-no-phone'))[0]!;
    expect(m.kind).toBe('text');
    expect(m.from.waId).toBeNull();
    expect(m.from.bsuid).toBe('IN.13491208655302741918');
    expect(m.from.profileName).toBe('Asha');
  });
  it('image -> other', () => {
    expect(parseWebhook(fx('image'))[0]).toMatchObject({ kind: 'other', waType: 'image' });
  });
  it('location', () => {
    expect(parseWebhook(fx('location'))[0]).toMatchObject({
      kind: 'location', lat: 12.9716, lng: 77.5946,
    });
  });
  it('matches contacts to messages by wa_id', () => {
    const body = fx('text') as any;
    const v = body.entry[0].changes[0].value;
    v.contacts.unshift({ profile: { name: 'Other' }, wa_id: '911111111111', user_id: 'IN.other' });
    expect(parseWebhook(body)[0]!.from).toMatchObject({ bsuid: 'IN.13491208655302741918', profileName: 'Asha Rao' });
  });
  it('matches contact by from_user_id for BSUID-only users', () => {
    const body = fx('text-username-no-phone') as any;
    body.entry[0].changes[0].value.contacts.unshift({
      profile: { name: 'Decoy', username: '@decoy' }, user_id: 'IN.decoy',
    });
    const m = parseWebhook(body)[0]!;
    expect(m.from).toMatchObject({ waId: null, bsuid: 'IN.13491208655302741918', profileName: 'Asha' });
  });
  it('reports dropped invalid messages without payload', () => {
    const body = fx('text') as any;
    body.entry[0].changes[0].value.messages.push({ id: 'wamid.bad', type: 'text', text: { body: 5 } });
    const drops: unknown[] = [];
    expect(parseWebhook(body, (i) => drops.push(i))).toHaveLength(1);
    expect(drops).toEqual([{ waMessageId: 'wamid.bad', type: 'text' }]);
  });
  it('garbage input -> []', () => {
    expect(parseWebhook(null)).toEqual([]);
    expect(parseWebhook({ entry: 'x' })).toEqual([]);
    expect(parseWebhook({})).toEqual([]);
  });
});
