# UAZAPI Broadcasts (Free-Text + Media) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let UAZAPI-connected accounts send Broadcasts — free text plus an optional single media attachment, sent via `provider.sendText`/`sendMedia` — since UAZAPI has no template/24h-window concept. Meta accounts keep the existing approved-template flow byte-for-byte. This closes the one piece the UAZAPI design doc (`docs/superpowers/specs/2026-07-09-uazapi-whatsapp-provider-design.md`) explicitly deferred: `broadcast-core.ts` was "out of scope" for both the Phase 1 and Phase 2a plans, which each said in their Global Constraints that migrating it was left for "a follow-up plan." This is that follow-up.

**Architecture:** Today there are two independent, Meta-only broadcast send paths that both hand-roll the same phone-variant-retry-around-`sendTemplateMessage` loop: `src/lib/whatsapp/broadcast-core.ts` (used by the public API, `POST /api/v1/broadcasts`) and `src/app/api/whatsapp/broadcast/route.ts` (used by the dashboard wizard, via `src/hooks/use-broadcast-sending.ts`). This plan extracts that shared send mechanics into one function, `sendBroadcastRecipient()`, exported from `broadcast-core.ts` and driven by a new `BroadcastSendContext` (`kind: 'template' | 'freeText'`) built once per broadcast. Both routes build a `BroadcastSendContext` — from a template row for Meta accounts, from `messageText`/an optional media attachment plus `getWhatsAppProvider(config)` for UAZAPI accounts — and then call the shared function per recipient. The dashboard wizard gains a new Step 1 variant (`Step1ComposeMessage`) for UAZAPI accounts, replacing the template gallery, and skips the "Personalize" step (no template placeholders exist for free text).

**Tech Stack:** TypeScript, Next.js 16 (App Router), Vitest 4, Supabase JS client, next-intl.

## Global Constraints

- Zero behavior change to the Meta template send path — `sendBroadcastRecipient()`'s `'template'` branch must reproduce today's `sendTemplateMessage` + phone-variant-retry logic exactly (same retry condition via `isRecipientNotAllowedError`, same fields passed to `sendTemplateMessage`). This is a move-and-generalize, not a rewrite, matching the discipline already used for `ingestInboundMessage()`/`ingestStatusUpdate()` in the Phase 2b plan.
- UAZAPI broadcasts are v1-scoped per the design doc + this plan's confirmed decisions: **no per-recipient personalization** (same text/media to every recipient — no `{{1}}`-style placeholders), and **one optional media attachment per broadcast** (image/video/document — no audio, matching the inbox composer's file-picker kinds, not its mic-recorder-only audio path).
- `whatsapp_config.access_token` is `NULL` for UAZAPI rows (migration `036_uazapi_provider.sql`) — never call `decrypt(config.access_token)` without first checking `config.provider !== 'uazapi'`. This is the exact bug both existing Meta-only routes have today against a UAZAPI config row.
- Run `npm run typecheck` and `npm test` after every task; both must pass before moving on (same 5 pre-existing `date-utils.test.ts`/`currency.test.ts` failures as every prior UAZAPI plan — confirm the count hasn't grown, don't try to fix them here).

---

## File Structure

- **Create** `supabase/migrations/037_broadcast_free_text.sql` — relax `broadcasts.template_name` to nullable, add `message_text`/`media_url`/`media_kind`/`media_filename` columns + a content-presence check constraint.
- **Modify** `src/lib/whatsapp/broadcast-core.ts` — add `BroadcastSendContext`, `BroadcastMedia`, `sendBroadcastRecipient()`; branch `createBroadcast()` on `config.provider`; simplify `deliverBroadcast()` to loop over `sendBroadcastRecipient()`.
- **Modify** `src/lib/whatsapp/broadcast-core.test.ts` — add UAZAPI validation/delivery tests + a Meta regression test; keep the 3 existing pure-validation tests.
- **Modify** `src/app/api/whatsapp/broadcast/route.ts` — accept `message_text`/`media` for UAZAPI accounts, build a `BroadcastSendContext`, delegate per-recipient sends to `sendBroadcastRecipient()` (dropping its own duplicate phone-variant loop).
- **Create** `src/app/api/whatsapp/broadcast/route.test.ts` — first tests this route has ever had.
- **Modify** `src/hooks/use-broadcast-sending.ts` — `BroadcastPayload` becomes a `'template' | 'freeText'` discriminated union; branch the `broadcasts` insert and the per-batch POST body.
- **Modify** `src/components/broadcasts/step4-schedule-send.tsx` — swap the `template: MessageTemplate` prop for provider-agnostic `summaryLabel`/`summarySublabel` strings.
- **Create** `src/components/broadcasts/step1-compose-message.tsx` — free text + optional media attachment UI for UAZAPI accounts, mirroring the inbox composer's upload pattern.
- **Modify** `src/app/(dashboard)/broadcasts/new/page.tsx` — fetch the account's provider once, branch Step 1, skip "Personalize" for UAZAPI, wire the new payload shapes through to the hook.
- **Modify** `messages/en.json` — add the new `Broadcasts.new.steps.compose`, `Broadcasts.new.freeTextLabel`, `Broadcasts.new.toastNoContent`, and `Broadcasts.wizard.composeMessage.*` keys.
- **Modify** `docs/public-api.md` — document the free-text broadcast body shape for UAZAPI accounts under `POST /api/v1/broadcasts`.
- **Modify** `CHANGELOG.md` — add the `0.9.0` entry (UAZAPI provider phases 1/2a/2b + this broadcast work — none of it has a changelog entry yet).

---

### Task 1: Migration — nullable `template_name`, free-text/media columns

**Files:**
- Create: `supabase/migrations/037_broadcast_free_text.sql`

**Context:** `broadcasts.template_name` is `NOT NULL` today (`supabase/migrations/001_initial_schema.sql:298`). A UAZAPI broadcast has no template, so this must relax to nullable, with a check constraint ensuring every row has *either* a template name *or* free text — never neither. `template_language` stays `NOT NULL DEFAULT 'en_US'` unchanged; UAZAPI rows simply keep that default (unused, harmless — not worth a second schema change).

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/037_broadcast_free_text.sql`:

```sql
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
```

- [ ] **Step 2: Apply it to your local/dev Supabase project**

Run via the Supabase MCP tool or the SQL editor (this repo has no local CLI migration runner configured beyond copy-pasting into Supabase — match whatever method you used for `036_uazapi_provider.sql`). Confirm no error, and that existing broadcast rows (all Meta, all with a `template_name`) are untouched.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/037_broadcast_free_text.sql
git commit -m "feat: relax broadcasts.template_name and add free-text/media columns"
```

---

### Task 2: `broadcast-core.ts` — shared send context + `sendBroadcastRecipient()`

**Files:**
- Modify: `src/lib/whatsapp/broadcast-core.ts`
- Modify: `src/lib/whatsapp/broadcast-core.test.ts`

