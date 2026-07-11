import { throwUazapiError, uazapiUrl } from '@/lib/whatsapp/uazapi-http'
import type { MediaKind } from '@/lib/whatsapp/meta-api'

export interface UazapiCredentials {
  serverUrl: string
  token: string
}

export interface UazapiSendResult {
  messageId: string
}

interface UazapiMessageResponse {
  messageid: string
}

async function postUazapi(
  creds: UazapiCredentials,
  path: string,
  body: Record<string, unknown>,
): Promise<UazapiSendResult> {
  const response = await fetch(uazapiUrl(creds.serverUrl, path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      token: creds.token,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI API error: ${response.status}`)
  }
  const data = (await response.json()) as UazapiMessageResponse
  return { messageId: data.messageid }
}

export interface SendUazapiTextArgs {
  to: string
  text: string
  contextMessageId?: string
}

export async function sendUazapiText(
  creds: UazapiCredentials,
  args: SendUazapiTextArgs,
): Promise<UazapiSendResult> {
  const body: Record<string, unknown> = { number: args.to, text: args.text }
  if (args.contextMessageId) body.replyid = args.contextMessageId
  return postUazapi(creds, '/send/text', body)
}

export interface SendUazapiMediaArgs {
  to: string
  kind: MediaKind
  link: string
  caption?: string
  filename?: string
  contextMessageId?: string
}

export async function sendUazapiMedia(
  creds: UazapiCredentials,
  args: SendUazapiMediaArgs,
): Promise<UazapiSendResult> {
  const body: Record<string, unknown> = {
    number: args.to,
    type: args.kind,
    file: args.link,
  }
  if (args.caption) body.text = args.caption
  if (args.kind === 'document' && args.filename) body.docName = args.filename
  if (args.contextMessageId) body.replyid = args.contextMessageId
  return postUazapi(creds, '/send/media', body)
}

export interface SendUazapiReactionArgs {
  to: string
  targetMessageId: string
  emoji: string
}

export async function sendUazapiReaction(
  creds: UazapiCredentials,
  args: SendUazapiReactionArgs,
): Promise<UazapiSendResult> {
  return postUazapi(creds, '/message/react', {
    number: args.to,
    text: args.emoji,
    id: args.targetMessageId,
  })
}
