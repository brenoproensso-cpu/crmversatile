# UAZAPI Provider — Phase 2b (Inbound Webhook) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let inbound WhatsApp messages, reactions, and status updates from a connected UAZAPI instance flow into the CRM — contacts, conversations, Flows, Automations, AI auto-reply, and outbound webhooks all fire exactly as they already do for Meta. This closes the loop opened by Phase 2a (connect + send only).

**Architecture:** The business logic currently trapped inside the Meta-only `webhook/route.ts` (`processMessage()`, `handleStatusUpdate()`, and their helpers) is extracted into a provider-agnostic core, `ingestInboundMessage()` / `ingestStatusUpdate()` in `src/lib/whatsapp/inbound.ts`, operating on a normalized `NormalizedInboundEvent` / `NormalizedStatusUpdate` shape instead of Meta's raw webhook payload. The existing Meta route becomes a thin adapter that parses its own payload into that normalized shape and calls the shared core — a zero-behavior-change refactor, verified the same way Phase 1 verified `WhatsAppProvider`. A new route, `src/app/api/whatsapp/webhook/uazapi/route.ts`, does the UAZAPI-side parsing (`src/lib/whatsapp/uazapi-inbound-parser.ts`) and calls the same shared core.

**Tech Stack:** TypeScript, Next.js 16 (App Router), Vitest 4, Supabase JS client.

## Global Constraints

- Zero behavior change to the Meta inbound path — `ingestInboundMessage()`/`ingestStatusUpdate()` must reproduce `processMessage()`/`handleStatusUpdate()`'s exact existing logic, just parameterized. No new fields, no changed dispatch order, no changed status-ladder rules.
- UAZAPI messages from groups (`isGroup: true`) or echoed self-sends (`fromMe: true`) are dropped at the parser — the design doc's v1 scope is 1:1 messaging only, and `excludeMessages: ["wasSentByApi"]` (registered in Phase 2a) already filters most self-echoes server-side, but `fromMe` is a second, cheap belt-and-braces check.
- Interactive replies (buttons/lists) are explicitly out of scope for UAZAPI per the design doc — `interactiveReplyId` is always `null` for UAZAPI-sourced events.
- The exact Baileys-style `messageType` string vocabulary UAZAPI emits (e.g. `conversation`, `imageMessage`) is inferred, not confirmed against a real payload — Task 2 says so explicitly, and Task 4 is a mandatory live-payload check before this plan is considered done.
- Run `npm run typecheck` and `npm test` after every task; both must pass before moving on.

---

## File Structure

