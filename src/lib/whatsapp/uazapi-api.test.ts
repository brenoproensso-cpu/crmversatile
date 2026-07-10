import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendUazapiMedia, sendUazapiReaction, sendUazapiText } from './uazapi-api'

const CREDS = { serverUrl: 'https://free.uazapi.com', token: 'inst-token' }

interface CapturedRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}
let captured: CapturedRequest | null = null

function okFetch(responseBody: Record<string, unknown>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    captured = {
      url,
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(init.body as string) : {},
    }
    return { ok: true, json: async () => responseBody } as Response
  })
}

beforeEach(() => {
  captured = null
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sendUazapiText', () => {
  it('POSTs to /send/text with the token header and returns the messageid', async () => {
    vi.stubGlobal('fetch', okFetch({ id: 'internal-id', messageid: 'wamid.1' }))

    const result = await sendUazapiText(CREDS, { to: '5511999999999', text: 'oi' })

    expect(captured?.url).toBe('https://free.uazapi.com/send/text')
    expect(captured?.headers.token).toBe('inst-token')
    expect(captured?.body).toEqual({ number: '5511999999999', text: 'oi' })
    expect(result).toEqual({ messageId: 'wamid.1' })
  })

  it('includes replyid when contextMessageId is set', async () => {
    vi.stubGlobal('fetch', okFetch({ messageid: 'wamid.2' }))

    await sendUazapiText(CREDS, { to: '5511999999999', text: 'oi', contextMessageId: 'wamid.0' })

    expect(captured?.body).toEqual({ number: '5511999999999', text: 'oi', replyid: 'wamid.0' })
  })

  it('throws the UAZAPI error message on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({ error: 'Invalid token' }) }) as Response),
    )

    await expect(sendUazapiText(CREDS, { to: '5511999999999', text: 'oi' })).rejects.toThrow(
      'Invalid token',
    )
  })
})

describe('sendUazapiMedia', () => {
  it('sends an image with a caption and no docName', async () => {
    vi.stubGlobal('fetch', okFetch({ messageid: 'wamid.3' }))

    const result = await sendUazapiMedia(CREDS, {
      to: '5511999999999',
      kind: 'image',
      link: 'https://example.com/pic.jpg',
      caption: 'hello',
      filename: 'pic.jpg',
    })

    expect(captured?.url).toBe('https://free.uazapi.com/send/media')
    expect(captured?.body).toEqual({
      number: '5511999999999',
      type: 'image',
      file: 'https://example.com/pic.jpg',
      text: 'hello',
    })
    expect(result).toEqual({ messageId: 'wamid.3' })
  })

  it('sends a document with docName', async () => {
    vi.stubGlobal('fetch', okFetch({ messageid: 'wamid.4' }))

    await sendUazapiMedia(CREDS, {
      to: '5511999999999',
      kind: 'document',
      link: 'https://example.com/f.pdf',
      filename: 'contrato.pdf',
    })

    expect(captured?.body).toEqual({
      number: '5511999999999',
      type: 'document',
      file: 'https://example.com/f.pdf',
      docName: 'contrato.pdf',
    })
  })
})

describe('sendUazapiReaction', () => {
  it('sends the emoji and target message id', async () => {
    vi.stubGlobal('fetch', okFetch({ messageid: 'wamid.5' }))

    const result = await sendUazapiReaction(CREDS, {
      to: '5511999999999',
      targetMessageId: 'wamid.0',
      emoji: '👍',
    })

    expect(captured?.url).toBe('https://free.uazapi.com/message/react')
    expect(captured?.body).toEqual({ number: '5511999999999', text: '👍', id: 'wamid.0' })
    expect(result).toEqual({ messageId: 'wamid.5' })
  })
})
