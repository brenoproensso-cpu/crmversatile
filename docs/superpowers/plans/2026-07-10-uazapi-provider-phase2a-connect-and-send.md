# UAZAPI Provider — Phase 2a (Connect & Send) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user pick UAZAPI as their WhatsApp provider in Settings, connect an existing UAZAPI instance via QR code, and send text/media/reactions through it — using the `WhatsAppProvider` abstraction built in Phase 1. Inbound message handling (the webhook route) is explicitly **out of scope** — that's Phase 2b, a separate plan.

**Architecture:** A new `UazapiProvider` (implementing the `WhatsAppProvider` interface from Phase 1) talks to the user's own UAZAPI server over its REST API (`/send/text`, `/send/media`, `/message/react`, `/instance/connect`, `/instance/status`, `/webhook`). `whatsapp_config` gains a `provider` column plus UAZAPI-specific columns, all nullable so the existing Meta rows are untouched. The Settings UI splits the current monolithic `WhatsAppConfig` component into a thin shell (provider picker) + two self-contained panels (`MetaConnectPanel` — the current component, renamed, zero behavior change; `UazapiConnectPanel` — new, QR-code flow). `POST /api/whatsapp/config` and `GET /api/whatsapp/config` grow an early branch for `provider === 'uazapi'` that delegates to a new orchestration module, leaving every existing Meta code path completely unmodified.

**Tech Stack:** TypeScript, Next.js 16 (App Router), Vitest 4, Supabase JS client + Postgres migrations, React 19, next-intl, sonner (toasts), lucide-react (icons).

## Global Constraints

- Zero behavior change to the Meta connect/send/GET/DELETE paths — every branch added to shared files must be gated behind `provider === 'uazapi'` (or the corresponding DB column), never restructuring the existing Meta branch.
- Named-args objects for all new function signatures (matches `meta-api.ts` / `provider.ts` convention from Phase 1).
- The browser never talks to the user's UAZAPI server directly and never sees the decrypted `uazapi_token` — every UAZAPI HTTP call happens server-side, mirroring how the Meta `access_token` is never sent to the client.
- `webhook_secret` and `uazapi_token` are stored encrypted with the existing `encrypt()`/`decrypt()` pair from `src/lib/whatsapp/encryption.ts` — no new crypto scheme.
- Broadcasts (`src/lib/whatsapp/broadcast-core.ts`) are **out of scope for this plan** — UAZAPI accounts simply won't have a working Broadcast feature yet after this plan lands (their Templates tab is already hidden per the design doc's scope decision #1). Adapting broadcasts to a template-free flow is deferred to a follow-up plan.
- The webhook route (`src/app/api/whatsapp/webhook/uazapi/route.ts`) and `ingestInboundMessage()` extraction are **out of scope for this plan** — Phase 2b, a separate plan, written after this one lands.
- Run `npm run typecheck` and `npm test` after every task; both must pass before moving on.

---

## File Structure

- **Create** `supabase/migrations/036_uazapi_provider.sql` — schema changes.
- **Create** `src/lib/whatsapp/uazapi-http.ts` — shared UAZAPI fetch error helper + URL builder.
- **Create** `src/lib/whatsapp/uazapi-http.test.ts` — unit tests for the above.
- **Create** `src/lib/whatsapp/uazapi-api.ts` — `UazapiProvider` class implementing `WhatsAppProvider` (send text/media/reaction).
- **Create** `src/lib/whatsapp/uazapi-api.test.ts` — unit tests.
- **Create** `src/lib/whatsapp/uazapi-instance.ts` — instance lifecycle: `getUazapiInstanceStatus`, `connectUazapiInstance`, `registerUazapiWebhook`.
- **Create** `src/lib/whatsapp/uazapi-instance.test.ts` — unit tests.
- **Create** `src/lib/whatsapp/uazapi-config.ts` — orchestration used by the API route: `saveAndConnectUazapiConfig`, `checkUazapiConfigHealth`.
- **Create** `src/lib/whatsapp/uazapi-config.test.ts` — unit tests.
- **Modify** `src/lib/whatsapp/provider.ts` — widen `WhatsAppConfigRow`, branch `getWhatsAppProvider()` on `config.provider`.
- **Modify** `src/lib/whatsapp/provider.test.ts` — add `provider: 'meta'` to the existing `CONFIG` fixture.
- **Modify** `src/app/api/whatsapp/config/route.ts` — branch `POST`/`GET` on `provider`.
- **Modify** `src/types/index.ts` — widen `WhatsAppConfig` with the new columns.
- **Create** `src/components/settings/meta-connect-panel.tsx` — current `whatsapp-config.tsx` body, moved verbatim, renamed.
- **Rewrite** `src/components/settings/whatsapp-config.tsx` — thin shell: provider picker + panel switch.
- **Create** `src/components/settings/uazapi-connect-panel.tsx` — new QR-code connect flow.
- **Modify** `messages/en.json` — add `Settings.whatsapp.providerPicker.*` and `Settings.whatsapp.uazapi.*` keys.

---

### Task 1: Database migration

**Files:**
- Create: `supabase/migrations/036_uazapi_provider.sql`

**Interfaces:**
- Produces (used by every later task): `whatsapp_config.provider` (`'meta'|'uazapi'`, default `'meta'`), `whatsapp_config.uazapi_server_url`, `whatsapp_config.uazapi_instance_id`, `whatsapp_config.uazapi_token`, `whatsapp_config.webhook_secret`.

**Context:** `whatsapp_config.phone_number_id` and `.access_token` are currently `NOT NULL` (set in `supabase/migrations/001_initial_schema.sql:190-201`). UAZAPI rows will leave those two NULL, so they must become nullable. A `CHECK` constraint enforces that each row has the fields its own provider needs. All existing rows are `provider='meta'` with both columns already populated, so the `CHECK` is satisfiable with no backfill.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/036_uazapi_provider.sql`:

```sql
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
```

- [ ] **Step 2: Apply the migration locally**

Run: `npx supabase db push` (or your project's usual migration-apply command — check `package.json` scripts for one, e.g. `npm run db:migrate`, before falling back to the Supabase CLI directly).
Expected: migration `036_uazapi_provider` applied with no errors.

- [ ] **Step 3: Verify the constraint against existing data**

Run against your local/dev DB:
```sql
SELECT count(*) FROM whatsapp_config WHERE provider = 'meta' AND (phone_number_id IS NULL OR access_token IS NULL);
```
Expected: `0` — confirms every pre-existing row still satisfies the new CHECK.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/036_uazapi_provider.sql
git commit -m "feat: add UAZAPI provider columns to whatsapp_config"
```

---

### Task 2: `uazapi-http.ts` — shared fetch error helper

**Files:**
- Create: `src/lib/whatsapp/uazapi-http.ts`
- Test: `src/lib/whatsapp/uazapi-http.test.ts`

**Interfaces:**
- Consumes: nothing (pure fetch wrapper).
- Produces (used by Tasks 3 and 5):
  ```ts
  export function uazapiUrl(serverUrl: string, path: string): string
  export async function throwUazapiError(response: Response, fallback: string): Promise<never>
  ```

