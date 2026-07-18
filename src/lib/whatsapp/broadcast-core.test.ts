import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const state = {
  configs: new Map<string, Record<string, unknown>>(),
  broadcasts: [] as Array<Record<string, unknown>>,
  broadcastRecipients: [] as Array<Record<string, unknown>>,
};

function resetState() {
  state.configs.clear();
  state.broadcasts.length = 0;
  state.broadcastRecipients.length = 0;
}

vi.mock('@/lib/api/v1/contacts', () => ({
  findOrCreateContact: vi.fn(
    async (_db: unknown, _accountId: string, _userId: string, input: { phone: string }) => ({
      id: `contact-${input.phone}`,
    }),
  ),
}));

const uazapiProviderSpies = {
  sendText: vi.fn(async () => ({ messageId: 'uazapi-msg-1' })),
  sendMedia: vi.fn(async () => ({ messageId: 'uazapi-msg-2' })),
  sendReaction: vi.fn(async () => ({ messageId: 'uazapi-msg-3' })),
  sendInteractive: vi.fn(async () => ({ messageId: 'uazapi-msg-4' })),
};
vi.mock('@/lib/whatsapp/provider', () => ({
  getWhatsAppProvider: vi.fn(() => uazapiProviderSpies),
}));

vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/meta-api')>();
  return {
    ...actual,
    sendTemplateMessage: vi.fn(async () => ({ messageId: 'meta-msg-1' })),
  };
});

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn((v: string) => v.replace(/^encrypted:/, '')),
}));

import { createBroadcast, deliverBroadcast, BroadcastError } from './broadcast-core';

function makeDb() {
  const chain = {
    select() {
      return chain;
    },
    eq(col: string, val: unknown) {
      chain._filters[col] = val;
      return chain;
    },
    insert(row: Record<string, unknown>) {
      const table = chain._table;
      if (table === 'broadcasts') {
        const id = `broadcast-${state.broadcasts.length + 1}`;
        const row2 = { id, ...row };
        state.broadcasts.push(row2);
        return { select: () => ({ single: async () => ({ data: row2, error: null }) }) };
      }
      if (table === 'broadcast_recipients') {
        const rows = (Array.isArray(row) ? row : [row]).map((r, i) => ({
          id: `recipient-${state.broadcastRecipients.length + i + 1}`,
          ...r,
        }));
        state.broadcastRecipients.push(...rows);
        return { select: async () => ({ data: rows, error: null }) };
      }
      return Promise.resolve({ error: null });
    },
    update(patch: Record<string, unknown>) {
      const table = chain._table;
      return {
        eq: (_col: string, val: unknown) => {
          if (table === 'broadcast_recipients') {
            const rec = state.broadcastRecipients.find((r) => r.id === val);
            if (rec) Object.assign(rec, patch);
          }
          if (table === 'broadcasts') {
            const b = state.broadcasts.find((r) => r.id === val);
            if (b) Object.assign(b, patch);
          }
          return Promise.resolve({ error: null });
        },
      };
    },
    maybeSingle: async () => {
      if (chain._table === 'whatsapp_config') {
        return { data: state.configs.get(chain._filters.account_id as string) ?? null, error: null };
      }
      return { data: null, error: null };
    },
    single: async () => {
      if (chain._table === 'whatsapp_config') {
        const cfg = state.configs.get(chain._filters.account_id as string);
        return cfg ? { data: cfg, error: null } : { data: null, error: { code: 'PGRST116' } };
      }
      return { data: null, error: { code: 'PGRST116' } };
    },
    _table: '',
    _filters: {} as Record<string, unknown>,
  };
  return {
    from(table: string) {
      chain._table = table;
      chain._filters = {};
      return chain;
    },
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  resetState();
  vi.clearAllMocks();
});