**Interfaces:**
- Consumes: `getWhatsAppProvider`, `WhatsAppProvider`, `WhatsAppConfigRow` from `@/lib/whatsapp/provider`; `MediaKind` (type) from `@/lib/whatsapp/meta-api`; `SendTimeParams` (type) from `@/lib/whatsapp/template-send-builder` (already available, used by the dashboard route today).
- Produces (used by Task 3's dashboard route):
  ```ts
  export interface BroadcastMedia {
    kind: MediaKind
    url: string
    filename?: string
  }

  export interface BroadcastSendContext {
    kind: 'template' | 'freeText'
    // 'template' (Meta) fields
    phoneNumberId?: string
    accessToken?: string
    templateName?: string
    templateLanguage?: string
    templateRow?: MessageTemplate | null
    // 'freeText' (UAZAPI) fields
    provider?: WhatsAppProvider
    messageText?: string
    media?: BroadcastMedia | null
  }

  export async function sendBroadcastRecipient(
    ctx: BroadcastSendContext,
    recipient: { phone: string; params?: string[]; messageParams?: SendTimeParams },
  ): Promise<{ messageId: string }>  // throws Error on total failure (all phone variants exhausted)
  ```
  `BroadcastPlan.sendContext: BroadcastSendContext` replaces its old flat `templateName`/`templateLanguage`/`phoneNumberId`/`accessToken`/`templateRow` fields. `CreateBroadcastParams` gains `messageText?: string` and `media?: BroadcastMedia | null`; `templateName` becomes optional.

**Context:** Today, `deliverBroadcast()` (lines 262-327 of the current file) inlines a phone-variant retry loop around `sendTemplateMessage`. That loop's *shape* — try each variant, call the provider's send, on failure only retry if `isRecipientNotAllowedError` — is identical to what a UAZAPI free-text send needs, just swapping which underlying call fires. `sendBroadcastRecipient()` extracts exactly that loop, parameterized by `BroadcastSendContext.kind`.

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `src/lib/whatsapp/broadcast-core.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const state = {
  configs: new Map<string, Record<string, unknown>>(),
  broadcasts: [] as Array<Record<string, unknown>>,
  broadcastRecipients: [] as Array<Record<string, unknown>>,
};

function resetState() {
  state.configs.clear();
  state.broadcasts.length = 0;
  state.broadcastRecipients.length = 0;
}

vi.mock('@/lib/api/v1/contacts', () => ({
  findOrCreateContact: vi.fn(
    async (_db: unknown, _accountId: string, _userId: string, input: { phone: string }) => ({
      id: `contact-${input.phone}`,
    }),
  ),
}));

const uazapiProviderSpies = {
  sendText: vi.fn(async () => ({ messageId: 'uazapi-msg-1' })),
  sendMedia: vi.fn(async () => ({ messageId: 'uazapi-msg-2' })),
  sendReaction: vi.fn(async () => ({ messageId: 'uazapi-msg-3' })),
};
vi.mock('@/lib/whatsapp/provider', () => ({
  getWhatsAppProvider: vi.fn(() => uazapiProviderSpies),
}));

vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/meta-api')>();
  return {
    ...actual,
    sendTemplateMessage: vi.fn(async () => ({ messageId: 'meta-msg-1' })),
  };
});

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn((v: string) => v.replace(/^encrypted:/, '')),
}));

import { createBroadcast, deliverBroadcast, BroadcastError } from './broadcast-core';

function makeDb() {
  const chain = {
    select() {
      return chain;
    },
    eq() {
      return chain;
    },
    insert(row: Record<string, unknown>) {
      const table = chain._table;
      if (table === 'broadcasts') {
        const id = `broadcast-${state.broadcasts.length + 1}`;
        const row2 = { id, ...row };
        state.broadcasts.push(row2);
        return { select: () => ({ single: async () => ({ data: row2, error: null }) }) };
      }
      if (table === 'broadcast_recipients') {
        const rows = (Array.isArray(row) ? row : [row]).map((r, i) => ({
          id: `recipient-${state.broadcastRecipients.length + i + 1}`,
          ...r,
        }));
        state.broadcastRecipients.push(...rows);
        return { select: async () => ({ data: rows, error: null }) };
      }
      return Promise.resolve({ error: null });
    },
    update(patch: Record<string, unknown>) {
      const table = chain._table;
      if (table === 'broadcast_recipients') {
        const rec = state.broadcastRecipients.find((r) => r.id === chain._filters.id);
        if (rec) Object.assign(rec, patch);
      }
      if (table === 'broadcasts') {
        const b = state.broadcasts.find((r) => r.id === chain._filters.id);
        if (b) Object.assign(b, patch);
      }
      return Promise.resolve({ error: null });
    },
    maybeSingle: async () => {
      if (chain._table === 'whatsapp_config') {
        return { data: state.configs.get(chain._filters.account_id as string) ?? null, error: null };
      }
      return { data: null, error: null };
    },
    single: async () => {
      if (chain._table === 'whatsapp_config') {
        const cfg = state.configs.get(chain._filters.account_id as string);
        return cfg ? { data: cfg, error: null } : { data: null, error: { code: 'PGRST116' } };
      }
      return { data: null, error: { code: 'PGRST116' } };
    },
    _table: '',
    _filters: {} as Record<string, unknown>,
  };
  return {
    from(table: string) {
      chain._table = table;
      chain._filters = {};
      const originalEq = chain.eq.bind(chain);
      chain.eq = ((col: string, val: unknown) => {
        chain._filters[col] = val;
        return originalEq();
      }) as typeof chain.eq;
      return chain;
    },
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  resetState();
  vi.clearAllMocks();
});

describe('createBroadcast validation', () => {
  it('rejects an empty recipient list', async () => {
    const db = {} as SupabaseClient;
    await expect(
      createBroadcast(db, 'acc', 'user', { templateName: 'promo', recipients: [] }),
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('rejects more than 1000 recipients', async () => {
    const db = {} as SupabaseClient;
    const recipients = Array.from({ length: 1001 }, () => ({ to: '+14155550123' }));
    await expect(
      createBroadcast(db, 'acc', 'user', { templateName: 'promo', recipients }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a missing template_name for a Meta account', async () => {
    const db = makeDb();
    state.configs.set('acct-meta', {
      account_id: 'acct-meta',
      provider: 'meta',
      phone_number_id: 'pnid-1',
      access_token: 'encrypted:tok-meta',
    });
    await expect(
      createBroadcast(db, 'acct-meta', 'user-1', {
        templateName: '',
        recipients: [{ to: '+14155550123' }],
      }),
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });
});

describe('createBroadcast — Meta template path (regression)', () => {
  beforeEach(() => {
    state.configs.set('acct-meta', {
      account_id: 'acct-meta',
      provider: 'meta',
      phone_number_id: 'pnid-1',
      access_token: 'encrypted:tok-meta',
    });
  });

  it('builds a template sendContext', async () => {
    const db = makeDb();
    const plan = await createBroadcast(db, 'acct-meta', 'user-1', {
      templateName: 'promo_july',
      recipients: [{ to: '+14155550123' }],
    });

    expect(plan.sendContext).toMatchObject({
      kind: 'template',
      phoneNumberId: 'pnid-1',
      accessToken: 'tok-meta',
      templateName: 'promo_july',
      templateLanguage: 'en_US',
    });
    expect(state.broadcasts[0]).toMatchObject({ template_name: 'promo_july' });
  });
});

describe('createBroadcast — UAZAPI free-text path', () => {
  beforeEach(() => {
    state.configs.set('acct-uazapi', {
      account_id: 'acct-uazapi',
      provider: 'uazapi',
      uazapi_server_url: 'https://free.uazapi.com',
      uazapi_token: 'encrypted:tok',
      uazapi_instance_id: 'inst-1',
    });
  });

  it('rejects a missing message_text', async () => {
    const db = makeDb();
    await expect(
      createBroadcast(db, 'acct-uazapi', 'user-1', { recipients: [{ to: '+14155550123' }] }),
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('builds a freeText sendContext and persists message_text', async () => {
    const db = makeDb();
    const plan = await createBroadcast(db, 'acct-uazapi', 'user-1', {
      messageText: 'Oi, promoção de julho!',
      recipients: [{ to: '+14155550123' }],
    });

    expect(plan.sendContext.kind).toBe('freeText');
    expect(plan.sendContext.messageText).toBe('Oi, promoção de julho!');
    expect(plan.planned).toHaveLength(1);
    expect(state.broadcasts[0]).toMatchObject({
      message_text: 'Oi, promoção de julho!',
      template_name: null,
    });
  });

  it('carries an optional media attachment through to the plan and the row', async () => {
    const db = makeDb();
    const plan = await createBroadcast(db, 'acct-uazapi', 'user-1', {
      messageText: 'Confira o catálogo',
      media: { kind: 'image', url: 'https://example.com/catalogo.jpg' },
      recipients: [{ to: '+14155550123' }],
    });

    expect(plan.sendContext.media).toEqual({ kind: 'image', url: 'https://example.com/catalogo.jpg' });
    expect(state.broadcasts[0]).toMatchObject({
      media_url: 'https://example.com/catalogo.jpg',
      media_kind: 'image',
    });
  });
});

describe('deliverBroadcast — UAZAPI free-text path', () => {
  it('sends text via the WhatsApp provider and stamps the recipient row sent', async () => {
    const db = makeDb();
    state.broadcasts.push({ id: 'b-1' });
    state.broadcastRecipients.push({ id: 'r-1' });

    await deliverBroadcast(db, {
      broadcastId: 'b-1',
      sendContext: {
        kind: 'freeText',
        provider: uazapiProviderSpies,
        messageText: 'Oi!',
        media: null,
      },
      planned: [{ recipientRowId: 'r-1', phone: '+14155550123', params: [] }],
      rejected: 0,
    });

    expect(uazapiProviderSpies.sendText).toHaveBeenCalledWith({ to: '+14155550123', text: 'Oi!' });
    expect(state.broadcastRecipients[0]).toMatchObject({ status: 'sent', whatsapp_message_id: 'uazapi-msg-1' });
    expect(state.broadcasts[0]).toMatchObject({ status: 'sent' });
  });

  it('sends media with the message text as caption when a media attachment is set', async () => {
    const db = makeDb();
    state.broadcasts.push({ id: 'b-2' });
    state.broadcastRecipients.push({ id: 'r-2' });

    await deliverBroadcast(db, {
      broadcastId: 'b-2',
      sendContext: {
        kind: 'freeText',
        provider: uazapiProviderSpies,
        messageText: 'Confira!',
        media: { kind: 'image', url: 'https://example.com/x.jpg' },
      },
      planned: [{ recipientRowId: 'r-2', phone: '+14155550123', params: [] }],
      rejected: 0,
    });

    expect(uazapiProviderSpies.sendMedia).toHaveBeenCalledWith({
      to: '+14155550123',
      kind: 'image',
      link: 'https://example.com/x.jpg',
      caption: 'Confira!',
      filename: undefined,
    });
    expect(state.broadcastRecipients[0]).toMatchObject({ status: 'sent', whatsapp_message_id: 'uazapi-msg-2' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/whatsapp/broadcast-core.test.ts`
Expected: FAIL — `createBroadcast`'s `CreateBroadcastParams` doesn't yet accept `messageText`/`media`, and `plan.sendContext` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Replace the full contents of `src/lib/whatsapp/broadcast-core.ts`:

```ts
// ============================================================
// Public-API + dashboard broadcast core.
//
// Splits a broadcast into two phases so callers can persist +
// acknowledge fast and fan out afterwards:
//
//   createBroadcast()  — validate, resolve contacts, insert the
//                        `broadcasts` row + `broadcast_recipients`
//                        rows (status 'pending'), return a plan.
//   deliverBroadcast() — send each recipient (phone-variant retry),
//                        stamp each recipient row + the aggregate
//                        counts, finalize status.
//
// A broadcast is either a Meta approved-template send or a UAZAPI
// free-text (+ optional single media attachment) send — never both.
// `BroadcastSendContext.kind` picks the branch; `sendBroadcastRecipient()`
// is the one place that actually calls out to Meta/UAZAPI, shared by
// deliverBroadcast() here AND by the dashboard's
// `/api/whatsapp/broadcast` route (which owns its own recipient rows,
// created client-side, so it can't just call createBroadcast()).
//
// Recipient rows carry `whatsapp_message_id`, so the inbound webhook's
// status handler (which matches on that column) updates delivered/read
// for API broadcasts exactly as it does for dashboard ones.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { sendTemplateMessage, type MediaKind } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import type { MessageTemplate } from '@/types';
import { findOrCreateContact } from '@/lib/api/v1/contacts';
import { getWhatsAppProvider, type WhatsAppProvider, type WhatsAppConfigRow } from '@/lib/whatsapp/provider';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';

/** Thrown by createBroadcast on a caller-visible failure; route maps it. */
export class BroadcastError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'BroadcastError';
    this.code = code;
    this.status = status;
  }
}

export interface BroadcastRecipientInput {
  /** E.164 phone. */
  to: string;
  /** Positional body params for the template ({{1}}, {{2}}…). Meta-only. */
  params?: string[];
}

export interface BroadcastMedia {
  kind: MediaKind;
  url: string;
  filename?: string;
}

export interface CreateBroadcastParams {
  name?: string | null;
  /** Required for Meta accounts. */
  templateName?: string;
  templateLanguage?: string | null;
  /** Required for UAZAPI accounts. */
  messageText?: string;
  /** Optional, UAZAPI accounts only. */
  media?: BroadcastMedia | null;
  recipients: BroadcastRecipientInput[];
}

interface PlannedRecipient {
  recipientRowId: string;
  phone: string;
  params: string[];
}

/**
 * Everything `sendBroadcastRecipient` needs to send ONE recipient,
 * built once per broadcast (not per recipient). `kind` picks which set
 * of fields is populated — the other set is left undefined.
 */
export interface BroadcastSendContext {
  kind: 'template' | 'freeText';
  // 'template' (Meta)
  phoneNumberId?: string;
  accessToken?: string;
  templateName?: string;
  templateLanguage?: string;
  templateRow?: MessageTemplate | null;
  // 'freeText' (UAZAPI)
  provider?: WhatsAppProvider;
  messageText?: string;
  media?: BroadcastMedia | null;
}

export interface BroadcastPlan {
  broadcastId: string;
  sendContext: BroadcastSendContext;
  planned: PlannedRecipient[];
  /** Phones rejected up front (invalid E.164) — counted as failed. */
  rejected: number;
}

const MAX_RECIPIENTS = 1000;

/**
 * Send to ONE recipient, retrying across phone-number variants on a
 * Meta "recipient not allowed" error (a sandbox-number quirk — see
 * `isRecipientNotAllowedError`). UAZAPI never throws that specific
 * error, so its branch effectively tries once. Throws on total
 * failure (every variant exhausted); callers decide how to record
 * that (a DB row update, an HTTP response entry, …).
 */
export async function sendBroadcastRecipient(
  ctx: BroadcastSendContext,
  recipient: { phone: string; params?: string[]; messageParams?: SendTimeParams },
): Promise<{ messageId: string }> {
  const variants = phoneVariants(recipient.phone);
  let lastError: string | null = null;

  for (const variant of variants) {
    try {
      if (ctx.kind === 'freeText') {
        const provider = ctx.provider!;
        const result = ctx.media
          ? await provider.sendMedia({
              to: variant,
              kind: ctx.media.kind,
              link: ctx.media.url,
              caption: ctx.messageText || undefined,
              filename: ctx.media.filename,
            })
          : await provider.sendText({ to: variant, text: ctx.messageText! });
        return { messageId: result.messageId };
      }

      const result = await sendTemplateMessage({
        phoneNumberId: ctx.phoneNumberId!,
        accessToken: ctx.accessToken!,
        to: variant,
        templateName: ctx.templateName!,
        language: ctx.templateLanguage!,
        template: ctx.templateRow ?? undefined,
        messageParams: recipient.messageParams,
        params: recipient.params ?? [],
      });
      return { messageId: result.messageId };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      lastError = message;
      if (!isRecipientNotAllowedError(message)) break;
    }
  }

  throw new Error(lastError || 'Unknown error');
}

/**
 * Validate + persist a broadcast, resolving each recipient to a
 * contact. Returns a plan for {@link deliverBroadcast}. Throws
 * {@link BroadcastError} on bad input / missing config / a malformed
 * template / a DB failure — nothing is sent in this phase.
 */
export async function createBroadcast(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  params: CreateBroadcastParams
): Promise<BroadcastPlan> {
  const { name, templateName, recipients } = params;
  const templateLanguage = params.templateLanguage || 'en_US';

  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new BroadcastError(
      'bad_request',
      "'recipients' must be a non-empty array of { to, params? }",
      400
    );
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new BroadcastError(
      'bad_request',
      `A broadcast is capped at ${MAX_RECIPIENTS} recipients per request; split larger sends`,
      400
    );
  }

  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single();
  if (configError || !config) {
    throw new BroadcastError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }

  const isUazapi = (config as WhatsAppConfigRow).provider === 'uazapi';
  let sendContext: BroadcastSendContext;
  let templateNameForRow: string | null = null;

  if (isUazapi) {
    const messageText = (params.messageText ?? '').trim();
    if (!messageText) {
      throw new BroadcastError(
        'bad_request',
        "'message_text' is required for a UAZAPI broadcast",
        400
      );
    }
    sendContext = {
      kind: 'freeText',
      provider: getWhatsAppProvider(config as WhatsAppConfigRow),
      messageText,
      media: params.media ?? null,
    };
  } else {
    if (!templateName) {
      throw new BroadcastError('bad_request', "'template_name' is required", 400);
    }
    const accessToken = decrypt(config.access_token);

    // Template row (once) for header/button components; guard a
    // malformed local row rather than N identical opaque failures.
    const { data: rawTemplateRow } = await db
      .from('message_templates')
      .select('*')
      .eq('account_id', accountId)
      .eq('name', templateName)
      .eq('language', templateLanguage)
      .maybeSingle();
    if (rawTemplateRow && !isMessageTemplate(rawTemplateRow)) {
      throw new BroadcastError(
        'template_malformed',
        'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
        500
      );
    }
    sendContext = {
      kind: 'template',
      phoneNumberId: config.phone_number_id,
      accessToken,
      templateName,
      templateLanguage,
      templateRow: (rawTemplateRow as MessageTemplate | null) ?? null,
    };
    templateNameForRow = templateName;
  }

  // Resolve each recipient to a contact. Invalid phones are dropped
  // (counted as rejected) rather than aborting the whole broadcast.
  const resolved: { contactId: string; phone: string; params: string[] }[] = [];
  let rejected = 0;
  for (const r of recipients) {
    const sanitized = sanitizePhoneForMeta(typeof r.to === 'string' ? r.to : '');
    if (!isValidE164(sanitized)) {
      rejected++;
      continue;
    }
    const { id } = await findOrCreateContact(db, accountId, auditUserId, {
      phone: sanitized,
    });
    resolved.push({
      contactId: id,
      phone: sanitized,
      params: Array.isArray(r.params)
        ? r.params.filter((p): p is string => typeof p === 'string')
        : [],
    });
  }

  // Collapse recipients that resolved to the SAME contact (the caller
  // listed a phone twice, or two numbers fuzzy-matched to one contact).
  // Keep the first occurrence so the contact is messaged once and its
  // params aren't silently overwritten by a later duplicate — and so
  // the row↔params pairing below (keyed by contact_id) is unambiguous.
  const seenContact = new Set<string>();
  const deduped = resolved.filter((r) => {
    if (seenContact.has(r.contactId)) return false;
    seenContact.add(r.contactId);
    return true;
  });

  if (deduped.length === 0) {
    throw new BroadcastError(
      'bad_request',
      'No recipients had a valid E.164 phone number',
      400
    );
  }

  // Persist the broadcast + its recipients. The count columns
  // (sent/delivered/read/replied/failed) are owned by the DB aggregate
  // trigger (migrations 003/005) and derived purely from
  // broadcast_recipients rows — we deliberately do NOT seed them here
  // (a manual value would be clobbered by the trigger on the first
  // recipient change). `rejected` phones have no recipient row, so they
  // are reported to the caller in the POST response, not in these
  // persisted counts.
  const { data: broadcast, error: bErr } = await db
    .from('broadcasts')
    .insert({
      account_id: accountId,
      user_id: auditUserId,
      name: name || (isUazapi ? 'API broadcast (free text)' : `API broadcast (${templateName})`),
      template_name: templateNameForRow,
      template_language: templateLanguage,
      message_text: isUazapi ? sendContext.messageText : null,
      media_url: isUazapi ? (sendContext.media?.url ?? null) : null,
      media_kind: isUazapi ? (sendContext.media?.kind ?? null) : null,
      media_filename: isUazapi ? (sendContext.media?.filename ?? null) : null,
      status: 'sending',
      total_recipients: deduped.length,
    })
    .select('id')
    .single();
  if (bErr || !broadcast) {
    console.error('[broadcast-core] create broadcast error:', bErr);
    throw new BroadcastError('internal', 'Failed to create broadcast', 500);
  }

  const { data: recipientRows, error: rErr } = await db
    .from('broadcast_recipients')
    .insert(
      deduped.map((r) => ({
        broadcast_id: broadcast.id,
        contact_id: r.contactId,
        status: 'pending' as const,
      }))
    )
    .select('id, contact_id');
  if (rErr || !recipientRows) {
    console.error('[broadcast-core] create recipients error:', rErr);
    throw new BroadcastError('internal', 'Failed to create broadcast', 500);
  }

  // Pair each inserted recipient row back to its phone/params by
  // contact_id — unambiguous now that duplicates are collapsed.
  const byContact = new Map(deduped.map((r) => [r.contactId, r]));
  const planned: PlannedRecipient[] = recipientRows.map((row) => {
    const r = byContact.get(row.contact_id as string)!;
    return { recipientRowId: row.id as string, phone: r.phone, params: r.params };
  });

  return {
    broadcastId: broadcast.id,
    sendContext,
    planned,
    rejected,
  };
}

/**
 * Fan out a {@link BroadcastPlan}: send each recipient (phone-variant
 * retry via {@link sendBroadcastRecipient}) and stamp its
 * `broadcast_recipients` row. Best-effort per recipient — one failure
 * never aborts the rest. Designed to run inside `after()`.
 *
 * The per-status count columns on `broadcasts` are owned by the DB
 * aggregate trigger (migrations 003/005): each recipient-row update
 * below advances them automatically, and later delivery/read webhooks
 * keep advancing them. We therefore never write those columns here —
 * only the terminal `status` — otherwise a manual value would race and
 * clobber the trigger-maintained counts.
 */
export async function deliverBroadcast(
  db: SupabaseClient,
  plan: BroadcastPlan
): Promise<void> {
  let sentCount = 0;

  for (const recipient of plan.planned) {
    try {
      const result = await sendBroadcastRecipient(plan.sendContext, recipient);
      sentCount++;
      await db
        .from('broadcast_recipients')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          whatsapp_message_id: result.messageId,
          error_message: null,
        })
        .eq('id', recipient.recipientRowId);
    } catch (error) {
      await db
        .from('broadcast_recipients')
        .update({
          status: 'failed',
          error_message: error instanceof Error ? error.message : 'Unknown error',
        })
        .eq('id', recipient.recipientRowId);
    }
  }

  // Terminal status only — counts are trigger-owned (see the note
  // above). If nothing sent, the broadcast failed outright; a partial
  // send is still 'sent' (per-recipient failures show in failed_count).
  await db
    .from('broadcasts')
    .update({
      status: sentCount > 0 ? 'sent' : 'failed',
      updated_at: new Date().toISOString(),
    })
    .eq('id', plan.broadcastId);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/whatsapp/broadcast-core.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no new errors. `src/app/api/v1/broadcasts/route.ts` and `src/app/api/whatsapp/broadcast/route.ts` will now fail to typecheck against the new `BroadcastPlan`/`CreateBroadcastParams` shapes — that's expected and fixed by Task 3 (the dashboard route) and by re-reading Task 2's own change to `src/app/api/v1/broadcasts/route.ts` below.

Update `src/app/api/v1/broadcasts/route.ts` — it doesn't reference `plan.templateName` etc. directly (it only reads `plan.broadcastId`/`plan.planned`/`plan.rejected`), so no code change is needed there; confirm this with:

Run: `grep -n "plan\." src/app/api/v1/broadcasts/route.ts`
Expected output: only `plan.broadcastId`, `plan.planned.length`, `plan.rejected` — nothing referencing the fields that moved into `sendContext`. If anything else shows up, update it to read from `plan.sendContext` instead.

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp/broadcast-core.ts src/lib/whatsapp/broadcast-core.test.ts
git commit -m "refactor: extract sendBroadcastRecipient and add UAZAPI free-text broadcasts to broadcast-core"
```

---

### Task 3: Dashboard broadcast route — UAZAPI branch + dedup via `sendBroadcastRecipient`

**Files:**
- Modify: `src/app/api/whatsapp/broadcast/route.ts`
- Create: `src/app/api/whatsapp/broadcast/route.test.ts`

**Interfaces:**
- Consumes: `sendBroadcastRecipient`, `BroadcastSendContext` from `@/lib/whatsapp/broadcast-core` (Task 2); `getWhatsAppProvider` from `@/lib/whatsapp/provider`.
- Produces: nothing new — this is a route; Task 4 (the hook) is its only caller.

**Context:** This route accepts `{ recipients: [{phone, params?, messageParams?}] }` (or the legacy `phone_numbers`/`template_params` shape) and `template_name` today, always. It gains a UAZAPI branch: when `config.provider === 'uazapi'`, `template_name` is no longer required — instead `message_text` (required) and `media` (optional, `{kind, url, filename?}`) drive the send. The existing hand-rolled phone-variant retry loop around `sendTemplateMessage` is deleted; the per-recipient loop now calls `sendBroadcastRecipient()`.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/whatsapp/broadcast/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = {
  profile: { account_id: 'acct-1' } as Record<string, unknown> | null,
  config: null as Record<string, unknown> | null,
};

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(() => ({ success: true })),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { broadcast: {} },
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn((v: string) => v.replace(/^encrypted:/, '')),
}));

