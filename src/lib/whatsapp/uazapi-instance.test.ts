import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectUazapiInstance,
  getUazapiInstanceStatus,
  registerUazapiWebhook,
} from './uazapi-instance'

const CREDS = { serverUrl: 'https://free.uazapi.com', token: 'inst-token' }

interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown> | null
}
let captured: CapturedRequest | null = null

function fetchReturning(responseBody: Record<string, unknown>, ok = true) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    captured = {
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(init.body as string) : null,
    }
    return { ok, json: async () => responseBody } as Response
  })
}

beforeEach(() => {
  captured = null
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getUazapiInstanceStatus', () => {
  it('parses the instance id, status, connected flag, and qrcode', async () => {
    vi.stubGlobal(
      'fetch',
      fetchReturning({
        instance: { id: 'r00cd19ce7afc39', status: 'connecting', qrcode: 'data:image/png;base64,abc' },
        status: { connected: false, loggedIn: false, jid: null },
      }),
    )

    const result = await getUazapiInstanceStatus(CREDS)

    expect(captured?.url).toBe('https://free.uazapi.com/instance/status')
    expect(captured?.headers.token).toBe('inst-token')
    expect(result).toEqual({
      instanceId: 'r00cd19ce7afc39',
      status: 'connecting',
      connected: false,
      qrcode: 'data:image/png;base64,abc',
    })
  })

  it('normalizes an empty qrcode string to null', async () => {
    vi.stubGlobal(
      'fetch',
      fetchReturning({
        instance: { id: 'r00cd19ce7afc39', status: 'disconnected', qrcode: '' },
        status: { connected: false },
      }),
    )

    const result = await getUazapiInstanceStatus(CREDS)
    expect(result.qrcode).toBeNull()
  })

  it('throws the UAZAPI error message on a non-2xx response', async () => {
    vi.stubGlobal('fetch', fetchReturning({ error: 'instance info not found' }, false))
    await expect(getUazapiInstanceStatus(CREDS)).rejects.toThrow('instance info not found')
  })
})

describe('connectUazapiInstance', () => {
  it('POSTs an empty body and returns the qrcode', async () => {
    vi.stubGlobal(
      'fetch',
      fetchReturning({ instance: { qrcode: 'data:image/png;base64,xyz' } }),
    )

    const result = await connectUazapiInstance(CREDS)

    expect(captured?.url).toBe('https://free.uazapi.com/instance/connect')
    expect(captured?.method).toBe('POST')
    expect(captured?.body).toEqual({})
    expect(result).toEqual({ qrcode: 'data:image/png;base64,xyz' })
  })
})

describe('registerUazapiWebhook', () => {
  it('POSTs the webhook URL with the required excludeMessages filter', async () => {
    vi.stubGlobal('fetch', fetchReturning({ id: 'wh-1' }))

    await registerUazapiWebhook(CREDS, 'https://crm.example.com/api/whatsapp/webhook/uazapi?key=secret')

    expect(captured?.url).toBe('https://free.uazapi.com/webhook')
    expect(captured?.body).toEqual({
      url: 'https://crm.example.com/api/whatsapp/webhook/uazapi?key=secret',
      events: ['messages', 'messages_update', 'connection'],
      excludeMessages: ['wasSentByApi'],
    })
  })
})
