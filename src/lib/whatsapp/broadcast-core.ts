// ============================================================
// Public-API + dashboard broadcast core.
//
// Splits a broadcast into two phases so callers can persist +
// acknowledge fast and fan out afterwards:
//
//   createBroadcast()  — validate, resolve contacts, insert the
//                        `broadcasts` row + `broadcast_recipients`
//                        rows (status 'pending'), return a plan.
//   deliverBroadcast() — send each recipient (phone-variant retry),
//                        stamp each recipient row + the aggregate
//                        counts, finalize status.
//
// A broadcast is either a Meta approved-template send or a UAZAPI
// free-text (+ optional single media attachment) send — never both.
// `BroadcastSendContext.kind` picks the branch; `sendBroadcastRecipient()`
// is the one place that actually calls out to Meta/UAZAPI, shared by
// deliverBroadcast() here AND by the dashboard's
// `/api/whatsapp/broadcast` route (which owns its own recipient rows,
// created client-side, so it can't just call createBroadcast()).
//
// Recipient rows carry `whatsapp_message_id`, so the inbound webhook's
// status handler (which matches on that column) updates delivered/read
// for API broadcasts exactly as it does for dashboard ones.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { sendTemplateMessage, type MediaKind } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import type { MessageTemplate } from '@/types';
import { findOrCreateContact } from '@/lib/api/v1/contacts';
import { getWhatsAppProvider, type WhatsAppProvider, type WhatsAppConfigRow } from '@/lib/whatsapp/provider';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';

/** Thrown by createBroadcast on a caller-visible failure; route maps it. */
export class BroadcastError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'BroadcastError';
    this.code = code;
    this.status = status;
  }
}

export interface BroadcastRecipientInput {
  /** E.164 phone. */
  to: string;
  /** Positional body params for the template ({{1}}, {{2}}…). Meta-only. */
  params?: string[];
}

export interface BroadcastMedia {
  kind: MediaKind;
  url: string;
  filename?: string;
}

export interface CreateBroadcastParams {
  name?: string | null;
  /** Required for Meta accounts. */
  templateName?: string;
  templateLanguage?: string | null;
  /** Required for UAZAPI accounts. */
  messageText?: string;
  /** Optional, UAZAPI accounts only. */
  media?: BroadcastMedia | null;
  recipients: BroadcastRecipientInput[];
}

interface PlannedRecipient {
  recipientRowId: string;
  phone: string;
  params: string[];
}

/**
 * Everything `sendBroadcastRecipient` needs to send ONE recipient,
 * built once per broadcast (not per recipient). `kind` picks which set
 * of fields is populated — the other set is left undefined.
 */
export interface BroadcastSendContext {
  kind: 'template' | 'freeText';
  // 'template' (Meta)
  phoneNumberId?: string;
  accessToken?: string;
  templateName?: string;
  templateLanguage?: string;
  templateRow?: MessageTemplate | null;
  // 'freeText' (UAZAPI)
  provider?: WhatsAppProvider;
  messageText?: string;
  media?: BroadcastMedia | null;
}

export interface BroadcastPlan {
  broadcastId: string;
  sendContext: BroadcastSendContext;
  planned: PlannedRecipient[];
  /** Phones rejected up front (invalid E.164) — counted as failed. */
  rejected: number;
}

const MAX_RECIPIENTS = 1000;

/**
 * Send to ONE recipient, retrying across phone-number variants on a
 * Meta "recipient not allowed" error (a sandbox-number quirk — see
 * `isRecipientNotAllowedError`). UAZAPI never throws that specific
 * error, so its branch effectively tries once. Throws on total
 * failure (every variant exhausted); callers decide how to record
 * that (a DB row update, an HTTP response entry, …).
 */
