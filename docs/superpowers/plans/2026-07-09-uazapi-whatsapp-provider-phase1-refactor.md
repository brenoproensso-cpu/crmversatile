# WhatsApp Provider Abstraction (Phase 1 — Refactor Sem Mudança de Comportamento) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a `WhatsAppProvider` interface + `MetaProvider` implementation and migrate the text/media send call-sites to use it, with zero behavior change to the existing Meta Cloud API flow.

**Architecture:** New module `src/lib/whatsapp/provider.ts` defines `WhatsAppProvider` (`sendText`/`sendMedia`/`sendReaction`) and a `getWhatsAppProvider(config)` factory that currently always returns a `MetaProvider` — a thin wrapper delegating to the existing `sendTextMessage`/`sendMediaMessage`/`sendReactionMessage` in `meta-api.ts` (decrypting `access_token` internally). Three call-sites that currently call those three functions directly are migrated to go through the provider instead. Template sends (`sendTemplateMessage`) and interactive sends (`sendInteractiveButtons`/`sendInteractiveList`) are explicitly **out of scope** — they stay Meta-only and keep calling `meta-api.ts` directly, since the design doc (`docs/superpowers/specs/2026-07-09-uazapi-whatsapp-provider-design.md`) excludes them from the common interface.

**Tech Stack:** TypeScript, Next.js 16, Vitest 4 (`vi.mock`/`vi.stubGlobal` for fetch mocking), Supabase JS client.

## Global Constraints

- Zero behavior change to the Meta send path — this phase is pure reorganization, not a rewrite. Every existing call must produce byte-identical HTTP requests to Meta after the refactor.
- Named-args objects only for all new function signatures (matches the existing `meta-api.ts` convention — avoids positional-arg swap bugs).
- `sendTemplateMessage`, `sendInteractiveButtons`, `sendInteractiveList` are **not** part of `WhatsAppProvider` — do not add them to the interface or route them through `getWhatsAppProvider`.
- `src/lib/whatsapp/broadcast-core.ts` is **out of scope for this plan** — it only ever calls `sendTemplateMessage` today (Meta-only forever), so there is nothing in it to migrate. It starts using `provider.sendText`/`sendMedia` for UAZAPI accounts in the Phase 2 plan, not here.
- Run `npm run typecheck` and `npm test` (both defined in `package.json`) after every task; both must pass before moving on.

---

## File Structure

- **Create** `src/lib/whatsapp/provider.ts` — `WhatsAppProvider` interface, `WhatsAppConfigRow` type, `MetaProvider` class, `getWhatsAppProvider()` factory.
- **Create** `src/lib/whatsapp/provider.test.ts` — unit tests for `MetaProvider`, mocking `meta-api.ts` and `encryption.ts`.
- **Modify** `src/lib/whatsapp/send-message.ts` — media + text branches of `attempt()` route through the provider; template + interactive branches unchanged.
- **Modify** `src/lib/flows/meta-send.ts` — `engineSendText` and `engineSendMedia` route through the provider; the interactive path (`sendInteractiveViaMeta`) unchanged.
- **Modify** `src/lib/automations/meta-send.ts` — the `text` branch of `sendViaMeta` routes through the provider; the `template` branch unchanged.

---

### Task 1: `WhatsAppProvider` interface + `MetaProvider`

**Files:**
- Create: `src/lib/whatsapp/provider.ts`
- Test: `src/lib/whatsapp/provider.test.ts`

**Interfaces:**
- Consumes: `sendTextMessage`, `sendMediaMessage`, `sendReactionMessage`, `type MediaKind` from `src/lib/whatsapp/meta-api.ts`; `decrypt` from `src/lib/whatsapp/encryption.ts`.
- Produces (used by Tasks 2-4):
  ```ts
  export interface WhatsAppConfigRow {
    phone_number_id: string
    access_token: string
  }
  export interface WhatsAppSendResult { messageId: string }
  export interface SendTextArgs { to: string; text: string; contextMessageId?: string }
  export interface SendMediaArgs {
    to: string; kind: MediaKind; link: string
    caption?: string; filename?: string; contextMessageId?: string
  }
  export interface SendReactionArgs { to: string; targetMessageId: string; emoji: string }
  export interface WhatsAppProvider {
    sendText(args: SendTextArgs): Promise<WhatsAppSendResult>
    sendMedia(args: SendMediaArgs): Promise<WhatsAppSendResult>
    sendReaction(args: SendReactionArgs): Promise<WhatsAppSendResult>
  }
  export function getWhatsAppProvider(config: WhatsAppConfigRow): WhatsAppProvider
  ```

