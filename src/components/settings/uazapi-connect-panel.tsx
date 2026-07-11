'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Loader2, RotateCcw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SettingsPanelHead } from './settings-panel-head';

const POLL_INTERVAL_MS = 3000;
const QR_TIMEOUT_MS = 2 * 60 * 1000;

type Phase = 'form' | 'connecting' | 'connected';

interface ConfigGetResponse {
  connected: boolean;
  provider?: 'meta' | 'uazapi';
  status?: string;
  qrcode?: string | null;
  message?: string;
}

export function UazapiConnectPanel({ hasExistingConfig }: { hasExistingConfig: boolean }) {
  const t = useTranslations('Settings.whatsapp.uazapi');
  const [phase, setPhase] = useState<Phase>(hasExistingConfig ? 'connecting' : 'form');
  const [serverUrl, setServerUrl] = useState('');
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [qrcode, setQrcode] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollDeadline = useRef<number>(0);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollDeadline.current = Date.now() + QR_TIMEOUT_MS;
    pollTimer.current = setInterval(async () => {
      try {
        const res = await fetch('/api/whatsapp/config', { method: 'GET' });
        const data = (await res.json()) as ConfigGetResponse;

        if (data.connected) {
          stopPolling();
          setPhase('connected');
          toast.success(t('connectedToast'));
          return;
        }
        if (data.qrcode) setQrcode(data.qrcode);

        if (Date.now() > pollDeadline.current) {
          stopPolling();
          toast.error(t('qrTimeout'));
        }
      } catch (err) {
        console.error('UAZAPI status poll failed:', err);
      }
    }, POLL_INTERVAL_MS);
  }, [stopPolling, t]);

  useEffect(() => {
    if (phase === 'connecting') startPolling();
    return () => stopPolling();
  }, [phase, startPolling, stopPolling]);

  async function handleConnect() {
    if (!serverUrl.trim() || !token.trim()) {
      toast.error(t('fieldsRequired'));
      return;
    }
    try {
      setSaving(true);
      const res = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'uazapi',
          uazapi_server_url: serverUrl.trim(),
          uazapi_token: token.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || t('connectFailed'));
        return;
      }
      setQrcode(data.qrcode ?? null);
      setPhase('connecting');
    } catch (err) {
      console.error('UAZAPI connect error:', err);
      toast.error(t('connectFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect() {
    if (!confirm(t('disconnectConfirm'))) return;
    try {
      setDisconnecting(true);
      const res = await fetch('/api/whatsapp/config', { method: 'DELETE' });
      if (!res.ok) {
        toast.error(t('disconnectFailed'));
        return;
      }
      stopPolling();
      setPhase('form');
      setServerUrl('');
      setToken('');
      setQrcode(null);
      toast.success(t('disconnected'));
    } catch (err) {
      console.error('UAZAPI disconnect error:', err);
      toast.error(t('disconnectFailed'));
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {phase === 'form' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">{t('formTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">{t('formDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('serverUrl')}</Label>
              <Input
                placeholder="https://free.uazapi.com"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('instanceToken')}</Label>
              <Input
                type="password"
                placeholder={t('instanceTokenPlaceholder')}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <Button
              onClick={handleConnect}
              disabled={saving}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('connecting')}
                </>
              ) : (
                t('connectButton')
              )}
            </Button>
          </CardContent>
        </Card>
      )}

      {phase === 'connecting' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">{t('scanTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">{t('scanDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4">
            {qrcode ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qrcode} alt={t('qrAlt')} className="size-64 rounded border border-border" />
            ) : (
              <div className="flex size-64 items-center justify-center rounded border border-border">
                <Loader2 className="size-8 animate-spin text-muted-foreground" />
              </div>
            )}
            <p className="text-sm text-muted-foreground">{t('waitingScan')}</p>
          </CardContent>
        </Card>
      )}

      {phase === 'connected' && (
        <Alert className="bg-emerald-950/30 border-emerald-700/50">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="size-4 text-emerald-400" />
              <AlertTitle className="mb-0 text-emerald-200">{t('connectedTitle')}</AlertTitle>
            </div>
            <Button
              variant="outline"
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
            >
              {disconnecting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('disconnecting')}
                </>
              ) : (
                <>
                  <RotateCcw className="size-4" />
                  {t('disconnectButton')}
                </>
              )}
            </Button>
          </div>
          <AlertDescription className="text-muted-foreground mt-2 text-xs">
            {t('connectedDesc')}
          </AlertDescription>
        </Alert>
      )}
    </section>
  );
}
