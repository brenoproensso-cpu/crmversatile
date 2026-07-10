# Suporte a UAZAPI como segundo provedor de WhatsApp

Data: 2026-07-09

## Contexto e objetivo

O CRM hoje conecta o WhatsApp exclusivamente via API Oficial da Meta (Cloud API): o usuário cola `phone_number_id` + `access_token` + `waba_id` obtidos no Meta Business Manager, e uma linha em `whatsapp_config` (uma por conta) guarda essas credenciais. Toda a lógica de envio (`meta-api.ts`), recebimento (`/api/whatsapp/webhook`), templates aprovados e broadcasts é acoplada a esse modelo.

Este documento define como adicionar a **UAZAPI** (API não oficial, protocolo WhatsApp Web multi-dispositivo) como segunda opção de conexão, escolhida pelo usuário na tela de Configurações, sem quebrar o fluxo Meta existente.

Diferenças-chave da UAZAPI que moldam o design:
- Conecta via **QR code** (ou código de pareamento por número), não via token de app OAuth.
- Não tem conceito de **templates aprovados** nem janela de 24h — mensagens são texto/mídia livre a qualquer momento.
- Webhooks **não são assinados** (sem HMAC como a Meta) — a autenticação precisa ser resolvida por nós.
- É organizada em "instâncias" (uma por número conectado), identificadas por um token, não por `phone_number_id`.

## Decisões de escopo (confirmadas com o usuário)

1. **Broadcast/Templates**: contas UAZAPI escondem a aba de Templates; Broadcasts passam a enviar texto/mídia livre em vez de templates aprovados (não há restrição de janela de 24h na UAZAPI que exigiria templates).
2. **Tipos de mensagem no v1**: texto, mídia (imagem/vídeo/áudio/documento) e reações. Mensagens interativas (botões/listas, usadas hoje pelo motor de Flows via `sendInteractiveButtons`/`sendInteractiveList`) ficam **fora do escopo** desta primeira versão — o formato `/send/menu` da UAZAPI e o webhook de resposta dela são suficientemente diferentes para merecer uma iteração própria.
3. **Provisionamento**: o usuário já possui (ou cria por conta própria na uazapi.com ou servidor próprio) uma instância e cola o token + URL do servidor nas Configurações do CRM — igual ao padrão já usado para a Meta. O CRM nunca guarda um `admintoken` nem cria instâncias automaticamente.

## Fora de escopo (v2 ou além)

- Mensagens interativas (botões/listas) via UAZAPI.
- Templates/broadcast com aprovação prévia via UAZAPI (não existe esse conceito lá).
- Qualquer feature além de mensageria 1:1: grupos, comunidades, newsletters, gerenciamento de proxy, cobrança via PIX, carrosséis, chamadas, etiquetas.
- Múltiplos números conectados por conta (continua 1 config por conta, como hoje).
- Migração automática de uma conta já conectada via Meta para UAZAPI (troca de provedor = desconectar e reconectar).

## Modelo de dados

`whatsapp_config` ganha um seletor de provedor e colunas específicas da UAZAPI, todas nullable (as colunas Meta continuam existindo e ficam NULL para contas UAZAPI, e vice-versa):

```sql
ALTER TABLE whatsapp_config
  ADD COLUMN provider TEXT NOT NULL DEFAULT 'meta' CHECK (provider IN ('meta', 'uazapi')),
  ADD COLUMN uazapi_server_url TEXT,      -- ex: https://free.uazapi.com
  ADD COLUMN uazapi_instance_id TEXT,     -- id da instância (usado para casar com o campo `instance` do webhook)
  ADD COLUMN uazapi_token TEXT,           -- token da instância, criptografado com encrypt() (mesmo esquema do access_token da Meta)
  ADD COLUMN webhook_secret TEXT;         -- gerado por nós no momento da conexão; ver seção Webhook
```

A constraint de unicidade em `account_id` (uma config por conta) é mantida sem alteração.

## Camada de abstração de provedor

Novo módulo `src/lib/whatsapp/provider.ts` define a interface comum e uma factory:

```ts
interface WhatsAppProvider {
  sendText(args: { to: string; text: string; contextMessageId?: string }): Promise<{ messageId: string }>
  sendMedia(args: { to: string; kind: MediaKind; link: string; caption?: string; filename?: string; contextMessageId?: string }): Promise<{ messageId: string }>
  sendReaction(args: { to: string; targetMessageId: string; emoji: string }): Promise<{ messageId: string }>
}

function getWhatsAppProvider(config: WhatsAppConfigRow): WhatsAppProvider
```

- **`MetaProvider`**: wrapper fino sobre as funções já existentes em `meta-api.ts` (`sendTextMessage`, `sendMediaMessage`, `sendReactionMessage`). Nenhuma mudança de comportamento — é reorganização, não reescrita.
- **`UazapiProvider`** (novo, `src/lib/whatsapp/uazapi-api.ts`): mesma forma de erro (`throw new Error(message)` no padrão de `throwMetaError`), autentica com o header `token` da instância contra `uazapi_server_url`, chamando `/send/text`, `/send/media`, `/message/react`.

Templates (`sendTemplateMessage`) e mensagens interativas **não entram** na interface comum — continuam exclusivos do `MetaProvider`. Os quatro call-sites que hoje chamam `meta-api.ts` diretamente são migrados para pedir `getWhatsAppProvider(config)` uma vez e usar os métodos genéricos:
- `src/lib/whatsapp/send-message.ts` (envio manual pelo Inbox + API pública)
- `src/lib/flows/meta-send.ts` (motor de Flows — texto e mídia; interativo permanece Meta-only)
- `src/lib/automations/meta-send.ts` (motor de Automations — texto; template permanece Meta-only)
- `src/lib/whatsapp/broadcast-core.ts` (Broadcasts — passa a usar `sendText`/`sendMedia` para contas UAZAPI em vez de `sendTemplateMessage`)

O retry por variação de número (`phoneVariants` / `isRecipientNotAllowedError`) é uma peculiaridade do sandbox da Meta. Para UAZAPI, o provider nunca lança esse erro específico, então o loop de retry tenta uma vez e segue — sem precisar de `if (provider === 'meta')` espalhado pelos call-sites.

## Fluxo de conexão (Settings UI)

`WhatsAppConfig` (hoje um componente monolítico só-Meta) é dividido em:
- `whatsapp-config.tsx` — casca: busca a config, mostra o seletor de provedor (dois cards: "API Oficial (Meta)" / "UAZAPI"), renderiza o painel correspondente.
- `meta-connect-panel.tsx` — o formulário atual, sem mudança de comportamento.
- `uazapi-connect-panel.tsx` — novo:
  1. Campos: URL do servidor + token da instância → botão "Conectar".
  2. `POST /api/whatsapp/config` com `provider: 'uazapi'` salva as credenciais criptografadas, gera o `webhook_secret`, registra o webhook na instância (`POST /webhook`, ver seção seguinte) e chama `/instance/connect`.
  3. O v1 não coleta número de telefone, então `/instance/connect` é sempre chamado sem `phone` — a UAZAPI sempre responde com QR code (`instance.qrcode`, base64), nunca `paircode` (esse código de pareamento por número fica fora de escopo do v1). A tela mostra a imagem do QR e faz polling em `/instance/status` a cada ~3s até `connected` ou timeout de 2 min (limite documentado pela UAZAPI para QR code).
  4. Ao conectar, mostra o estado "Conectado" com nome de perfil etc., no mesmo padrão visual do painel Meta.
  5. Estado `hibernated` (sessão pausada com credenciais preservadas, retornado por `/instance/status`): tratado como "Desconectado" na UI, mas o botão "Conectar" nesse caso deve reenviar `/instance/connect` esperando reconexão automática das credenciais salvas em vez de gerar QR novo do zero — se a UAZAPI ainda assim devolver um QR novo, o fluxo cai de volta no passo 3 normalmente.

## Webhook

A UAZAPI não assina requisições de webhook. Para autenticar a origem e identificar a conta ao mesmo tempo, o CRM gera um `webhook_secret` aleatório por conta no momento da conexão e registra na UAZAPI uma URL contendo esse segredo:

```
POST /webhook   (na instância do cliente)
{ "url": "https://<crm>/api/whatsapp/webhook/uazapi?key=<webhook_secret>",
  "events": ["messages", "messages_update", "connection"],
  "excludeMessages": ["wasSentByApi"] }
```