const { sendBroadcastRecipient } = vi.hoisted(() => ({
  sendBroadcastRecipient: vi.fn(async () => ({ messageId: 'msg-1' })),
}));
vi.mock('@/lib/whatsapp/broadcast-core', () => ({ sendBroadcastRecipient }));

const providerSpy = { sendText: vi.fn(), sendMedia: vi.fn(), sendReaction: vi.fn() };
vi.mock('@/lib/whatsapp/provider', () => ({
  getWhatsAppProvider: vi.fn(() => providerSpy),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }),
    },
    from(table: string) {
      const chain = {
        select() {
          return chain;
        },
        eq() {
          return chain;
        },
        maybeSingle: async () => {
          if (table === 'profiles') return { data: state.profile, error: null };
          if (table === 'message_templates') return { data: null, error: null };
          return { data: null, error: null };
        },
        single: async () => {
          if (table === 'whatsapp_config') {
            return state.config
              ? { data: state.config, error: null }
              : { data: null, error: { code: 'PGRST116' } };
          }
          return { data: null, error: { code: 'PGRST116' } };
        },
      };
      return chain;
    },
  })),
}));

import { POST } from './route';

function postBody(body: Record<string, unknown>) {
  return POST(
    new Request('http://localhost/api/whatsapp/broadcast', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.profile = { account_id: 'acct-1' };
  state.config = null;
});

describe('POST /api/whatsapp/broadcast — UAZAPI', () => {
  it('requires message_text for a UAZAPI-provider account', async () => {
    state.config = { provider: 'uazapi', account_id: 'acct-1' };
    const res = await postBody({ recipients: [{ phone: '+14155550123' }] });
    expect(res.status).toBe(400);
  });

  it('sends a free-text broadcast for a UAZAPI-provider account', async () => {
    state.config = { provider: 'uazapi', account_id: 'acct-1' };
    const res = await postBody({
      recipients: [{ phone: '+14155550123' }],
      message_text: 'Oi!',
    });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.sent).toBe(1);
    expect(sendBroadcastRecipient).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'freeText', messageText: 'Oi!' }),
      expect.objectContaining({ phone: '+14155550123' }),
    );
  });

  it('passes a media attachment through to the send context', async () => {
    state.config = { provider: 'uazapi', account_id: 'acct-1' };
    await postBody({
      recipients: [{ phone: '+14155550123' }],
      message_text: 'Confira',
      media: { kind: 'image', url: 'https://example.com/x.jpg' },
    });
    expect(sendBroadcastRecipient).toHaveBeenCalledWith(
      expect.objectContaining({ media: { kind: 'image', url: 'https://example.com/x.jpg', filename: undefined } }),
      expect.anything(),
    );
  });
});

