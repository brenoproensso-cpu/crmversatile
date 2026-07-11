import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTextMessage: vi.fn(),
  sendMediaMessage: vi.fn(),
  sendReactionMessage: vi.fn(),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn((v: string) => `decrypted:${v}`),
}))
vi.mock('@/lib/whatsapp/uazapi-api', () => ({
  sendUazapiText: vi.fn(),
  sendUazapiMedia: vi.fn(),
  sendUazapiReaction: vi.fn(),
}))

import {
  sendTextMessage,
  sendMediaMessage,
  sendReactionMessage,
} from '@/lib/whatsapp/meta-api'
import {
  sendUazapiText,
  sendUazapiMedia,
  sendUazapiReaction,
} from '@/lib/whatsapp/uazapi-api'
import { getWhatsAppProvider } from './provider'

const CONFIG = { provider: 'meta' as const, phone_number_id: 'PNID123', access_token: 'enc-token' }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('MetaProvider', () => {
  it('sendText forwards to sendTextMessage with the decrypted token', async () => {
    vi.mocked(sendTextMessage).mockResolvedValue({ messageId: 'wamid.1' })
    const provider = getWhatsAppProvider(CONFIG)

    const result = await provider.sendText({
      to: '+15551234',
      text: 'hi',
      contextMessageId: 'ctx1',
    })

    expect(sendTextMessage).toHaveBeenCalledWith({
      phoneNumberId: 'PNID123',
      accessToken: 'decrypted:enc-token',
      to: '+15551234',
      text: 'hi',
      contextMessageId: 'ctx1',
    })
    expect(result).toEqual({ messageId: 'wamid.1' })
  })

  it('sendMedia forwards to sendMediaMessage with the decrypted token', async () => {
    vi.mocked(sendMediaMessage).mockResolvedValue({ messageId: 'wamid.2' })
    const provider = getWhatsAppProvider(CONFIG)

    const result = await provider.sendMedia({
      to: '+15551234',
      kind: 'image',
      link: 'https://example.com/img.jpg',
      caption: 'cap',
    })

    expect(sendMediaMessage).toHaveBeenCalledWith({
      phoneNumberId: 'PNID123',
      accessToken: 'decrypted:enc-token',
      to: '+15551234',
      kind: 'image',
      link: 'https://example.com/img.jpg',
      caption: 'cap',
      filename: undefined,
      contextMessageId: undefined,
    })
    expect(result).toEqual({ messageId: 'wamid.2' })
  })

  it('sendReaction forwards to sendReactionMessage with the decrypted token', async () => {
    vi.mocked(sendReactionMessage).mockResolvedValue({ messageId: 'wamid.3' })
    const provider = getWhatsAppProvider(CONFIG)

    const result = await provider.sendReaction({
      to: '+15551234',
      targetMessageId: 'wamid.0',
      emoji: '👍',
    })

    expect(sendReactionMessage).toHaveBeenCalledWith({
      phoneNumberId: 'PNID123',
      accessToken: 'decrypted:enc-token',
      to: '+15551234',
      targetMessageId: 'wamid.0',
      emoji: '👍',
    })
    expect(result).toEqual({ messageId: 'wamid.3' })
  })
})

const UAZAPI_CONFIG = {
  provider: 'uazapi' as const,
  uazapi_server_url: 'https://free.uazapi.com',
  uazapi_token: 'enc-uazapi-token',
}

describe('UazapiProvider', () => {
  it('sendText forwards to sendUazapiText with the decrypted token', async () => {
    vi.mocked(sendUazapiText).mockResolvedValue({ messageId: 'wamid.1' })
    const provider = getWhatsAppProvider(UAZAPI_CONFIG)

    const result = await provider.sendText({ to: '+15551234', text: 'hi', contextMessageId: 'ctx1' })

    expect(sendUazapiText).toHaveBeenCalledWith(
      { serverUrl: 'https://free.uazapi.com', token: 'decrypted:enc-uazapi-token' },
      { to: '+15551234', text: 'hi', contextMessageId: 'ctx1' },
    )
    expect(result).toEqual({ messageId: 'wamid.1' })
  })

  it('sendMedia forwards to sendUazapiMedia with the decrypted token', async () => {
    vi.mocked(sendUazapiMedia).mockResolvedValue({ messageId: 'wamid.2' })
    const provider = getWhatsAppProvider(UAZAPI_CONFIG)

    const result = await provider.sendMedia({
      to: '+15551234',
      kind: 'image',
      link: 'https://example.com/img.jpg',
      caption: 'cap',
    })

    expect(sendUazapiMedia).toHaveBeenCalledWith(
      { serverUrl: 'https://free.uazapi.com', token: 'decrypted:enc-uazapi-token' },
      {
        to: '+15551234',
        kind: 'image',
        link: 'https://example.com/img.jpg',
        caption: 'cap',
        filename: undefined,
        contextMessageId: undefined,
      },
    )
    expect(result).toEqual({ messageId: 'wamid.2' })
  })

  it('sendReaction forwards to sendUazapiReaction with the decrypted token', async () => {
    vi.mocked(sendUazapiReaction).mockResolvedValue({ messageId: 'wamid.3' })
    const provider = getWhatsAppProvider(UAZAPI_CONFIG)

    const result = await provider.sendReaction({
      to: '+15551234',
      targetMessageId: 'wamid.0',
      emoji: '👍',
    })

    expect(sendUazapiReaction).toHaveBeenCalledWith(
      { serverUrl: 'https://free.uazapi.com', token: 'decrypted:enc-uazapi-token' },
      { to: '+15551234', targetMessageId: 'wamid.0', emoji: '👍' },
    )
    expect(result).toEqual({ messageId: 'wamid.3' })
  })
})

describe('getWhatsAppProvider — defaulting', () => {
  it('defaults to MetaProvider when `provider` is absent (back-compat for pre-migration rows)', async () => {
    vi.mocked(sendTextMessage).mockResolvedValue({ messageId: 'wamid.legacy' })
    const provider = getWhatsAppProvider({ phone_number_id: 'PNID123', access_token: 'enc-token' })

    await provider.sendText({ to: '+15551234', text: 'hi' })

    expect(sendTextMessage).toHaveBeenCalled()
  })
})