`excludeMessages: ["wasSentByApi"]` é obrigatório — sem isso, mensagens enviadas pelo próprio CRM voltariam como eventos de webhook, causando eco/duplicidade.

Nova rota `src/app/api/whatsapp/webhook/uazapi/route.ts` (uma única URL compartilhada por todas as contas UAZAPI, no mesmo padrão da rota Meta atual): lê `?key=`, busca `whatsapp_config` por `webhook_secret = key AND provider = 'uazapi'` — isso autentica e resolve o tenant simultaneamente (sem `key` correta, 401). Como checagem extra, confirma que `payload.instance` bate com `uazapi_instance_id`.

**Formato confirmado do payload** (validado contra a documentação OpenAPI oficial da UAZAPI em `docs.uazapi.com` e uma instância real de teste em 2026-07-10):

Todo evento chega no formato-envelope:
```json
{ "event": "messages", "instance": "r00cd19ce7afc39", "data": { ... } }
```
- `event`: um de `messages`, `messages_update`, `connection`, `history`, `presence`, `groups`, etc. (registramos apenas `messages`, `messages_update`, `connection` — ver seção anterior).
- `instance`: o **id interno** da instância (ex.: `r00cd19ce7afc39`), não o token — é esse valor que deve bater com `uazapi_instance_id`.
- `data` (para `messages` e `messages_update`): objeto `Message` — `id`, `messageid` (id da mensagem no WhatsApp), `chatid` (JID do contato, ex. `5511999999999@s.whatsapp.net`), `sender`, `senderName`, `isGroup`, `fromMe`, `messageType`, `messageTimestamp`, `status` (`Queued`→`Sent`→`Delivered`→`Read`, ou `Canceled`/`Failed` — mesmo "ladder" já usado para a Meta), `text`, `quoted` (id da mensagem citada), `reaction` (id da mensagem reagida quando o evento é uma reação), `wasSentByApi`, `fileURL` (URL direta do arquivo de mídia, já pronta para uso — **não é necessário chamar `/message/download`** no caminho normal de ingestão), `content` (objeto bruto ou string com detalhes específicos do tipo de mensagem).

**Ponto em aberto remanescente** (não é decisão de arquitetura, é detalhe de payload a confirmar contra uma mensagem real antes de finalizar o parser): a doc oficial não exemplifica os sub-campos exatos de `content` por tipo de mídia (image/video/audio/document — ex. nomes de campo para mimetype, thumbnail, duração). Resolver isso durante a implementação conectando a instância de teste e inspecionando um payload real de mídia recebida.

**Reuso do pipeline de ingestão**: a lógica de negócio hoje presa em `processMessage()` (dentro de `webhook/route.ts`) — achar/criar contato e conversa, disparar Flows, Automations, IA de auto-resposta, webhooks públicos de saída — é extraída para um núcleo comum `ingestInboundMessage()` em `src/lib/whatsapp/inbound.ts`, que recebe campos já normalizados (telefone, nome, tipo de conteúdo, texto, mídia, timestamp, id da mensagem, contexto de reply/reação). A rota Meta parseia o formato dela e chama esse núcleo; a rota UAZAPI faz o mesmo com o formato dela.

## Testes

- `MetaProvider`: testes existentes de `meta-api.ts` continuam válidos (nenhuma mudança de comportamento).
- `UazapiProvider`: testes unitários no mesmo molde de `meta-api.test.ts` (mock de `fetch`, casos de sucesso + erro).
- `ingestInboundMessage()`: testes unitários com payloads normalizados sintéticos, cobrindo os casos que hoje só são testados indiretamente via `processMessage`.
- Roteamento do webhook UAZAPI: teste de que uma chave inválida retorna 401 e uma válida resolve a conta correta.

## Fases de implementação sugeridas

1. **Refactor sem mudança de comportamento**: introduzir a interface `WhatsAppProvider` + `MetaProvider`, migrar os 4 call-sites para usá-la. Nenhuma feature nova, só reorganização — fácil de verificar que nada quebrou no fluxo Meta.
2. **UAZAPI de verdade**: schema, `UazapiProvider`, painel de conexão + QR code, rota de webhook, extração de `ingestInboundMessage()`.