describe('POST /api/whatsapp/broadcast — Meta (regression)', () => {
  it('still requires template_name for a Meta-provider account', async () => {
    state.config = { provider: 'meta', phone_number_id: 'pnid', access_token: 'encrypted:tok' };
    const res = await postBody({ recipients: [{ phone: '+14155550123' }] });
    expect(res.status).toBe(400);
  });

  it('sends a template broadcast for a Meta-provider account', async () => {
    state.config = { provider: 'meta', phone_number_id: 'pnid', access_token: 'encrypted:tok' };
    const res = await postBody({
      recipients: [{ phone: '+14155550123', params: ['Jane'] }],
      template_name: 'promo_july',
    });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.sent).toBe(1);
    expect(sendBroadcastRecipient).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'template', templateName: 'promo_july', accessToken: 'tok' }),
      expect.objectContaining({ phone: '+14155550123', params: ['Jane'] }),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/app/api/whatsapp/broadcast/route.test.ts`
Expected: FAIL — the current route always requires `template_name` and always decrypts `config.access_token`, so the UAZAPI-branch tests fail (400/decrypt-crash instead of the expected 200 flow).

- [ ] **Step 3: Write the implementation**

Replace the full contents of `src/app/api/whatsapp/broadcast/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard'
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'
import { getWhatsAppProvider } from '@/lib/whatsapp/provider'
import {
  sendBroadcastRecipient,
  type BroadcastSendContext,
} from '@/lib/whatsapp/broadcast-core'
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

interface BroadcastResult {
  phone: string
  status: 'sent' | 'failed'
  whatsapp_message_id?: string
  error?: string
}

/**
 * Meta accounts: two input shapes are accepted —
 *
 *   NEW (preferred — supports per-recipient variable substitution):
 *     { recipients: [{ phone, params: string[] }], template_name, template_language }
 *
 *   LEGACY (all phones receive the same params):
 *     { phone_numbers: string[], template_params: string[], template_name, template_language }
 *
 * UAZAPI accounts: `message_text` (required) + optional `media`
 * ({ kind, url, filename? }) replace `template_name` — the same text
 * and attachment go to every recipient (no per-recipient personalization
 * in v1, matching the design doc's UAZAPI scope decisions).
 */
interface NewRecipient {
  phone: string
  params?: string[]
  messageParams?: SendTimeParams
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Per-user broadcast budget. Note: this limits how often a user
    // can *start* a campaign, not how many messages go out inside
    // one — the fan-out loop below runs without additional gating.
    const limit = checkRateLimit(`broadcast:${user.id}`, RATE_LIMITS.broadcast)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    // Resolve the caller's account_id. whatsapp_config + templates
    // + broadcasts are all account-scoped post-multi-user, so the
    // old `.eq('user_id', user.id)` filters miss every row created
    // by a teammate.
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

    const body = await request.json()
    const {
      recipients: newRecipients,
      phone_numbers,
      template_name,
      template_language,
      template_params,
      message_text,
      media,
    } = body

    // Normalize to a list of {phone, params} regardless of shape.
    let recipients: NewRecipient[]
    if (Array.isArray(newRecipients) && newRecipients.length > 0) {
      recipients = newRecipients
    } else if (Array.isArray(phone_numbers) && phone_numbers.length > 0) {
      const shared: string[] = Array.isArray(template_params)
        ? template_params
        : []
      recipients = phone_numbers.map((phone: string) => ({
        phone,
        params: shared,
      }))
    } else {
      return NextResponse.json(
        {
          error:
            'Provide either `recipients` (preferred) or `phone_numbers` — must be a non-empty array',
        },
        { status: 400 }
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        {
          error:
            'WhatsApp not configured. Please set up your WhatsApp integration first.',
        },
        { status: 400 }
      )
    }

    let sendContext: BroadcastSendContext

    if (config.provider === 'uazapi') {
      const messageText = typeof message_text === 'string' ? message_text.trim() : ''
      if (!messageText) {
        return NextResponse.json({ error: 'message_text is required' }, { status: 400 })
      }
      sendContext = {
        kind: 'freeText',
        provider: getWhatsAppProvider(config),
        messageText,
        media:
          media && typeof media === 'object' && typeof media.url === 'string'
            ? { kind: media.kind, url: media.url, filename: media.filename }
            : null,
      }
    } else {
      if (!template_name) {
        return NextResponse.json(
          { error: 'template_name is required' },
          { status: 400 }
        )
      }
      const accessToken = decrypt(config.access_token)

      // Load the template row once so sendTemplateMessage can build
      // header + button components on each iteration. Loading inside
      // the loop would N+1 against Supabase for every recipient.
      // Guard against a malformed local row crashing every send in
      // the loop with the same opaque TypeError — fail loudly once.
      const { data: rawTemplateRow } = await supabase
        .from('message_templates')
        .select('*')
        .eq('account_id', accountId)
        .eq('name', template_name)
        .eq('language', template_language || 'en_US')
        .maybeSingle()
      if (rawTemplateRow && !isMessageTemplate(rawTemplateRow)) {
        return NextResponse.json(
          {
            error:
              'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
          },
          { status: 500 },
        )
      }
      sendContext = {
        kind: 'template',
        phoneNumberId: config.phone_number_id,
        accessToken,
        templateName: template_name,
        templateLanguage: template_language || 'en_US',
        templateRow: rawTemplateRow ?? null,
      }
    }

    const results: BroadcastResult[] = []
    let sentCount = 0
    let failedCount = 0

    for (const recipient of recipients) {
      const sanitized = sanitizePhoneForMeta(recipient.phone)

      if (!isValidE164(sanitized)) {
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: 'Invalid phone number format',
        })
        failedCount++
        continue
      }

      try {
        const result = await sendBroadcastRecipient(sendContext, {
          phone: sanitized,
          params: recipient.params,
          messageParams: recipient.messageParams,
        })
        results.push({
          phone: recipient.phone,
          status: 'sent',
          whatsapp_message_id: result.messageId,
        })
        sentCount++
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error'
        console.error(
          `Failed to send broadcast to ${recipient.phone}:`,
          errorMessage
        )
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: errorMessage,
        })
        failedCount++
      }
    }

    return NextResponse.json({
      success: true,
      total: recipients.length,
      sent: sentCount,
      failed: failedCount,
      results,
    })
  } catch (error) {
    console.error('Error in WhatsApp broadcast POST:', error)
    return NextResponse.json(
      { error: 'Failed to process broadcast' },
      { status: 500 }
    )
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/app/api/whatsapp/broadcast/route.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/whatsapp/broadcast/route.ts src/app/api/whatsapp/broadcast/route.test.ts
git commit -m "feat: add UAZAPI free-text branch to the dashboard broadcast route"
```

---

### Task 4: `use-broadcast-sending.ts` — discriminated `BroadcastPayload`

**Files:**
- Modify: `src/hooks/use-broadcast-sending.ts`

**Interfaces:**
- Consumes: nothing new from other tasks — this hook calls `/api/whatsapp/broadcast` (Task 3) over `fetch`, not any TypeScript import.
- Produces (used by Task 7's `new/page.tsx`):
  ```ts
  export interface BroadcastMediaAttachment {
    kind: 'image' | 'video' | 'document' | 'audio'
    url: string
    filename?: string
  }

  export type BroadcastPayload =
    | { mode: 'template'; name: string; template: MessageTemplate; audience: AudienceConfig;
        variables: Record<string, VariableMapping>; headerMediaUrl?: string }
    | { mode: 'freeText'; name: string; audience: AudienceConfig; messageText: string;
        media?: BroadcastMediaAttachment | null }
  ```

**Context:** No test file exists for this hook today (it's exercised only through the wizard UI) — this plan doesn't add one, matching that existing convention. Three edits, all inside `createAndSendBroadcast`.

- [ ] **Step 1: Replace the `BroadcastPayload` type**

In `src/hooks/use-broadcast-sending.ts`, replace:

```ts
interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  /**
   * Media URL for an IMAGE/VIDEO/DOCUMENT header. Required at send
   * time for media-header templates — Meta rejects the send without
   * it. Passed through as `messageParams.headerMediaUrl`; the builder
   * falls back to the template's stored URL only when this is empty.
   */
  headerMediaUrl?: string;
}
```

with:

```ts
export interface BroadcastMediaAttachment {
  kind: 'image' | 'video' | 'document' | 'audio';
  url: string;
  filename?: string;
}

