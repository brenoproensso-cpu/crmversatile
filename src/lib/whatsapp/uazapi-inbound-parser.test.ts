import { describe, expect, it } from 'vitest'
import { parseUazapiMessageEvent, parseUazapiStatusEvent } from './uazapi-inbound-parser'

const BASE = { accountId: 'acct-1', configOwnerUserId: 'user-1' }

describe('parseUazapiMessageEvent', () => {
  it('parses a plain text message (real captured shape: capitalized messageType)', () => {
    const result = parseUazapiMessageEvent(
      {
        messageid: '3A57290C27829E4717BB',
        chatid: '556391106266@s.whatsapp.net',
        senderName: 'Breno Proenço',
        isGroup: false,
        fromMe: false,
        messageType: 'Conversation',
        messageTimestamp: 1783738251000,
        text: 'Oi',
      },
      BASE.accountId,
      BASE.configOwnerUserId,
    )

    expect(result).toEqual({
      kind: 'message',
      accountId: 'acct-1',
      configOwnerUserId: 'user-1',
      senderPhone: '556391106266',
      senderName: 'Breno Proenço',
      providerMessageId: '3A57290C27829E4717BB',
      timestamp: new Date(1783738251000),
      contentType: 'text',
      contentText: 'Oi',
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
        messageType: 'ImageMessage',
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
        messageType: 'ReactionMessage',
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
        messageType: 'Conversation',
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
  it('maps a real captured Delivered batch to one update per message id', () => {
    const results = parseUazapiStatusEvent({
      EventType: 'messages_update',
      event: {
        MessageIDs: ['2A82573383C61D4C18A0', '2A65CBE478E7C52F97E1'],
        Timestamp: 1783738083,
        Type: 'Delivered',
      },
      state: 'Delivered',
    })

    expect(results).toEqual([
      { providerMessageId: '2A82573383C61D4C18A0', status: 'delivered', timestamp: new Date(1783738083 * 1000) },
      { providerMessageId: '2A65CBE478E7C52F97E1', status: 'delivered', timestamp: new Date(1783738083 * 1000) },
    ])
  })

  it('maps Sent/Read', () => {
    expect(
      parseUazapiStatusEvent({ event: { MessageIDs: ['id1'] }, state: 'Sent' })[0]?.status,
    ).toBe('sent')
    expect(
      parseUazapiStatusEvent({ event: { MessageIDs: ['id1'] }, state: 'Read' })[0]?.status,
    ).toBe('read')
  })

  it('maps Canceled and Failed to failed', () => {
    expect(
      parseUazapiStatusEvent({ event: { MessageIDs: ['id1'] }, state: 'Canceled' })[0]?.status,
    ).toBe('failed')
    expect(
      parseUazapiStatusEvent({ event: { MessageIDs: ['id1'] }, state: 'Failed' })[0]?.status,
    ).toBe('failed')
  })

  it('ignores Queued (no forward-ladder meaning)', () => {
    expect(parseUazapiStatusEvent({ event: { MessageIDs: ['id1'] }, state: 'Queued' })).toEqual([])
  })

  it('ignores a payload with no MessageIDs', () => {
    expect(parseUazapiStatusEvent({ state: 'Sent' })).toEqual([])
  })
})
