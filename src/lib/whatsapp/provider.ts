import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sendInteractiveButtons,
  sendInteractiveList,
  sendMediaMessage,
  sendReactionMessage,
  sendTextMessage,
  type MediaKind,
} from '@/lib/whatsapp/meta-api'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import {
  sendUazapiButtons,
  sendUazapiList,
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

export interface SendInteractiveArgs {
  to: string
  payload: InteractiveMessagePayload
  contextMessageId?: string
}

export interface WhatsAppProvider {
  sendText(args: SendTextArgs): Promise<WhatsAppSendResult>
  sendMedia(args: SendMediaArgs): Promise<WhatsAppSendResult>
  sendReaction(args: SendReactionArgs): Promise<WhatsAppSendResult>
  sendInteractive(args: SendInteractiveArgs): Promise<WhatsAppSendResult>
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

  async sendInteractive(args: SendInteractiveArgs): Promise<WhatsAppSendResult> {
    const phoneNumberId = this.config.phone_number_id!
    const accessToken = decrypt(this.config.access_token!)
    if (args.payload.kind === 'buttons') {
      return sendInteractiveButtons({
        phoneNumberId,
        accessToken,
        to: args.to,
        bodyText: args.payload.body,
        headerText: args.payload.header,
        footerText: args.payload.footer,
        buttons: args.payload.buttons,
        contextMessageId: args.contextMessageId,
      })
    }
    return sendInteractiveList({
      phoneNumberId,
      accessToken,
      to: args.to,
      bodyText: args.payload.body,
      buttonLabel: args.payload.button_label,
      headerText: args.payload.header,
      footerText: args.payload.footer,
      sections: args.payload.sections,
      contextMessageId: args.contextMessageId,
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

  async sendInteractive(args: SendInteractiveArgs): Promise<WhatsAppSendResult> {
    if (args.payload.kind === 'buttons') {
      return sendUazapiButtons(this.creds, {
        to: args.to,
        bodyText: args.payload.body,
        headerText: args.payload.header,
        footerText: args.payload.footer,
        buttons: args.payload.buttons,
        contextMessageId: args.contextMessageId,
      })
    }
    return sendUazapiList(this.creds, {
      to: args.to,
      bodyText: args.payload.body,
      buttonLabel: args.payload.button_label,
      headerText: args.payload.header,
      footerText: args.payload.footer,
      sections: args.payload.sections,
      contextMessageId: args.contextMessageId,
    })
  }
}

export function getWhatsAppProvider(config: WhatsAppConfigRow): WhatsAppProvider {
  if (config.provider === 'uazapi') {
    return new UazapiProvider(config)
  }
  return new MetaProvider(config)
}