export type BroadcastPayload =
  | {
      mode: 'template';
      name: string;
      template: MessageTemplate;
      audience: AudienceConfig;
      variables: Record<string, VariableMapping>;
      /**
       * Media URL for an IMAGE/VIDEO/DOCUMENT header. Required at send
       * time for media-header templates — Meta rejects the send without
       * it. Passed through as `messageParams.headerMediaUrl`; the builder
       * falls back to the template's stored URL only when this is empty.
       */
      headerMediaUrl?: string;
    }
  | {
      mode: 'freeText';
      name: string;
      audience: AudienceConfig;
      messageText: string;
      media?: BroadcastMediaAttachment | null;
    };
```

- [ ] **Step 2: Branch the `broadcasts` insert**

Replace:

```ts
      const { data: broadcast, error: broadcastError } = await supabase
        .from('broadcasts')
        .insert({
          user_id: user.id,
          account_id: accountId,
          name: payload.name,
          template_name: payload.template.name,
          template_language: payload.template.language ?? 'en_US',
          template_variables: payload.variables,
          audience_filter: {
            type: payload.audience.type,
            tagIds: payload.audience.tagIds,
            customField: payload.audience.customField,
            excludeTagIds: payload.audience.excludeTagIds,
          },
          status: 'sending',
          total_recipients: contacts.length,
          sent_count: 0,
          delivered_count: 0,
          read_count: 0,
          replied_count: 0,
          failed_count: 0,
        })
        .select()
        .single();
