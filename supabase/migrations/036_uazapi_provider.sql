-- whatsapp_config: add UAZAPI as a second provider option
--
-- Existing Meta rows are untouched: `provider` defaults to 'meta' and
-- their phone_number_id/access_token stay NOT NULL in practice (enforced
-- by the CHECK below, not by the column constraint itself — the column
-- constraint has to relax to nullable so UAZAPI rows can leave them NULL).

ALTER TABLE whatsapp_config
  ALTER COLUMN phone_number_id DROP NOT NULL,
  ALTER COLUMN access_token DROP NOT NULL;

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta',
  ADD COLUMN IF NOT EXISTS uazapi_server_url TEXT,
  ADD COLUMN IF NOT EXISTS uazapi_instance_id TEXT,
  ADD COLUMN IF NOT EXISTS uazapi_token TEXT,
  ADD COLUMN IF NOT EXISTS webhook_secret TEXT;

ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_provider_check;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_provider_check
  CHECK (provider IN ('meta', 'uazapi'));

-- Each row must carry the fields its own provider actually needs.
-- Existing rows all satisfy the 'meta' branch today (both columns were
-- already NOT NULL pre-migration), so this is safe to add with no backfill.
ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_provider_fields_check;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_provider_fields_check
  CHECK (
    (provider = 'meta' AND phone_number_id IS NOT NULL AND access_token IS NOT NULL)
    OR
    (provider = 'uazapi' AND uazapi_server_url IS NOT NULL AND uazapi_token IS NOT NULL AND uazapi_instance_id IS NOT NULL)
  );

-- Mirrors the existing UNIQUE(phone_number_id) from migration 013 — one
-- UAZAPI instance can't be claimed by two accounts. Partial index so
-- Meta rows (uazapi_instance_id IS NULL) never collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_uazapi_instance_unique
  ON whatsapp_config (uazapi_instance_id)
  WHERE uazapi_instance_id IS NOT NULL;
