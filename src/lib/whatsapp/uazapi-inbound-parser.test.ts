import { describe, expect, it } from 'vitest'
import { parseUazapiMessageEvent, parseUazapiStatusEvent } from './uazapi-inbound-parser'

const BASE = { accountId: 'acct-1', configOwnerUserId: 'user-1' }

describe('parseUazapiMessageEvent', () => {
  it('parses a plain text message', () => {
    const result = parseUazapiMessageEvent(
      {
        messageid: 'wamid.1',
        chatid: '5511999999999@s.whatsapp.net',
        senderName: 'Alice',
        isGroup: false,
        fromMe: false,
        messageType: 'conversation',
        messageTimestamp: 1752191999000,
        text: 'oi',
      },
      BASE.accountId,
      BASE.configOwnerUserId,
    )

    expect(result).toEqual({
      kind: 'message',
      accountId: 'acct-1',
      configOwnerUserId: 'user-1',
      senderPhone: '5511999999999',
      senderName: 'Alice',
      providerMessageId: 'wamid.1',
      timestamp: new Date(1752191999000),
      contentType: 'text',
      contentText: 'oi',
      mediaUrl: null,
      interactiveReplyId: null,
      replyToProviderId: null,
    })
  })

  it('parses an image message with a caption and fileURL, no download needed', () => {
    const result = parseUazapiMessageEvent(
      {
        messageid: 'wamid.2',
        chatid: '5511999999999@s.whatsapp.net',
        senderName: 'Alice',
        messageType: 'imageMessage',
        messageTimestamp: 1752191999000,
        text: 'legenda',
        fileURL: 'https://crmversatile.uazapi.com/files/abc.jpg',
      },
      BASE.accountId,
      BASE.configOwnerUserId,
    )

    expect(result).toMatchObject({
      kind: 'message',
      contentType: 'image',
      contentText: 'legenda',
      mediaUrl: 'https://crmversatile.uazapi.com/files/abc.jpg',
    })
  })

  it('parses a reaction — emoji in `text`, target id in `reaction`', () => {
    const result = parseUazapiMessageEvent(
      {
        messageid: 'wamid.3',
        chatid: '5511999999999@s.whatsapp.net',
        senderName: 'Alice',
        messageType: 'reactionMessage',
        text: '👍',
        reaction: 'wamid.1',
      },
      BASE.accountId,
      BASE.configOwnerUserId,
    )

    expect(result).toMatchObject({
      kind: 'reaction',
      targetProviderMessageId: 'wamid.1',
      emoji: '👍',
    })
  })

  it('carries the quoted id as replyToProviderId', () => {
    const result = parseUazapiMessageEvent(
      {
        messageid: 'wamid.4',
        chatid: '5511999999999@s.whatsapp.net',
        messageType: 'conversation',
        text: 'respondendo',
        quoted: 'wamid.1',
      },
      BASE.accountId,
      BASE.configOwnerUserId,
    )

    expect(result).toMatchObject({ replyToProviderId: 'wamid.1' })
  })

  it('drops group messages', () => {
    const result = parseUazapiMessageEvent(
      { messageid: 'wamid.5', chatid: '123-456@g.us', isGroup: true, text: 'oi grupo' },
      BASE.accountId,
      BASE.configOwnerUserId,
    )
    expect(result).toBeNull()
  })

  it('drops self-sent echoes', () => {
    const result = parseUazapiMessageEvent(
      { messageid: 'wamid.6', chatid: '5511999999999@s.whatsapp.net', fromMe: true, text: 'oi' },
      BASE.accountId,
      BASE.configOwnerUserId,
    )
    expect(result).toBeNull()
  })

  it('drops a payload with no chatid or messageid', () => {
    expect(parseUazapiMessageEvent({ text: 'oi' }, BASE.accountId, BASE.configOwnerUserId)).toBeNull()
  })
})

describe('parseUazapiStatusEvent', () => {
  it('maps Sent/Delivered/Read to the internal ladder', () => {
    expect(
      parseUazapiStatusEvent({ messageid: 'wamid.1', status: 'Sent', messageTimestamp: 1752191999000 }),
    ).toEqual({ providerMessageId: 'wamid.1', status: 'sent', timestamp: new Date(1752191999000) })

    expect(parseUazapiStatusEvent({ messageid: 'wamid.1', status: 'Delivered' })?.status).toBe('delivered')
    expect(parseUazapiStatusEvent({ messageid: 'wamid.1', status: 'Read' })?.status).toBe('read')
  })

  it('maps Canceled and Failed to failed', () => {
    expect(parseUazapiStatusEvent({ messageid: 'wamid.1', status: 'Canceled' })?.status).toBe('failed')
    expect(parseUazapiStatusEvent({ messageid: 'wamid.1', status: 'Failed' })?.status).toBe('failed')
  })

  it('ignores Queued (no forward-ladder meaning)', () => {
    expect(parseUazapiStatusEvent({ messageid: 'wamid.1', status: 'Queued' })).toBeNull()
  })

  it('ignores a payload with no messageid', () => {
    expect(parseUazapiStatusEvent({ status: 'Sent' })).toBeNull()
  })
})
