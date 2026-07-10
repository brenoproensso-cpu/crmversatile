import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTextMessage: vi.fn(),
  sendMediaMessage: vi.fn(),
  sendReactionMessage: vi.fn(),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn((v: string) => `decrypted:${v}`),
}))

import {
  sendTextMessage,
  sendMediaMessage,
  sendReactionMessage,
} from '@/lib/whatsapp/meta-api'
import { getWhatsAppProvider } from './provider'

const CONFIG = { phone_number_id: 'PNID123', access_token: 'enc-token' }

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