```

with:

```ts
      const { data: broadcast, error: broadcastError } = await supabase
        .from('broadcasts')
        .insert({
          user_id: user.id,
          account_id: accountId,
          name: payload.name,
          ...(payload.mode === 'template'
            ? {
                template_name: payload.template.name,
                template_language: payload.template.language ?? 'en_US',
                template_variables: payload.variables,
              }
            : {
                message_text: payload.messageText,
                media_url: payload.media?.url ?? null,
                media_kind: payload.media?.kind ?? null,
                media_filename: payload.media?.filename ?? null,
              }),
          audience_filter: {
            type: payload.audience.type,
            tagIds: payload.audience.tagIds,
            customField: payload.audience.customField,
            excludeTagIds: payload.audience.excludeTagIds,
          },
          status: 'sending',
          total_recipients: contacts.length,
          sent_count: 0,
          delivered_count: 0,
          read_count: 0,
          replied_count: 0,
          failed_count: 0,
        })
        .select()
        .single();
```

- [ ] **Step 3: Branch the per-batch send loop**

Replace:

```ts
      // Media-header templates (image/video/document) require a media
      // URL on every send. Collected in the personalize step and applied
      // to all recipients; falls back to the template's stored URL on the
      // server when omitted.
      const headerType = payload.template.header_type;
      const isMediaHeader =
        headerType === 'image' ||
        headerType === 'video' ||
        headerType === 'document';
      const headerMediaUrl = payload.headerMediaUrl?.trim();
      const messageParams =
        isMediaHeader && headerMediaUrl ? { headerMediaUrl } : undefined;

      for (let i = 0; i < recipients.length; i += SEND_BATCH_SIZE) {
        const batch = recipients.slice(i, i + SEND_BATCH_SIZE);

        const apiRecipients = batch
          .filter((r) => r.contact?.phone)
          .map((r) => ({
            phone: r.contact!.phone as string,
            params: r.contact
              ? resolveVariables(
                  payload.variables,
                  r.contact,
                  customValueIndex.get(r.contact.id),
                )
              : [],
            ...(messageParams ? { messageParams } : {}),
          }));

        if (apiRecipients.length === 0) continue;

        try {
          const res = await fetch('/api/whatsapp/broadcast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              recipients: apiRecipients,
              template_name: payload.template.name,
              template_language: payload.template.language ?? 'en_US',
            }),
          });
```

with:

```ts
      // Media-header templates (image/video/document) require a media
      // URL on every send. Collected in the personalize step and applied
      // to all recipients; falls back to the template's stored URL on the
      // server when omitted. Meaningless in 'freeText' mode.
      const headerType = payload.mode === 'template' ? payload.template.header_type : null;
      const isMediaHeader =
        headerType === 'image' ||
        headerType === 'video' ||
        headerType === 'document';
      const headerMediaUrl = payload.mode === 'template' ? payload.headerMediaUrl?.trim() : undefined;
      const messageParams =
        isMediaHeader && headerMediaUrl ? { headerMediaUrl } : undefined;

      for (let i = 0; i < recipients.length; i += SEND_BATCH_SIZE) {
        const batch = recipients.slice(i, i + SEND_BATCH_SIZE);

        const apiRecipients = batch
          .filter((r) => r.contact?.phone)
          .map((r) => ({
            phone: r.contact!.phone as string,
            params:
              payload.mode === 'template' && r.contact
                ? resolveVariables(
                    payload.variables,
                    r.contact,
                    customValueIndex.get(r.contact.id),
                  )
                : [],
            ...(messageParams ? { messageParams } : {}),
          }));

        if (apiRecipients.length === 0) continue;

        try {
          const res = await fetch('/api/whatsapp/broadcast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              payload.mode === 'template'
                ? {
                    recipients: apiRecipients,
                    template_name: payload.template.name,
                    template_language: payload.template.language ?? 'en_US',
                  }
                : {
                    recipients: apiRecipients,
                    message_text: payload.messageText,
                    media: payload.media ?? undefined,
                  },
            ),
          });
```

The rest of the loop (reading `data.results`, stamping recipient rows) is unchanged — it only keys off `phone`, which both modes produce identically.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: errors in `src/app/(dashboard)/broadcasts/new/page.tsx` (still calling `createAndSendBroadcast` with the old flat shape) — expected, fixed by Task 7.

- [ ] **Step 5: Commit**

Hold this commit — Task 4 alone doesn't typecheck clean (Task 7 depends on it and vice versa isn't true, but committing a broken typecheck state mid-plan is avoidable). Combine into one commit with Task 7:

```bash
git add src/hooks/use-broadcast-sending.ts
```
(no commit yet — staged only; committed together with Task 7's changes)

---

### Task 5: `Step4ScheduleSend` — provider-agnostic summary props

**Files:**
- Modify: `src/components/broadcasts/step4-schedule-send.tsx`

**Context:** This step only ever reads `template.name` and `template.language` — never anything else off the `MessageTemplate` object. Replacing those two reads with plain strings lets the same component serve both wizard flows without importing `MessageTemplate` at all.

- [ ] **Step 1: Remove the `MessageTemplate` import**

Replace:

```ts
import { MessageTemplate } from '@/types';
```

with nothing (delete the line).

- [ ] **Step 2: Replace the `template` prop with `summaryLabel`/`summarySublabel`**

Replace:

```ts
interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  template: MessageTemplate;
  audience: AudienceConfig;
  onSend: () => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
}

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
  audience,
  onSend,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
}: Step4Props) {
```

with:

```ts
interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  /** Template name (Meta) or a truncated free-text preview (UAZAPI). */
  summaryLabel: string;
  /** Template language (Meta) or a fixed "Free text" label (UAZAPI). */
  summarySublabel: string;
  audience: AudienceConfig;
  onSend: () => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
}

