import { throwUazapiError, uazapiUrl } from '@/lib/whatsapp/uazapi-http'

export interface UazapiCredentials {
  serverUrl: string
  token: string
}

export interface UazapiInstanceStatus {
  instanceId: string
  status: 'disconnected' | 'connecting' | 'connected' | 'hibernated'
  connected: boolean
  qrcode: string | null
}

interface UazapiStatusResponse {
  instance: { id: string; status: string; qrcode?: string }
  status: { connected: boolean }
}

export async function getUazapiInstanceStatus(
  creds: UazapiCredentials,
): Promise<UazapiInstanceStatus> {
  const response = await fetch(uazapiUrl(creds.serverUrl, '/instance/status'), {
    headers: { token: creds.token },
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI instance/status error: ${response.status}`)
  }
  const data = (await response.json()) as UazapiStatusResponse
  return {
    instanceId: data.instance.id,
    status: data.instance.status as UazapiInstanceStatus['status'],
    connected: data.status.connected,
    qrcode: data.instance.qrcode || null,
  }
}

interface UazapiConnectResponse {
  instance?: { qrcode?: string }
}

export async function connectUazapiInstance(
  creds: UazapiCredentials,
): Promise<{ qrcode: string | null }> {
  const response = await fetch(uazapiUrl(creds.serverUrl, '/instance/connect'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      token: creds.token,
    },
    body: JSON.stringify({}),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI instance/connect error: ${response.status}`)
  }
  const data = (await response.json()) as UazapiConnectResponse
  return { qrcode: data.instance?.qrcode || null }
}

export async function registerUazapiWebhook(
  creds: UazapiCredentials,
  webhookUrl: string,
): Promise<void> {
  const response = await fetch(uazapiUrl(creds.serverUrl, '/webhook'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      token: creds.token,
    },
    body: JSON.stringify({
      enabled: true,
      url: webhookUrl,
      events: ['messages', 'messages_update', 'connection'],
      excludeMessages: ['wasSentByApi'],
    }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI webhook registration error: ${response.status}`)
  }
}
