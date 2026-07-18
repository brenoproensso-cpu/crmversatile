import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = {
  profile: { account_id: 'acct-1' } as Record<string, unknown> | null,
  config: null as Record<string, unknown> | null,
};

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(() => ({ success: true })),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { broadcast: {} },
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn((v: string) => v.replace(/^encrypted:/, '')),
}));

const { sendBroadcastRecipient } = vi.hoisted(() => ({
  sendBroadcastRecipient: vi.fn(async () => ({ messageId: 'msg-1' })),
}));
vi.mock('@/lib/whatsapp/broadcast-core', () => ({ sendBroadcastRecipient }));

const providerSpy = { sendText: vi.fn(), sendMedia: vi.fn(), sendReaction: vi.fn() };
vi.mock('@/lib/whatsapp/provider', () => ({
  getWhatsAppProvider: vi.fn(() => providerSpy),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }),
    },
    from(table: string) {
      const chain = {
        select() {
          return chain;
        },
        eq() {
          return chain;
        },
        maybeSingle: async () => {
          if (table === 'profiles') return { data: state.profile, error: null };
          if (table === 'message_templates') return { data: null, error: null };
          return { data: null, error: null };
        },
        single: async () => {
          if (table === 'whatsapp_config') {
            return state.config
              ? { data: state.config, error: null }
              : { data: null, error: { code: 'PGRST116' } };
          }
          return { data: null, error: { code: 'PGRST116' } };
        },
      };
      return chain;
    },
  })),
}));

import { POST } from './route';

function postBody(body: Record<string, unknown>) {
  return POST(
    new Request('http://localhost/api/whatsapp/broadcast', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.profile = { account_id: 'acct-1' };
  state.config = null;
});

describe('POST /api/whatsapp/broadcast — UAZAPI', () => {
  it('requires message_text for a UAZAPI-provider account', async () => {
    state.config = { provider: 'uazapi', account_id: 'acct-1' };
    const res = await postBody({ recipients: [{ phone: '+14155550123' }] });
    expect(res.status).toBe(400);
  });

  it('sends a free-text broadcast for a UAZAPI-provider account', async () => {
    state.config = { provider: 'uazapi', account_id: 'acct-1' };
    const res = await postBody({
      recipients: [{ phone: '+14155550123' }],
      message_text: 'Oi!',
    });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.sent).toBe(1);
    expect(sendBroadcastRecipient).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'freeText', messageText: 'Oi!' }),
      expect.objectContaining({ phone: '14155550123' }),
    );
  });

  it('passes a media attachment through to the send context', async () => {
    state.config = { provider: 'uazapi', account_id: 'acct-1' };
    await postBody({
      recipients: [{ phone: '+14155550123' }],
      message_text: 'Confira',
      media: { kind: 'image', url: 'https://example.com/x.jpg' },
    });
    expect(sendBroadcastRecipient).toHaveBeenCalledWith(
      expect.objectContaining({ media: { kind: 'image', url: 'https://example.com/x.jpg', filename: undefined } }),
      expect.anything(),
    );
  });
});

describe('POST /api/whatsapp/broadcast — Meta (regression)', () => {
  it('still requires template_name for a Meta-provider account', async () => {
    state.config = { provider: 'meta', phone_number_id: 'pnid', access_token: 'encrypted:tok' };
    const res = await postBody({ recipients: [{ phone: '+14155550123' }] });
    expect(res.status).toBe(400);
  });

  it('sends a template broadcast for a Meta-provider account', async () => {
    state.config = { provider: 'meta', phone_number_id: 'pnid', access_token: 'encrypted:tok' };
    const res = await postBody({
      recipients: [{ phone: '+14155550123', params: ['Jane'] }],
      template_name: 'promo_july',
    });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.sent).toBe(1);
    expect(sendBroadcastRecipient).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'template', templateName: 'promo_july', accessToken: 'tok' }),
      expect.objectContaining({ phone: '14155550123', params: ['Jane'] }),
    );
  });
});