**Context:** UAZAPI's error responses are `{ "error": "message" }` (a flat string), unlike Meta's nested `{ error: { message } }` — confirmed against the official OpenAPI spec's `/send/text` 400/401/500 examples. `uazapiUrl` strips a trailing slash from the user-supplied server URL (e.g. `https://free.uazapi.com/`) before appending the path, so a stray trailing slash the user pastes doesn't produce `https://host//send/text`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/whatsapp/uazapi-http.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { throwUazapiError, uazapiUrl } from './uazapi-http'

describe('uazapiUrl', () => {
  it('joins a server URL without a trailing slash', () => {
    expect(uazapiUrl('https://free.uazapi.com', '/send/text')).toBe(
      'https://free.uazapi.com/send/text',
    )
  })

  it('strips a trailing slash from the server URL before joining', () => {
    expect(uazapiUrl('https://free.uazapi.com/', '/send/text')).toBe(
      'https://free.uazapi.com/send/text',
    )
  })
})

describe('throwUazapiError', () => {
  it('throws the flat `error` string from the response body', async () => {
    const response = {
      json: async () => ({ error: 'Invalid token' }),
    } as Response

    await expect(throwUazapiError(response, 'fallback')).rejects.toThrow(
      'Invalid token',
    )
  })

  it('falls back when the body is not JSON', async () => {
    const response = {
      json: async () => {
        throw new Error('not json')
      },
    } as unknown as Response

    await expect(throwUazapiError(response, 'UAZAPI error: 500')).rejects.toThrow(
      'UAZAPI error: 500',
    )
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/whatsapp/uazapi-http.test.ts`
Expected: FAIL — `Cannot find module './uazapi-http'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/whatsapp/uazapi-http.ts`:

```ts
interface UazapiErrorResponse {
  error?: string
}

/** Joins a user-supplied UAZAPI server URL with an API path, tolerating a trailing slash. */
export function uazapiUrl(serverUrl: string, path: string): string {
  return `${serverUrl.replace(/\/+$/, '')}${path}`
}

/** UAZAPI error bodies are a flat `{ error: string }` — unlike Meta's nested `{ error: { message } }`. */
export async function throwUazapiError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as UazapiErrorResponse
    if (data.error) message = data.error
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/whatsapp/uazapi-http.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp/uazapi-http.ts src/lib/whatsapp/uazapi-http.test.ts
git commit -m "feat: add shared UAZAPI fetch error helper"
```

---

### Task 3: `UazapiProvider` — send text/media/reaction

**Files:**
- Create: `src/lib/whatsapp/uazapi-api.ts`
- Test: `src/lib/whatsapp/uazapi-api.test.ts`

**Interfaces:**
- Consumes: `uazapiUrl`, `throwUazapiError` from `src/lib/whatsapp/uazapi-http.ts` (Task 2); `type MediaKind` from `src/lib/whatsapp/meta-api.ts`.
- Produces (used by Task 4):
  ```ts
  export interface UazapiCredentials { serverUrl: string; token: string }
  export interface UazapiSendResult { messageId: string }
  export async function sendUazapiText(creds: UazapiCredentials, args: { to: string; text: string; contextMessageId?: string }): Promise<UazapiSendResult>
  export async function sendUazapiMedia(creds: UazapiCredentials, args: { to: string; kind: MediaKind; link: string; caption?: string; filename?: string; contextMessageId?: string }): Promise<UazapiSendResult>
  export async function sendUazapiReaction(creds: UazapiCredentials, args: { to: string; targetMessageId: string; emoji: string }): Promise<UazapiSendResult>
  ```

**Context:** Confirmed against the official UAZAPI OpenAPI spec (`docs.uazapi.com/openapi-bundled.json`, `paths./send/text`, `paths./send/media`, `paths./message/react`) plus a live test instance:
- Auth: header `token: <instance-token>` (an `apiKey` header scheme, not `Authorization: Bearer`).
- `POST /send/text` body: `{ number, text, replyid? }`. `number` is digits-only (the same format `sanitizePhoneForMeta`/`normalizePhone` already produce upstream — no reformatting needed here).
- `POST /send/media` body: `{ number, type, file, text?, docName? }` — `type` is UAZAPI's media-kind enum, a superset of `MediaKind`; the 4 values used here (`image`/`video`/`document`/`audio`) map 1:1. `text` is the caption; `docName` is the filename, only meaningful for `type: 'document'` (UAZAPI ignores it silently for other kinds, mirroring Meta's own filename-is-document-only rule already encoded in `MetaProvider`).
- `POST /message/react` body: `{ number, text, id }` — `text` is the emoji (empty string removes the reaction), `id` is the target message's UAZAPI `messageid`.
- Response for all three: a `Message` object (see the design doc) plus a `response` wrapper — the field to extract is `messageid` (the WhatsApp-side id), not `id` (UAZAPI's internal row id).

- [ ] **Step 1: Write the failing test**

Create `src/lib/whatsapp/uazapi-api.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendUazapiMedia, sendUazapiReaction, sendUazapiText } from './uazapi-api'

const CREDS = { serverUrl: 'https://free.uazapi.com', token: 'inst-token' }

interface CapturedRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}
let captured: CapturedRequest | null = null

function okFetch(responseBody: Record<string, unknown>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    captured = {
      url,
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(init.body as string) : {},
    }
    return { ok: true, json: async () => responseBody } as Response
  })
}

beforeEach(() => {
  captured = null
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sendUazapiText', () => {
  it('POSTs to /send/text with the token header and returns the messageid', async () => {
    vi.stubGlobal('fetch', okFetch({ id: 'internal-id', messageid: 'wamid.1' }))

    const result = await sendUazapiText(CREDS, { to: '5511999999999', text: 'oi' })

    expect(captured?.url).toBe('https://free.uazapi.com/send/text')
    expect(captured?.headers.token).toBe('inst-token')
    expect(captured?.body).toEqual({ number: '5511999999999', text: 'oi' })
    expect(result).toEqual({ messageId: 'wamid.1' })
  })

  it('includes replyid when contextMessageId is set', async () => {
    vi.stubGlobal('fetch', okFetch({ messageid: 'wamid.2' }))

    await sendUazapiText(CREDS, { to: '5511999999999', text: 'oi', contextMessageId: 'wamid.0' })

    expect(captured?.body).toEqual({ number: '5511999999999', text: 'oi', replyid: 'wamid.0' })
  })

  it('throws the UAZAPI error message on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({ error: 'Invalid token' }) }) as Response),
    )

    await expect(sendUazapiText(CREDS, { to: '5511999999999', text: 'oi' })).rejects.toThrow(
      'Invalid token',
    )
  })
})

describe('sendUazapiMedia', () => {
  it('sends an image with a caption and no docName', async () => {
    vi.stubGlobal('fetch', okFetch({ messageid: 'wamid.3' }))

    const result = await sendUazapiMedia(CREDS, {
      to: '5511999999999',
      kind: 'image',
      link: 'https://example.com/pic.jpg',
      caption: 'hello',
      filename: 'pic.jpg',
    })

    expect(captured?.url).toBe('https://free.uazapi.com/send/media')
    expect(captured?.body).toEqual({
      number: '5511999999999',
      type: 'image',
      file: 'https://example.com/pic.jpg',
      text: 'hello',
    })
    expect(result).toEqual({ messageId: 'wamid.3' })
  })

  it('sends a document with docName', async () => {
    vi.stubGlobal('fetch', okFetch({ messageid: 'wamid.4' }))

    await sendUazapiMedia(CREDS, {
      to: '5511999999999',
      kind: 'document',
      link: 'https://example.com/f.pdf',
      filename: 'contrato.pdf',
    })

    expect(captured?.body).toEqual({
      number: '5511999999999',
      type: 'document',
      file: 'https://example.com/f.pdf',
      docName: 'contrato.pdf',
    })
  })
})

