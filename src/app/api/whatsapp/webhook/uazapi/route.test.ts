import { beforeEach, describe, expect, it, vi } from 'vitest'

const configs = [
  { id: 'row-1', account_id: 'acct-1', user_id: 'user-1', webhook_secret: 'encrypted:secret-1', uazapi_instance_id: 'inst-1' },
  { id: 'row-2', account_id: 'acct-2', user_id: 'user-2', webhook_secret: 'encrypted:secret-2', uazapi_instance_id: 'inst-2' },
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
    const res = await postEvent('', { event: 'messages', instance: 'inst-1', data: {} })
    expect(res.status).toBe(401)
  })

  it('rejects a key that matches no config', async () => {
    const res = await postEvent('wrong-secret', { event: 'messages', instance: 'inst-1', data: {} })
    expect(res.status).toBe(401)
  })

  it('rejects when the instance id does not match the resolved account', async () => {
    const res = await postEvent('secret-1', { event: 'messages', instance: 'inst-2', data: {} })
    expect(res.status).toBe(401)
  })

  it('resolves the account and ingests a messages event', async () => {
    const res = await postEvent('secret-1', {
      event: 'messages',
      instance: 'inst-1',
      data: {
        messageid: 'wamid.1',
        chatid: '5511999999999@s.whatsapp.net',
        messageType: 'conversation',
        text: 'oi',
      },
    })
    expect(res.status).toBe(200)
    expect(ingestInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct-1', providerMessageId: 'wamid.1' }),
    )
  })

  it('resolves the account and ingests a messages_update event', async () => {
    const res = await postEvent('secret-2', {
      event: 'messages_update',
      instance: 'inst-2',
      data: { messageid: 'wamid.1', status: 'Delivered' },
    })
    expect(res.status).toBe(200)
    expect(ingestStatusUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ providerMessageId: 'wamid.1', status: 'delivered' }),
    )
  })

  it('acks 200 without ingesting for an unhandled event type', async () => {
    const res = await postEvent('secret-1', { event: 'connection', instance: 'inst-1', data: {} })
    expect(res.status).toBe(200)
    expect(ingestInboundMessage).not.toHaveBeenCalled()
    expect(ingestStatusUpdate).not.toHaveBeenCalled()
  })
})
