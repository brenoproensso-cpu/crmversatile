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
            const row2 = { id, account_id: row.account_id as string, phone: row.phone as string, name: row.name as string }
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
        single: async () => {
          if (table === 'conversations') {
            const conv = [...state.conversations.values()].find(
              (c) => c.account_id === chain._filters.account_id && c.contact_id === chain._filters.contact_id,
            )
            return conv ? { data: conv, error: null } : { data: null, error: { code: 'PGRST116' } }
          }
          return { data: null, error: { code: 'PGRST116' } }
        },
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
