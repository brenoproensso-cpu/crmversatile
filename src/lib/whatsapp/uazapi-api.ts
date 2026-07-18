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

export interface UazapiMenuButton {
  id: string
  title: string
}

export interface SendUazapiButtonsArgs {
  to: string
  bodyText: string
  buttons: UazapiMenuButton[]
  headerText?: string
  footerText?: string
  contextMessageId?: string
}

/**
 * UAZAPI has no separate header field for `/send/menu` — fold it into
 * the leading line of `text` since that's the closest visual match.
 */
function withHeader(bodyText: string, headerText?: string): string {
  return headerText ? `${headerText}\n\n${bodyText}` : bodyText
}

/**
 * Send interactive reply buttons via UAZAPI's unified `/send/menu`
 * endpoint (`type: "button"`). Each choice is `"title|id"` so the
 * button id we assign (and expect back on tap) survives the round
 * trip — see docs.uazapi.com/endpoint/post/send~menu.
 */
export async function sendUazapiButtons(
  creds: UazapiCredentials,
  args: SendUazapiButtonsArgs,
): Promise<UazapiSendResult> {
  const body: Record<string, unknown> = {
    number: args.to,
    type: 'button',
    text: withHeader(args.bodyText, args.headerText),
    choices: args.buttons.map((b) => `${b.title}|${b.id}`),
  }
  if (args.footerText) body.footerText = args.footerText
  if (args.contextMessageId) body.replyid = args.contextMessageId
  return postUazapi(creds, '/send/menu', body)
}

export interface UazapiMenuListRow {
  id: string
  title: string
  description?: string
}

export interface UazapiMenuListSection {
  title?: string
  rows: UazapiMenuListRow[]
}

export interface SendUazapiListArgs {
  to: string
  bodyText: string
  buttonLabel: string
  sections: UazapiMenuListSection[]
  headerText?: string
  footerText?: string
  contextMessageId?: string
}

/**
 * Send an interactive list via UAZAPI's `/send/menu` endpoint
 * (`type: "list"`). Section headers are `"[Title]"` entries; rows are
 * `"title|id|description"` — see docs.uazapi.com/endpoint/post/send~menu.
 */
export async function sendUazapiList(
  creds: UazapiCredentials,
  args: SendUazapiListArgs,
): Promise<UazapiSendResult> {
  const choices: string[] = []
  for (const section of args.sections) {
    if (section.title) choices.push(`[${section.title}]`)
    for (const row of section.rows) {
      choices.push(
        row.description ? `${row.title}|${row.id}|${row.description}` : `${row.title}|${row.id}`,
      )
    }
  }
  const body: Record<string, unknown> = {
    number: args.to,
    type: 'list',
    text: withHeader(args.bodyText, args.headerText),
    choices,
    listButton: args.buttonLabel,
  }
  if (args.footerText) body.footerText = args.footerText
  if (args.contextMessageId) body.replyid = args.contextMessageId
  return postUazapi(creds, '/send/menu', body)
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
