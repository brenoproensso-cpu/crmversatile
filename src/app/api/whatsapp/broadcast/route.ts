import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard'
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'
import { getWhatsAppProvider } from '@/lib/whatsapp/provider'
import {
  sendBroadcastRecipient,
  type BroadcastSendContext,
} from '@/lib/whatsapp/broadcast-core'
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

interface BroadcastResult {
  phone: string
  status: 'sent' | 'failed'
  whatsapp_message_id?: string
  error?: string
}

/**
 * Meta accounts: two input shapes are accepted —
 *
 *   NEW (preferred — supports per-recipient variable substitution):
 *     { recipients: [{ phone, params: string[] }], template_name, template_language }
 *
 *   LEGACY (all phones receive the same params):
 *     { phone_numbers: string[], template_params: string[], template_name, template_language }
 *
 * UAZAPI accounts: `message_text` (required) + optional `media`
 * ({ kind, url, filename? }) replace `template_name` — the same text
 * and attachment go to every recipient (no per-recipient personalization
 * in v1, matching the design doc's UAZAPI scope decisions).
 */
interface NewRecipient {
  phone: string
  params?: string[]
  messageParams?: SendTimeParams
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Per-user broadcast budget. Note: this limits how often a user
    // can *start* a campaign, not how many messages go out inside
    // one — the fan-out loop below runs without additional gating.
    const limit = checkRateLimit(`broadcast:${user.id}`, RATE_LIMITS.broadcast)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    // Resolve the caller's account_id. whatsapp_config + templates
    // + broadcasts are all account-scoped post-multi-user, so the
    // old `.eq('user_id', user.id)` filters miss every row created
    // by a teammate.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const body = await request.json()
    const {
      recipients: newRecipients,
      phone_numbers,
      template_name,
      template_language,
      template_params,
      message_text,
      media,
    } = body

    // Normalize to a list of {phone, params} regardless of shape.
    let recipients: NewRecipient[]
    if (Array.isArray(newRecipients) && newRecipients.length > 0) {
      recipients = newRecipients
    } else if (Array.isArray(phone_numbers) && phone_numbers.length > 0) {
      const shared: string[] = Array.isArray(template_params)
        ? template_params
        : []
      recipients = phone_numbers.map((phone: string) => ({
        phone,
        params: shared,
      }))
    } else {
      return NextResponse.json(
        {
          error:
            'Provide either `recipients` (preferred) or `phone_numbers` — must be a non-empty array',
        },
        { status: 400 }
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        {
          error:
            'WhatsApp not configured. Please set up your WhatsApp integration first.',
        },
        { status: 400 }
      )
    }

    let sendContext: BroadcastSendContext

    if (config.provider === 'uazapi') {
      const messageText = typeof message_text === 'string' ? message_text.trim() : ''
      if (!messageText) {
        return NextResponse.json({ error: 'message_text is required' }, { status: 400 })
      }
      sendContext = {
        kind: 'freeText',
        provider: getWhatsAppProvider(config),
        messageText,
        media:
          media && typeof media === 'object' && typeof media.url === 'string'
            ? { kind: media.kind, url: media.url, filename: media.filename }
            : null,
      }
    } else {
      if (!template_name) {
        return NextResponse.json(
          { error: 'template_name is required' },
          { status: 400 }
        )
      }
      const accessToken = decrypt(config.access_token)

      // Load the template row once so sendTemplateMessage can build
      // header + button components on each iteration. Loading inside
      // the loop would N+1 against Supabase for every recipient.
      // Guard against a malformed local row crashing every send in
      // the loop with the same opaque TypeError — fail loudly once.
      const { data: rawTemplateRow } = await supabase
        .from('message_templates')
        .select('*')
        .eq('account_id', accountId)
        .eq('name', template_name)
        .eq('language', template_language || 'en_US')
        .maybeSingle()
      if (rawTemplateRow && !isMessageTemplate(rawTemplateRow)) {
        return NextResponse.json(
          {
            error:
              'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
          },
          { status: 500 },
        )
      }
      sendContext = {
        kind: 'template',
        phoneNumberId: config.phone_number_id,
        accessToken,
        templateName: template_name,
        templateLanguage: template_language || 'en_US',
        templateRow: rawTemplateRow ?? null,
      }
    }

    const results: BroadcastResult[] = []
    let sentCount = 0
    let failedCount = 0

    for (const recipient of recipients) {
      const sanitized = sanitizePhoneForMeta(recipient.phone)

      if (!isValidE164(sanitized)) {
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: 'Invalid phone number format',
        })
        failedCount++
        continue
      }

      try {
        const result = await sendBroadcastRecipient(sendContext, {
          phone: sanitized,
          params: recipient.params,
          messageParams: recipient.messageParams,
        })
        results.push({
          phone: recipient.phone,
          status: 'sent',
          whatsapp_message_id: result.messageId,
        })
        sentCount++
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error'
        console.error(
          `Failed to send broadcast to ${recipient.phone}:`,
          errorMessage
        )
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: errorMessage,
        })
        failedCount++
      }
    }

    return NextResponse.json({
      success: true,
      total: recipients.length,
      sent: sentCount,
      failed: failedCount,
      results,
    })
  } catch (error) {
    console.error('Error in WhatsApp broadcast POST:', error)
    return NextResponse.json(
      { error: 'Failed to process broadcast' },
      { status: 500 }
    )
  }
}
