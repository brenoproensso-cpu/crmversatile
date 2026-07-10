import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sendMediaMessage,
  sendReactionMessage,
  sendTextMessage,
  type MediaKind,
} from '@/lib/whatsapp/meta-api'
import {
  sendUazapiMedia,
  sendUazapiReaction,
  sendUazapiText,
} from '@/lib/whatsapp/uazapi-api'

export interface WhatsAppConfigRow {
  /** Defaults to 'meta' when absent — keeps pre-migration rows/callers on the existing path. */
  provider?: 'meta' | 'uazapi'
  phone_number_id?: string
  access_token?: string
  uazapi_server_url?: string
  uazapi_instance_id?: string
  uazapi_token?: string
}

export interface WhatsAppSendResult {
  messageId: string
}

export interface SendTextArgs {
  to: string
  text: string
  contextMessageId?: string
}

export interface SendMediaArgs {
  to: string
  kind: MediaKind
  link: string
  caption?: string
  filename?: string
  contextMessageId?: string
}

export interface SendReactionArgs {
  to: string
  targetMessageId: string
  emoji: string
}

export interface WhatsAppProvider {
  sendText(args: SendTextArgs): Promise<WhatsAppSendResult>
  sendMedia(args: SendMediaArgs): Promise<WhatsAppSendResult>
  sendReaction(args: SendReactionArgs): Promise<WhatsAppSendResult>
}

class MetaProvider implements WhatsAppProvider {
  constructor(private readonly config: WhatsAppConfigRow) {}

  async sendText(args: SendTextArgs): Promise<WhatsAppSendResult> {
    return sendTextMessage({
      phoneNumberId: this.config.phone_number_id!,
      accessToken: decrypt(this.config.access_token!),
      to: args.to,
      text: args.text,
      contextMessageId: args.contextMessageId,
    })
  }

  async sendMedia(args: SendMediaArgs): Promise<WhatsAppSendResult> {
    return sendMediaMessage({
      phoneNumberId: this.config.phone_number_id!,
      accessToken: decrypt(this.config.access_token!),
      to: args.to,
      kind: args.kind,
      link: args.link,
      caption: args.caption,
      filename: args.filename,
      contextMessageId: args.contextMessageId,
    })
  }

  async sendReaction(args: SendReactionArgs): Promise<WhatsAppSendResult> {
    return sendReactionMessage({
      phoneNumberId: this.config.phone_number_id!,
      accessToken: decrypt(this.config.access_token!),
      to: args.to,
      targetMessageId: args.targetMessageId,
      emoji: args.emoji,
    })
  }
}

class UazapiProvider implements WhatsAppProvider {
  constructor(private readonly config: WhatsAppConfigRow) {}

  private get creds() {
    return {
      serverUrl: this.config.uazapi_server_url!,
      token: decrypt(this.config.uazapi_token!),
    }
  }

  async sendText(args: SendTextArgs): Promise<WhatsAppSendResult> {
    return sendUazapiText(this.creds, args)
  }

  async sendMedia(args: SendMediaArgs): Promise<WhatsAppSendResult> {
    return sendUazapiMedia(this.creds, args)
  }

  async sendReaction(args: SendReactionArgs): Promise<WhatsAppSendResult> {
    return sendUazapiReaction(this.creds, args)
  }
}

export function getWhatsAppProvider(config: WhatsAppConfigRow): WhatsAppProvider {
  if (config.provider === 'uazapi') {
    return new UazapiProvider(config)
  }
  return new MetaProvider(config)
}