export async function sendBroadcastRecipient(
  ctx: BroadcastSendContext,
  recipient: { phone: string; params?: string[]; messageParams?: SendTimeParams },
): Promise<{ messageId: string }> {
  const variants = phoneVariants(recipient.phone);
  let lastError: string | null = null;

  for (const variant of variants) {
    try {
      if (ctx.kind === 'freeText') {
        const provider = ctx.provider!;
        const result = ctx.media
          ? await provider.sendMedia({
              to: variant,
              kind: ctx.media.kind,
              link: ctx.media.url,
              caption: ctx.messageText || undefined,
              filename: ctx.media.filename,
            })
          : await provider.sendText({ to: variant, text: ctx.messageText! });
        return { messageId: result.messageId };
      }

      const result = await sendTemplateMessage({
        phoneNumberId: ctx.phoneNumberId!,
        accessToken: ctx.accessToken!,
        to: variant,
        templateName: ctx.templateName!,
        language: ctx.templateLanguage!,
        template: ctx.templateRow ?? undefined,
        messageParams: recipient.messageParams,
        params: recipient.params ?? [],
      });
      return { messageId: result.messageId };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      lastError = message;
      if (!isRecipientNotAllowedError(message)) break;
    }
  }

  throw new Error(lastError || 'Unknown error');
}

/**
 * Validate + persist a broadcast, resolving each recipient to a
 * contact. Returns a plan for {@link deliverBroadcast}. Throws
 * {@link BroadcastError} on bad input / missing config / a malformed
 * template / a DB failure — nothing is sent in this phase.
 */
export async function createBroadcast(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  params: CreateBroadcastParams
): Promise<BroadcastPlan> {
  const { name, templateName, recipients } = params;
  const templateLanguage = params.templateLanguage || 'en_US';

  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new BroadcastError(
      'bad_request',
      "'recipients' must be a non-empty array of { to, params? }",
      400
    );
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new BroadcastError(
      'bad_request',
      `A broadcast is capped at ${MAX_RECIPIENTS} recipients per request; split larger sends`,
      400
    );
  }

  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single();
  if (configError || !config) {
    throw new BroadcastError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }

  const isUazapi = (config as WhatsAppConfigRow).provider === 'uazapi';
  let sendContext: BroadcastSendContext;
  let templateNameForRow: string | null = null;

  if (isUazapi) {
    const messageText = (params.messageText ?? '').trim();
    if (!messageText) {
      throw new BroadcastError(
        'bad_request',
        "'message_text' is required for a UAZAPI broadcast",
        400
      );
    }
    sendContext = {
      kind: 'freeText',
      provider: getWhatsAppProvider(config as WhatsAppConfigRow),
      messageText,
      media: params.media ?? null,
    };
  } else {
    if (!templateName) {
      throw new BroadcastError('bad_request', "'template_name' is required", 400);
    }
    const accessToken = decrypt(config.access_token);

    // Template row (once) for header/button components; guard a
    // malformed local row rather than N identical opaque failures.
    const { data: rawTemplateRow } = await db
      .from('message_templates')
      .select('*')
      .eq('account_id', accountId)
      .eq('name', templateName)
      .eq('language', templateLanguage)
      .maybeSingle();
    if (rawTemplateRow && !isMessageTemplate(rawTemplateRow)) {
      throw new BroadcastError(
        'template_malformed',
        'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
        500
      );
    }
    sendContext = {
      kind: 'template',
      phoneNumberId: config.phone_number_id,
      accessToken,
      templateName,
      templateLanguage,
      templateRow: (rawTemplateRow as MessageTemplate | null) ?? null,
    };
    templateNameForRow = templateName;
  }

  // Resolve each recipient to a contact. Invalid phones are dropped
  // (counted as rejected) rather than aborting the whole broadcast.
  const resolved: { contactId: string; phone: string; params: string[] }[] = [];
  let rejected = 0;
  for (const r of recipients) {
    const sanitized = sanitizePhoneForMeta(typeof r.to === 'string' ? r.to : '');
    if (!isValidE164(sanitized)) {
      rejected++;
      continue;
    }
    const { id } = await findOrCreateContact(db, accountId, auditUserId, {
      phone: sanitized,
    });
    resolved.push({
      contactId: id,
      phone: sanitized,
      params: Array.isArray(r.params)
        ? r.params.filter((p): p is string => typeof p === 'string')
        : [],
    });
  }

  // Collapse recipients that resolved to the SAME contact (the caller
  // listed a phone twice, or two numbers fuzzy-matched to one contact).
  // Keep the first occurrence so the contact is messaged once and its
  // params aren't silently overwritten by a later duplicate — and so
  // the row↔params pairing below (keyed by contact_id) is unambiguous.
  const seenContact = new Set<string>();
  const deduped = resolved.filter((r) => {
    if (seenContact.has(r.contactId)) return false;
    seenContact.add(r.contactId);
    return true;
  });

  if (deduped.length === 0) {
    throw new BroadcastError(
      'bad_request',
      'No recipients had a valid E.164 phone number',
      400
    );
  }

  // Persist the broadcast + its recipients. The count columns
  // (sent/delivered/read/replied/failed) are owned by the DB aggregate
  // trigger (migrations 003/005) and derived purely from
  // broadcast_recipients rows — we deliberately do NOT seed them here
  // (a manual value would be clobbered by the trigger on the first
  // recipient change). `rejected` phones have no recipient row, so they
  // are reported to the caller in the POST response, not in these
  // persisted counts.
  const { data: broadcast, error: bErr } = await db
    .from('broadcasts')
    .insert({
      account_id: accountId,
      user_id: auditUserId,
      name: name || (isUazapi ? 'API broadcast (free text)' : `API broadcast (${templateName})`),
      template_name: templateNameForRow,
      template_language: templateLanguage,
      message_text: isUazapi ? sendContext.messageText : null,
      media_url: isUazapi ? (sendContext.media?.url ?? null) : null,
      media_kind: isUazapi ? (sendContext.media?.kind ?? null) : null,
      media_filename: isUazapi ? (sendContext.media?.filename ?? null) : null,
      status: 'sending',
      total_recipients: deduped.length,
    })
    .select('id')
    .single();
  if (bErr || !broadcast) {
    console.error('[broadcast-core] create broadcast error:', bErr);
    throw new BroadcastError('internal', 'Failed to create broadcast', 500);
  }

  const { data: recipientRows, error: rErr } = await db
    .from('broadcast_recipients')
    .insert(
      deduped.map((r) => ({
        broadcast_id: broadcast.id,
        contact_id: r.contactId,
        status: 'pending' as const,
      }))
    )
    .select('id, contact_id');
  if (rErr || !recipientRows) {
    console.error('[broadcast-core] create recipients error:', rErr);
    throw new BroadcastError('internal', 'Failed to create broadcast', 500);
  }

  // Pair each inserted recipient row back to its phone/params by
  // contact_id — unambiguous now that duplicates are collapsed.
  const byContact = new Map(deduped.map((r) => [r.contactId, r]));
  const planned: PlannedRecipient[] = recipientRows.map((row) => {
    const r = byContact.get(row.contact_id as string)!;
    return { recipientRowId: row.id as string, phone: r.phone, params: r.params };
  });

  return {
    broadcastId: broadcast.id,
    sendContext,
    planned,
    rejected,
  };
}