- [x] **Step 1: Write the failing test**

Create `src/lib/whatsapp/provider.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTextMessage: vi.fn(),
  sendMediaMessage: vi.fn(),
  sendReactionMessage: vi.fn(),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn((v: string) => `decrypted:${v}`),
}))

import {
  sendTextMessage,
  sendMediaMessage,
  sendReactionMessage,
} from '@/lib/whatsapp/meta-api'
import { getWhatsAppProvider } from './provider'

const CONFIG = { phone_number_id: 'PNID123', access_token: 'enc-token' }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('MetaProvider', () => {
  it('sendText forwards to sendTextMessage with the decrypted token', async () => {
    vi.mocked(sendTextMessage).mockResolvedValue({ messageId: 'wamid.1' })
    const provider = getWhatsAppProvider(CONFIG)

    const result = await provider.sendText({
      to: '+15551234',
      text: 'hi',
      contextMessageId: 'ctx1',
    })

    expect(sendTextMessage).toHaveBeenCalledWith({
      phoneNumberId: 'PNID123',
      accessToken: 'decrypted:enc-token',
      to: '+15551234',
      text: 'hi',
      contextMessageId: 'ctx1',
    })
    expect(result).toEqual({ messageId: 'wamid.1' })
  })

  it('sendMedia forwards to sendMediaMessage with the decrypted token', async () => {
    vi.mocked(sendMediaMessage).mockResolvedValue({ messageId: 'wamid.2' })
    const provider = getWhatsAppProvider(CONFIG)

    const result = await provider.sendMedia({
      to: '+15551234',
      kind: 'image',
      link: 'https://example.com/img.jpg',
      caption: 'cap',
    })

    expect(sendMediaMessage).toHaveBeenCalledWith({
      phoneNumberId: 'PNID123',
      accessToken: 'decrypted:enc-token',
      to: '+15551234',
      kind: 'image',
      link: 'https://example.com/img.jpg',
      caption: 'cap',
      filename: undefined,
      contextMessageId: undefined,
    })
    expect(result).toEqual({ messageId: 'wamid.2' })
  })

  it('sendReaction forwards to sendReactionMessage with the decrypted token', async () => {
    vi.mocked(sendReactionMessage).mockResolvedValue({ messageId: 'wamid.3' })
    const provider = getWhatsAppProvider(CONFIG)

    const result = await provider.sendReaction({
      to: '+15551234',
      targetMessageId: 'wamid.0',
      emoji: '👍',
    })

    expect(sendReactionMessage).toHaveBeenCalledWith({
      phoneNumberId: 'PNID123',
      accessToken: 'decrypted:enc-token',
      to: '+15551234',
      targetMessageId: 'wamid.0',
      emoji: '👍',
    })
    expect(result).toEqual({ messageId: 'wamid.3' })
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/whatsapp/provider.test.ts`
Expected: FAIL — `Cannot find module './provider'` (file doesn't exist yet).

- [x] **Step 3: Write the implementation**

Create `src/lib/whatsapp/provider.ts`:

```ts
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sendMediaMessage,
  sendReactionMessage,
  sendTextMessage,
  type MediaKind,
} from '@/lib/whatsapp/meta-api'

export interface WhatsAppConfigRow {
  phone_number_id: string
  access_token: string
}

export interface WhatsAppSendResult {
  messageId: string
}

export interface SendTextArgs {
  to: string
  text: string
  contextMessageId?: string
}

export interface SendMediaArgs {
  to: string
  kind: MediaKind
  link: string
  caption?: string
  filename?: string
  contextMessageId?: string
}

export interface SendReactionArgs {
  to: string
  targetMessageId: string
  emoji: string
}

export interface WhatsAppProvider {
  sendText(args: SendTextArgs): Promise<WhatsAppSendResult>
  sendMedia(args: SendMediaArgs): Promise<WhatsAppSendResult>
  sendReaction(args: SendReactionArgs): Promise<WhatsAppSendResult>
}

class MetaProvider implements WhatsAppProvider {
  constructor(private readonly config: WhatsAppConfigRow) {}

  async sendText(args: SendTextArgs): Promise<WhatsAppSendResult> {
    return sendTextMessage({
      phoneNumberId: this.config.phone_number_id,
      accessToken: decrypt(this.config.access_token),
      to: args.to,
      text: args.text,
      contextMessageId: args.contextMessageId,
    })
  }

  async sendMedia(args: SendMediaArgs): Promise<WhatsAppSendResult> {
    return sendMediaMessage({
      phoneNumberId: this.config.phone_number_id,
      accessToken: decrypt(this.config.access_token),
      to: args.to,
      kind: args.kind,
      link: args.link,
      caption: args.caption,
      filename: args.filename,
      contextMessageId: args.contextMessageId,
    })
  }

  async sendReaction(args: SendReactionArgs): Promise<WhatsAppSendResult> {
    return sendReactionMessage({
      phoneNumberId: this.config.phone_number_id,
      accessToken: decrypt(this.config.access_token),
      to: args.to,
      targetMessageId: args.targetMessageId,
      emoji: args.emoji,
    })
  }
}

export function getWhatsAppProvider(config: WhatsAppConfigRow): WhatsAppProvider {
  return new MetaProvider(config)
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/whatsapp/provider.test.ts`
Expected: PASS (3 tests).

- [x] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [x] **Step 6: Commit**

```bash
git add src/lib/whatsapp/provider.ts src/lib/whatsapp/provider.test.ts
git commit -m "feat: add WhatsAppProvider interface and MetaProvider"
```

---

### Task 2: Migrate `send-message.ts` to the provider

**Files:**
- Modify: `src/lib/whatsapp/send-message.ts`

**Interfaces:**
- Consumes: `getWhatsAppProvider` from `src/lib/whatsapp/provider.ts` (Task 1).
- Produces: nothing new — `sendMessageToConversation`'s external signature is unchanged.

**Context:** `attempt()` (currently lines 332-396) is a `messageType` switch that calls four different `meta-api.ts` senders. Only the `isMediaKind` branch (`sendMediaMessage`, lines 347-359) and the fallback text branch (`sendTextMessage`, lines 388-395) migrate to the provider. The `template` branch (`sendTemplateMessage`, lines 333-346) and `interactive` branch (`sendInteractiveButtons`/`sendInteractiveList`, lines 360-387) are untouched and keep using `accessToken` directly — do not remove that variable, it's still needed by those two branches.

- [x] **Step 1: Update the `meta-api.ts` import**

In `src/lib/whatsapp/send-message.ts`, replace the import block (lines 24-31):

```ts
import {
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  type MediaKind,
} from '@/lib/whatsapp/meta-api';
```

with:

```ts
import {
  sendTemplateMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  type MediaKind,
} from '@/lib/whatsapp/meta-api';
import { getWhatsAppProvider } from '@/lib/whatsapp/provider';
```

- [x] **Step 2: Construct the provider once, before `attempt`**

Immediately before the `const attempt = async (phone: string): Promise<string> => {` line (currently line 332), insert:

```ts
  const provider = getWhatsAppProvider(config);

```

- [x] **Step 3: Route the media branch through the provider**

Replace (currently lines 347-359):

```ts
    if (isMediaKind) {
      const result = await sendMediaMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        kind: messageType as MediaKind,
        link: mediaUrl!,
        caption: contentText || undefined,
        filename: filename || undefined,
        contextMessageId,
      });
      return result.messageId;
    }
```

with:

```ts
    if (isMediaKind) {
      const result = await provider.sendMedia({
        to: phone,
        kind: messageType as MediaKind,
        link: mediaUrl!,
        caption: contentText || undefined,
        filename: filename || undefined,
        contextMessageId,
      });
      return result.messageId;
    }
```

- [x] **Step 4: Route the text branch through the provider**

Replace (currently lines 388-395):

```ts
    const result = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      text: contentText!,
      contextMessageId,
    });
    return result.messageId;
```

with:

```ts
    const result = await provider.sendText({
      to: phone,
      text: contentText!,
      contextMessageId,
    });
    return result.messageId;
```

- [x] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (`MediaKind` is still used for the `messageType as MediaKind` cast, so its import stays.)

- [x] **Step 6: Run the existing test suite for this file**

Run: `npx vitest run src/lib/whatsapp/send-message.test.ts`
Expected: PASS — these tests only exercise `validateSendMessageParams`/`SendMessageError`, so they must be unaffected.

- [x] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS, no new failures.

- [x] **Step 8: Commit**

```bash
git add src/lib/whatsapp/send-message.ts
git commit -m "refactor: route send-message text/media sends through WhatsAppProvider"
```

---

### Task 3: Migrate `flows/meta-send.ts` to the provider

**Files:**
- Modify: `src/lib/flows/meta-send.ts`

**Interfaces:**
- Consumes: `getWhatsAppProvider` from `src/lib/whatsapp/provider.ts` (Task 1).
- Produces: nothing new — `engineSendText`, `engineSendMedia`, `engineSendInteractiveButtons`, `engineSendInteractiveList` keep their existing signatures.

**Context:** This file has three independent config-fetch blocks (`engineSendText`, `engineSendMedia`, `sendInteractiveViaMeta`). Only the first two migrate. `sendInteractiveViaMeta` (backing `engineSendInteractiveButtons`/`engineSendInteractiveList`) is untouched and keeps its own `decrypt(config.access_token)` call — do not remove the `decrypt` import, it's still needed there.

- [x] **Step 1: Update the `meta-api.ts` import**

Replace the import block (lines 1-9):

```ts
import {
  sendInteractiveButtons,
  sendInteractiveList,
  sendMediaMessage,
  sendTextMessage,
  type InteractiveButton,
  type InteractiveListSection,
  type MediaKind,
} from '@/lib/whatsapp/meta-api'
```

with:

```ts
import {
  sendInteractiveButtons,
  sendInteractiveList,
  type InteractiveButton,
  type InteractiveListSection,
  type MediaKind,
} from '@/lib/whatsapp/meta-api'
```

and add, alongside the existing `import { decrypt } from '@/lib/whatsapp/encryption'` line (line 11):

```ts
import { getWhatsAppProvider } from '@/lib/whatsapp/provider'
```

- [x] **Step 2: Migrate `engineSendText`**

Replace (currently lines 94-104):

```ts
  const accessToken = decrypt(config.access_token)

  const attempt = async (phone: string): Promise<string> => {
    const r = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      text: args.text,
    })
    return r.messageId
  }
```

with:

```ts
  const provider = getWhatsAppProvider(config)

  const attempt = async (phone: string): Promise<string> => {
    const r = await provider.sendText({
      to: phone,
      text: args.text,
    })
    return r.messageId
  }
```

- [x] **Step 3: Migrate `engineSendMedia`**

Replace (currently lines 204-217):

```ts
  const accessToken = decrypt(config.access_token)

  const attempt = async (phone: string): Promise<string> => {
    const r = await sendMediaMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      kind: args.kind,
      link: args.link,
      caption: args.caption,
      filename: args.filename,
    })
    return r.messageId
  }
```

with:

```ts
  const provider = getWhatsAppProvider(config)

  const attempt = async (phone: string): Promise<string> => {
    const r = await provider.sendMedia({
      to: phone,
      kind: args.kind,
      link: args.link,
      caption: args.caption,
      filename: args.filename,
    })
    return r.messageId
  }
```

- [x] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (`MediaKind` is still used in `SendMediaEngineArgs`; `decrypt` is still used in `sendInteractiveViaMeta`.)

- [x] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, no new failures.

- [x] **Step 6: Commit**

```bash
git add src/lib/flows/meta-send.ts
git commit -m "refactor: route flows engineSendText/engineSendMedia through WhatsAppProvider"
```

---

### Task 4: Migrate `automations/meta-send.ts` to the provider

**Files:**
- Modify: `src/lib/automations/meta-send.ts`

**Interfaces:**
- Consumes: `getWhatsAppProvider` from `src/lib/whatsapp/provider.ts` (Task 1).
- Produces: nothing new — `engineSendText`, `engineSendTemplate`, `engineSendInteractive` keep their existing signatures.

**Context:** `sendViaMeta` (lines 108-224) handles both `text` and `template` kinds in one `attempt()`. Only the `text` branch migrates; the `template` branch keeps using `accessToken` directly via `sendTemplateMessage` — do not remove the `accessToken` const, it's still needed there.

- [x] **Step 1: Update the `meta-api.ts` import**

Replace line 1:

```ts
import { sendTextMessage, sendTemplateMessage } from '@/lib/whatsapp/meta-api'
```

with:

```ts
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
```

and add, alongside the existing `import { decrypt } from '@/lib/whatsapp/encryption'` line (line 7):

```ts
import { getWhatsAppProvider } from '@/lib/whatsapp/provider'
```

- [x] **Step 2: Construct the provider and route the text branch through it**

Replace (currently lines 143-164):

```ts
  const accessToken = decrypt(config.access_token)

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'template') {
      const r = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        templateName: input.templateName,
        language: input.language,
        params: input.params,
      })
      return r.messageId
    }
    const r = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      text: input.text,
    })
    return r.messageId
  }
```

with:

```ts
  const accessToken = decrypt(config.access_token)
  const provider = getWhatsAppProvider(config)

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'template') {
      const r = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        templateName: input.templateName,
        language: input.language,
        params: input.params,
      })
      return r.messageId
    }
    const r = await provider.sendText({
      to: phone,
      text: input.text,
    })
    return r.messageId
  }
```

- [x] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [x] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS, no new failures.

- [x] **Step 5: Commit**

```bash
git add src/lib/automations/meta-send.ts
git commit -m "refactor: route automations engineSendText through WhatsAppProvider"
```

---

### Task 5: Final verification pass

**Files:** none (verification only).

- [x] **Step 1: Full typecheck + lint + test**

Run:
```bash
npm run typecheck
npm run lint
npm test
```
Expected: all three pass with zero errors and no new warnings.

- [x] **Step 2: Confirm no remaining direct `sendTextMessage`/`sendMediaMessage` imports outside `meta-api.ts`/`provider.ts`/their tests**

Run: `grep -rn "sendTextMessage\|sendMediaMessage" src --include=*.ts --include=*.tsx -l`
Expected output: only `src/lib/whatsapp/meta-api.ts`, `src/lib/whatsapp/provider.ts`, `src/lib/whatsapp/provider.test.ts`, and the pre-existing `src/lib/whatsapp/meta-api*.test.ts` files. If `send-message.ts`, `flows/meta-send.ts`, or `automations/meta-send.ts` still appear, a migration step was missed — go back and fix it.

- [ ] **Step 3: Manual smoke check against a real WhatsApp number (optional but recommended)**

Since none of `send-message.ts`, `flows/meta-send.ts`, or `automations/meta-send.ts` have pre-existing unit tests covering the actual Meta-calling code path, run the dev server and send one real text message and one real media message from the inbox composer against a connected sandbox number, confirming both arrive exactly as they did before this refactor.

---

## Self-Review Notes

- **Spec coverage:** This plan implements exactly item 1 of the spec's "Fases de implementação sugeridas" — the `WhatsAppProvider`/`MetaProvider` interface and the 3 applicable call-site migrations (`send-message.ts`, `flows/meta-send.ts`, `automations/meta-send.ts`). `broadcast-core.ts` is explicitly excluded (see Global Constraints) since it has nothing to migrate until Phase 2. Schema changes, `UazapiProvider`, the Settings UI, and the webhook route are all Phase 2 — a separate plan, written once the "pontos em aberto" (real UAZAPI webhook payload shapes) in the spec are resolved.
- **`sendReaction` has no caller in Phase 1:** confirmed via repo-wide grep that `sendReactionMessage` has zero call-sites outside `meta-api.ts` today. `WhatsAppProvider.sendReaction`/`MetaProvider.sendReaction` are still implemented (per the spec's interface) and unit-tested in Task 1, but no task wires a real call-site to it — there isn't one yet.
- **Type consistency:** `WhatsAppConfigRow`, `SendTextArgs`, `SendMediaArgs`, `SendReactionArgs`, `WhatsAppSendResult`, and `getWhatsAppProvider` names/shapes are identical between Task 1 (where they're defined) and Tasks 2-4 (where they're consumed).