- **Create** `src/lib/whatsapp/inbound.ts` — `NormalizedInboundEvent`, `NormalizedStatusUpdate` types; `ingestInboundMessage()`, `ingestStatusUpdate()`; moved helpers (`findOrCreateContact`, `findOrCreateConversation`, `flagBroadcastReplyIfAny`, `lookupInternalIdByProviderId`, `handleReaction`, the status ladder).
- **Create** `src/lib/whatsapp/inbound.test.ts` — unit tests for the above, with synthetic normalized payloads (mirrors the design doc's testing section).
- **Modify** `src/app/api/whatsapp/webhook/route.ts` — `processMessage()` and `handleStatusUpdate()` shrink to thin Meta-payload-to-normalized-shape adapters; the moved helpers/ladder are deleted from this file.
- **Create** `src/lib/whatsapp/uazapi-inbound-parser.ts` — `parseUazapiMessageEvent()`, `parseUazapiStatusEvent()`.
- **Create** `src/lib/whatsapp/uazapi-inbound-parser.test.ts` — unit tests.
- **Create** `src/app/api/whatsapp/webhook/uazapi/route.ts` — auth via `?key=`, routes `messages`/`messages_update` events to the parser + shared core.
- **Create** `src/app/api/whatsapp/webhook/uazapi/route.test.ts` — unit tests (401 on bad key, 200 + correct account resolution on a valid one).

---

### Task 1: Extract the shared inbound core (zero behavior change)

**Files:**
- Create: `src/lib/whatsapp/inbound.ts`
- Test: `src/lib/whatsapp/inbound.test.ts`
- Modify: `src/app/api/whatsapp/webhook/route.ts`

**Interfaces:**
- Consumes: `findExistingContact`, `isUniqueViolation` from `@/lib/contacts/dedupe`; `dispatchWebhookEvent` from `@/lib/webhooks/deliver`; `runAutomationsForTrigger` from `@/lib/automations/engine`; `dispatchInboundToFlows` from `@/lib/flows/engine`; `dispatchInboundToAiReply` from `@/lib/ai/auto-reply` (all already imported by `webhook/route.ts` today — they move to `inbound.ts`).
- Produces (used by Task 3's UAZAPI route, and by the Meta route's new thin adapters):
  ```ts
  export type NormalizedMessageContentType =
    | 'text' | 'image' | 'document' | 'audio' | 'video' | 'location' | 'interactive'

  interface BaseInboundEvent {
    accountId: string
    configOwnerUserId: string
    senderPhone: string
    senderName: string
    providerMessageId: string
    timestamp: Date
  }

  export type NormalizedInboundEvent =
    | (BaseInboundEvent & {
        kind: 'message'
        contentType: NormalizedMessageContentType
        contentText: string | null
        mediaUrl: string | null
        interactiveReplyId: string | null
        replyToProviderId: string | null
      })
    | (BaseInboundEvent & {
        kind: 'reaction'
        targetProviderMessageId: string
        emoji: string | null
      })

  export interface NormalizedStatusUpdate {
    providerMessageId: string
    status: 'sent' | 'delivered' | 'read' | 'failed'
    timestamp: Date
  }

  export async function ingestInboundMessage(event: NormalizedInboundEvent): Promise<void>
  export async function ingestStatusUpdate(update: NormalizedStatusUpdate): Promise<void>
  ```

**Context:** `webhook/route.ts` today has `processMessage()` (lines 560-827) doing: find-or-create contact/conversation, short-circuit for reactions (`handleReaction`, lines 509-558), insert the message row, update the conversation, flag a replied broadcast (`flagBroadcastReplyIfAny`, lines 448-477), dispatch to Flows/Automations/AI, and fire the `message.received` webhook. Separately, `handleStatusUpdate()` (lines 352-438) plus `RECIPIENT_STATUS_LADDER`/`ladderLevel`/`isValidStatusTransition` (lines 319-350) update `messages.status`, mirror onto `broadcast_recipients`, and fire `message.status_updated`. None of this logic reads anything Meta-specific *after* the initial parse — it's already expressed in terms of phone numbers, ids, and content, not Meta wire format. This task moves it verbatim (function bodies unchanged) into `inbound.ts`, and replaces the two Meta entry points with thin adapters that build the normalized shape and delegate.

Confirmed against `messages.status` and `broadcast_recipients.status` CHECK constraints (`supabase/migrations/001_initial_schema.sql:173,325`): `'sent' | 'delivered' | 'read' | 'failed'` are exactly the four values a webhook status update ever needs to write (`'pending'`/`'sending'` are insert-time-only local states, `'replied'` is set by `flagBroadcastReplyIfAny`, not by a provider status event) — matching `NormalizedStatusUpdate.status` above.

- [ ] **Step 1: Write the failing test**

Create `src/lib/whatsapp/inbound.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = {
  contacts: new Map<string, { id: string; account_id: string; phone: string; name: string }>(),
  conversations: new Map<string, { id: string; account_id: string; contact_id: string; unread_count: number }>(),
  messages: [] as Array<Record<string, unknown>>,
  reactions: [] as Array<Record<string, unknown>>,
  broadcastRecipients: [] as Array<Record<string, unknown>>,
}

function resetState() {
  state.contacts.clear()
  state.conversations.clear()
  state.messages.length = 0
  state.reactions.length = 0
  state.broadcastRecipients.length = 0
}

vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(async (_db: unknown, accountId: string, phone: string) => {
    for (const c of state.contacts.values()) {
      if (c.account_id === accountId && c.phone === phone) return c
    }
    return null
  }),
  isUniqueViolation: vi.fn(() => false),
}))
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn(async () => {}) }))
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: vi.fn(async () => ({})) }))
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: vi.fn(async () => ({ consumed: false })),
}))
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: vi.fn(async () => {}) }))

// Minimal chainable Supabase mock covering exactly the query shapes
// ingestInboundMessage/ingestStatusUpdate issue.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      const chain = {
        _table: table,
        _filters: {} as Record<string, unknown>,
        select() {
          return chain
        },
        eq(col: string, val: unknown) {
          chain._filters[col] = val
          return chain
        },
        insert(row: Record<string, unknown>) {
          if (table === 'contacts') {
            const id = `contact-${state.contacts.size + 1}`
            const row2 = { id, account_id: row.account_id, phone: row.phone, name: row.name as string }
            state.contacts.set(id, row2)
            return { select: () => ({ single: async () => ({ data: row2, error: null }) }) }
          }
          if (table === 'conversations') {
            const id = `conv-${state.conversations.size + 1}`
            const row2 = { id, account_id: row.account_id as string, contact_id: row.contact_id as string, unread_count: 0 }
            state.conversations.set(id, row2)
            return { select: () => ({ single: async () => ({ data: row2, error: null }) }) }
          }
          if (table === 'messages') {
            state.messages.push(row)
            return Promise.resolve({ error: null })
          }
          return Promise.resolve({ error: null })
        },
        update(patch: Record<string, unknown>) {
          if (table === 'conversations') {
            const conv = [...state.conversations.values()].find((c) => c.id === chain._filters.id)
            if (conv) Object.assign(conv, patch)
          }
          if (table === 'messages') {
            const msg = state.messages.find((m) => m.message_id === chain._filters.message_id)
            if (msg) Object.assign(msg, patch)
          }
          return chain
        },
        delete() {
          return chain
        },
        upsert(row: Record<string, unknown>) {
          state.reactions.push(row)
          return Promise.resolve({ error: null })
        },
        maybeSingle: async () => {
          if (table === 'conversations') {
            const conv = [...state.conversations.values()].find(
              (c) => c.account_id === chain._filters.account_id && c.contact_id === chain._filters.contact_id,
            )
            return { data: conv ?? null, error: null }
          }
          if (table === 'messages') {
            const msg = state.messages.find(
              (m) =>
                m.message_id === chain._filters.message_id &&
                (!chain._filters.conversation_id || m.conversation_id === chain._filters.conversation_id),
            )
            return { data: msg ? { id: 'internal-1' } : null, error: null }
          }
          if (table === 'broadcast_recipients') return { data: null, error: null }
          return { data: null, error: null }
        },
        single: async () => ({ data: null, error: { code: 'PGRST116' } }),
        limit() {
          return chain
        },
      }
      return chain
    },
  }),
}))

import { ingestInboundMessage, ingestStatusUpdate } from './inbound'

beforeEach(() => {
  resetState()
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-key')
})

describe('ingestInboundMessage — message', () => {
  it('creates a contact + conversation and inserts the message', async () => {
    await ingestInboundMessage({
      kind: 'message',
      accountId: 'acct-1',
      configOwnerUserId: 'user-1',
      senderPhone: '5511999999999',
      senderName: 'Alice',
      providerMessageId: 'wamid.1',
      timestamp: new Date('2026-07-11T00:00:00Z'),
      contentType: 'text',
      contentText: 'oi',
      mediaUrl: null,
      interactiveReplyId: null,
      replyToProviderId: null,
    })

    expect(state.contacts.size).toBe(1)
    expect(state.conversations.size).toBe(1)
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]).toMatchObject({
      content_type: 'text',
      content_text: 'oi',
      message_id: 'wamid.1',
      sender_type: 'customer',
    })
  })

  it('reuses an existing contact/conversation on a second message', async () => {
    const base = {
      kind: 'message' as const,
      accountId: 'acct-1',
      configOwnerUserId: 'user-1',
      senderPhone: '5511999999999',
      senderName: 'Alice',
      timestamp: new Date('2026-07-11T00:00:00Z'),
      contentType: 'text' as const,
      mediaUrl: null,
      interactiveReplyId: null,
      replyToProviderId: null,
    }
    await ingestInboundMessage({ ...base, providerMessageId: 'wamid.1', contentText: 'oi' })
    await ingestInboundMessage({ ...base, providerMessageId: 'wamid.2', contentText: 'de novo' })

    expect(state.contacts.size).toBe(1)
    expect(state.conversations.size).toBe(1)
    expect(state.messages).toHaveLength(2)
  })
})

describe('ingestInboundMessage — reaction', () => {
  it('upserts a reaction row instead of inserting a message', async () => {
    await ingestInboundMessage({
      kind: 'message',
      accountId: 'acct-1',
      configOwnerUserId: 'user-1',
      senderPhone: '5511999999999',
      senderName: 'Alice',
      providerMessageId: 'wamid.1',
      timestamp: new Date('2026-07-11T00:00:00Z'),
      contentType: 'text',
      contentText: 'oi',
      mediaUrl: null,
      interactiveReplyId: null,
      replyToProviderId: null,
    })

    await ingestInboundMessage({
      kind: 'reaction',
      accountId: 'acct-1',
      configOwnerUserId: 'user-1',
      senderPhone: '5511999999999',
      senderName: 'Alice',
      providerMessageId: 'wamid.2',
      timestamp: new Date('2026-07-11T00:01:00Z'),
      targetProviderMessageId: 'wamid.1',
      emoji: '👍',
    })

    expect(state.messages).toHaveLength(1) // no second message row for the reaction
    expect(state.reactions).toHaveLength(1)
    expect(state.reactions[0]).toMatchObject({ emoji: '👍', actor_type: 'customer' })
  })
})

describe('ingestStatusUpdate', () => {
  it('updates the message status', async () => {
    await ingestInboundMessage({
      kind: 'message',
      accountId: 'acct-1',
      configOwnerUserId: 'user-1',
      senderPhone: '5511999999999',
      senderName: 'Alice',
      providerMessageId: 'wamid.1',
      timestamp: new Date('2026-07-11T00:00:00Z'),
      contentType: 'text',
      contentText: 'oi',
      mediaUrl: null,
      interactiveReplyId: null,
      replyToProviderId: null,
    })

    await ingestStatusUpdate({
      providerMessageId: 'wamid.1',
      status: 'delivered',
      timestamp: new Date('2026-07-11T00:00:05Z'),
    })

    expect(state.messages[0].status).toBe('delivered')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/whatsapp/inbound.test.ts`
Expected: FAIL — `Cannot find module './inbound'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/whatsapp/inbound.ts`:

```ts
import { createClient } from '@supabase/supabase-js'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'

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

export type NormalizedMessageContentType =
  | 'text' | 'image' | 'document' | 'audio' | 'video' | 'location' | 'interactive'

interface BaseInboundEvent {
  accountId: string
  configOwnerUserId: string
  senderPhone: string
  senderName: string
  providerMessageId: string
  timestamp: Date
}

export type NormalizedInboundEvent =
  | (BaseInboundEvent & {
      kind: 'message'
      contentType: NormalizedMessageContentType
      contentText: string | null
      mediaUrl: string | null
      interactiveReplyId: string | null
      replyToProviderId: string | null
    })
  | (BaseInboundEvent & {
      kind: 'reaction'
      targetProviderMessageId: string
      emoji: string | null
    })

export interface NormalizedStatusUpdate {
  providerMessageId: string
  status: 'sent' | 'delivered' | 'read' | 'failed'
  timestamp: Date
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  wasCreated: boolean
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string,
): Promise<ContactOutcome | null> {
  const existingContact = await findExistingContact(supabaseAdmin(), accountId, phone)

  if (existingContact) {
    if (name && name !== existingContact.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  const { data: existing, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .single()

  if (!findError && existing) {
    return { conversation: existing, created: false }
  }

  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    console.error('Error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}

async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]
    const { error: updErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) {
      console.error('Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err)
  }
}

async function lookupInternalIdByProviderId(
  providerMessageId: string,
  conversationId: string,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', providerMessageId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[inbound] lookupInternalIdByProviderId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

async function handleReaction(
  event: Extract<NormalizedInboundEvent, { kind: 'reaction' }>,
  conversationId: string,
  contactId: string,
): Promise<void> {
  const targetInternalId = await lookupInternalIdByProviderId(event.targetProviderMessageId, conversationId)
  if (!targetInternalId) {
    console.warn('[inbound] reaction target message not found; skipping', event.targetProviderMessageId)
    return
  }

  if (!event.emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    if (delError) {
      console.error('[inbound] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: event.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' },
    )
  if (upsertError) {
    console.error('[inbound] reaction upsert failed:', upsertError.message)
  }
}

export async function ingestInboundMessage(event: NormalizedInboundEvent): Promise<void> {
  const { accountId, configOwnerUserId, senderPhone, senderName } = event

  const contactOutcome = await findOrCreateContact(accountId, configOwnerUserId, senderPhone, senderName)
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  const convResult = await findOrCreateConversation(accountId, configOwnerUserId, contactRecord.id)
  if (!convResult) return
  const conversation = convResult.conversation

  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    })
  }

  if (event.kind === 'reaction') {
    await handleReaction(event, conversation.id, contactRecord.id)
    return
  }

  let replyToInternalId: string | null = null
  if (event.replyToProviderId) {
    replyToInternalId = await lookupInternalIdByProviderId(event.replyToProviderId, conversation.id)
    if (!replyToInternalId) {
      console.warn('[inbound] reply context parent not found:', event.replyToProviderId)
    }
  }

  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: event.contentType,
    content_text: event.contentText,
    media_url: event.mediaUrl,
    message_id: event.providerMessageId,
    status: 'delivered',
    created_at: event.timestamp.toISOString(),
    reply_to_message_id: replyToInternalId,
    interactive_reply_id: event.interactiveReplyId,
  })

  if (msgError) {
    console.error('Error inserting message:', msgError)
    return
  }

  const { error: convError } = await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: event.contentText || `[${event.contentType}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  if (convError) {
    console.error('Error updating conversation:', convError)
  }

  await flagBroadcastReplyIfAny(accountId, contactRecord.id)

  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message:
      event.interactiveReplyId
        ? {
            kind: 'interactive_reply',
            reply_id: event.interactiveReplyId,
            reply_title: event.contentText ?? '',
            meta_message_id: event.providerMessageId,
          }
        : {
            kind: 'text',
            text: event.contentText ?? '',
            meta_message_id: event.providerMessageId,
          },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  const inboundText = event.contentText ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
    if (event.interactiveReplyId) {
      automationTriggers.push('interactive_reply')
    }
  }
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        interactive_reply_id: event.interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  if (!flowConsumed && !event.interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId,
    })
  }

  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: event.providerMessageId,
    content_type: event.contentType,
    text: event.contentText,
  })
}

