'use client';

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ArrowRight, Image as ImageIcon, Video, FileText, X, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  uploadAccountMedia,
  deleteAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from '@/lib/storage/upload-media';
import { CHAT_MEDIA_BUCKET } from '@/components/inbox/message-composer';
import { useTranslations } from 'next-intl';

export type ComposeMediaKind = 'image' | 'video' | 'document';

export interface ComposeMediaAttachment {
  kind: ComposeMediaKind;
  url: string;
  /** Storage object path — lets the caller GC the object if the draft is discarded. */
  path: string;
  filename?: string;
}

// Mirrors message-composer.tsx's PICKER_ACCEPT for the same bucket's
// allowed_mime_types (migration 023).
const PICKER_ACCEPT: Record<ComposeMediaKind, string> = {
  image: 'image/png,image/jpeg,image/webp',
  video: 'video/mp4,video/3gpp',
  document:
    'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain',
};

interface Step1ComposeMessageProps {
  messageText: string;
  onMessageTextChange: (text: string) => void;
  media: ComposeMediaAttachment | null;
  onMediaChange: (media: ComposeMediaAttachment | null) => void;
  onNext: () => void;
  onBack: () => void;
}

export function Step1ComposeMessage({
  messageText,
  onMessageTextChange,
  media,
  onMediaChange,
  onNext,
  onBack,
}: Step1ComposeMessageProps) {
  const t = useTranslations('Broadcasts.wizard');
  const [uploading, setUploading] = useState<ComposeMediaKind | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const documentInput = useRef<HTMLInputElement>(null);
  const inputRefs: Record<ComposeMediaKind, React.RefObject<HTMLInputElement | null>> = {
    image: imageInput,
    video: videoInput,
    document: documentInput,
  };

  async function handleFilePicked(kind: ComposeMediaKind, file: File) {
    if (file.size > MEDIA_MAX_BYTES_BY_KIND[kind]) {
      toast.error(t('composeMessage.fileTooLarge'));
      return;
    }
    setUploading(kind);
    try {
      const uploaded = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
      onMediaChange({ kind, url: uploaded.publicUrl, path: uploaded.path, filename: file.name });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('composeMessage.uploadFailed'));
    } finally {
      setUploading(null);
    }
  }

  async function handleRemoveMedia() {
    if (media) {
      await deleteAccountMedia(CHAT_MEDIA_BUCKET, media.path).catch(() => {});
    }
    onMediaChange(null);
  }

  const canProceed = messageText.trim().length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('composeMessage.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('composeMessage.subtitle')}</p>
      </div>

      <Textarea
        value={messageText}
        onChange={(e) => onMessageTextChange(e.target.value)}
        placeholder={t('composeMessage.placeholder')}
        rows={6}
        className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
      />

      {media ? (
        <div className="flex items-center justify-between rounded-lg border border-border bg-card/50 p-3">
          <div className="flex items-center gap-2 text-sm text-foreground">
            {media.kind === 'image' && <ImageIcon className="h-4 w-4" />}
            {media.kind === 'video' && <Video className="h-4 w-4" />}
            {media.kind === 'document' && <FileText className="h-4 w-4" />}
            <span>{media.filename ?? media.kind}</span>
          </div>
          <Button variant="ghost" size="icon" onClick={handleRemoveMedia}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {(['image', 'video', 'document'] as const).map((kind) => (
            <div key={kind}>
              <input
                ref={inputRefs[kind]}
                type="file"
                accept={PICKER_ACCEPT[kind]}
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFilePicked(kind, file);
                  e.target.value = '';
                }}
              />
              <Button
                type="button"
                variant="outline"
                className="border-border text-muted-foreground"
                disabled={uploading !== null}
                onClick={() => inputRefs[kind].current?.click()}
              >
                {uploading === kind ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : kind === 'image' ? (
                  <ImageIcon className="h-4 w-4" />
                ) : kind === 'video' ? (
                  <Video className="h-4 w-4" />
                ) : (
                  <FileText className="h-4 w-4" />
                )}
                {t(`composeMessage.attach.${kind}`)}
              </Button>
            </div>
          ))}
          <span className="text-xs text-muted-foreground">{t('composeMessage.attachOptional')}</span>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="outline" onClick={onBack} className="border-border text-muted-foreground">
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={!canProceed}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
