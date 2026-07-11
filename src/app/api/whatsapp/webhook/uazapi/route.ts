import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { ingestInboundMessage, ingestStatusUpdate } from '@/lib/whatsapp/inbound'
import {
  parseUazapiMessageEvent,
  parseUazapiStatusEvent,
} from '@/lib/whatsapp/uazapi-inbound-parser'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

interface MatchedConfig {
  account_id: string
  user_id: string
  uazapi_instance_id: string
}

/**
 * webhook_secret is stored encrypted, so it can't be matched with a SQL
 * .eq() — scan every uazapi config and decrypt each secret to compare.
 * Mirrors the verify_token scan in the Meta webhook's GET handler.
 */
async function resolveConfigByWebhookKey(key: string): Promise<MatchedConfig | null> {
  const { data: configs, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('account_id, user_id, webhook_secret, uazapi_instance_id')
    .eq('provider', 'uazapi')

  if (error || !configs) return null

  for (const config of configs) {
    if (!config.webhook_secret) continue
    try {
      if (decrypt(config.webhook_secret) === key) {
        return {
          account_id: config.account_id,
          user_id: config.user_id,
          uazapi_instance_id: config.uazapi_instance_id,
        }
      }
    } catch {
      // Malformed / wrong-key row — skip it and keep checking.
    }
  }
  return null
}

export async function POST(request: Request) {
  const { searchParams } = new URL(request.url)
  const key = searchParams.get('key')

  if (!key) {
    return NextResponse.json({ error: 'Missing key' }, { status: 401 })
  }

  const config = await resolveConfigByWebhookKey(key)
  if (!config) {
    return NextResponse.json({ error: 'Invalid key' }, { status: 401 })
  }

  let body: { event?: string; instance?: string; data?: Record<string, unknown> }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (body.instance !== config.uazapi_instance_id) {
    return NextResponse.json({ error: 'Instance mismatch' }, { status: 401 })
  }

  const data = body.data ?? {}

  if (body.event === 'messages') {
    const parsed = parseUazapiMessageEvent(data, config.account_id, config.user_id)
    if (parsed) {
      await ingestInboundMessage(parsed)
    }
  } else if (body.event === 'messages_update') {
    const parsed = parseUazapiStatusEvent(data)
    if (parsed) {
      await ingestStatusUpdate(parsed)
    }
  }
  // Other events (connection, history, presence, ...) are acked but not
  // acted on yet — Phase 2a's polling already covers the connection-status
  // use case; wiring the live `connection` event is a future optimization.

  return NextResponse.json({ status: 'received' }, { status: 200 })
}