const RECIPIENT_STATUS_LADDER = ['pending', 'sent', 'delivered', 'read', 'replied'] as const

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s)
  return idx < 0 ? -1 : idx
}

function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent'
  }
  if (current === 'failed') {
    return false
  }
  const ci = ladderLevel(current)
  const ii = ladderLevel(incoming)
  if (ii < 0) return false
  if (ci < 0) return true
  return ii > ci
}

export async function ingestStatusUpdate(update: NormalizedStatusUpdate): Promise<void> {
  const { providerMessageId, status, timestamp } = update

  const { error: msgErr } = await supabaseAdmin()
    .from('messages')
    .update({ status })
    .eq('message_id', providerMessageId)
  if (msgErr) {
    console.error('Error updating message status:', msgErr)
  }

  const tsIso = timestamp.toISOString()

  const { data: recipient, error: recFetchErr } = await supabaseAdmin()
    .from('broadcast_recipients')
    .select('id, status')
    .eq('whatsapp_message_id', providerMessageId)
    .maybeSingle()

  if (recFetchErr) {
    console.error('Error fetching broadcast recipient:', recFetchErr)
  } else if (recipient && isValidStatusTransition(recipient.status, status)) {
    const patch: Record<string, unknown> = { status }
    if (status === 'sent') patch.sent_at = tsIso
    if (status === 'delivered') patch.delivered_at = tsIso
    if (status === 'read') patch.read_at = tsIso

    const { error: recUpdateErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update(patch)
      .eq('id', recipient.id)
    if (recUpdateErr) {
      console.error('Error updating broadcast recipient status:', recUpdateErr)
    }
  }

  const { data: msgRow } = await supabaseAdmin()
    .from('messages')
    .select('conversation_id, conversations(account_id)')
    .eq('message_id', providerMessageId)
    .limit(1)
    .maybeSingle()

  if (msgRow) {
    const conv = msgRow.conversations as { account_id: string } | null
    const accountId = conv?.account_id
    if (accountId) {
      await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.status_updated', {
        whatsapp_message_id: providerMessageId,
        conversation_id: msgRow.conversation_id,
        status,
      })
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/whatsapp/inbound.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Update `webhook/route.ts` — remove the moved code, add thin adapters**

Delete from `src/app/api/whatsapp/webhook/route.ts` (these move to `inbound.ts` verbatim, already covered by Step 3 above): the `RECIPIENT_STATUS_LADDER`/`ladderLevel`/`isValidStatusTransition` block, `flagBroadcastReplyIfAny`, `lookupInternalIdByMetaId`, `handleReaction`, `ContactRow`/`ContactOutcome`/`findOrCreateContact`/`findOrCreateConversation`, and the full body of `handleStatusUpdate` and `processMessage`.

Update the import block — replace:
```ts
import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook'
```
with:
```ts
import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { ingestInboundMessage, ingestStatusUpdate } from '@/lib/whatsapp/inbound'
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook'
```
(`downloadMedia` stays imported but unused — that's a pre-existing lint warning from before this refactor, not introduced by it; do not touch it.)

Replace the entire `handleStatusUpdate` function with:
```ts
async function handleStatusUpdate(status: {
  id: string
  status: string
  timestamp: string
  recipient_id: string
}) {
  await ingestStatusUpdate({
    providerMessageId: status.id,
    status: status.status as 'sent' | 'delivered' | 'read' | 'failed',
    timestamp: new Date(parseInt(status.timestamp) * 1000),
  })
}
```

Replace the entire `processMessage` function with:
```ts
async function processMessage(
  message: WhatsAppMessage,
  contact: { profile: { name: string }; wa_id: string },
  accountId: string,
  configOwnerUserId: string,
  accessToken: string
) {
  const senderPhone = normalizePhone(message.from)
  const contactName = contact.profile.name
  const timestamp = new Date(parseInt(message.timestamp) * 1000)

  if (message.type === 'reaction') {
    if (!message.reaction?.message_id) return
    await ingestInboundMessage({
      kind: 'reaction',
      accountId,
      configOwnerUserId,
      senderPhone,
      senderName: contactName,
      providerMessageId: message.id,
      timestamp,
      targetProviderMessageId: message.reaction.message_id,
      emoji: message.reaction.emoji || null,
    })
    return
  }

  const { contentText, mediaUrl, interactiveReplyId } = await parseMessageContent(message, accessToken)

  const ALLOWED_CONTENT_TYPES = new Set([
    'text', 'image', 'document', 'audio', 'video', 'location', 'interactive',
  ])
  const contentType = (
    ALLOWED_CONTENT_TYPES.has(message.type)
      ? message.type
      : message.type === 'sticker'
        ? 'image'
        : 'text'
  ) as 'text' | 'image' | 'document' | 'audio' | 'video' | 'location' | 'interactive'

  await ingestInboundMessage({
    kind: 'message',
    accountId,
    configOwnerUserId,
    senderPhone,
    senderName: contactName,
    providerMessageId: message.id,
    timestamp,
    contentType,
    contentText,
    mediaUrl,
    interactiveReplyId,
    replyToProviderId: message.context?.id ?? null,
  })
}
```

`parseMessageContent` (Meta-specific media verification via `getMediaUrl`) is untouched — it stays exactly as-is and is still called from the new `processMessage` above.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (If `WhatsAppMessage`'s `reaction`/`context` fields are typed correctly, this should be immediate. If not, re-check the interface at the top of `webhook/route.ts` — it's unchanged by this task.)

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS, no new failures.

- [ ] **Step 8: Manual smoke check against the Meta path**

Run: `npm run dev`, and if you have a connected Meta sandbox number, send it a real text message and a real reaction from your phone; confirm both still land in the Inbox exactly as before (new conversation/contact if it's the first message, unread count increments, reaction renders under the bubble). This is the one path nothing in this task's unit tests exercises end-to-end.

- [ ] **Step 9: Commit**

```bash
git add src/lib/whatsapp/inbound.ts src/lib/whatsapp/inbound.test.ts src/app/api/whatsapp/webhook/route.ts
git commit -m "refactor: extract ingestInboundMessage/ingestStatusUpdate from the Meta webhook route"
```

---

### Task 2: UAZAPI inbound event parser

**Files:**
- Create: `src/lib/whatsapp/uazapi-inbound-parser.ts`
- Test: `src/lib/whatsapp/uazapi-inbound-parser.test.ts`

**Interfaces:**
- Consumes: `NormalizedInboundEvent`, `NormalizedStatusUpdate` types from `src/lib/whatsapp/inbound.ts` (Task 1); `normalizePhone` from `src/lib/whatsapp/phone-utils.ts`.
- Produces (used by Task 3):
  ```ts
  export interface UazapiMessagePayload {
    messageid?: string
    chatid?: string
    senderName?: string
    isGroup?: boolean
    fromMe?: boolean
    messageType?: string
    messageTimestamp?: number
    status?: string
    text?: string
    quoted?: string
    reaction?: string
    fileURL?: string
  }

  export function parseUazapiMessageEvent(
    data: UazapiMessagePayload,
    accountId: string,
    configOwnerUserId: string,
  ): NormalizedInboundEvent | null

  export function parseUazapiStatusEvent(data: UazapiMessagePayload): NormalizedStatusUpdate | null
  ```

**Context:** Per the design doc (`docs/superpowers/specs/2026-07-09-uazapi-whatsapp-provider-design.md`, confirmed against the official OpenAPI spec), the `messages`/`messages_update` webhook events deliver a `Message` object as `data`, with `chatid` as the sender's JID (e.g. `5511999999999@s.whatsapp.net`), `reaction` holding the *target* message's id (not the emoji — the emoji is in `text`), `fileURL` a directly-fetchable media URL (no download/proxy step needed, unlike Meta), and `status` one of `Queued|Sent|Delivered|Read|Canceled|Failed`.

**The exact `messageType` string vocabulary is inferred, not confirmed** — UAZAPI wraps a Baileys-based WhatsApp Web client, so the `CONTENT_TYPE_MAP` below uses Baileys' well-known message-type key names (`conversation`, `imageMessage`, etc.) as the best available guess. **Task 4 captures a real payload and is the point where this map gets corrected if wrong** — don't treat this task's mapping as final until then.

- [ ] **Step 1: Write the failing test**

Create `src/lib/whatsapp/uazapi-inbound-parser.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseUazapiMessageEvent, parseUazapiStatusEvent } from './uazapi-inbound-parser'

const BASE = { accountId: 'acct-1', configOwnerUserId: 'user-1' }

describe('parseUazapiMessageEvent', () => {
  it('parses a plain text message', () => {
    const result = parseUazapiMessageEvent(
      {
        messageid: 'wamid.1',
        chatid: '5511999999999@s.whatsapp.net',
        senderName: 'Alice',
        isGroup: false,
        fromMe: false,
        messageType: 'conversation',
        messageTimestamp: 1752191999000,
        text: 'oi',
      },
      BASE.accountId,
      BASE.configOwnerUserId,
    )

    expect(result).toEqual({
      kind: 'message',
      accountId: 'acct-1',
      configOwnerUserId: 'user-1',
      senderPhone: '5511999999999',
      senderName: 'Alice',
      providerMessageId: 'wamid.1',
      timestamp: new Date(1752191999000),
      contentType: 'text',
      contentText: 'oi',
      mediaUrl: null,
      interactiveReplyId: null,
      replyToProviderId: null,
    })
  })

  it('parses an image message with a caption and fileURL, no download needed', () => {
    const result = parseUazapiMessageEvent(
      {
        messageid: 'wamid.2',
        chatid: '5511999999999@s.whatsapp.net',
        senderName: 'Alice',
        messageType: 'imageMessage',
        messageTimestamp: 1752191999000,
        text: 'legenda',
        fileURL: 'https://crmversatile.uazapi.com/files/abc.jpg',
      },
      BASE.accountId,
      BASE.configOwnerUserId,
    )

    expect(result).toMatchObject({
      kind: 'message',
      contentType: 'image',
      contentText: 'legenda',
      mediaUrl: 'https://crmversatile.uazapi.com/files/abc.jpg',
    })
  })

  it('parses a reaction — emoji in `text`, target id in `reaction`', () => {
    const result = parseUazapiMessageEvent(
      {
        messageid: 'wamid.3',
        chatid: '5511999999999@s.whatsapp.net',
        senderName: 'Alice',
        messageType: 'reactionMessage',
        text: '👍',
        reaction: 'wamid.1',
      },
      BASE.accountId,
      BASE.configOwnerUserId,
    )

    expect(result).toMatchObject({
      kind: 'reaction',
      targetProviderMessageId: 'wamid.1',
      emoji: '👍',
    })
  })

  it('carries the quoted id as replyToProviderId', () => {
    const result = parseUazapiMessageEvent(
      {
        messageid: 'wamid.4',
        chatid: '5511999999999@s.whatsapp.net',
        messageType: 'conversation',
        text: 'respondendo',
        quoted: 'wamid.1',
      },
      BASE.accountId,
      BASE.configOwnerUserId,
    )

    expect(result).toMatchObject({ replyToProviderId: 'wamid.1' })
  })

  it('drops group messages', () => {
    const result = parseUazapiMessageEvent(
      { messageid: 'wamid.5', chatid: '123-456@g.us', isGroup: true, text: 'oi grupo' },
      BASE.accountId,
      BASE.configOwnerUserId,
    )
    expect(result).toBeNull()
  })

  it('drops self-sent echoes', () => {
    const result = parseUazapiMessageEvent(
      { messageid: 'wamid.6', chatid: '5511999999999@s.whatsapp.net', fromMe: true, text: 'oi' },
      BASE.accountId,
      BASE.configOwnerUserId,
    )
    expect(result).toBeNull()
  })

  it('drops a payload with no chatid or messageid', () => {
    expect(parseUazapiMessageEvent({ text: 'oi' }, BASE.accountId, BASE.configOwnerUserId)).toBeNull()
  })
})

describe('parseUazapiStatusEvent', () => {
  it('maps Sent/Delivered/Read to the internal ladder', () => {
    expect(
      parseUazapiStatusEvent({ messageid: 'wamid.1', status: 'Sent', messageTimestamp: 1752191999000 }),
    ).toEqual({ providerMessageId: 'wamid.1', status: 'sent', timestamp: new Date(1752191999000) })

    expect(parseUazapiStatusEvent({ messageid: 'wamid.1', status: 'Delivered' })?.status).toBe('delivered')
    expect(parseUazapiStatusEvent({ messageid: 'wamid.1', status: 'Read' })?.status).toBe('read')
  })

  it('maps Canceled and Failed to failed', () => {
    expect(parseUazapiStatusEvent({ messageid: 'wamid.1', status: 'Canceled' })?.status).toBe('failed')
    expect(parseUazapiStatusEvent({ messageid: 'wamid.1', status: 'Failed' })?.status).toBe('failed')
  })

  it('ignores Queued (no forward-ladder meaning)', () => {
    expect(parseUazapiStatusEvent({ messageid: 'wamid.1', status: 'Queued' })).toBeNull()
  })

  it('ignores a payload with no messageid', () => {
    expect(parseUazapiStatusEvent({ status: 'Sent' })).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/whatsapp/uazapi-inbound-parser.test.ts`
Expected: FAIL — `Cannot find module './uazapi-inbound-parser'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/whatsapp/uazapi-inbound-parser.ts`:

```ts
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import type { NormalizedInboundEvent, NormalizedMessageContentType, NormalizedStatusUpdate } from '@/lib/whatsapp/inbound'

export interface UazapiMessagePayload {
  messageid?: string
  chatid?: string
  senderName?: string
  isGroup?: boolean
  fromMe?: boolean
  messageType?: string
  messageTimestamp?: number
  status?: string
  text?: string
  quoted?: string
  reaction?: string
  fileURL?: string
}

// Baileys-style message-type keys — UAZAPI wraps a Baileys-based WhatsApp
// Web client. INFERRED, not confirmed against a real payload; Task 4
// corrects this against a live capture before the parser is considered final.
const CONTENT_TYPE_MAP: Record<string, NormalizedMessageContentType> = {
  conversation: 'text',
  extendedTextMessage: 'text',
  imageMessage: 'image',
  videoMessage: 'video',
  documentMessage: 'document',
  audioMessage: 'audio',
  pttMessage: 'audio',
  stickerMessage: 'image',
  locationMessage: 'location',
}

function chatIdToPhone(chatid: string): string {
  return normalizePhone(chatid.split('@')[0])
}

export function parseUazapiMessageEvent(
  data: UazapiMessagePayload,
  accountId: string,
  configOwnerUserId: string,
): NormalizedInboundEvent | null {
  if (!data.chatid || !data.messageid) return null
  if (data.isGroup || data.fromMe) return null

  const senderPhone = chatIdToPhone(data.chatid)
  const timestamp = data.messageTimestamp ? new Date(data.messageTimestamp) : new Date()
  const base = {
    accountId,
    configOwnerUserId,
    senderPhone,
    senderName: data.senderName || senderPhone,
    providerMessageId: data.messageid,
    timestamp,
  }

  if (data.reaction) {
    return {
      ...base,
      kind: 'reaction',
      targetProviderMessageId: data.reaction,
      emoji: data.text || null,
    }
  }

  const contentType = CONTENT_TYPE_MAP[data.messageType ?? ''] ?? 'text'

  return {
    ...base,
    kind: 'message',
    contentType,
    contentText: data.text || null,
    mediaUrl: data.fileURL || null,
    interactiveReplyId: null,
    replyToProviderId: data.quoted || null,
  }
}

const STATUS_MAP: Record<string, NormalizedStatusUpdate['status']> = {
  Sent: 'sent',
  Delivered: 'delivered',
  Read: 'read',
  Canceled: 'failed',
  Failed: 'failed',
}

export function parseUazapiStatusEvent(data: UazapiMessagePayload): NormalizedStatusUpdate | null {
  if (!data.messageid || !data.status) return null
  const status = STATUS_MAP[data.status]
  if (!status) return null // Queued (and anything unrecognized) has no forward-ladder meaning
  return {
    providerMessageId: data.messageid,
    status,
    timestamp: data.messageTimestamp ? new Date(data.messageTimestamp) : new Date(),
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/whatsapp/uazapi-inbound-parser.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp/uazapi-inbound-parser.ts src/lib/whatsapp/uazapi-inbound-parser.test.ts
git commit -m "feat: add UAZAPI inbound event parser"
```

---

### Task 3: UAZAPI webhook route

**Files:**
- Create: `src/app/api/whatsapp/webhook/uazapi/route.ts`
- Test: `src/app/api/whatsapp/webhook/uazapi/route.test.ts`

**Interfaces:**
- Consumes: `parseUazapiMessageEvent`, `parseUazapiStatusEvent` from `src/lib/whatsapp/uazapi-inbound-parser.ts` (Task 2); `ingestInboundMessage`, `ingestStatusUpdate` from `src/lib/whatsapp/inbound.ts` (Task 1); `decrypt` from `src/lib/whatsapp/encryption.ts`.
- Produces: nothing new — this is a route, its contract is the HTTP interface UAZAPI calls.

**Context:** Per the design doc, the URL is `/api/whatsapp/webhook/uazapi?key=<webhook_secret>` — one shared URL for every UAZAPI account, same pattern as the Meta route. `webhook_secret` is stored **encrypted** (Phase 2a, `uazapi-config.ts`'s `saveAndConnectUazapiConfig`), so it can't be matched with a SQL `.eq()` — the route fetches every `provider = 'uazapi'` row and decrypts each `webhook_secret` to find the match, exactly the pattern the existing Meta `GET` handler already uses for `verify_token` (`webhook/route.ts:117-132`). As an extra check, the resolved row's `uazapi_instance_id` must equal the payload's top-level `instance` field. Every event is acked with `200` even on a parse miss (a group message, a `connection` event we don't yet act on) — non-200 responses make some webhook senders retry/back off aggressively, and there's nothing actionable in these anyway.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/whatsapp/webhook/uazapi/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const configs = [
  { id: 'row-1', account_id: 'acct-1', user_id: 'user-1', webhook_secret: 'encrypted:secret-1', uazapi_instance_id: 'inst-1' },
  { id: 'row-2', account_id: 'acct-2', user_id: 'user-2', webhook_secret: 'encrypted:secret-2', uazapi_instance_id: 'inst-2' },
]

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn((v: string) => v.replace(/^encrypted:/, '')),
}))

const { ingestInboundMessage, ingestStatusUpdate } = vi.hoisted(() => ({
  ingestInboundMessage: vi.fn(async () => {}),
  ingestStatusUpdate: vi.fn(async () => {}),
}))
vi.mock('@/lib/whatsapp/inbound', () => ({ ingestInboundMessage, ingestStatusUpdate }))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => Promise.resolve({ data: configs, error: null }),
      }),
    }),
  }),
}))

