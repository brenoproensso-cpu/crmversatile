import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import {
  connectUazapiInstance,
  getUazapiInstanceStatus,
  registerUazapiWebhook,
  type UazapiInstanceStatus,
} from '@/lib/whatsapp/uazapi-instance'

export interface SaveUazapiConfigInput {
  serverUrl: string
  token: string
}

export interface SaveUazapiConfigResult {
  qrcode: string | null
}

/**
 * Validates the given UAZAPI credentials, registers our webhook on that
 * instance, kicks off the QR-code connect flow, and persists the row.
 * Throws a user-facing Error on the first failure — callers (the API
 * route) map that straight to a 400 response.
 */
export async function saveAndConnectUazapiConfig(
  supabase: SupabaseClient,
  adminClient: SupabaseClient,
  accountId: string,
  userId: string,
  existingConfigId: string | null,
  input: SaveUazapiConfigInput,
  webhookBaseUrl: string,
): Promise<SaveUazapiConfigResult> {
  const creds = { serverUrl: input.serverUrl, token: input.token }

  // Validates the server URL + token are correct AND resolves the
  // instance's real id — never user-supplied directly.
  const liveStatus = await getUazapiInstanceStatus(creds)

  // Reject if another account already claimed this instance. Mirrors
  // the phone_number_id ownership check in the Meta POST handler.
  const { data: claimed, error: claimedError } = await adminClient
    .from('whatsapp_config')
    .select('account_id')
    .eq('uazapi_instance_id', liveStatus.instanceId)
    .neq('account_id', accountId)
    .maybeSingle()

  if (claimedError) {
    throw new Error('Failed to validate configuration')
  }
  if (claimed) {
    throw new Error(
      'This UAZAPI instance is already linked to another account on this instance. Each instance can only be connected to one wacrm account.',
    )
  }

  const webhookSecret = crypto.randomBytes(24).toString('hex')
  const webhookUrl = `${webhookBaseUrl}/api/whatsapp/webhook/uazapi?key=${webhookSecret}`
  await registerUazapiWebhook(creds, webhookUrl)

  // Skip /instance/connect entirely when the instance is already connected
  // (e.g. reconnecting wacrm to a session that was set up outside it, or
  // one that outlived a prior wacrm row getting deleted) — some UAZAPI
  // server configurations reject a connect call on an already-connected
  // instance with "Maximum number of instances connected reached".
  const connectResult = liveStatus.connected
    ? { qrcode: null }
    : await connectUazapiInstance(creds)

  const baseRow = {
    provider: 'uazapi' as const,
    uazapi_server_url: input.serverUrl,
    uazapi_instance_id: liveStatus.instanceId,
    uazapi_token: encrypt(input.token),
    webhook_secret: encrypt(webhookSecret),
    status: liveStatus.connected ? ('connected' as const) : ('disconnected' as const),
    connected_at: liveStatus.connected ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  }

  if (existingConfigId) {
    const { error } = await supabase
      .from('whatsapp_config')
      .update(baseRow)
      .eq('account_id', accountId)
    if (error) throw new Error('Failed to save configuration')
  } else {
    const { error } = await supabase
      .from('whatsapp_config')
      .insert({ account_id: accountId, user_id: userId, ...baseRow })
    if (error) throw new Error('Failed to save configuration')
  }

  return { qrcode: connectResult.qrcode }
}

export interface UazapiHealthCheckResult {
  connected: boolean
  status: UazapiInstanceStatus['status']
  qrcode: string | null
}

export interface UazapiConfigRow {
  id: string
  uazapi_server_url: string
  uazapi_token: string
  status: string
}

/**
 * Polls the live UAZAPI instance status. If it newly reports connected
 * while our row still says 'disconnected', flips the row to 'connected'
 * — the only place this plan persists a live connection (Phase 2b's
 * `connection` webhook event will do this going forward instead).
 */
export async function checkUazapiConfigHealth(
  supabase: SupabaseClient,
  config: UazapiConfigRow,
): Promise<UazapiHealthCheckResult> {
  const liveStatus = await getUazapiInstanceStatus({
    serverUrl: config.uazapi_server_url,
    token: decrypt(config.uazapi_token),
  })

  if (liveStatus.connected && config.status !== 'connected') {
    await supabase
      .from('whatsapp_config')
      .update({ status: 'connected', connected_at: new Date().toISOString() })
      .eq('id', config.id)
  }

  return {
    connected: liveStatus.connected,
    status: liveStatus.status,
    qrcode: liveStatus.qrcode,
  }
}
