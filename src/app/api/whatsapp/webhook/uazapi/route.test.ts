import { beforeEach, describe, expect, it, vi } from 'vitest'

const configs = [
  { account_id: 'acct-1', user_id: 'user-1', webhook_secret: 'encrypted:secret-1', uazapi_token: 'encrypted:token-1' },
  { account_id: 'acct-2', user_id: 'user-2', webhook_secret: 'encrypted:secret-2', uazapi_token: 'encrypted:token-2' },
]

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn((v: string) => v.replace(/^encrypted:/, '')),
}))

const { ingestInboundMessage, ingestStatusUpdate } = vi.hoisted(() => ({
  ingestInboundMessage: vi.fn(async () => {}),
  ingestStatusUpdate: vi.fn(async () => {}),
}))
vi.mock('@/lib/whatsapp/inbound', () => ({ ingestInboundMessage, ingestStatusUpdate }))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => Promise.resolve({ data: configs, error: null }),
      }),
    }),
  }),
}))

import { POST } from './route'

function postEvent(key: string, body: Record<string, unknown>) {
  return POST(
    new Request(`http://localhost/api/whatsapp/webhook/uazapi?key=${key}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/whatsapp/webhook/uazapi', () => {
  it('rejects a missing key', async () => {
    const res = await postEvent('', { EventType: 'messages', token: 'token-1', message: {} })
    expect(res.status).toBe(401)
  })

  it('rejects a key that matches no config', async () => {
    const res = await postEvent('wrong-secret', { EventType: 'messages', token: 'token-1', message: {} })
    expect(res.status).toBe(401)
  })

  it('rejects when the payload token does not match the resolved account', async () => {
    const res = await postEvent('secret-1', { EventType: 'messages', token: 'token-2', message: {} })
    expect(res.status).toBe(401)
  })

  it('resolves the account and ingests a real-shaped messages event', async () => {
    const res = await postEvent('secret-1', {
      EventType: 'messages',
      token: 'token-1',
      instanceName: 'crm',
      message: {
        messageid: '3A57290C27829E4717BB',
        chatid: '556391106266@s.whatsapp.net',
        messageType: 'Conversation',
        text: 'Oi',
      },
    })
    expect(res.status).toBe(200)
    expect(ingestInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct-1', providerMessageId: '3A57290C27829E4717BB' }),
    )
  })

  it('resolves the account and ingests a real-shaped messages_update batch', async () => {
    const res = await postEvent('secret-2', {
      EventType: 'messages_update',
      token: 'token-2',
      event: { MessageIDs: ['id1', 'id2'], Timestamp: 1783738083, Type: 'Delivered' },
      state: 'Delivered',
    })
    expect(res.status).toBe(200)
    expect(ingestStatusUpdate).toHaveBeenCalledTimes(2)
    expect(ingestStatusUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ providerMessageId: 'id1', status: 'delivered' }),
    )
    expect(ingestStatusUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ providerMessageId: 'id2', status: 'delivered' }),
    )
  })

  it('acks 200 without ingesting for an unhandled event type', async () => {
    const res = await postEvent('secret-1', { EventType: 'connection', token: 'token-1' })
    expect(res.status).toBe(200)
    expect(ingestInboundMessage).not.toHaveBeenCalled()
    expect(ingestStatusUpdate).not.toHaveBeenCalled()
  })
})