import { POST } from './route'

function postEvent(key: string, body: Record<string, unknown>) {
  return POST(
    new Request(`http://localhost/api/whatsapp/webhook/uazapi?key=${key}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/whatsapp/webhook/uazapi', () => {
  it('rejects a missing key', async () => {
    const res = await postEvent('', { event: 'messages', instance: 'inst-1', data: {} })
    expect(res.status).toBe(401)
  })

  it('rejects a key that matches no config', async () => {
    const res = await postEvent('wrong-secret', { event: 'messages', instance: 'inst-1', data: {} })
    expect(res.status).toBe(401)
  })

  it('rejects when the instance id does not match the resolved account', async () => {
    const res = await postEvent('secret-1', { event: 'messages', instance: 'inst-2', data: {} })
    expect(res.status).toBe(401)
  })

  it('resolves the account and ingests a messages event', async () => {
    const res = await postEvent('secret-1', {
      event: 'messages',
      instance: 'inst-1',
      data: {
        messageid: 'wamid.1',
        chatid: '5511999999999@s.whatsapp.net',
        messageType: 'conversation',
        text: 'oi',
      },
    })
    expect(res.status).toBe(200)
    expect(ingestInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct-1', providerMessageId: 'wamid.1' }),
    )
  })

  it('resolves the account and ingests a messages_update event', async () => {
    const res = await postEvent('secret-2', {
      event: 'messages_update',
      instance: 'inst-2',
      data: { messageid: 'wamid.1', status: 'Delivered' },
    })
    expect(res.status).toBe(200)
    expect(ingestStatusUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ providerMessageId: 'wamid.1', status: 'delivered' }),
    )
  })

  it('acks 200 without ingesting for an unhandled event type', async () => {
    const res = await postEvent('secret-1', { event: 'connection', instance: 'inst-1', data: {} })
    expect(res.status).toBe(200)
    expect(ingestInboundMessage).not.toHaveBeenCalled()
    expect(ingestStatusUpdate).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/app/api/whatsapp/webhook/uazapi/route.test.ts`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 3: Write the implementation**

Create `src/app/api/whatsapp/webhook/uazapi/route.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/app/api/whatsapp/webhook/uazapi/route.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/whatsapp/webhook/uazapi/route.ts src/app/api/whatsapp/webhook/uazapi/route.test.ts
git commit -m "feat: add UAZAPI inbound webhook route"
```

---

### Task 4: Live payload verification (mandatory before considering this plan done)

**Files:** none (verification only — fixes to Task 2/3 code happen here if the live payload doesn't match what was inferred).

**Context:** Everything in Tasks 1-3 about the exact shape of `messageType` values, and where captions/media metadata live inside `content`, is inferred from the OpenAPI spec's field *descriptions*, not confirmed against a real payload — the OpenAPI spec never gave a filled-in example for an inbound `messages` event. This task closes that gap.

- [ ] **Step 1: Expose the local dev server publicly**

Run: `npx localtunnel --port 3000` (or `ngrok http 3000` if you have an ngrok account) to get a temporary public URL. Note it — the UAZAPI instance needs to reach it.

- [ ] **Step 2: Re-register the webhook against the tunnel URL**

The webhook registered in Phase 2a points at whatever `NEXT_PUBLIC_SITE_URL`/`Host` resolved to at connect time (likely `localhost:3000`, unreachable from UAZAPI's servers). Re-run the connect flow (Settings → WhatsApp → UAZAPI → Connect) with `NEXT_PUBLIC_SITE_URL` set to the tunnel URL from Step 1, so `registerUazapiWebhook` points at a reachable address.

- [ ] **Step 2: Send yourself a real message and a real reaction**

From a phone with the connected UAZAPI number's WhatsApp, message a different real number, then react to your own inbound test message from that other number. Watch the dev server's console output — add a temporary `console.log(JSON.stringify(body))` at the top of the new route's `POST` handler if needed (remove it before Step 4).

- [ ] **Step 3: Compare the captured payload against `CONTENT_TYPE_MAP` and the reaction/quoted field assumptions**

If `messageType` values differ from the Baileys-style keys assumed in Task 2 (e.g. UAZAPI normalizes them to something else entirely), update `CONTENT_TYPE_MAP` in `src/lib/whatsapp/uazapi-inbound-parser.ts` to match, and add/adjust the corresponding test cases in `uazapi-inbound-parser.test.ts`. If `content` (not `text`/`reaction`) turns out to hold the reaction emoji or the quoted-message id, adjust `parseUazapiMessageEvent` accordingly.

- [ ] **Step 4: Confirm the message lands correctly in the Inbox**

Confirm the text message and the reaction both appear in the CRM's Inbox, attributed to the correct contact/conversation, with the reaction rendered under the right bubble.

- [ ] **Step 5: Commit any corrections**

```bash
git add src/lib/whatsapp/uazapi-inbound-parser.ts src/lib/whatsapp/uazapi-inbound-parser.test.ts
git commit -m "fix: correct UAZAPI messageType mapping against a real captured payload"
```
(Skip this commit if Task 2's inference turned out correct — note that in your final report instead.)

---

### Task 5: Final verification pass

**Files:** none (verification only).

- [ ] **Step 1: Full typecheck + lint + test**

Run:
```bash
npm run typecheck
npm run lint
npm test
```
Expected: all three pass with zero errors and no new warnings (same 5 pre-existing `currency.test.ts`/`date-utils.test.ts` failures as Phase 1/2a — confirm the count hasn't grown).

- [ ] **Step 2: Confirm no remaining direct references to the moved functions outside `inbound.ts`**

Run: `grep -rn "findOrCreateContact\|findOrCreateConversation\|flagBroadcastReplyIfAny\|lookupInternalIdByMetaId\|lookupInternalIdByProviderId" src/app/api/whatsapp/webhook/route.ts`
Expected: no output — confirms Task 1's extraction removed every definition and call-site from the Meta route file.

- [ ] **Step 3: End-to-end regression check on the Meta path**

Repeat Task 1 Step 8's manual check (real Meta text message + reaction) once more now that Tasks 2-4 have also landed, to catch any accidental cross-contamination between the Meta adapter and the new UAZAPI code sharing `inbound.ts`.

---

## Self-Review Notes

- **Spec coverage:** Implements the design doc's Webhook section in full — the envelope shape (`event`/`instance`/`data`), the `Message` field mapping, the `webhook_secret`-based auth scan, and the status ladder reuse it explicitly called for ("mesmo 'ladder' já usado para a Meta"). The one item the spec flagged as unresolved (`content` sub-fields per media type) is carried forward honestly as Task 4, not guessed away.
- **Type consistency:** `NormalizedInboundEvent`/`NormalizedStatusUpdate` (Task 1) are the single shared contract consumed unchanged by both the Meta adapter (Task 1) and the UAZAPI parser (Task 2) — field names and the status vocabulary (`'sent'|'delivered'|'read'|'failed'`) match end-to-end through to the DB CHECK constraints confirmed in Task 1's Context section.
- **Zero-behavior-change discipline:** Task 1's extracted function bodies are verbatim copies of the current `processMessage`/`handleStatusUpdate` logic (same table names, same column names, same dispatch order) — the only lines that changed are the ones reading from Meta's raw payload shape, now reading from the normalized one instead.
- **Out of scope, called out explicitly:** the `connection` webhook event (Phase 2a's polling already covers reconnection detection) and interactive replies (design doc's existing UAZAPI v1 scope decision) are both acknowledged-but-not-acted-on in Task 3, not silently dropped.