describe('createBroadcast validation', () => {
  it('rejects an empty recipient list', async () => {
    const db = {} as SupabaseClient;
    await expect(
      createBroadcast(db, 'acc', 'user', { templateName: 'promo', recipients: [] }),
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('rejects more than 1000 recipients', async () => {
    const db = {} as SupabaseClient;
    const recipients = Array.from({ length: 1001 }, () => ({ to: '+14155550123' }));
    await expect(
      createBroadcast(db, 'acc', 'user', { templateName: 'promo', recipients }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a missing template_name for a Meta account', async () => {
    const db = makeDb();
    state.configs.set('acct-meta', {
      account_id: 'acct-meta',
      provider: 'meta',
      phone_number_id: 'pnid-1',
      access_token: 'encrypted:tok-meta',
    });
    await expect(
      createBroadcast(db, 'acct-meta', 'user-1', {
        templateName: '',
        recipients: [{ to: '+14155550123' }],
      }),
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });
});

describe('createBroadcast — Meta template path (regression)', () => {
  beforeEach(() => {
    state.configs.set('acct-meta', {
      account_id: 'acct-meta',
      provider: 'meta',
      phone_number_id: 'pnid-1',
      access_token: 'encrypted:tok-meta',
    });
  });

  it('builds a template sendContext', async () => {
    const db = makeDb();
    const plan = await createBroadcast(db, 'acct-meta', 'user-1', {
      templateName: 'promo_july',
      recipients: [{ to: '+14155550123' }],
    });

    expect(plan.sendContext).toMatchObject({
      kind: 'template',
      phoneNumberId: 'pnid-1',
      accessToken: 'tok-meta',
      templateName: 'promo_july',
      templateLanguage: 'en_US',
    });
    expect(state.broadcasts[0]).toMatchObject({ template_name: 'promo_july' });
  });
});

describe('createBroadcast — UAZAPI free-text path', () => {
  beforeEach(() => {
    state.configs.set('acct-uazapi', {
      account_id: 'acct-uazapi',
      provider: 'uazapi',
      uazapi_server_url: 'https://free.uazapi.com',
      uazapi_token: 'encrypted:tok',
      uazapi_instance_id: 'inst-1',
    });
  });

  it('rejects a missing message_text', async () => {
    const db = makeDb();
    await expect(
      createBroadcast(db, 'acct-uazapi', 'user-1', { recipients: [{ to: '+14155550123' }] }),
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('builds a freeText sendContext and persists message_text', async () => {
    const db = makeDb();
    const plan = await createBroadcast(db, 'acct-uazapi', 'user-1', {
      messageText: 'Oi, promoção de julho!',
      recipients: [{ to: '+14155550123' }],
    });

    expect(plan.sendContext.kind).toBe('freeText');
    expect(plan.sendContext.messageText).toBe('Oi, promoção de julho!');
    expect(plan.planned).toHaveLength(1);
    expect(state.broadcasts[0]).toMatchObject({
      message_text: 'Oi, promoção de julho!',
      template_name: null,
    });
  });

  it('carries an optional media attachment through to the plan and the row', async () => {
    const db = makeDb();
    const plan = await createBroadcast(db, 'acct-uazapi', 'user-1', {
      messageText: 'Confira o catálogo',
      media: { kind: 'image', url: 'https://example.com/catalogo.jpg' },
      recipients: [{ to: '+14155550123' }],
    });

    expect(plan.sendContext.media).toEqual({ kind: 'image', url: 'https://example.com/catalogo.jpg' });
    expect(state.broadcasts[0]).toMatchObject({
      media_url: 'https://example.com/catalogo.jpg',
      media_kind: 'image',
    });
  });
});

describe('deliverBroadcast — UAZAPI free-text path', () => {
  it('sends text via the WhatsApp provider and stamps the recipient row sent', async () => {
    const db = makeDb();
    state.broadcasts.push({ id: 'b-1' });
    state.broadcastRecipients.push({ id: 'r-1' });

    await deliverBroadcast(db, {
      broadcastId: 'b-1',
      sendContext: {
        kind: 'freeText',
        provider: uazapiProviderSpies,
        messageText: 'Oi!',
        media: null,
      },
      planned: [{ recipientRowId: 'r-1', phone: '+14155550123', params: [] }],
      rejected: 0,
    });

    expect(uazapiProviderSpies.sendText).toHaveBeenCalledWith({ to: '+14155550123', text: 'Oi!' });
    expect(state.broadcastRecipients[0]).toMatchObject({ status: 'sent', whatsapp_message_id: 'uazapi-msg-1' });
    expect(state.broadcasts[0]).toMatchObject({ status: 'sent' });
  });

  it('sends media with the message text as caption when a media attachment is set', async () => {
    const db = makeDb();
    state.broadcasts.push({ id: 'b-2' });
    state.broadcastRecipients.push({ id: 'r-2' });

    await deliverBroadcast(db, {
      broadcastId: 'b-2',
      sendContext: {
        kind: 'freeText',
        provider: uazapiProviderSpies,
        messageText: 'Confira!',
        media: { kind: 'image', url: 'https://example.com/x.jpg' },
      },
      planned: [{ recipientRowId: 'r-2', phone: '+14155550123', params: [] }],
      rejected: 0,
    });

    expect(uazapiProviderSpies.sendMedia).toHaveBeenCalledWith({
      to: '+14155550123',
      kind: 'image',
      link: 'https://example.com/x.jpg',
      caption: 'Confira!',
      filename: undefined,
    });
    expect(state.broadcastRecipients[0]).toMatchObject({ status: 'sent', whatsapp_message_id: 'uazapi-msg-2' });
  });
});
