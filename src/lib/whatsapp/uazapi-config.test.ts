import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/whatsapp/uazapi-instance', () => ({
  getUazapiInstanceStatus: vi.fn(),
  connectUazapiInstance: vi.fn(),
  registerUazapiWebhook: vi.fn(),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: vi.fn((v: string) => `encrypted:${v}`),
  decrypt: vi.fn((v: string) => v.replace(/^encrypted:/, '')),
}))

import {
  connectUazapiInstance,
  getUazapiInstanceStatus,
  registerUazapiWebhook,
} from '@/lib/whatsapp/uazapi-instance'
import { checkUazapiConfigHealth, saveAndConnectUazapiConfig } from './uazapi-config'

function fakeSupabase(overrides: Record<string, unknown> = {}) {
  const maybeSingleMock = vi.fn().mockResolvedValue({ data: null, error: null })
  const chain = {
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    maybeSingle: maybeSingleMock,
    ...overrides,
  }
  return chain as unknown as {
    from: typeof chain.from
  }
}

describe('saveAndConnectUazapiConfig', () => {
  beforeEach(() => {
    vi.mocked(getUazapiInstanceStatus).mockResolvedValue({
      instanceId: 'r00cd19ce7afc39',
      status: 'connecting',
      connected: false,
      qrcode: null,
    })
    vi.mocked(connectUazapiInstance).mockResolvedValue({
      qrcode: 'data:image/png;base64,abc',
    })
    vi.mocked(registerUazapiWebhook).mockResolvedValue(undefined)
  })

  it('validates credentials, checks for a claimed instance, registers the webhook, connects, and returns the qrcode', async () => {
    const supabase = fakeSupabase()
    const adminClient = fakeSupabase()

    const result = await saveAndConnectUazapiConfig(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adminClient as any,
      'account-1',
      'user-1',
      null,
      { serverUrl: 'https://free.uazapi.com', token: 'inst-token' },
      'https://crm.example.com',
    )

    expect(getUazapiInstanceStatus).toHaveBeenCalledWith({
      serverUrl: 'https://free.uazapi.com',
      token: 'inst-token',
    })
    expect(registerUazapiWebhook).toHaveBeenCalledWith(
      { serverUrl: 'https://free.uazapi.com', token: 'inst-token' },
      expect.stringMatching(
        /^https:\/\/crm\.example\.com\/api\/whatsapp\/webhook\/uazapi\?key=[0-9a-f]{48}$/,
      ),
    )
    expect(connectUazapiInstance).toHaveBeenCalledWith({
      serverUrl: 'https://free.uazapi.com',
      token: 'inst-token',
    })
    expect(result).toEqual({ qrcode: 'data:image/png;base64,abc' })
  })

  it('throws when the instance is already claimed by another account', async () => {
    const supabase = fakeSupabase()
    const adminClient = fakeSupabase({
      maybeSingle: vi.fn().mockResolvedValue({ data: { account_id: 'other-account' }, error: null }),
    })

    await expect(
      saveAndConnectUazapiConfig(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        supabase as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        adminClient as any,
        'account-1',
        'user-1',
        null,
        { serverUrl: 'https://free.uazapi.com', token: 'inst-token' },
        'https://crm.example.com',
      ),
    ).rejects.toThrow(/already linked to another account/)
  })

  it('surfaces the UAZAPI error message when the credentials are invalid', async () => {
    vi.mocked(getUazapiInstanceStatus).mockRejectedValue(new Error('Invalid token'))
    const supabase = fakeSupabase()
    const adminClient = fakeSupabase()

    await expect(
      saveAndConnectUazapiConfig(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        supabase as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        adminClient as any,
        'account-1',
        'user-1',
        null,
        { serverUrl: 'https://free.uazapi.com', token: 'bad-token' },
        'https://crm.example.com',
      ),
    ).rejects.toThrow('Invalid token')
  })

  it('skips /instance/connect and saves status=connected when the instance is already connected', async () => {
    vi.mocked(getUazapiInstanceStatus).mockResolvedValue({
      instanceId: 'r00cd19ce7afc39',
      status: 'connected',
      connected: true,
      qrcode: null,
    })
    const supabase = fakeSupabase()
    const adminClient = fakeSupabase()

    const result = await saveAndConnectUazapiConfig(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adminClient as any,
      'account-1',
      'user-1',
      null,
      { serverUrl: 'https://free.uazapi.com', token: 'inst-token' },
      'https://crm.example.com',
    )

    expect(connectUazapiInstance).not.toHaveBeenCalled()
    expect(result).toEqual({ qrcode: null })
  })
})

describe('checkUazapiConfigHealth', () => {
  it('reports live status without writing when nothing changed', async () => {
    vi.mocked(getUazapiInstanceStatus).mockResolvedValue({
      instanceId: 'r00cd19ce7afc39',
      status: 'connecting',
      connected: false,
      qrcode: 'data:image/png;base64,abc',
    })
    const supabase = fakeSupabase()

    const result = await checkUazapiConfigHealth(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      { id: 'row-1', uazapi_server_url: 'https://free.uazapi.com', uazapi_token: 'encrypted:inst-token', status: 'disconnected' },
    )

    expect(result).toEqual({ connected: false, status: 'connecting', qrcode: 'data:image/png;base64,abc' })
  })

  it('flips the row to connected when the live status newly reports connected', async () => {
    vi.mocked(getUazapiInstanceStatus).mockResolvedValue({
      instanceId: 'r00cd19ce7afc39',
      status: 'connected',
      connected: true,
      qrcode: null,
    })
    const updateMock = vi.fn().mockReturnThis()
    const supabase = fakeSupabase({ update: updateMock })

    await checkUazapiConfigHealth(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      { id: 'row-1', uazapi_server_url: 'https://free.uazapi.com', uazapi_token: 'encrypted:inst-token', status: 'disconnected' },
    )

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'connected' }),
    )
  })
})
