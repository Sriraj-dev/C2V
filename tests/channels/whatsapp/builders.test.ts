import { describe, expect, it } from 'vitest';
import {
  addressMsg,
  audioMsg,
  contactsMsg,
  ctaUrlMsg,
  documentMsg,
  flowMsg,
  imageMsg,
  listMsg,
  locationMsg,
  locationRequestMsg,
  reactionMsg,
  replyButtonsMsg,
  templateMsg,
  textMsg,
} from '../../../src/channels/whatsapp/builders.js';

describe('builders: shapes', () => {
  it('textMsg', () => expect(textMsg('hi')).toMatchInlineSnapshot(`
    {
      "text": {
        "body": "hi",
      },
      "type": "text",
    }
  `));
  it('replyButtonsMsg', () =>
    expect(
      replyButtonsMsg('Pick', [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], {
        header: { type: 'text', text: 'Head' },
        footer: 'Foot',
      }),
    ).toMatchInlineSnapshot(`
      {
        "interactive": {
          "action": {
            "buttons": [
              {
                "reply": {
                  "id": "a",
                  "title": "A",
                },
                "type": "reply",
              },
              {
                "reply": {
                  "id": "b",
                  "title": "B",
                },
                "type": "reply",
              },
            ],
          },
          "body": {
            "text": "Pick",
          },
          "footer": {
            "text": "Foot",
          },
          "header": {
            "text": "Head",
            "type": "text",
          },
          "type": "button",
        },
        "type": "interactive",
      }
    `));
  it('ctaUrlMsg', () =>
    expect(
      ctaUrlMsg({ body: 'Pay', buttonText: 'Pay', url: 'https://x.test/p', footer: 'f' }),
    ).toMatchInlineSnapshot(`
      {
        "interactive": {
          "action": {
            "name": "cta_url",
            "parameters": {
              "display_text": "Pay",
              "url": "https://x.test/p",
            },
          },
          "body": {
            "text": "Pay",
          },
          "footer": {
            "text": "f",
          },
          "type": "cta_url",
        },
        "type": "interactive",
      }
    `));
  it('flowMsg', () =>
    expect(
      flowMsg({ body: 'Go', flowId: '123', flowToken: 'tok', cta: 'Order', screen: 'S1', data: { a: 1 } }),
    ).toMatchInlineSnapshot(`
      {
        "interactive": {
          "action": {
            "name": "flow",
            "parameters": {
              "flow_action": "navigate",
              "flow_action_payload": {
                "data": {
                  "a": 1,
                },
                "screen": "S1",
              },
              "flow_cta": "Order",
              "flow_id": "123",
              "flow_message_version": "3",
              "flow_token": "tok",
            },
          },
          "body": {
            "text": "Go",
          },
          "type": "flow",
        },
        "type": "interactive",
      }
    `));
  it('templateMsg', () => expect(templateMsg('hello', 'en', ['x', 'y'])).toMatchInlineSnapshot(`
    {
      "template": {
        "components": [
          {
            "parameters": [
              {
                "text": "x",
                "type": "text",
              },
              {
                "text": "y",
                "type": "text",
              },
            ],
            "type": "body",
          },
        ],
        "language": {
          "code": "en",
        },
        "name": "hello",
      },
      "type": "template",
    }
  `));
  it('locationRequestMsg', () => expect(locationRequestMsg('Where?')).toMatchInlineSnapshot(`
    {
      "interactive": {
        "action": {
          "name": "send_location",
        },
        "body": {
          "text": "Where?",
        },
        "type": "location_request_message",
      },
      "type": "interactive",
    }
  `));
  it('listMsg', () =>
    expect(
      listMsg({
        body: 'Choose',
        buttonText: 'Open',
        sections: [{ title: 'S', rows: [{ id: 'r1', title: 'Row', description: 'Desc' }] }],
        header: { type: 'text', text: 'H' },
        footer: 'F',
      }),
    ).toMatchInlineSnapshot(`
      {
        "interactive": {
          "action": {
            "button": "Open",
            "sections": [
              {
                "rows": [
                  {
                    "description": "Desc",
                    "id": "r1",
                    "title": "Row",
                  },
                ],
                "title": "S",
              },
            ],
          },
          "body": {
            "text": "Choose",
          },
          "footer": {
            "text": "F",
          },
          "header": {
            "text": "H",
            "type": "text",
          },
          "type": "list",
        },
        "type": "interactive",
      }
    `));
  it('imageMsg', () => expect(imageMsg({ link: 'https://x.test/a.jpg', caption: 'c' })).toMatchInlineSnapshot(`
    {
      "image": {
        "caption": "c",
        "link": "https://x.test/a.jpg",
      },
      "type": "image",
    }
  `));
  it('documentMsg', () =>
    expect(documentMsg({ link: 'https://x.test/a.pdf', filename: 'a.pdf', caption: 'c' })).toMatchInlineSnapshot(`
      {
        "document": {
          "caption": "c",
          "filename": "a.pdf",
          "link": "https://x.test/a.pdf",
        },
        "type": "document",
      }
    `));
  it('audioMsg', () => expect(audioMsg({ link: 'https://x.test/a.mp3' })).toMatchInlineSnapshot(`
    {
      "audio": {
        "link": "https://x.test/a.mp3",
      },
      "type": "audio",
    }
  `));
  it('locationMsg', () =>
    expect(locationMsg({ lat: 12.9, lng: 77.6, name: 'Farm', address: 'Road' })).toMatchInlineSnapshot(`
      {
        "location": {
          "address": "Road",
          "latitude": 12.9,
          "longitude": 77.6,
          "name": "Farm",
        },
        "type": "location",
      }
    `));
  it('contactsMsg', () =>
    expect(
      contactsMsg([{ name: { formatted_name: 'Ravi' }, phones: [{ phone: '+919398651343', type: 'CELL' }] }]),
    ).toMatchInlineSnapshot(`
      {
        "contacts": [
          {
            "name": {
              "formatted_name": "Ravi",
            },
            "phones": [
              {
                "phone": "+919398651343",
                "type": "CELL",
              },
            ],
          },
        ],
        "type": "contacts",
      }
    `));
  it('reactionMsg', () => expect(reactionMsg('wamid.1', '👍')).toMatchInlineSnapshot(`
    {
      "reaction": {
        "emoji": "👍",
        "message_id": "wamid.1",
      },
      "type": "reaction",
    }
  `));
  it('addressMsg', () =>
    expect(addressMsg({ body: 'Address?', values: { name: 'A', in_pin_code: '560034' } })).toMatchInlineSnapshot(`
      {
        "interactive": {
          "action": {
            "name": "address_message",
            "parameters": {
              "country": "IN",
              "values": {
                "in_pin_code": "560034",
                "name": "A",
              },
            },
          },
          "body": {
            "text": "Address?",
          },
          "type": "address_message",
        },
        "type": "interactive",
      }
    `));
  it('image header on buttons', () =>
    expect(
      replyButtonsMsg('b', [{ id: 'a', title: 'A' }], { header: { type: 'image', link: 'https://x.test/i.png' } })
        .interactive,
    ).toMatchObject({ header: { type: 'image', image: { link: 'https://x.test/i.png' } } }));
});

