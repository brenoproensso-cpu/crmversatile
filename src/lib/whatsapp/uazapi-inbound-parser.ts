import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import type { NormalizedInboundEvent, NormalizedMessageContentType, NormalizedStatusUpdate } from '@/lib/whatsapp/inbound'

export interface UazapiMessagePayload {
  messageid?: string
  chatid?: string
  senderName?: string
  isGroup?: boolean
  fromMe?: boolean
  messageType?: string
  messageTimestamp?: number
  status?: string
  text?: string
  quoted?: string
  reaction?: string
  fileURL?: string
}

// Baileys-style message-type keys — UAZAPI wraps a Baileys-based WhatsApp
// Web client. INFERRED, not confirmed against a real payload; Task 4
// corrects this against a live capture before the parser is considered final.
const CONTENT_TYPE_MAP: Record<string, NormalizedMessageContentType> = {
  conversation: 'text',
  extendedTextMessage: 'text',
  imageMessage: 'image',
  videoMessage: 'video',
  documentMessage: 'document',
  audioMessage: 'audio',
  pttMessage: 'audio',
  stickerMessage: 'image',
  locationMessage: 'location',
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

  const contentType = CONTENT_TYPE_MAP[data.messageType ?? ''] ?? 'text'

  return {
    ...base,
    kind: 'message',
    contentType,
    contentText: data.text || null,
    mediaUrl: data.fileURL || null,
    interactiveReplyId: null,
    replyToProviderId: data.quoted || null,
  }
}

const STATUS_MAP: Record<string, NormalizedStatusUpdate['status']> = {
  Sent: 'sent',
  Delivered: 'delivered',
  Read: 'read',
  Canceled: 'failed',
  Failed: 'failed',
}

export function parseUazapiStatusEvent(data: UazapiMessagePayload): NormalizedStatusUpdate | null {
  if (!data.messageid || !data.status) return null
  const status = STATUS_MAP[data.status]
  if (!status) return null // Queued (and anything unrecognized) has no forward-ladder meaning
  return {
    providerMessageId: data.messageid,
    status,
    timestamp: data.messageTimestamp ? new Date(data.messageTimestamp) : new Date(),
  }
}
