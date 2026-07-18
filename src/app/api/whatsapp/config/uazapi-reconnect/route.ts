import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import { connectUazapiInstance } from '@/lib/whatsapp/uazapi-instance'

/**
 * POST /api/whatsapp/config/uazapi-reconnect
 *
 * Re-invokes UAZAPI's `/instance/connect` for the caller's already-saved
 * config, using the stored credentials (no re-entry needed). Needed
 * because `/instance/status` (polled by `GET /api/whatsapp/config`)
 * does NOT itself generate a QR code — only `/instance/connect` does.
 * A returning user whose instance is sitting `disconnected` (session
 * expired, manually logged out on the phone, etc.) would otherwise
 * poll status forever and never see a QR, since nothing ever asked
 * UAZAPI to start a new QR session.
 */
export async function POST() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

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

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('provider, uazapi_server_url, uazapi_token')
      .eq('account_id', accountId)
      .maybeSingle()

    if (configError || !config || config.provider !== 'uazapi') {
      return NextResponse.json({ error: 'No UAZAPI configuration found.' }, { status: 400 })
    }

    const result = await connectUazapiInstance({
      serverUrl: config.uazapi_server_url,
      token: decrypt(config.uazapi_token),
    })

    return NextResponse.json({ qrcode: result.qrcode })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown UAZAPI error'
    console.error('[whatsapp/config/uazapi-reconnect] failed:', message)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