describe('sendUazapiReaction', () => {
  it('sends the emoji and target message id', async () => {
    vi.stubGlobal('fetch', okFetch({ messageid: 'wamid.5' }))

    const result = await sendUazapiReaction(CREDS, {
      to: '5511999999999',
      targetMessageId: 'wamid.0',
      emoji: '👍',
    })

    expect(captured?.url).toBe('https://free.uazapi.com/message/react')
    expect(captured?.body).toEqual({ number: '5511999999999', text: '👍', id: 'wamid.0' })
    expect(result).toEqual({ messageId: 'wamid.5' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/whatsapp/uazapi-api.test.ts`
Expected: FAIL — `Cannot find module './uazapi-api'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/whatsapp/uazapi-api.ts`:

```ts
import { throwUazapiError, uazapiUrl } from '@/lib/whatsapp/uazapi-http'
import type { MediaKind } from '@/lib/whatsapp/meta-api'

export interface UazapiCredentials {
  serverUrl: string
  token: string
}

export interface UazapiSendResult {
  messageId: string
}

interface UazapiMessageResponse {
  messageid: string
}

async function postUazapi(
  creds: UazapiCredentials,
  path: string,
  body: Record<string, unknown>,
): Promise<UazapiSendResult> {
  const response = await fetch(uazapiUrl(creds.serverUrl, path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      token: creds.token,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI API error: ${response.status}`)
  }
  const data = (await response.json()) as UazapiMessageResponse
  return { messageId: data.messageid }
}

export interface SendUazapiTextArgs {
  to: string
  text: string
  contextMessageId?: string
}

export async function sendUazapiText(
  creds: UazapiCredentials,
  args: SendUazapiTextArgs,
): Promise<UazapiSendResult> {
  const body: Record<string, unknown> = { number: args.to, text: args.text }
  if (args.contextMessageId) body.replyid = args.contextMessageId
  return postUazapi(creds, '/send/text', body)
}

export interface SendUazapiMediaArgs {
  to: string
  kind: MediaKind
  link: string
  caption?: string
  filename?: string
  contextMessageId?: string
}

export async function sendUazapiMedia(
  creds: UazapiCredentials,
  args: SendUazapiMediaArgs,
): Promise<UazapiSendResult> {
  const body: Record<string, unknown> = {
    number: args.to,
    type: args.kind,
    file: args.link,
  }
  if (args.caption) body.text = args.caption
  if (args.kind === 'document' && args.filename) body.docName = args.filename
  if (args.contextMessageId) body.replyid = args.contextMessageId
  return postUazapi(creds, '/send/media', body)
}

export interface SendUazapiReactionArgs {
  to: string
  targetMessageId: string
  emoji: string
}

export async function sendUazapiReaction(
  creds: UazapiCredentials,
  args: SendUazapiReactionArgs,
): Promise<UazapiSendResult> {
  return postUazapi(creds, '/message/react', {
    number: args.to,
    text: args.emoji,
    id: args.targetMessageId,
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/whatsapp/uazapi-api.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp/uazapi-api.ts src/lib/whatsapp/uazapi-api.test.ts
git commit -m "feat: add UAZAPI send text/media/reaction API client"
```

---

### Task 4: Wire `UazapiProvider` into `getWhatsAppProvider()`

**Files:**
- Modify: `src/lib/whatsapp/provider.ts`
- Modify: `src/lib/whatsapp/provider.test.ts`

**Interfaces:**
- Consumes: `sendUazapiText`, `sendUazapiMedia`, `sendUazapiReaction` from `src/lib/whatsapp/uazapi-api.ts` (Task 3).
- Produces (used by every existing call-site — `send-message.ts`, `flows/meta-send.ts`, `automations/meta-send.ts` — with no changes needed at those call-sites, since they already just call `getWhatsAppProvider(config)`):
  ```ts
  export interface WhatsAppConfigRow {
    provider?: 'meta' | 'uazapi'
    phone_number_id?: string
    access_token?: string
    uazapi_server_url?: string
    uazapi_instance_id?: string
    uazapi_token?: string
  }
  ```
  (`phone_number_id`/`access_token`/`uazapi_*` all become optional on the shared row type since a single config row only ever populates one provider's fields — enforced at the DB layer by Task 1's CHECK constraint, not by TypeScript.)

**Context:** `getWhatsAppProvider` currently always returns `MetaProvider` (Phase 1). This task adds the `UazapiProvider` class and branches the factory on `config.provider`, defaulting to Meta when the field is absent (keeps every existing caller — none of which set `provider` yet — on the exact same path as before).

- [ ] **Step 1: Write the failing test**

Add to `src/lib/whatsapp/provider.test.ts` (append a new `describe` block; do not touch the existing `MetaProvider` tests except the one fixture change in Step 1a below):

```ts
vi.mock('@/lib/whatsapp/uazapi-api', () => ({
  sendUazapiText: vi.fn(),
  sendUazapiMedia: vi.fn(),
  sendUazapiReaction: vi.fn(),
}))
```

Add this `vi.mock` call at the top of the file, alongside the existing `vi.mock('@/lib/whatsapp/meta-api', ...)` and `vi.mock('@/lib/whatsapp/encryption', ...)` calls.

Add the import, alongside the existing `meta-api` import:

```ts
import {
  sendUazapiText,
  sendUazapiMedia,
  sendUazapiReaction,
} from '@/lib/whatsapp/uazapi-api'
```

**Step 1a:** Change the existing `CONFIG` fixture from:
```ts
const CONFIG = { phone_number_id: 'PNID123', access_token: 'enc-token' }
```
to:
```ts
const CONFIG = { provider: 'meta' as const, phone_number_id: 'PNID123', access_token: 'enc-token' }
```
(Required because `WhatsAppConfigRow.provider` becomes part of the type this task adds — the existing `MetaProvider` tests must keep passing with an explicit `provider: 'meta'`.)

Then append:

```ts
const UAZAPI_CONFIG = {
  provider: 'uazapi' as const,
  uazapi_server_url: 'https://free.uazapi.com',
  uazapi_token: 'enc-uazapi-token',
}

describe('UazapiProvider', () => {
  it('sendText forwards to sendUazapiText with the decrypted token', async () => {
    vi.mocked(sendUazapiText).mockResolvedValue({ messageId: 'wamid.1' })
    const provider = getWhatsAppProvider(UAZAPI_CONFIG)

    const result = await provider.sendText({ to: '+15551234', text: 'hi', contextMessageId: 'ctx1' })

    expect(sendUazapiText).toHaveBeenCalledWith(
      { serverUrl: 'https://free.uazapi.com', token: 'decrypted:enc-uazapi-token' },
      { to: '+15551234', text: 'hi', contextMessageId: 'ctx1' },
    )
    expect(result).toEqual({ messageId: 'wamid.1' })
  })

  it('sendMedia forwards to sendUazapiMedia with the decrypted token', async () => {
    vi.mocked(sendUazapiMedia).mockResolvedValue({ messageId: 'wamid.2' })
    const provider = getWhatsAppProvider(UAZAPI_CONFIG)

    const result = await provider.sendMedia({
      to: '+15551234',
      kind: 'image',
      link: 'https://example.com/img.jpg',
      caption: 'cap',
    })

    expect(sendUazapiMedia).toHaveBeenCalledWith(
      { serverUrl: 'https://free.uazapi.com', token: 'decrypted:enc-uazapi-token' },
      {
        to: '+15551234',
        kind: 'image',
        link: 'https://example.com/img.jpg',
        caption: 'cap',
        filename: undefined,
        contextMessageId: undefined,
      },
    )
    expect(result).toEqual({ messageId: 'wamid.2' })
  })

  it('sendReaction forwards to sendUazapiReaction with the decrypted token', async () => {
    vi.mocked(sendUazapiReaction).mockResolvedValue({ messageId: 'wamid.3' })
    const provider = getWhatsAppProvider(UAZAPI_CONFIG)

    const result = await provider.sendReaction({
      to: '+15551234',
      targetMessageId: 'wamid.0',
      emoji: '👍',
    })

    expect(sendUazapiReaction).toHaveBeenCalledWith(
      { serverUrl: 'https://free.uazapi.com', token: 'decrypted:enc-uazapi-token' },
      { to: '+15551234', targetMessageId: 'wamid.0', emoji: '👍' },
    )
    expect(result).toEqual({ messageId: 'wamid.3' })
  })
})

describe('getWhatsAppProvider — defaulting', () => {
  it('defaults to MetaProvider when `provider` is absent (back-compat for pre-migration rows)', async () => {
    vi.mocked(sendTextMessage).mockResolvedValue({ messageId: 'wamid.legacy' })
    const provider = getWhatsAppProvider({ phone_number_id: 'PNID123', access_token: 'enc-token' })

    await provider.sendText({ to: '+15551234', text: 'hi' })

    expect(sendTextMessage).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/whatsapp/provider.test.ts`
Expected: FAIL — `Cannot find module '@/lib/whatsapp/uazapi-api'` is already resolvable (Task 3 created it), so the failure here is instead a type/runtime error: `getWhatsAppProvider` doesn't yet branch on `provider`, so the `UazapiProvider` tests fail (`sendUazapiText` never called).

- [ ] **Step 3: Write the implementation**

In `src/lib/whatsapp/provider.ts`, add the import (alongside the existing `meta-api` import):

```ts
import {
  sendUazapiMedia,
  sendUazapiReaction,
  sendUazapiText,
} from '@/lib/whatsapp/uazapi-api'
```

Replace the `WhatsAppConfigRow` interface:

```ts
export interface WhatsAppConfigRow {
  phone_number_id: string
  access_token: string
}
```

with:

```ts
export interface WhatsAppConfigRow {
  /** Defaults to 'meta' when absent — keeps pre-migration rows/callers on the existing path. */
  provider?: 'meta' | 'uazapi'
  phone_number_id?: string
  access_token?: string
  uazapi_server_url?: string
  uazapi_instance_id?: string
  uazapi_token?: string
}
```

Add a new class alongside `MetaProvider` (after its closing brace):

```ts
class UazapiProvider implements WhatsAppProvider {
  constructor(private readonly config: WhatsAppConfigRow) {}

  private get creds() {
    return {
      serverUrl: this.config.uazapi_server_url!,
      token: decrypt(this.config.uazapi_token!),
    }
  }

  async sendText(args: SendTextArgs): Promise<WhatsAppSendResult> {
    return sendUazapiText(this.creds, args)
  }

  async sendMedia(args: SendMediaArgs): Promise<WhatsAppSendResult> {
    return sendUazapiMedia(this.creds, args)
  }

  async sendReaction(args: SendReactionArgs): Promise<WhatsAppSendResult> {
    return sendUazapiReaction(this.creds, args)
  }
}
```

Replace the factory:

```ts
export function getWhatsAppProvider(config: WhatsAppConfigRow): WhatsAppProvider {
  return new MetaProvider(config)
}
```

with:

```ts
export function getWhatsAppProvider(config: WhatsAppConfigRow): WhatsAppProvider {
  if (config.provider === 'uazapi') {
    return new UazapiProvider(config)
  }
  return new MetaProvider(config)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/whatsapp/provider.test.ts`
Expected: PASS (7 tests: 3 existing `MetaProvider` + 3 new `UazapiProvider` + 1 defaulting).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (`MetaProvider`'s constructor still types `this.config.phone_number_id`/`.access_token` as possibly-`undefined` now — since those methods only ever run when `config.provider !== 'uazapi'`, i.e. the DB CHECK constraint guarantees them present, add a non-null assertion the same way `UazapiProvider.creds` does: `this.config.phone_number_id!` and `decrypt(this.config.access_token!)` in all three `MetaProvider` methods.)

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, no new failures.

- [ ] **Step 7: Commit**

```bash
git add src/lib/whatsapp/provider.ts src/lib/whatsapp/provider.test.ts
git commit -m "feat: wire UazapiProvider into getWhatsAppProvider factory"
```

---

### Task 5: `uazapi-instance.ts` — connect / status / webhook registration

**Files:**
- Create: `src/lib/whatsapp/uazapi-instance.ts`
- Test: `src/lib/whatsapp/uazapi-instance.test.ts`

**Interfaces:**
- Consumes: `uazapiUrl`, `throwUazapiError` from `src/lib/whatsapp/uazapi-http.ts` (Task 2).
- Produces (used by Task 6):
  ```ts
  export interface UazapiCredentials { serverUrl: string; token: string }
  export interface UazapiInstanceStatus {
    instanceId: string
    status: 'disconnected' | 'connecting' | 'connected' | 'hibernated'
    connected: boolean
    qrcode: string | null
  }
  export async function getUazapiInstanceStatus(creds: UazapiCredentials): Promise<UazapiInstanceStatus>
  export async function connectUazapiInstance(creds: UazapiCredentials): Promise<{ qrcode: string | null }>
  export async function registerUazapiWebhook(creds: UazapiCredentials, webhookUrl: string): Promise<void>
  ```

**Context:** Confirmed against the OpenAPI spec and a live `GET /instance/status` call against a real test instance, which returned:
```json
{"instance":{"id":"r00cd19ce7afc39","status":"disconnected","paircode":"","qrcode":"", ...},"status":{"connected":false,"jid":null,"loggedIn":false,"resetting":false}}
```
— confirming `instance.id`/`instance.status`/`instance.qrcode` and `status.connected` are the fields to read. `POST /instance/connect` is called with an empty body (`{}`) — the v1 scope never sends `phone`, so UAZAPI always returns a QR code, never a pairing code (see the design doc's connection-flow section). `POST /webhook` registers our callback URL in UAZAPI's "simple mode" (no `action`/`id` fields) with `excludeMessages: ["wasSentByApi"]`, which the official docs say is required to avoid an infinite loop of the CRM's own outbound sends echoing back as inbound webhook events.

- [ ] **Step 1: Write the failing test**

Create `src/lib/whatsapp/uazapi-instance.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectUazapiInstance,
  getUazapiInstanceStatus,
  registerUazapiWebhook,
} from './uazapi-instance'

const CREDS = { serverUrl: 'https://free.uazapi.com', token: 'inst-token' }

interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown> | null
}
let captured: CapturedRequest | null = null

function fetchReturning(responseBody: Record<string, unknown>, ok = true) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    captured = {
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(init.body as string) : null,
    }
    return { ok, json: async () => responseBody } as Response
  })
}

beforeEach(() => {
  captured = null
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getUazapiInstanceStatus', () => {
  it('parses the instance id, status, connected flag, and qrcode', async () => {
    vi.stubGlobal(
      'fetch',
      fetchReturning({
        instance: { id: 'r00cd19ce7afc39', status: 'connecting', qrcode: 'data:image/png;base64,abc' },
        status: { connected: false, loggedIn: false, jid: null },
      }),
    )

    const result = await getUazapiInstanceStatus(CREDS)

    expect(captured?.url).toBe('https://free.uazapi.com/instance/status')
    expect(captured?.headers.token).toBe('inst-token')
    expect(result).toEqual({
      instanceId: 'r00cd19ce7afc39',
      status: 'connecting',
      connected: false,
      qrcode: 'data:image/png;base64,abc',
    })
  })

  it('normalizes an empty qrcode string to null', async () => {
    vi.stubGlobal(
      'fetch',
      fetchReturning({
        instance: { id: 'r00cd19ce7afc39', status: 'disconnected', qrcode: '' },
        status: { connected: false },
      }),
    )

    const result = await getUazapiInstanceStatus(CREDS)
    expect(result.qrcode).toBeNull()
  })

  it('throws the UAZAPI error message on a non-2xx response', async () => {
    vi.stubGlobal('fetch', fetchReturning({ error: 'instance info not found' }, false))
    await expect(getUazapiInstanceStatus(CREDS)).rejects.toThrow('instance info not found')
  })
})

describe('connectUazapiInstance', () => {
  it('POSTs an empty body and returns the qrcode', async () => {
    vi.stubGlobal(
      'fetch',
      fetchReturning({ instance: { qrcode: 'data:image/png;base64,xyz' } }),
    )

    const result = await connectUazapiInstance(CREDS)

    expect(captured?.url).toBe('https://free.uazapi.com/instance/connect')
    expect(captured?.method).toBe('POST')
    expect(captured?.body).toEqual({})
    expect(result).toEqual({ qrcode: 'data:image/png;base64,xyz' })
  })
})

describe('registerUazapiWebhook', () => {
  it('POSTs the webhook URL with the required excludeMessages filter', async () => {
    vi.stubGlobal('fetch', fetchReturning({ id: 'wh-1' }))

    await registerUazapiWebhook(CREDS, 'https://crm.example.com/api/whatsapp/webhook/uazapi?key=secret')

    expect(captured?.url).toBe('https://free.uazapi.com/webhook')
    expect(captured?.body).toEqual({
      url: 'https://crm.example.com/api/whatsapp/webhook/uazapi?key=secret',
      events: ['messages', 'messages_update', 'connection'],
      excludeMessages: ['wasSentByApi'],
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/whatsapp/uazapi-instance.test.ts`
Expected: FAIL — `Cannot find module './uazapi-instance'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/whatsapp/uazapi-instance.ts`:

```ts
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
      url: webhookUrl,
      events: ['messages', 'messages_update', 'connection'],
      excludeMessages: ['wasSentByApi'],
    }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI webhook registration error: ${response.status}`)
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/whatsapp/uazapi-instance.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp/uazapi-instance.ts src/lib/whatsapp/uazapi-instance.test.ts
git commit -m "feat: add UAZAPI instance connect/status/webhook-registration client"
```

---

### Task 6: `uazapi-config.ts` — save/connect + health-check orchestration

**Files:**
- Create: `src/lib/whatsapp/uazapi-config.ts`
- Test: `src/lib/whatsapp/uazapi-config.test.ts`

**Interfaces:**
- Consumes: `getUazapiInstanceStatus`, `connectUazapiInstance`, `registerUazapiWebhook` from `src/lib/whatsapp/uazapi-instance.ts` (Task 5); `encrypt`, `decrypt` from `src/lib/whatsapp/encryption.ts`.
- Produces (used by Task 7):
  ```ts
  export interface SaveUazapiConfigInput { serverUrl: string; token: string }
  export interface SaveUazapiConfigResult { qrcode: string | null }
  export async function saveAndConnectUazapiConfig(
    supabase: SupabaseClient,
    adminClient: SupabaseClient,
    accountId: string,
    userId: string,
    existingConfigId: string | null,
    input: SaveUazapiConfigInput,
    webhookBaseUrl: string,
  ): Promise<SaveUazapiConfigResult>

  export interface UazapiHealthCheckResult {
    connected: boolean
    status: 'disconnected' | 'connecting' | 'connected' | 'hibernated'
    qrcode: string | null
  }
  export async function checkUazapiConfigHealth(
    supabase: SupabaseClient,
    config: { id: string; uazapi_server_url: string; uazapi_token: string; status: string },
  ): Promise<UazapiHealthCheckResult>
  ```

**Context:** `saveAndConnectUazapiConfig` does 5 things in order, throwing a user-facing `Error(message)` on the first failure (the route maps this straight to a 400 JSON response, same pattern as the existing Meta POST handler's `try/catch` around `verifyPhoneNumber`):
1. Calls `getUazapiInstanceStatus` with the raw (unencrypted) input token — this both validates the server URL + token are correct **and** resolves the instance's real `instanceId` (never user-supplied directly).
2. Checks no *other* account already has this `uazapi_instance_id` (via `adminClient`, mirroring the existing `phone_number_id` ownership check in `route.ts:213-226` — RLS hides other accounts' rows from the caller's own `supabase` client).
3. Generates a `webhook_secret` (`crypto.randomBytes(24).toString('hex')`).
4. Registers the webhook (`registerUazapiWebhook`) pointing at `${webhookBaseUrl}/api/whatsapp/webhook/uazapi?key=${webhook_secret}` — this route doesn't exist until Phase 2b, but registering it now is harmless (UAZAPI will just get 404s until then, which don't block anything in this plan's scope).
5. Calls `connectUazapiInstance` to kick off the QR flow, then upserts the row (`status: 'disconnected'` — accurate, since the DB `status` column only ever means "is this row hooked up at all", not "has the QR been scanned yet"; the live `connecting`/`connected` state lives entirely in `UazapiInstanceStatus`, polled via `checkUazapiConfigHealth`).

`checkUazapiConfigHealth` calls `getUazapiInstanceStatus` and, if it reports `connected: true` while the DB row's `status` column still says `'disconnected'`, opportunistically flips it to `'connected'` (+ `connected_at`) — the only place in this plan where a *live* UAZAPI connection is persisted, since Phase 2b's `connection` webhook event doesn't exist yet.

- [ ] **Step 1: Write the failing test**

Create `src/lib/whatsapp/uazapi-config.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/whatsapp/uazapi-instance', () => ({
  getUazapiInstanceStatus: vi.fn(),
  connectUazapiInstance: vi.fn(),
  registerUazapiWebhook: vi.fn(),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: vi.fn((v: string) => `encrypted:${v}`),
  decrypt: vi.fn((v: string) => v.replace(/^encrypted:/, '')),
}))

import {
  connectUazapiInstance,
  getUazapiInstanceStatus,
  registerUazapiWebhook,
} from '@/lib/whatsapp/uazapi-instance'
import { checkUazapiConfigHealth, saveAndConnectUazapiConfig } from './uazapi-config'

function fakeSupabase(overrides: Record<string, unknown> = {}) {
  const upsertMock = vi.fn().mockResolvedValue({ error: null })
  const maybeSingleMock = vi.fn().mockResolvedValue({ data: null, error: null })
  const chain = {
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    maybeSingle: maybeSingleMock,
    ...overrides,
  }
  return { ...chain, __upsert: upsertMock } as unknown as {
    from: typeof chain.from
  }
}

describe('saveAndConnectUazapiConfig', () => {
  beforeEach(() => {
    vi.mocked(getUazapiInstanceStatus).mockResolvedValue({
      instanceId: 'r00cd19ce7afc39',
      status: 'connecting',
      connected: false,
      qrcode: null,
    })
    vi.mocked(connectUazapiInstance).mockResolvedValue({
      qrcode: 'data:image/png;base64,abc',
    })
    vi.mocked(registerUazapiWebhook).mockResolvedValue(undefined)
  })

  it('validates credentials, checks for a claimed instance, registers the webhook, connects, and returns the qrcode', async () => {
    const supabase = fakeSupabase()
    const adminClient = fakeSupabase()

    const result = await saveAndConnectUazapiConfig(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      adminClient as any,
      'account-1',
      'user-1',
      null,
      { serverUrl: 'https://free.uazapi.com', token: 'inst-token' },
      'https://crm.example.com',
    )

    expect(getUazapiInstanceStatus).toHaveBeenCalledWith({
      serverUrl: 'https://free.uazapi.com',
      token: 'inst-token',
    })
    expect(registerUazapiWebhook).toHaveBeenCalledWith(
      { serverUrl: 'https://free.uazapi.com', token: 'inst-token' },
      expect.stringMatching(
        /^https:\/\/crm\.example\.com\/api\/whatsapp\/webhook\/uazapi\?key=[0-9a-f]{48}$/,
      ),
    )
    expect(connectUazapiInstance).toHaveBeenCalledWith({
      serverUrl: 'https://free.uazapi.com',
      token: 'inst-token',
    })
    expect(result).toEqual({ qrcode: 'data:image/png;base64,abc' })
  })

  it('throws when the instance is already claimed by another account', async () => {
    const supabase = fakeSupabase()
    const adminClient = fakeSupabase({
      maybeSingle: vi.fn().mockResolvedValue({ data: { account_id: 'other-account' }, error: null }),
    })

    await expect(
      saveAndConnectUazapiConfig(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        supabase as any,
        adminClient as any,
        'account-1',
        'user-1',
        null,
        { serverUrl: 'https://free.uazapi.com', token: 'inst-token' },
        'https://crm.example.com',
      ),
    ).rejects.toThrow(/already linked to another account/)
  })

  it('surfaces the UAZAPI error message when the credentials are invalid', async () => {
    vi.mocked(getUazapiInstanceStatus).mockRejectedValue(new Error('Invalid token'))
    const supabase = fakeSupabase()
    const adminClient = fakeSupabase()

    await expect(
      saveAndConnectUazapiConfig(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        supabase as any,
        adminClient as any,
        'account-1',
        'user-1',
        null,
        { serverUrl: 'https://free.uazapi.com', token: 'bad-token' },
        'https://crm.example.com',
      ),
    ).rejects.toThrow('Invalid token')
  })
})

describe('checkUazapiConfigHealth', () => {
  it('reports live status without writing when nothing changed', async () => {
    vi.mocked(getUazapiInstanceStatus).mockResolvedValue({
      instanceId: 'r00cd19ce7afc39',
      status: 'connecting',
      connected: false,
      qrcode: 'data:image/png;base64,abc',
    })
    const supabase = fakeSupabase()

    const result = await checkUazapiConfigHealth(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      { id: 'row-1', uazapi_server_url: 'https://free.uazapi.com', uazapi_token: 'encrypted:inst-token', status: 'disconnected' },
    )

    expect(result).toEqual({ connected: false, status: 'connecting', qrcode: 'data:image/png;base64,abc' })
  })

  it('flips the row to connected when the live status newly reports connected', async () => {
    vi.mocked(getUazapiInstanceStatus).mockResolvedValue({
      instanceId: 'r00cd19ce7afc39',
      status: 'connected',
      connected: true,
      qrcode: null,
    })
    const updateMock = vi.fn().mockReturnThis()
    const supabase = fakeSupabase({ update: updateMock })

    await checkUazapiConfigHealth(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      { id: 'row-1', uazapi_server_url: 'https://free.uazapi.com', uazapi_token: 'encrypted:inst-token', status: 'disconnected' },
    )

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'connected' }),
    )
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/whatsapp/uazapi-config.test.ts`
Expected: FAIL — `Cannot find module './uazapi-config'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/whatsapp/uazapi-config.ts`:

```ts
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

  const connectResult = await connectUazapiInstance(creds)

  const baseRow = {
    provider: 'uazapi' as const,
    uazapi_server_url: input.serverUrl,
    uazapi_instance_id: liveStatus.instanceId,
    uazapi_token: encrypt(input.token),
    webhook_secret: encrypt(webhookSecret),
    // Accurate: the QR hasn't been scanned yet. The live connecting/
    // connected state is polled separately via checkUazapiConfigHealth.
    status: 'disconnected' as const,
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/whatsapp/uazapi-config.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp/uazapi-config.ts src/lib/whatsapp/uazapi-config.test.ts
git commit -m "feat: add UAZAPI save/connect and health-check orchestration"
```

---

### Task 7: Wire the config API route

**Files:**
- Modify: `src/app/api/whatsapp/config/route.ts`
- Modify: `src/types/index.ts`

**Interfaces:**
- Consumes: `saveAndConnectUazapiConfig`, `checkUazapiConfigHealth` from `src/lib/whatsapp/uazapi-config.ts` (Task 6).
- Produces: no new exports — this task only changes `POST`/`GET` response shapes (additively) for `provider: 'uazapi'` requests. `DELETE` is untouched (deleting a row by `account_id` already works identically for either provider's row shape).

**Context:** `POST` currently destructures `{ phone_number_id, waba_id, access_token, verify_token, pin }` straight from the body and 400s if `access_token`/`phone_number_id` are missing (`route.ts:187-195`) — a UAZAPI-shaped body (`{ provider: 'uazapi', uazapi_server_url, uazapi_token }`) would trip that check today. `GET` currently selects only `phone_number_id, access_token, status` (`route.ts:88-92`) and unconditionally calls `verifyPhoneNumber` — it needs to select `provider` too and branch before touching Meta-only fields.

- [ ] **Step 1: Widen `WhatsAppConfig` type**

In `src/types/index.ts`, replace the `WhatsAppConfig` interface (lines 269-288):

```ts
export interface WhatsAppConfig {
  id: string;
  user_id: string;
  phone_number_id: string;
  waba_id?: string;
  access_token: string;
  verify_token?: string;
  status: 'connected' | 'disconnected';
  connected_at?: string;
  registered_at?: string;
  subscribed_apps_at?: string;
  last_registration_error?: string;
}
```

with:

```ts
export interface WhatsAppConfig {
  id: string;
  user_id: string;
  provider: 'meta' | 'uazapi';
  phone_number_id?: string;
  waba_id?: string;
  access_token?: string;
  verify_token?: string;
  status: 'connected' | 'disconnected';
  connected_at?: string;
  registered_at?: string;
  subscribed_apps_at?: string;
  last_registration_error?: string;
  uazapi_server_url?: string;
  uazapi_instance_id?: string;
  uazapi_token?: string;
}
```

- [ ] **Step 2: Add the base-URL resolver + imports to `route.ts`**

In `src/app/api/whatsapp/config/route.ts`, replace the import block (lines 1-9):

```ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
```

with:

```ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import {
  checkUazapiConfigHealth,
  saveAndConnectUazapiConfig,
} from '@/lib/whatsapp/uazapi-config'

/** Same resolution order as getBaseUrl() in api/account/invitations/route.ts,
 *  minus the ALLOWED_INVITE_HOSTS allow-list — a spoofed Host header here only
 *  mis-registers our OWN webhook against the wrong domain (the user notices
 *  immediately, since inbound events simply stop working), not a phishing
 *  vector like invite links are. */
function resolveAppBaseUrl(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')

  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  if (forwardedHost) return `${forwardedProto || 'https'}://${forwardedHost}`

  const host = request.headers.get('host')?.trim()
  if (host) {
    const reqProto = new URL(request.url).protocol.replace(':', '')
    return `${reqProto}://${host}`
  }

  throw new Error('Could not determine the app base URL for the UAZAPI webhook callback')
}
```

- [ ] **Step 3: Branch `GET`**

Replace the config-fetch block in `GET` (lines 88-100):

```ts
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('phone_number_id, access_token, status')
      .eq('account_id', accountId)
      .maybeSingle()

    if (configError) {
      console.error('Error fetching whatsapp_config:', configError)
      return NextResponse.json(
        { connected: false, reason: 'db_error', message: 'Failed to fetch configuration' },
        { status: 200 }
      )
    }
```

with:

```ts
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('phone_number_id, access_token, status, provider, uazapi_server_url, uazapi_token, id')
      .eq('account_id', accountId)
      .maybeSingle()

    if (configError) {
      console.error('Error fetching whatsapp_config:', configError)
      return NextResponse.json(
        { connected: false, reason: 'db_error', message: 'Failed to fetch configuration' },
        { status: 200 }
      )
    }
```

Then, immediately after the existing `if (!config) { ... }` block (ends at line 111), insert a new branch — before the Meta-only `let accessToken: string` decrypt block (currently line 113 onward):

```ts
    if (config.provider === 'uazapi') {
      try {
        const health = await checkUazapiConfigHealth(supabase, {
          id: config.id,
          uazapi_server_url: config.uazapi_server_url!,
          uazapi_token: config.uazapi_token!,
          status: config.status,
        })
        return NextResponse.json({
          connected: health.connected,
          provider: 'uazapi',
          status: health.status,
          qrcode: health.qrcode,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown UAZAPI error'
        console.error('[whatsapp/config GET] UAZAPI status check failed:', message)
        return NextResponse.json(
          { connected: false, provider: 'uazapi', reason: 'uazapi_api_error', message },
          { status: 200 },
        )
      }
    }
```

(Every existing line below this point in `GET` — the Meta token decrypt + `verifyPhoneNumber` call — runs unchanged, now implicitly gated to `provider !== 'uazapi'`, i.e. `'meta'` or a legacy row with no `provider` set.)

- [ ] **Step 4: Branch `POST`**

Replace the body-parsing line in `POST` (line 187):

```ts
    const body = await request.json()
    const { phone_number_id, waba_id, access_token, verify_token, pin } = body
```

with:

```ts
    const body = await request.json()

    if (body.provider === 'uazapi') {
      const { uazapi_server_url, uazapi_token } = body
      if (!uazapi_server_url || !uazapi_token) {
        return NextResponse.json(
          { error: 'uazapi_server_url and uazapi_token are required' },
          { status: 400 },
        )
      }

      const { data: existing } = await supabase
        .from('whatsapp_config')
        .select('id')
        .eq('account_id', accountId)
        .maybeSingle()

      try {
        const result = await saveAndConnectUazapiConfig(
          supabase,
          supabaseAdmin(),
          accountId,
          user.id,
          existing?.id ?? null,
          { serverUrl: uazapi_server_url, token: uazapi_token },
          resolveAppBaseUrl(request),
        )
        return NextResponse.json({ success: true, saved: true, provider: 'uazapi', qrcode: result.qrcode })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown UAZAPI error'
        console.error('[whatsapp/config POST] UAZAPI save failed:', message)
        return NextResponse.json({ error: message }, { status: 400 })
      }
    }

    const { phone_number_id, waba_id, access_token, verify_token, pin } = body
```

(Every existing line below this point in `POST` — the Meta uniqueness check, `verifyPhoneNumber`, encryption, `/register`, `subscribed_apps`, and the insert/update — runs unchanged, now implicitly gated to `body.provider !== 'uazapi'`. Since no existing caller ever sends `provider` today, this is a strict no-op for all current traffic.)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, no new failures. (There is no pre-existing `route.test.ts` for this file — Task 10's final verification covers manual/API-level checks instead.)

- [ ] **Step 7: Commit**

```bash
git add src/app/api/whatsapp/config/route.ts src/types/index.ts
git commit -m "feat: branch whatsapp/config GET/POST on provider for UAZAPI"
```

---

### Task 8: Extract `MetaConnectPanel` (zero behavior change)

**Files:**
- Create: `src/components/settings/meta-connect-panel.tsx`
- Modify: `src/components/settings/whatsapp-config.tsx` (temporarily re-exports the moved component — replaced with the real shell in Task 9, so this task stays a pure, verifiable move)

**Interfaces:**
- Produces: `export function MetaConnectPanel()` — identical behavior to today's `WhatsAppConfig`, just renamed.

**Context:** This is a pure rename/move, no logic changes, so it's verifiable by diffing: every line of the current `src/components/settings/whatsapp-config.tsx` (840 lines) moves verbatim into the new file, with only the function name and the file's own export changing.

- [ ] **Step 1: Copy the file**

Copy `src/components/settings/whatsapp-config.tsx` to `src/components/settings/meta-connect-panel.tsx` verbatim, then rename the exported function:

```ts
export function WhatsAppConfig() {
```
→
```ts
export function MetaConnectPanel() {
```

(No other line changes — every hook, handler, and JSX block stays byte-identical.)

- [ ] **Step 2: Point the old file at the new one (temporary shim)**

Replace the entire contents of `src/components/settings/whatsapp-config.tsx` with:

```tsx
export { MetaConnectPanel as WhatsAppConfig } from './meta-connect-panel';
```

(This keeps every existing importer of `WhatsAppConfig` from `whatsapp-config.tsx` working with zero changes, while the real logic now lives in `meta-connect-panel.tsx`. Task 9 replaces this shim with the actual provider-picker shell.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Run the dev server and confirm the Settings → WhatsApp tab still renders identically**

Run: `npm run dev`, navigate to Settings → WhatsApp, confirm the page looks and behaves exactly as before (this is a pure move — any visual difference is a bug).

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/meta-connect-panel.tsx src/components/settings/whatsapp-config.tsx
git commit -m "refactor: extract MetaConnectPanel from whatsapp-config.tsx"
```

---

### Task 9: `UazapiConnectPanel` + the real provider-picker shell

**Files:**
- Create: `src/components/settings/uazapi-connect-panel.tsx`
- Rewrite: `src/components/settings/whatsapp-config.tsx` (replaces Task 8's temporary shim)
- Modify: `messages/en.json`

**Interfaces:**
- Consumes: `MetaConnectPanel` from `src/components/settings/meta-connect-panel.tsx` (Task 8).
- Produces: `export function WhatsAppConfig()` — the shell, same export name/signature every existing importer already uses (no importer changes needed).

**Context:** The shell fetches only `{ provider }` for the account's config row (a cheap query, separate from each panel's own full fetch) to decide what to render:
- No config row yet → show the two-card provider picker; clicking a card sets local `selectedProvider` state and mounts the matching panel (no DB write happens here — the panel's own save flow creates the row).
- A config row exists → render the panel matching `config.provider` directly, no picker.

`UazapiConnectPanel` posts `{ provider: 'uazapi', uazapi_server_url, uazapi_token }` to `POST /api/whatsapp/config` (Task 7), then polls `GET /api/whatsapp/config` every 3s (reusing the exact same endpoint the health-check/"Test Connection" flow already uses) until `connected: true` or a 2-minute timeout, showing the returned `qrcode` as an `<img>` the whole time. A "Disconnect" button calls the existing (unmodified) `DELETE /api/whatsapp/config`.

- [ ] **Step 1: Write the `UazapiConnectPanel` component**

Create `src/components/settings/uazapi-connect-panel.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Loader2, RotateCcw, XCircle } from 'lucide-react';
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
```

- [ ] **Step 2: Rewrite the shell**

Replace the entire contents of `src/components/settings/whatsapp-config.tsx` (the Task 8 shim) with:

```tsx
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
```

- [ ] **Step 3: Add i18n keys**

In `messages/en.json`, inside the existing `"whatsapp": { ... }` block under `Settings` (the block ending at line 1495), add two new nested objects right before its closing `}` (i.e. after the `"metaDocs"` key, line 1494):

```json
      "metaDocs": "Meta WhatsApp API Documentation",
      "providerPicker": {
        "metaTitle": "Official API (Meta)",
        "metaDesc": "Connect via Meta's WhatsApp Cloud API using a permanent access token from Meta Business Manager.",
        "uazapiTitle": "UAZAPI",
        "uazapiDesc": "Connect an existing UAZAPI instance by scanning a QR code — no Meta Business account required."
      },
      "uazapi": {
        "title": "UAZAPI connection",
        "description": "Connect your UAZAPI instance by scanning a QR code.",
        "formTitle": "Connect your instance",
        "formDesc": "Enter the server URL and instance token from your UAZAPI provider (e.g. uazapi.com or your own server).",
        "serverUrl": "Server URL",
        "instanceToken": "Instance Token",
        "instanceTokenPlaceholder": "Enter your instance token",
        "connectButton": "Connect",
        "connecting": "Connecting...",
        "fieldsRequired": "Server URL and Instance Token are required",
        "connectFailed": "Failed to connect. Check your server URL and token.",
        "scanTitle": "Scan the QR code",
        "scanDesc": "Open WhatsApp on your phone, go to Linked Devices, and scan this code.",
        "qrAlt": "WhatsApp connection QR code",
        "waitingScan": "Waiting for scan...",
        "qrTimeout": "QR code expired. Reload the page to try again.",
        "connectedToast": "WhatsApp connected!",
        "connectedTitle": "Connected",
        "connectedDesc": "Your UAZAPI instance is connected and ready to send messages.",
        "disconnectButton": "Disconnect",
        "disconnecting": "Disconnecting...",
        "disconnectConfirm": "This will disconnect your UAZAPI instance from wacrm. Continue?",
        "disconnectFailed": "Failed to disconnect",
        "disconnected": "Disconnected. You can reconnect at any time."
      }
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, no new failures.

- [ ] **Step 6: Manual smoke test against the real UAZAPI test instance**

Run: `npm run dev`, navigate to Settings → WhatsApp on an account with no existing config. Confirm the provider picker shows both cards. Click "UAZAPI", enter the test server URL and instance token, click Connect, confirm the QR code renders. This is the point in the plan where you'd scan it with a real phone to confirm the whole flow — optional but recommended before merging, since nothing earlier in this plan exercises a live UAZAPI server end-to-end.

- [ ] **Step 7: Commit**

```bash
git add src/components/settings/uazapi-connect-panel.tsx src/components/settings/whatsapp-config.tsx messages/en.json
git commit -m "feat: add UAZAPI QR-connect panel and provider picker shell"
```

---

### Task 10: Final verification pass

**Files:** none (verification only).

- [ ] **Step 1: Full typecheck + lint + test**

Run:
```bash
npm run typecheck
npm run lint
npm test
```
Expected: all three pass with zero errors and no new warnings (the 5 pre-existing `currency.test.ts`/`date-utils.test.ts` failures noted during Phase 1 are unrelated to this work — confirm the count hasn't grown).

- [ ] **Step 2: Confirm the Meta path is byte-identical**

Run: `git diff main -- src/components/settings/meta-connect-panel.tsx` and compare against the pre-Task-8 `whatsapp-config.tsx` (`git show HEAD~<n>:src/components/settings/whatsapp-config.tsx` from before Task 8's commit) — the only difference should be the function name.

- [ ] **Step 3: Send a real message through the connected UAZAPI test instance**

With the account from Task 9 Step 6 fully connected (QR scanned), use the Inbox composer (or `POST /api/whatsapp/send`) to send a text message to a real WhatsApp number and confirm it arrives — this exercises `send-message.ts` → `getWhatsAppProvider` → `UazapiProvider.sendText` → the live UAZAPI server end-to-end, the one path nothing in this plan's unit tests can cover.

---

## Self-Review Notes

- **Spec coverage:** Implements the design doc's Phase 2 items that belong to "connect + send": schema (Modelo de dados), `UazapiProvider` (Camada de abstração de provedor), and the Settings UI connection flow (Fluxo de conexão). Explicitly excludes the webhook route + `ingestInboundMessage()` extraction (Webhook section) — Phase 2b, a separate plan — and `broadcast-core.ts` — deferred further per this plan's Global Constraints.
- **Type consistency:** `WhatsAppConfigRow` (Task 4), `SaveUazapiConfigInput`/`SaveUazapiConfigResult`/`UazapiHealthCheckResult` (Task 6), and the `POST`/`GET` JSON shapes consumed by `UazapiConnectPanel` (Task 9) all agree on field names (`qrcode`, `connected`, `status`, `provider`) end-to-end from the UAZAPI HTTP response through to the React component.
- **Existing-row safety:** Task 1's CHECK constraint is satisfiable by every pre-existing row with no backfill (verified in Task 1 Step 3); Task 4's `getWhatsAppProvider` defaults to `MetaProvider` when `provider` is absent, so no existing caller needs to change.
- **`webhook_secret` is generated and stored but never verified against** in this plan — verification happens in the Phase 2b webhook route, which is the only consumer of that column. Storing it now (rather than deferring the column to Phase 2b) means Phase 2b doesn't need its own migration.