/**
 * Fan out a {@link BroadcastPlan}: send each recipient (phone-variant
 * retry via {@link sendBroadcastRecipient}) and stamp its
 * `broadcast_recipients` row. Best-effort per recipient — one failure
 * never aborts the rest. Designed to run inside `after()`.
 *
 * The per-status count columns on `broadcasts` are owned by the DB
 * aggregate trigger (migrations 003/005): each recipient-row update
 * below advances them automatically, and later delivery/read webhooks
 * keep advancing them. We therefore never write those columns here —
 * only the terminal `status` — otherwise a manual value would race and
 * clobber the trigger-maintained counts.
 */
export async function deliverBroadcast(
  db: SupabaseClient,
  plan: BroadcastPlan
): Promise<void> {
  let sentCount = 0;

  for (const recipient of plan.planned) {
    try {
      const result = await sendBroadcastRecipient(plan.sendContext, recipient);
      sentCount++;
      await db
        .from('broadcast_recipients')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          whatsapp_message_id: result.messageId,
          error_message: null,
        })
        .eq('id', recipient.recipientRowId);
    } catch (error) {
      await db
        .from('broadcast_recipients')
        .update({
          status: 'failed',
          error_message: error instanceof Error ? error.message : 'Unknown error',
        })
        .eq('id', recipient.recipientRowId);
    }
  }

  // Terminal status only — counts are trigger-owned (see the note
  // above). If nothing sent, the broadcast failed outright; a partial
  // send is still 'sent' (per-recipient failures show in failed_count).
  await db
    .from('broadcasts')
    .update({
      status: sentCount > 0 ? 'sent' : 'failed',
      updated_at: new Date().toISOString(),
    })
    .eq('id', plan.broadcastId);
}
