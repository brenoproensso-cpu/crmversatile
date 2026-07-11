'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';
import { MetaConnectPanel } from './meta-connect-panel';
import { UazapiConnectPanel } from './uazapi-connect-panel';

type Provider = 'meta' | 'uazapi';

export function WhatsAppConfig() {
  const t = useTranslations('Settings.whatsapp');
  const supabase = createClient();
  const { user, accountId, loading: authLoading, profileLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [existingProvider, setExistingProvider] = useState<Provider | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null);
  const loadedAccountIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (authLoading || profileLoading) return;
    if (!user || !accountId) {
      loadedAccountIdRef.current = null;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(false);
      return;
    }
    if (loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;

    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from('whatsapp_config')
        .select('provider')
        .eq('account_id', accountId)
        .maybeSingle();
      setExistingProvider((data?.provider as Provider | undefined) ?? null);
      setLoading(false);
    })();
  }, [authLoading, profileLoading, user?.id, accountId, supabase]);

  if (loading) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      </section>
    );
  }

  const provider = existingProvider ?? selectedProvider;

  if (provider === 'meta') return <MetaConnectPanel />;
  if (provider === 'uazapi') return <UazapiConnectPanel hasExistingConfig={existingProvider === 'uazapi'} />;

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Card
          role="button"
          tabIndex={0}
          onClick={() => setSelectedProvider('meta')}
          onKeyDown={(e) => e.key === 'Enter' && setSelectedProvider('meta')}
          className="cursor-pointer hover:border-primary transition-colors"
        >
          <CardHeader>
            <CardTitle className="text-foreground">{t('providerPicker.metaTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('providerPicker.metaDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent />
        </Card>
        <Card
          role="button"
          tabIndex={0}
          onClick={() => setSelectedProvider('uazapi')}
          onKeyDown={(e) => e.key === 'Enter' && setSelectedProvider('uazapi')}
          className="cursor-pointer hover:border-primary transition-colors"
        >
          <CardHeader>
            <CardTitle className="text-foreground">{t('providerPicker.uazapiTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('providerPicker.uazapiDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent />
        </Card>
      </div>
    </section>
  );
}