describe('builders: limits', () => {
  const btn = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `b${i}`, title: `B${i}` }));
  it('buttons 1-3', () => {
    expect(() => replyButtonsMsg('b', [])).toThrow(/1.?3/);
    expect(() => replyButtonsMsg('b', btn(4))).toThrow(/1.?3/);
    expect(() => replyButtonsMsg('b', btn(3))).not.toThrow();
  });
  it('button title <= 20 and unique', () => {
    expect(() => replyButtonsMsg('b', [{ id: 'a', title: 'x'.repeat(21) }])).toThrow(/20/);
    expect(() => replyButtonsMsg('b', [{ id: 'a', title: 'x'.repeat(20) }])).not.toThrow();
    expect(() => replyButtonsMsg('b', [{ id: 'a', title: 'Same' }, { id: 'b', title: 'Same' }])).toThrow(/unique/);
  });
  it('interactive body <= 1024', () => {
    expect(() => replyButtonsMsg('x'.repeat(1025), btn(1))).toThrow(/1024/);
    expect(() => ctaUrlMsg({ body: 'x'.repeat(1025), buttonText: 'a', url: 'https://x.test' })).toThrow(/1024/);
  });
  it('header/footer <= 60', () => {
    expect(() => replyButtonsMsg('b', btn(1), { footer: 'x'.repeat(61) })).toThrow(/60/);
    expect(() => replyButtonsMsg('b', btn(1), { header: { type: 'text', text: 'x'.repeat(61) } })).toThrow(/60/);
  });
  it('cta button <= 20, url must be https', () => {
    expect(() => ctaUrlMsg({ body: 'b', buttonText: 'x'.repeat(21), url: 'https://x.test' })).toThrow(/20/);
    expect(() => ctaUrlMsg({ body: 'b', buttonText: 'ok', url: 'not a url' })).toThrow(/url/i);
  });
  it('cta url allows tel: and https, rejects other schemes', () => {
    for (const url of ['tel:+919398651343', 'https://wa.me/919398651343'])
      expect(() => ctaUrlMsg({ body: 'b', buttonText: 'ok', url })).not.toThrow();
    for (const url of ['javascript:alert(1)', 'ftp://x.test/a', 'mailto:a@b.co'])
      expect(() => ctaUrlMsg({ body: 'b', buttonText: 'ok', url })).toThrow(/url/i);
  });
  it('reaction allows empty emoji (removes reaction)', () => {
    expect(reactionMsg('wamid.1', '')).toMatchObject({ reaction: { message_id: 'wamid.1', emoji: '' } });
  });
  it('flow cta <= 20', () => {
    expect(() =>
      flowMsg({ body: 'b', flowId: '1', flowToken: 't', cta: 'x'.repeat(21), screen: 'S', data: {} }),
    ).toThrow(/20/);
  });
  it('text body 1..4096', () => {
    expect(() => textMsg('x'.repeat(4097))).toThrow(/4096/);
    expect(() => textMsg('')).toThrow(/empty/i);
    expect(() => textMsg('x'.repeat(4096))).not.toThrow();
  });
  it('list limits', () => {
    const row = (i: number) => ({ id: `r${i}`, title: `Row ${i}` });
    const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i));
    const base = { body: 'b', buttonText: 'Open' };
    expect(() => listMsg({ ...base, buttonText: 'x'.repeat(21), sections: [{ rows: rows(1) }] })).toThrow(/20/);
    expect(() => listMsg({ ...base, sections: [{ rows: [{ id: 'a', title: 'x'.repeat(25) }] }] })).toThrow(/24/);
    expect(() =>
      listMsg({ ...base, sections: [{ rows: [{ id: 'a', title: 't', description: 'x'.repeat(73) }] }] }),
    ).toThrow(/72/);
    expect(() => listMsg({ ...base, sections: [{ rows: rows(11) }] })).toThrow(/10/);
    expect(() => listMsg({ ...base, sections: [{ title: 'a', rows: rows(6) }, { title: 'b', rows: rows(5) }] })).toThrow(/10/);
    expect(() => listMsg({ ...base, sections: [{ rows: rows(10) }] })).not.toThrow();
    expect(() => listMsg({ ...base, sections: [] })).toThrow();
    expect(() =>
      listMsg({ ...base, sections: [{ title: 'x'.repeat(25), rows: rows(1) }, { title: 'b', rows: rows(1) }] }),
    ).toThrow(/24/);
    expect(() => listMsg({ ...base, sections: [{ rows: rows(1) }, { rows: rows(1) }] })).toThrow(/title/);
  });
  it('captions <= 1024', () => {
    expect(() => imageMsg({ link: 'https://x.test/a.jpg', caption: 'x'.repeat(1025) })).toThrow(/1024/);
    expect(() => documentMsg({ link: 'https://x.test/a.pdf', caption: 'x'.repeat(1025) })).toThrow(/1024/);
  });
  it('contacts need formatted_name', () => {
    expect(() => contactsMsg([{ name: { formatted_name: '' } }])).toThrow(/formatted_name/);
    expect(() => contactsMsg([])).toThrow();
  });
});