export function Step4ScheduleSend({
  name,
  onNameChange,
  summaryLabel,
  summarySublabel,
  audience,
  onSend,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
}: Step4Props) {
```

- [ ] **Step 3: Replace the two summary-card reads**

Replace:

```tsx
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.template')}</p>
            <p className="text-foreground">{template.name}</p>
          </div>
```

with:

```tsx
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.template')}</p>
            <p className="text-foreground">{summaryLabel}</p>
          </div>
```

Replace:

```tsx
          <div>
            <p className="text-xs text-muted-foreground">Language</p>
            <p className="text-foreground">{template.language ?? 'en_US'}</p>
          </div>
```

with:

```tsx
          <div>
            <p className="text-xs text-muted-foreground">Language</p>
            <p className="text-foreground">{summarySublabel}</p>
          </div>
```

- [ ] **Step 4: Replace the confirm-dialog read**

Replace:

```tsx
              <DialogDescription className="text-muted-foreground">
                You are about to send this broadcast to{' '}
                <span className="font-medium text-popover-foreground">{estimatedReach.toLocaleString()}</span>{' '}
                contacts using the{' '}
                <span className="font-medium text-popover-foreground">{template.name}</span> template.
                This action cannot be undone.
              </DialogDescription>
```

with:

```tsx
              <DialogDescription className="text-muted-foreground">
                You are about to send this broadcast to{' '}
                <span className="font-medium text-popover-foreground">{estimatedReach.toLocaleString()}</span>{' '}
                contacts (
                <span className="font-medium text-popover-foreground">{summaryLabel}</span>).
                This action cannot be undone.
              </DialogDescription>
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: an error in `src/app/(dashboard)/broadcasts/new/page.tsx` — still passing the old `template` prop. Expected, fixed by Task 7.

- [ ] **Step 6: Commit**

Stage only — committed together with Task 7:

```bash
git add src/components/broadcasts/step4-schedule-send.tsx
```

---

### Task 6: `Step1ComposeMessage` — free text + optional media (UAZAPI)

**Files:**
- Create: `src/components/broadcasts/step1-compose-message.tsx`

**Interfaces:**
- Consumes: `uploadAccountMedia`, `deleteAccountMedia`, `MEDIA_MAX_BYTES_BY_KIND` from `@/lib/storage/upload-media`; `CHAT_MEDIA_BUCKET` from `@/components/inbox/message-composer` (already exported there and imported cross-feature by `message-thread.tsx` — same bucket, same account-scoped RLS policy, no reason for a second one).
- Produces (used by Task 7's `new/page.tsx`):
  ```ts
  export type ComposeMediaKind = 'image' | 'video' | 'document'
  export interface ComposeMediaAttachment {
    kind: ComposeMediaKind
    url: string
    path: string
    filename?: string
  }
  ```

**Context:** Mirrors the inbox composer's attach pattern (`src/components/inbox/message-composer.tsx`'s `PICKER_ACCEPT` map and upload/remove calls), simplified to a single attachment instead of a full chat composer: a textarea plus up to one of image/video/document. No audio (mic-recorder-only in the inbox, out of scope here per this plan's Global Constraints).

- [ ] **Step 1: Write the component**

Create `src/components/broadcasts/step1-compose-message.tsx`:

```tsx
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
```

- [ ] **Step 2: Add the new translation keys**

In `messages/en.json`, inside `"Broadcasts": { "wizard": { ... } }` (after the existing `"chooseTemplate": { ... }` block, before `"selectAudience"`), add:

```json
      "composeMessage": {
        "title": "Write your message",
        "subtitle": "This text (and an optional attachment) goes to every recipient — no per-contact personalization in this version.",
        "placeholder": "Type your broadcast message…",
        "attach": {
          "image": "Image",
          "video": "Video",
          "document": "Document"
        },
        "attachOptional": "Optional — attach one image, video, or document.",
        "fileTooLarge": "File is too large.",
        "uploadFailed": "Upload failed."
      },
```

In `"Broadcasts": { "new": { "steps": { ... } } }`, add a `compose` key alongside the existing `template`/`audience`/`personalize`/`send`:

```json
      "steps": {
        "template": "Template",
        "compose": "Message",
        "audience": "Audience",
        "personalize": "Personalize",
        "send": "Send"
      },
```

In `"Broadcasts": { "new": { ... } }` (alongside `toastGiveName` etc.), add two more keys:

```json
      "freeTextLabel": "Free text",
      "toastNoContent": "Write a message before saving a draft.",
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no new errors (this component isn't imported anywhere yet — that's Task 7).

- [ ] **Step 4: Commit**

Stage only — committed together with Task 7:

```bash
git add src/components/broadcasts/step1-compose-message.tsx messages/en.json
```

---

### Task 7: Wire the wizard — provider detection, step branching

**Files:**
- Modify: `src/app/(dashboard)/broadcasts/new/page.tsx`

**Interfaces:**
- Consumes: `Step1ComposeMessage`, `ComposeMediaAttachment` (Task 6); `BroadcastPayload`, `BroadcastMediaAttachment` (Task 4).

**Context:** The page fetches the account's `whatsapp_config.provider` once (mirroring the exact query `src/components/settings/whatsapp-config.tsx:39-43` already uses), then picks a 3-step (`compose → audience → send`) or 4-step (`template → audience → personalize → send`) flow. Step content is now selected by a string step-key instead of a numeric index, since the two flows have different step counts.

- [ ] **Step 1: Replace the full file**

Replace the full contents of `src/app/(dashboard)/broadcasts/new/page.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import { MessageTemplate } from '@/types';
import { Step1ChooseTemplate } from '@/components/broadcasts/step1-choose-template';
import { Step1ComposeMessage, type ComposeMediaAttachment } from '@/components/broadcasts/step1-compose-message';
import { Step2SelectAudience } from '@/components/broadcasts/step2-select-audience';
import { Step3Personalize } from '@/components/broadcasts/step3-personalize';
import { Step4ScheduleSend } from '@/components/broadcasts/step4-schedule-send';
import { useBroadcastSending } from '@/hooks/use-broadcast-sending';
import { Check, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

const STEPS_META = ['template', 'audience', 'personalize', 'send'] as const;
const STEPS_UAZAPI = ['compose', 'audience', 'send'] as const;

export default function NewBroadcastPage() {
  const router = useRouter();
  const t = useTranslations('Broadcasts.new');
  const { accountId } = useAuth();
  const { createAndSendBroadcast, isProcessing, progress } = useBroadcastSending();

  const [provider, setProvider] = useState<'meta' | 'uazapi' | null>(null);
  const [providerLoading, setProviderLoading] = useState(true);

  useEffect(() => {
    if (!accountId) return;
    async function fetchProvider() {
      const supabase = createClient();
      const { data } = await supabase
        .from('whatsapp_config')
        .select('provider')
        .eq('account_id', accountId)
        .maybeSingle();
      setProvider((data?.provider as 'meta' | 'uazapi' | undefined) ?? 'meta');
      setProviderLoading(false);
    }
    fetchProvider();
  }, [accountId]);

  const steps = provider === 'uazapi' ? STEPS_UAZAPI : STEPS_META;

  const [currentStep, setCurrentStep] = useState(0);
  const [template, setTemplate] = useState<MessageTemplate | null>(null);
  const [messageText, setMessageText] = useState('');
  const [media, setMedia] = useState<ComposeMediaAttachment | null>(null);
  const [audience, setAudience] = useState<{
    type: 'all' | 'tags' | 'custom_field' | 'csv';
    tagIds?: string[];
    customField?: {
      fieldId: string;
      operator: 'is' | 'is_not' | 'contains';
      value: string;
    };
    csvContacts?: { phone: string; name?: string }[];
    excludeTagIds?: string[];
  }>({ type: 'all' });
  const [variables, setVariables] = useState<
    Record<string, { type: 'static' | 'field' | 'custom_field'; value: string }>
  >({});
  const [headerMediaUrl, setHeaderMediaUrl] = useState('');
  const [name, setName] = useState('');

  const stepKey = steps[currentStep];

  async function handleSend() {
    try {
      const commonAudience = {
        type: audience.type,
        tagIds: audience.tagIds,
        customField: audience.customField,
        csvContacts: audience.csvContacts,
        excludeTagIds: audience.excludeTagIds,
      };

      const broadcastId = await createAndSendBroadcast(
        provider === 'uazapi'
          ? {
              mode: 'freeText',
              name,
              audience: commonAudience,
              messageText,
              media: media ? { kind: media.kind, url: media.url, filename: media.filename } : null,
            }
          : {
              mode: 'template',
              name,
              template: template!,
              audience: commonAudience,
              variables,
              headerMediaUrl,
            },
      );
      router.push(`/broadcasts/${broadcastId}`);
    } catch (err) {
      // Previously swallowed with console.error — the wizard would
      // just no-op, leaving the user confused. Surface the reason.
      const message = err instanceof Error ? err.message : 'Broadcast failed';
      console.error('Broadcast failed:', err);
      toast.error(message);
    }
  }

  /**
   * Writes a draft broadcast row — no recipients, no sending. The user
   * can revisit it via the list page to finish the flow later. We
   * don't persist the in-progress audience/variable config here
   * because the current schema doesn't carry it past `audience_filter`
   * and `template_variables`; those are enough for the user to
   * recognize the draft but not to exactly round-trip into the wizard.
   * A full resume-draft UX is a future polish.
   */
  async function handleSaveDraft() {
    const hasContent = provider === 'uazapi' ? messageText.trim().length > 0 : Boolean(template);
    if (!hasContent) {
      toast.error(t('toastNoContent'));
      return;
    }
    if (!name.trim()) {
      toast.error(t('toastGiveName'));
      return;
    }
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      toast.error(t('toastNotSignedIn'));
      return;
    }
    if (!accountId) {
      toast.error(t('toastNotLinked'));
      return;
    }

    const { error } = await supabase.from('broadcasts').insert({
      user_id: user.id,
      account_id: accountId,
      name: name.trim(),
      ...(provider === 'uazapi'
        ? { message_text: messageText }
        : {
            template_name: template!.name,
            template_language: template!.language ?? 'en_US',
            template_variables: variables,
          }),
      audience_filter: {
        type: audience.type,
        tagIds: audience.tagIds,
      },
      status: 'draft',
      total_recipients: 0,
      sent_count: 0,
      delivered_count: 0,
      read_count: 0,
      replied_count: 0,
      failed_count: 0,
    });

    if (error) {
      toast.error(t('toastFailedDraft', { error: error.message }));
      return;
    }
    toast.success(t('toastDraftSaved'));
    router.push('/broadcasts');
  }

  if (providerLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('subtitle')}
        </p>
      </div>

      {/* Step Indicator */}
      <div className="flex items-center justify-between">
        {steps.map((step, index) => {
          const isActive = index === currentStep;
          const isCompleted = index < currentStep;

          return (
            <div key={step} className="flex flex-1 items-center">
              <div className="flex items-center gap-2">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-all ${
                    isCompleted
                      ? 'bg-primary text-primary-foreground'
                      : isActive
                        ? 'border-2 border-primary bg-primary/10 text-primary'
                        : 'border border-border bg-muted text-muted-foreground'
                  }`}
                >
                  {isCompleted ? <Check className="h-4 w-4" /> : index + 1}
                </div>
                <span
                  className={`hidden text-sm font-medium sm:block ${
                    isActive ? 'text-foreground' : isCompleted ? 'text-primary' : 'text-muted-foreground'
                  }`}
                >
                  {t(`steps.${step}`)}
                </span>
              </div>
              {index < steps.length - 1 && (
                <div
                  className={`mx-3 h-px flex-1 ${
                    index < currentStep ? 'bg-primary' : 'bg-muted'
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Step Content */}
      <div className="relative min-h-[400px]">
        <div
          className="transition-all duration-300 ease-in-out"
          style={{
            opacity: isProcessing ? 0.6 : 1,
            pointerEvents: isProcessing ? 'none' : 'auto',
          }}
        >
          {stepKey === 'template' && (
            <Step1ChooseTemplate
              selectedTemplate={template}
              onSelect={setTemplate}
              onNext={() => setCurrentStep(currentStep + 1)}
              onBack={() => router.push('/broadcasts')}
            />
          )}
          {stepKey === 'compose' && (
            <Step1ComposeMessage
              messageText={messageText}
              onMessageTextChange={setMessageText}
              media={media}
              onMediaChange={setMedia}
              onNext={() => setCurrentStep(currentStep + 1)}
              onBack={() => router.push('/broadcasts')}
            />
          )}
          {stepKey === 'audience' && (
            <Step2SelectAudience
              audience={audience}
              onUpdate={setAudience}
              onNext={() => setCurrentStep(currentStep + 1)}
              onBack={() => setCurrentStep(currentStep - 1)}
            />
          )}
          {stepKey === 'personalize' && template && (
            <Step3Personalize
              template={template}
              variables={variables}
              onUpdate={setVariables}
              headerMediaUrl={headerMediaUrl}
              onHeaderMediaUrlChange={setHeaderMediaUrl}
              onNext={() => setCurrentStep(currentStep + 1)}
              onBack={() => setCurrentStep(currentStep - 1)}
            />
          )}
          {stepKey === 'send' && (
            <Step4ScheduleSend
              name={name}
              onNameChange={setName}
              summaryLabel={
                provider === 'uazapi' ? messageText.slice(0, 60) || '—' : (template?.name ?? '—')
              }
              summarySublabel={
                provider === 'uazapi' ? t('freeTextLabel') : (template?.language ?? 'en_US')
              }
              audience={audience}
              onSend={handleSend}
              onSaveDraft={handleSaveDraft}
              onBack={() => setCurrentStep(currentStep - 1)}
              isProcessing={isProcessing}
              progress={progress}
            />
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors — this is the task that resolves the errors left dangling by Tasks 4 and 5.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS, same pre-existing failure count as before this plan (5).

- [ ] **Step 4: Manual smoke check**

Run: `npm run dev`, sign into an account connected via **Meta** and walk through **New Broadcast**: confirm all 4 steps still render exactly as before (template gallery → audience → personalize → send), and the step indicator shows 4 steps.

Then, on an account connected via **UAZAPI** (or temporarily flip a test account's `whatsapp_config.provider` to `'uazapi'` if you don't have a live UAZAPI instance handy — the wizard only reads that column, it doesn't require a live connection to render), walk through **New Broadcast**: confirm the step indicator shows 3 steps (Message → Audience → Send), the compose step accepts text + optionally one image/video/document attachment, "Next" is disabled until text is entered, and the Send step's summary shows a truncated text preview instead of a template name.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/use-broadcast-sending.ts src/components/broadcasts/step4-schedule-send.tsx src/components/broadcasts/step1-compose-message.tsx src/app/\(dashboard\)/broadcasts/new/page.tsx messages/en.json
git commit -m "feat: add free-text broadcast composer for UAZAPI accounts"
```

---

### Task 8: Docs — public API + changelog

**Files:**
- Modify: `docs/public-api.md`
- Modify: `CHANGELOG.md`

**Context:** `docs/public-api.md`'s `POST /api/v1/broadcasts` section only documents the template shape today. Separately, none of the UAZAPI provider work (Phase 1 refactor, Phase 2a connect+send, Phase 2b inbound webhook) has a `CHANGELOG.md` entry yet — it shipped straight to `main` without one. This task adds both.

- [ ] **Step 1: Document the free-text broadcast body in `docs/public-api.md`**

In `docs/public-api.md`, immediately after the existing code block under `### POST /api/v1/broadcasts` (right after the ` ```json { "data": { ... } } ``` ` response block, before `### GET /api/v1/broadcasts/{id}`), add:

```markdown
For accounts connected via **UAZAPI** instead of the Meta Cloud API,
there is no template/24h-window concept — send free text and an
optional single media attachment instead of `template_name`:

```bash
curl -X POST https://your-crm.example.com/api/v1/broadcasts \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "July promo",
        "message_text": "Confira nossa promoção de julho!",
        "media": { "kind": "image", "url": "https://example.com/promo.jpg" },
        "recipients": [
          { "to": "+14155550123" },
          { "to": "+14155550124" }
        ]
      }'
```

`media` is optional; when set, `kind` is one of `image` / `video` /
`document` / `audio`, and `url` must be a publicly fetchable link. The
same text and attachment go to every recipient — there is no
per-recipient `params` substitution in this mode (that's a
template-only feature). Which shape to send is determined by the
account's connected provider, not by the request — a template-shaped
body against a UAZAPI account (or vice versa) is rejected with `400`.
```

- [ ] **Step 2: Add the CHANGELOG entry**

At the top of `CHANGELOG.md`, immediately after the `Versions follow [Keep a Changelog]...` paragraph and before `## [0.8.0] — 2026-07-08`, add:

```markdown
## [0.9.0] — 2026-07-17

Adds **UAZAPI** as a second WhatsApp connection option alongside the
Meta Cloud API — QR-code connect, no approved-template requirement,
and now full Broadcast support.

> **Migration required:** apply, in order: `supabase/migrations/036_uazapi_provider.sql`
> (adds `whatsapp_config.provider` + UAZAPI credential columns) and
> `supabase/migrations/037_broadcast_free_text.sql` (relaxes
> `broadcasts.template_name` to nullable, adds `message_text`/`media_*`
> columns).

### Added

- **UAZAPI as a connection option.** Under **Settings → WhatsApp**,
  choose "UAZAPI" instead of the Meta Cloud API: paste your instance's
  server URL + token, scan the QR code, done — no Meta Business
  Manager, no app review, no approved templates. Sending (text, media,
  reactions) and receiving (messages, reactions, delivery/read status)
  both work exactly as they do for Meta accounts, backed by a shared
  `WhatsAppProvider` abstraction (`getWhatsAppProvider`) so the rest of
  the CRM — Inbox, Flows, Automations — doesn't know which provider is
  behind a given account.
- **Free-text Broadcasts for UAZAPI accounts.** Since UAZAPI has no
  template/24h-window concept, the Broadcast wizard shows a text +
  optional single media attachment composer instead of the template
  gallery for these accounts, and skips the personalization step (no
  per-recipient variables in this version). Meta accounts keep the
  existing approved-template flow unchanged.

### Changed

- `POST /api/v1/broadcasts` accepts a `message_text`/`media` body
  shape for UAZAPI accounts as an alternative to `template_name` — see
  `docs/public-api.md`.
```

- [ ] **Step 3: Commit**

```bash
git add docs/public-api.md CHANGELOG.md
git commit -m "docs: document UAZAPI free-text broadcasts and add the 0.9.0 changelog entry"
```

---

### Task 9: Final verification pass

**Files:** none (verification only).

- [ ] **Step 1: Full typecheck + lint + test**

Run:
```bash
npm run typecheck
npm run lint
npm test
```
Expected: all three pass with zero errors and no new warnings (same 5 pre-existing `date-utils.test.ts`/`currency.test.ts` failures as every prior UAZAPI plan — confirm the count hasn't grown).

- [ ] **Step 2: Confirm no leftover references to the removed flat `BroadcastPlan` fields**

Run: `grep -rn "plan\.templateName\|plan\.phoneNumberId\|plan\.accessToken\|plan\.templateRow" src/`
Expected: no output — confirms every caller reads through `plan.sendContext` now, not the old flat fields.

- [ ] **Step 3: End-to-end regression check on the Meta path**

Repeat Task 7 Step 4's Meta-account walkthrough once more now that Task 8 has also landed, to catch any accidental cross-contamination between the two wizard flows sharing `Step4ScheduleSend`.

- [ ] **Step 4: End-to-end check on the UAZAPI path (if a live instance is available)**

If you have a connected UAZAPI test instance, send a real free-text broadcast (with and without a media attachment) to a small test audience and confirm: the messages arrive on the recipient's phone, `broadcast_recipients.status` progresses `sent` → `delivered` → `read` as the inbound webhook (Phase 2b) reports status updates, and the Broadcast detail page's stats match.

---

## Self-Review Notes

- **Spec coverage:** Closes the exact gap both the Phase 1 and Phase 2a plans called out and deferred — `broadcast-core.ts`'s "nothing to migrate until Phase 2" (Phase 1) and "adapting broadcasts to a template-free flow is deferred to a follow-up plan" (Phase 2a) — by implementing the design doc's scope decision #1 verbatim: "Broadcasts passam a enviar texto/mídia livre em vez de templates aprovados" for UAZAPI accounts, with Meta accounts fully unaffected.
- **Duplication eliminated, not just relocated:** Both Meta-only send paths (`broadcast-core.ts`'s `deliverBroadcast`, and the dashboard's `/api/whatsapp/broadcast` route) previously hand-rolled the identical phone-variant-retry-around-`sendTemplateMessage` loop. `sendBroadcastRecipient()` is now the single place that loop exists, used by both — a UAZAPI branch was added to one function instead of two.
- **Type consistency:** `BroadcastSendContext` (Task 2) is the single shared contract consumed unchanged by `deliverBroadcast` (Task 2) and the dashboard route (Task 3); `BroadcastPayload`'s `mode` discriminant (Task 4) and `Step4ScheduleSend`'s `summaryLabel`/`summarySublabel` (Task 5) are threaded through consistently by `new/page.tsx` (Task 7) — verified by the Step 2/3 typecheck gates in Tasks 4, 5, and 7.
- **Zero-behavior-change discipline on the Meta path:** `sendBroadcastRecipient`'s `'template'` branch is a verbatim move of the existing retry loop (same `isRecipientNotAllowedError` condition, same fields passed to `sendTemplateMessage`) — locked in by Task 2's Meta regression test and Task 3's Meta regression tests.
- **Scope discipline:** No per-recipient personalization and no audio attachments for UAZAPI broadcasts in this plan — both explicitly confirmed decisions, not silent omissions. A resumable-draft round-trip for free-text broadcasts has the same "future polish" gap the existing template flow already has (noted in `handleSaveDraft`'s comment) — not a regression introduced here.
