import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import type { NormalizedInboundEvent, NormalizedMessageContentType, NormalizedStatusUpdate } from '@/lib/whatsapp/inbound'

/**
 * Shape of `payload.message` inside a real `EventType: "messages"` webhook
 * delivery — confirmed 2026-07-11 against a live UAZAPI instance's
 * webhook-error log (the OpenAPI spec's generic Message schema didn't
 * document the real casing or the enclosing envelope).
 */
export interface UazapiMessagePayload {
  messageid?: string
  chatid?: string
  senderName?: string
  isGroup?: boolean
  fromMe?: boolean
  messageType?: string
  messageTimestamp?: number
  text?: string
  quoted?: string
  reaction?: string
  fileURL?: string
  /**
   * Id of the button or list row the customer tapped, when this message
   * is a reply to a `/send/menu` prompt we sent. Documented on the
   * `Message` schema in UAZAPI's OpenAPI spec ("ID do botão ou item de
   * lista selecionado") — this is what makes the round trip back to the
   * `id` half of the `"title|id"` choices we send in `sendUazapiButtons`
   * / `sendUazapiList`.
   */
  buttonOrListid?: string
}

/**
 * Top-level webhook envelope for `EventType: "messages"`. Real field names
 * confirmed live: `EventType` (not `event`), the message nested under
 * `message` (not `data`), and `token` present directly (not an `instance`
 * id) — see `resolveConfigByWebhookKey` in the route, which uses `token`
 * for the secondary integrity check instead.
 */
export interface UazapiMessageEnvelope {
  EventType?: string
  message?: UazapiMessagePayload
  token?: string
  instanceName?: string
}

/**
 * Top-level webhook envelope for `EventType: "messages_update"`. Confirmed
 * live shape: a single event can batch-update MANY message ids at once
 * (`event.MessageIDs`), with one status (`state` / `event.Type`) applying
 * to the whole batch — not one id + one status as the OpenAPI spec's
 * generic Message schema implied.
 */
export interface UazapiStatusEnvelope {
  EventType?: string
  event?: {
    MessageIDs?: string[]
    Timestamp?: number
    Type?: string
  }
  state?: string
  token?: string
  instanceName?: string
}

// Baileys-style message-type keys, lowercased for comparison — UAZAPI's
// real payloads capitalize them (e.g. "Conversation"), confirmed live.
const CONTENT_TYPE_MAP: Record<string, NormalizedMessageContentType> = {
  conversation: 'text',
  extendedtextmessage: 'text',
  imagemessage: 'image',
  videomessage: 'video',
  documentmessage: 'document',
  audiomessage: 'audio',
  pttmessage: 'audio',
  stickermessage: 'image',
  locationmessage: 'location',
}

function chatIdToPhone(chatid: string): string {
  return normalizePhone(chatid.split('@')[0])
}

export function parseUazapiMessageEvent(
  data: UazapiMessagePayload,
  accountId: string,
  configOwnerUserId: string,
): NormalizedInboundEvent | null {
  if (!data.chatid || !data.messageid) return null
  if (data.isGroup || data.fromMe) return null

  const senderPhone = chatIdToPhone(data.chatid)
  const timestamp = data.messageTimestamp ? new Date(data.messageTimestamp) : new Date()
  const base = {
    accountId,
    configOwnerUserId,
    senderPhone,
    senderName: data.senderName || senderPhone,
    providerMessageId: data.messageid,
    timestamp,
  }

  if (data.reaction) {
    return {
      ...base,
      kind: 'reaction',
      targetProviderMessageId: data.reaction,
      emoji: data.text || null,
    }
  }

  const contentType = CONTENT_TYPE_MAP[(data.messageType ?? '').toLowerCase()] ?? 'text'

  return {
    ...base,
    kind: 'message',
    contentType,
    contentText: data.text || null,
    mediaUrl: data.fileURL || null,
    interactiveReplyId: data.buttonOrListid || null,
    replyToProviderId: data.quoted || null,
  }
}

// Lowercased for comparison — confirmed live value was "Delivered";
// the others are the documented enum siblings, not yet individually
// confirmed against a live payload.
const STATUS_MAP: Record<string, NormalizedStatusUpdate['status']> = {
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  played: 'read',
  canceled: 'failed',
  failed: 'failed',
}

/**
 * Confirmed live: a single messages_update event can batch many message
 * ids under one status, so this returns one NormalizedStatusUpdate per id
 * rather than a single result.
 */
export function parseUazapiStatusEvent(payload: UazapiStatusEnvelope): NormalizedStatusUpdate[] {
  const ids = payload.event?.MessageIDs
  if (!ids || ids.length === 0) return []

  const statusRaw = (payload.state || payload.event?.Type || '').toLowerCase()
  const status = STATUS_MAP[statusRaw]
  if (!status) return [] // Queued (and anything unrecognized) has no forward-ladder meaning

  const timestamp = payload.event?.Timestamp ? new Date(payload.event.Timestamp * 1000) : new Date()

  return ids.map((providerMessageId) => ({ providerMessageId, status, timestamp }))
}
