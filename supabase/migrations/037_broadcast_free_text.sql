-- Broadcasts: support free-text (+ optional single media attachment)
-- sends for UAZAPI accounts, alongside the existing Meta template flow.
--
-- template_name relaxes to nullable — UAZAPI broadcasts carry a
-- message_text instead, enforced by the content-presence check below.

ALTER TABLE broadcasts
  ALTER COLUMN template_name DROP NOT NULL;

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS message_text TEXT,
  ADD COLUMN IF NOT EXISTS media_url TEXT,
  ADD COLUMN IF NOT EXISTS media_kind TEXT,
  ADD COLUMN IF NOT EXISTS media_filename TEXT;

ALTER TABLE broadcasts
  DROP CONSTRAINT IF EXISTS broadcasts_media_kind_check;
ALTER TABLE broadcasts
  ADD CONSTRAINT broadcasts_media_kind_check
  CHECK (media_kind IS NULL OR media_kind IN ('image', 'video', 'document', 'audio'));

ALTER TABLE broadcasts
  DROP CONSTRAINT IF EXISTS broadcasts_content_check;
ALTER TABLE broadcasts
  ADD CONSTRAINT broadcasts_content_check
  CHECK (template_name IS NOT NULL OR message_text IS NOT NULL);
