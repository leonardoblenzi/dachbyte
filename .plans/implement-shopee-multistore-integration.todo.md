# Plano: integração Shopee multi-loja por empresa no VoltPrice

## Summary

Completar a integração Shopee Open Platform V2 do VoltPrice para que cada empresa possa autorizar e operar várias lojas Shopee, importar e persistir seus pedidos, consultar escrow/taxas na conta certa e acompanhar a saúde de cada conexão. A implementação deve substituir o callback Shopee inline e o uso opcional de `connectionId` por contratos testáveis, tenant-safe e equivalentes ao padrão multi-conta já publicado para Mercado Livre.

## Type

Feature / enhancement de integração existente.

## Source Issue/Task

Solicitação do usuário: OAuth Shopee multi-loja por empresa, refresh automático, callback seguro, sincronização/persistência de pedidos, taxas/escrow, UI de conexão/lojas/status e seleção da conta correta em cada pedido.

## Original Requirements (100% Coverage Required)

| # | Requirement | Plan step(s) |
|---|---|---|
| 1 | OAuth Shopee para múltiplas lojas da mesma empresa | 2, 3, 8 |
| 2 | Refresh automático e seguro | 4, 10 |
| 3 | Callback seguro | 2, 3, 10 |
| 4 | Sincronizar e persistir pedidos Shopee | 5, 6, 7, 10 |
| 5 | Disponibilizar taxas/escrow Shopee | 6, 7, 10 |
| 6 | UI de conexão, lojas e status | 8, 9, 10 |
| 7 | Usar a conta correta ao operar pedidos | 5, 6, 7, 8, 10 |
| 8 | Respeitar padrões de ML multi-conta, Tray, migrações, testes, README/.env e Render/Open Platform | 1, 4, 5, 9, 10 |

**Coverage Check**: 8 of 8 requirements mapped to plan steps.

## Status

Todo (renomear para `.done.md` apenas após a implementação e validação).

## Context

O VoltPrice já possui `integration_connections`, criptografia de tokens, OAuth states de uso único, RLS por tenant e manutenção automática de tokens. `src/integrations/shopee.js` já assina chamadas V2 por HMAC, troca/renova token e expõe listagem/detalhe de pedidos e escrow, mas o callback está inline em `integrations.routes.js`, a UI mostra somente a primeira conexão Shopee e taxas são buscadas por `order_sn` com `connectionId` opcional. Assim, uma empresa com duas lojas pode ter uma operação Shopee executada na loja mais recentemente atualizada, em vez da loja associada ao pedido.

## Current State

- `volt_price.integration_connections` permite várias linhas por `(tenant_id, channel, external_account_id)` e já aceita `channel='shopee'`; tokens são AES-256-GCM e a listagem não os expõe.
- O OAuth Shopee cria um state no banco, mas retorna a URL de autorização sem levar state ao provedor e consome somente o cookie. O callback também encaminha erros ao error handler geral, em vez de redirecionar para um destino constante e seguro.
- `maintenance.js` já inclui Shopee na renovação automática e `shopee.refreshLocked` usa `FOR UPDATE`, mas faltam testes específicos de concorrência/retentativa/expiração e erro de reautorização.
- Os pedidos persistidos usam `orders.marketplace`, `marketplace_order_id`, `marketplace_account_id` e `marketplace_account_source`; a migration `012_meli_order_account.sql` tornou esses campos genéricos, mas a UI e a rota financeira só resolvem a conta de Mercado Livre.
- A Tray é hoje a fonte de sync. Shopee consegue listar/detalhar pedidos, mas não tem `shopeeSync`, checkpoints/runs por loja, rota de sincronização nem normalizador para persistir pedidos de origem Shopee.
- `fee_snapshots` e `finance/fees.js` já normalizam o escrow Shopee, porém a rota de taxas não resolve a conta a partir do pedido persistido.

## Desired State

- Cada autorização cria/atualiza exatamente uma conexão Shopee por `tenant_id + shop_id`; a tela permite adicionar, renovar e desconectar qualquer loja individualmente.
- O callback exige state opaco de uso único, cookie callback-only correspondente, `code` e `shop_id`; jamais exibe/loga token, code, state ou resposta do provedor e sempre volta para rota same-origin constante em falha.
- O sync explicitamente seleciona uma loja, usa aquela conexão em cada página/detalhe, persiste pedidos de modo idempotente e registra run/checkpoint/erro por conexão.
- Todo pedido Shopee persistido carrega `marketplace_account_id = shop_id`. A consulta de escrow por pedido interno resolve a conexão por esse campo; se não houver conta identificada ou conectada, falha com conflito explícito, sem fallback para "última" ou "conta padrão".

## CLAUDE.md Requirements

Nenhum `CLAUDE.md` foi encontrado no worktree, na raiz do repositório ou no escopo `business/volt-price` durante a auditoria. Aplicar as convenções observadas no módulo:

### Naming Conventions

- CommonJS, arquivos em camelCase (`shopeeSync.js`, `shopeeAccount.js`) e testes `*.test.js` em `business/volt-price/tests`.
- Migrations imutáveis e sequenciais na raiz `business/volt-price/db`, usando o próximo nome definitivo somente se uma mudança de schema for realmente necessária.

### Architecture Requirements

- Rotas Express finas em `src/routes`; integração de provedor em `src/integrations`; sincronização em `src/orders`; cálculo/armazenamento financeiro em `src/finance`.
- Todas as queries tenant-owned passam por `withTenant`; somente manutenção usa `withPlatformAdmin` para localizar conexões e então executa a operação sob o tenant/usuário dono.
- OAuth tokens apenas por `tokenStore.upsertConnection`; nunca em resposta HTTP, audit metadata, UI ou logs.

### Type Requirements

- Projeto JavaScript: representar dados com objetos de contrato pequenos e testes de contrato; não introduzir `any`/`unknown`, nem payloads soltos sem normalização.

### Other Guidelines

- Mutations exigem autenticação, password-change guard, CSRF e a permissão específica existente.
- RLS é obrigatório e `redactForStorage` deve ser aplicado a payloads externos persistidos.
- Preserve o shell/protótipo já usado pela UI e não invente dados de marketplace.

## Existing Types / Contracts

### Contracts to Reuse

- `integration_connections` e `tokenStore` (`listConnections`, `getConnection`, `getConnectionByExternalAccount`, `upsertConnection`, `connectionStatus`) — conexão por conta externa, status seguro e tokens cifrados.
- `oauth_states` (`createOAuthState`, `consumeOAuthState`) — state SHA-256, escopo tenant/usuário/canal, uso único e TTL de 15 minutos.
- `resolveMeliConnectionForOrder` em `src/orders/meliAccount.js` — molde para uma resolução estrita por pedido, sem fallback.
- `sync_runs` / `sync_checkpoints` e `traySync` — execução exclusiva por conexão, checkpoint, paginação, persistência idempotente, auditoria e registro seguro de falhas.
- `normalizeTrayOrder` / `syncWindow` — contratos de normalização e janela histórica/incremental reutilizáveis com origem Shopee.
- `normalizeEscrow` em `integrations/shopee.js` e `normalizeFeeResult` em `finance/fees.js` — componentes financeiros Shopee já compreendidos pelo Profit.
- `maintenance.runTokenMaintenance` — scheduler único de refresh por token expirando.

### Contracts to Create

- `createShopeeConnectHandler(deps?)` e `createShopeeCallbackHandler(deps?)` — factories injetáveis, como Tray/ML, para teste seguro do OAuth.
- `createShopeeClient(deps?)` — client Shopee com dependências injetáveis e API pública compatível (`buildAuthUrl`, `exchangeCode`, `refreshLocked`, `listOrders`, `orderDetail`, `orderFees`).
- `resolveShopeeConnectionForOrder(auth, orderId, deps?)` — retorna `{ order, connection }` apenas quando `marketplace='shopee'`, `marketplace_order_id` e `marketplace_account_id` apontam para uma conexão ativa daquele tenant.
- `normalizeShopeeOrder(detail, shopId)` — contrato de persistência: identificador, datas, status, valor total, itens em `normalizedData`, `marketplace='shopee'`, `marketplaceOrderId`, `marketplaceAccountId` e proveniência `shopee_sync`.
- `syncShopeeOrders(auth, options, request)` — run/checkpoint por `connection_id`, cursor Shopee, detalhes em lotes e upsert idempotente.

## Data Model and Migration Analysis

### Existing Model to Reuse

`001_initial.sql` e `002_orders_sync.sql` já fornecem o necessário para a primeira entrega sem DDL adicional:

| Entity | Required persisted fields | How Shopee uses it |
|---|---|---|
| `integration_connections` | `tenant_id`, `channel`, `external_account_id`, status, encrypted tokens, expiry, sync/error metadata | uma conexão ativa por loja, com `external_account_id = shop_id` |
| `orders` | `tenant_id`, `source_channel`, `source_order_id`, status, datas, total, payloads, campos marketplace/account | sync direto usa `source_channel='shopee'`, `source_order_id=order_sn`, `marketplace='shopee'`, `marketplace_order_id=order_sn`, `marketplace_account_id=shop_id`, `marketplace_account_source='shopee_sync'` |
| `sync_runs` | `connection_id`, resource, cursor/statísticas/erro | recurso `shopee.orders`, uma execução por loja |
| `sync_checkpoints` | tenant + connection + resource + cursor | cursor Shopee e última sincronização por loja |
| `fee_snapshots` | tenant + channel + external order id, componentes e versão | snapshot do escrow normalizado por `order_sn`; a conta é resolvida antes de chamar a API |

`012_meli_order_account.sql` não é ML-específica no schema: ela já adiciona a identificação de conta e o índice composto usados por Shopee. Não editar migrations aplicadas nem duplicar colunas em uma `013` apenas para alterar o nome. Antes de implementar, confirmar com `db/verify.js` que os campos e índices existem no banco alvo.

### Conditional Migration Decision

Não criar migration nesta funcionalidade enquanto o identificador de pedido Shopee for globalmente único e o contrato acima for aceito. Se a validação oficial Open Platform demonstrar que `order_sn` pode se repetir entre lojas, criar **antes do código** uma única migration definitiva `013_scope_shopee_orders_by_account.sql` que introduza uma chave/índice de origem por conta de forma compatível com a constraint atual, atualize os upserts e aplique RLS somente se houver nova tabela. Essa decisão depende da confirmação do contrato do parceiro; não inventar uma migration preventiva nem editar `001`, `002` ou `012`.

## Impact Analysis

### Files to Modify

- `business/volt-price/src/integrations/shopee.js` — extrair client injetável, corrigir URL/state OAuth, validar resposta, refresh/retry e obter detalhes completos para sync.
- `business/volt-price/src/routes/integrations.routes.js` — substituir handlers Shopee inline por factories e registrar connect/callback seguros.
- `business/volt-price/src/integrations/maintenance.js` — manter a seleção Shopee existente e tornar observável/retestável o status de refresh, se necessário.
- `business/volt-price/src/routes/orders.routes.js` — endpoints/status de sync Shopee, lookup de runs/checkpoints por conexão e vínculo manual com conta Shopee obrigatória.
- `business/volt-price/src/routes/finance.routes.js` — receber `orderId` interno no endpoint Shopee e resolver sua conta antes de consultar/cachear escrow.
- `business/volt-price/public/tray-connection.js` — evoluir a tela de integrações real (que sobrescreve `window.integrations`) para listar todas as lojas Shopee e suas ações individuais.
- `business/volt-price/public/app.js` — render de pedidos, botões de sync e taxa Shopee por pedido interno; remover o caminho que envia apenas `order_sn`.
- `business/volt-price/public/orders-reconciliation.js` — exigir/mostrar `shop_id` para vínculos Shopee, assim como ML exige conta, e mostrar status de sync por loja.
- `business/volt-price/.env.example`, `business/volt-price/README.md`, `render.yaml` — documentar/declaração das variáveis e callback exato.

### Files to Create

- `business/volt-price/src/orders/shopeeAccount.js` — resolução estrita de conexão Shopee a partir do pedido.
- `business/volt-price/src/orders/shopeeNormalization.js` — normalização de detalhes Shopee e janelas/cursor de sync, se não for claro manter junto em `normalization.js`.
- `business/volt-price/src/orders/shopeeSync.js` — orquestração de sync/persistência por loja.
- `business/volt-price/tests/shopee-oauth.test.js` — callback/connect, state/cookie e não vazamento.
- `business/volt-price/tests/shopee-account.test.js` — resolução da conta correta e rejeição de fallback.
- `business/volt-price/tests/shopee-sync.test.js` — paginação, cursor, upsert, checkpoint, idempotência e erros.
- `business/volt-price/tests/shopee-connection-ui.test.js` — UI multi-loja, ações por `connectionId`, sem segredos.
- `business/volt-price/tests/shopee-finance.test.js` — escrow somente para a conexão do pedido e persistência/caching seguros.

### Files to Delete / Replace

- Remover os handlers inline de `/shopee/connect` e `/shopee/callback` em `integrations.routes.js`; eles são substituídos pelas factories testáveis.
- Remover da UI qualquer seleção `firstConnection('shopee')`, `by[channel][0]` ou chamada de taxa Shopee baseada somente no ID externo.
- Não há arquivo inteiro a apagar.

### Dependencies and Breaking Changes

- Clientes que chamam `POST /orders/fees/shopee/:orderId` com um `order_sn` externo passarão a enviar o UUID interno do pedido, igual ao contrato ML. A UI deste módulo será atualizada na mesma entrega; documentar como mudança de API interna.
- `POST /orders/:id/link-marketplace` passa a exigir `marketplaceAccountId` também para `shopee`; vínculos antigos Shopee sem conta continuam visíveis, mas a consulta de taxas retorna `shopee_order_account_missing` até reconciliação manual.
- Adicionar sync Shopee não altera o sync Tray nem agenda sincronização automática; renovação de token e sincronização continuam responsabilidades separadas.

## Target Endpoints

| Method and route | Permission / protection | Contract |
|---|---|---|
| `GET /volt-price/api/integrations/` | authenticated + `integrations.read` | retorna todas as conexões Shopee, sem ciphertext/token, com status/lifecycle por loja |
| `POST /volt-price/api/integrations/shopee/connect` | auth, password-change guard, CSRF, `integrations.manage` | cria state opaco e cookie HttpOnly callback-only; responde apenas `{ authorizationUrl }` |
| `GET /volt-price/api/integrations/shopee/callback` | state + cookie, sem sessão de navegador | consome state uma vez, troca code, persiste `shop_id`, auditoria segura, redirect constante |
| `POST /volt-price/api/integrations/shopee/refresh` | auth, guard, CSRF, `integrations.manage` | recebe `connectionId`, refresca somente aquela loja |
| `POST /volt-price/api/integrations/shopee/disconnect` | auth, guard, CSRF, `integrations.manage` | recebe `connectionId`, revoga localmente somente aquela loja e limpa tokens |
| `POST /volt-price/api/orders/sync/shopee` | auth, guard, CSRF, `orders.sync` | requer `{ connectionId, from?, to?, pageSize? }`; sincroniza apenas a loja indicada |
| `GET /volt-price/api/orders/sync/status?channel=shopee&connectionId=...` | auth + `orders.read` | último `shopee.orders` run/checkpoint para aquela conexão; manter o status Tray atual compatível |
| `POST /volt-price/api/orders/:id/hydrate-shopee` | auth, guard, CSRF, `orders.sync` | opcional, atualiza detalhes do pedido pela conexão resolvida do próprio pedido |
| `POST /volt-price/api/orders/fees/shopee/:orderId` | auth, guard, CSRF, `fees.read` | `orderId` interno; resolve shop id, chama escrow e salva snapshot |
| `PATCH /volt-price/api/orders/:id/link-marketplace` | auth, guard, CSRF, `orders.sync` | para `shopee`, exige `externalOrderId` e `marketplaceAccountId=shop_id` válidos no tenant |

## Security Requirements

- Fixar `VOLT_PRICE_PUBLIC_BASE_URL` como origem canônica em produção; não confiar em `Host`, `X-Forwarded-Host` ou `redirect` provido pelo cliente para construir callback de OAuth. Usar `baseUrl(req)` somente como fallback local controlado.
- Colocar o state opaco no parâmetro `state` da URL de autorização **e** no cookie `vp_shopee_oauth_state`, com valor de comparação constante/igualdade segura antes de `consumeOAuthState`; cookie `HttpOnly`, `Secure` em produção, `SameSite=Lax`, path exato do callback, 15 minutos, limpo em sucesso e falha.
- Aceitar apenas callback com state/cookie correspondente, `code` e `shop_id` numérico positivo. Consumir state atomicamente uma única vez antes da troca e fazer redirect genérico `/volt-price/app/integrations?shopee=error` em qualquer falha.
- Nunca registrar `state`, authorization code, `partner_key`, tokens, ciphertext, assinatura, URL completa do provedor ou raw payload em frontend, logs, audit ou `last_error`. Diagnóstico interno deve conter somente stage, erro permitido/código upstream e request id.
- Manter HMAC SHA-256 com a string-base oficial do endpoint e usar `partner_id`/`shop_id` numéricos. Não expor Partner ID/Key além do ambiente Render.
- Refresh: bloquear a linha `FOR UPDATE`, usar o refresh token atual, persistir ambos tokens cifrados da resposta, atualizar expiries, retentar uma chamada autenticada por erro de token no máximo uma vez e marcar `last_error` seguro em falha. Refresh token ausente/expirado deve resultar em `reauthorization_required`, não em fallback para outra loja.
- Toda query de pedidos/snapshots/runs/checkpoints deve executar em `withTenant`; upsert sempre inclui `tenant_id`; payloads Shopee passam por `redactForStorage`.

## Implementation Steps

### Step 1: Establish baseline and confirm the official Open Platform contract

**Files**: `business/volt-price/README.md`, `business/volt-price/.env.example`, existing `src/config.js`, `src/integrations/shopee.js`

**Action**: Before changing behavior, verify in the authenticated Shopee Open Platform partner console for the production app/region: authorization URL/path, registered callback, token/refresh paths, base string order for each signature, OAuth callback parameters, allowed `response_optional_fields`, `get_order_list` date/cursor/page limits, `get_order_detail` batch limit, escrow eligibility/latency and refresh-token lifetime/rotation. Record only non-secret configuration decisions in README.

**Why**: The current code deliberately keeps V2 paths configurable because public docs were inaccessible during prior validation; a complete plan must not assume a path/region/permission.

**Details**:

- Confirm that `shop_id` from callback is the stable external account identifier and whether `order_sn` is globally unique; use this result to finalize the migration decision above.
- Enable only scopes/permissions necessary for authorization, order list/detail and escrow. Enable webhook/push only if it is explicitly added in a future scoped change; this plan performs pull sync.
- Verify exact callback: `${VOLT_PRICE_PUBLIC_BASE_URL}/volt-price/api/integrations/shopee/callback`, HTTPS, with the public Render hostname—not a preview/local URL.

### Step 2: Write failing secure OAuth and client-contract tests

**Files**: create `tests/shopee-oauth.test.js`; modify `tests/config.test.js` if present

**Action**: Test handlers through dependency injection rather than real network/database.

**Details**:

- Connect creates DB state with `{ intendedConnection: 'new' }`, sets the scoped opaque cookie and returns a provider authorization URL containing `state`; response must not include state/token/code/partner key.
- Callback success requires matching cookie + query state, consumes exactly once, validates numeric `shop_id`, exchanges code, upserts `channel:'shopee'` with `externalAccountId:String(shop_id)`, all expiry timestamps and safe metadata `{ partner_id, shop_id }`, audits only `shop_id`, clears cookie and redirects to `?connected=shopee`.
- Replaying callback, missing/mismatched cookie/state, missing code/shop id, malformed response and provider error redirect to constant `?shopee=error`, clear cookie and never exchange/persist secret data.
- Test auth URL contains the canonical callback and state; test signing/exchange/refresh with injected clock/fetch. Prove a token failure causes exactly one locked refresh and one retry, and that concurrent refreshes target a row lock.
- Run the new test first and capture that it fails because factories/client seam do not exist.

### Step 3: Replace inline Shopee OAuth with safe, testable factories

**Files**: modify `src/integrations/shopee.js`, `src/routes/integrations.routes.js`

**Action**: Implement `createShopeeClient(deps?)`, then `createShopeeConnectHandler` and `createShopeeCallbackHandler`; register factories on existing routes while preserving all middleware on connect.

**Details**:

- `buildAuthUrl(req, state)` must use canonical callback and append opaque state according to verified provider contract; retain deterministic HMAC construction per Open Platform docs.
- Callback first validates cookie/query equality, then atomically consumes `consumeOAuthState(query.state,'shopee')`; never use a cookie as the only DB state identifier.
- Validate `access_token`, `refresh_token`, `shop_id`, expiration values and provider success before `upsertConnection`; connection uniqueness lets reauthorization update the same shop rather than creating a duplicate.
- Upsert under `withTenant(oauth.tenant_id, oauth.user_id, ...)`, preserve display name if one exists or format `Shopee <shop_id>`, set encrypted tokens/expiry/last refresh, and audit safe values.
- Export factories and `shopeeStateCookieOptions` only for node tests. Do not change external module functions used by finance/maintenance.

### Step 4: Complete lifecycle/refresh behavior without changing sync scheduling

**Files**: modify `src/integrations/shopee.js`, `src/integrations/maintenance.js`, `src/integrations/tokenStore.js` only if status mapping needs a dedicated safe code; extend `tests/shopee-oauth.test.js`

**Action**: Align Shopee refresh with ML multi-account guarantees.

**Details**:

- `validConnection(auth, connectionId)` always resolves the supplied active connection; no caller without a resolved account may reach it for per-order operations.
- `refreshLocked` locks that specific connection in the tenant transaction and replaces rotating refresh token atomically. On revoked/expired refresh, preserve a bounded redacted error that lets `connectionStatus` show reauthorization required.
- Retain maintenance selection of all active connections expiring in 45 minutes. Add tests proving each eligible Shopee store is refreshed separately and no order-sync job is triggered by maintenance.
- Manual `POST /integrations/shopee/refresh` and disconnect must carry `connectionId`, audit that ID/shop id safely and never affect sibling shops.

### Step 5: Add strict Shopee account resolution and direct-order normalization

**Files**: create `src/orders/shopeeAccount.js`, `src/orders/shopeeNormalization.js`; modify `src/orders/normalization.js` only if shared helpers improve reuse; create `tests/shopee-account.test.js`

**Action**: Mirror `resolveMeliConnectionForOrder` for Shopee and define one authoritative order mapping.

**Details**:

- Resolver fetches an internal `orders.id` under `withTenant`; it accepts only a Shopee marketplace order with external id and non-empty `marketplace_account_id`.
- Lookup with `getConnectionByExternalAccount(auth,'shopee',shopId)`, require returned `external_account_id === shopId` and active/non-disconnected status. Throw `shopee_order_not_linked`, `shopee_order_account_missing` or `shopee_order_account_not_connected` (409) as applicable.
- Normalizer converts detail response into safe `orders` fields. Keep monetary values numeric/nullable, normalize create/update timestamps, source/status/order sn and item list, set `marketplaceAccountSource:'shopee_sync'`, and preserve the raw response only after `redactForStorage` at persistence.
- Test a request for shop A never reads shop B, a missing shop id never picks the newest connection and a disconnected/foreign connection is rejected.

### Step 6: Implement idempotent per-store Shopee order synchronization

**Files**: create `src/orders/shopeeSync.js`, modify `src/routes/orders.routes.js`; create `tests/shopee-sync.test.js`

**Action**: Implement a pull sync modeled after `traySync`, with `RESOURCE='shopee.orders'` and mandatory `connectionId`.

**Details**:

- Validate optional ISO dates, enforce documented maximum historical window/page size and select the connection by ID before starting a run. First run uses bounded history; incremental run uses a small overlap based on the previous successful checkpoint. Record filters/mode.
- Call `shopee.listOrders` using the resolved connection, page through provider cursor/`more`, guard against loops/repeated cursors and only then call `orderDetail` in documented batches using the **same** connection id.
- Persist each normalized order with `tenant_id`, source `shopee`, external account id, raw/redacted and normalized data. Use the existing `(tenant_id, source_channel, source_order_id)` conflict contract; preserve manual reconciliation fields exactly as Tray sync does.
- Update run counters after each durable page; only write checkpoint/cursor after all pages complete. On failure mark `sync_runs` failed, update only that connection's safe `last_error`, retain old checkpoint and audit success without raw provider data.
- Add routes for sync/status and optional hydrate; do not schedule this job from token maintenance. Ensure existing Tray status remains selectable/backward compatible.
- Tests cover two connections with isolated cursors, no duplicate order after replay/overlap, pagination loop guard, detail batching, redaction, checkpoint only on success, conflict for simultaneous run of same connection/resource, and no cross-tenant write.

### Step 7: Make escrow/tax snapshots account-correct and Profit-compatible

**Files**: modify `src/routes/finance.routes.js`, `src/integrations/shopee.js`, `src/finance/service.js` only if cache lookup needs explicit account context; create `tests/shopee-finance.test.js`

**Action**: Change the Shopee fee route to resolve the internal order and its connection before API access, as ML already does.

**Details**:

- For `POST /orders/fees/shopee/:orderId`, resolve `{order,connection}`; use `order.marketplace_order_id` as `order_sn` and `connection.id` for `shopee.orderFees`.
- Cache and snapshot exact escrow response with existing `normalizeEscrow`/`normalizeFeeResult`; retain commission, service, seller transaction, vouchers/coins, actual shipping, Shopee rebate and escrow amount. Do not calculate a fee from a manual commission reference.
- Use a conservative escrow cache duration and permit authorized `force`; cache does not bypass connection resolution. Confirm current snapshot keys are safe after the Open Platform uniqueness decision; implement the conditional migration if and only if that decision requires account-scoped fee snapshot keys.
- Profit uses the latest snapshot already associated by marketplace/order. Test the selected request uses Shop A even if Shop B is newest, fails closed for missing account, persists redacted/raw snapshot, and produces expected normalized components/net shipping.

### Step 8: Upgrade the integrations and orders UI for Shopee multi-loja

**Files**: modify `public/tray-connection.js`, `public/app.js`, `public/orders-reconciliation.js`, and styles only when needed; create `tests/shopee-connection-ui.test.js`

**Action**: Change the real integrations renderer (`tray-connection.js`, loaded after `app.js`) so Shopee is rendered like ML: one card per connection plus an explicit **Adicionar loja Shopee** action.

**Details**:

- Render every Shopee connection with safe display name/shop id, `connection_status`, token/refresh expiry, last refresh/sync and bounded safe error. Give refresh/disconnect/data-sync buttons the individual `data-connection-id`.
- Consume `connected=shopee` / `shopee=error` redirects with generic Portuguese toast then remove query parameters. Never include provider input in a toast.
- Add a store selector to the order sync area populated from `GET /integrations/`; sync button is disabled with an explanatory state if no Shopee store exists. Pass only selected internal `connectionId` to `POST /orders/sync/shopee`.
- Show `Shopee / loja <shop_id>` in order/reconciliation rows. Manual binding prompt/form must require the Shop ID and validate it against current tenant Shopee connections before enabling it. Existing Shopee links without shop ID should show `conta não identificada` and a repair action, not a fee button.
- Replace `data-fee-shopee="<external id>"` with the internal order id and call the new account-resolving fee endpoint. Do not ask user for a connection ID to consult escrow.
- Tests assert all connections are iterated, connectionId is sent for refresh/disconnect/sync, explicit add-store affordance exists, UI never references token/cipher/partner key, and no `firstConnection('shopee')` remains.

### Step 9: Document and configure production deployment

**Files**: modify `.env.example`, `README.md`, root `render.yaml`; potentially modify `tests/config.test.js` and `tests/shopee-connection-ui.test.js`

**Action**: Make operator setup explicit and secret-safe.

**Details**:

- Keep `VOLT_PRICE_SHOPEE_PARTNER_ID`, `VOLT_PRICE_SHOPEE_PARTNER_KEY`, `VOLT_PRICE_SHOPEE_API_BASE` and all verified V2 path variables in `.env.example`, with no example secret. Add a safe comment for the exact callback and region/path confirmation.
- Add `VOLT_PRICE_TOKEN_MAINTENANCE=true` and interval guidance to Render if the deployment currently relies on default only; preserve the 15-minute minimum. Add all required Shopee vars to the `volt-corp` Render service as `sync:false` so they are configured exclusively in Render.
- README deployment checklist: direct Neon URL for migrations vs pooled runtime, encryption key, exact registered callback, app permissions, refresh lifecycle, multi-store operational flow, disconnect/reauthorize recovery, manual sync behavior and no-secrets policy.
- Confirm Render web service remains publicly HTTPS, `/volt-price/health` succeeds, pre-deploy executes `npm run migrate:all`, and the root `buildFilter` includes `business/**` through the service rooted at `business`.

### Step 10: Verify end to end and review migration decision

**Files**: all above; conditional `db/013_scope_shopee_orders_by_account.sql` only if Step 1 proves necessary

**Action**: Execute automated, static, database and non-production provider QA before production enablement.

**Details**:

- Run `npm --prefix business run test:volt-price`, then `node --check` for changed browser/server JS and `git diff --check`.
- With direct DB URL, run `npm --prefix business run migrate:volt-price` and `node business/volt-price/db/verify.js`; confirm existing generic account fields/indexes or, only if created, the new migration checksum/schema/RLS.
- In a Shopee test app with two shops in the same tenant: authorize A and B; inspect API/UI that no token appears; sync distinct windows; verify independent run/checkpoint/status; fetch escrow from an order of each shop; ensure a missing/disconnected account fails closed; refresh A and verify B is unchanged; disconnect A and verify B remains usable.
- Verify OAuth negative paths: denied consent, missing/replayed/mismatched state, stale cookie, invalid shop id, expired/revoked refresh and upstream token error. All must have generic redirects/UX and redacted persistence/logs.
- Inspect order rows/fee snapshots/profit after syncing: `tenant_id`, `marketplace_account_id`, source/marketplace ids and fee components agree; manual mappings are not overwritten by sync.

## REMOVAL SPECIFICATION

### Code to Remove

#### From `business/volt-price/src/routes/integrations.routes.js`

- Inline anonymous handlers currently registered for `/shopee/connect` and `/shopee/callback`.
  - **Why removing**: they are not independently testable, use cookie-only state consumption, and have non-generic callback failure behavior.
  - **Replacement**: Step 3 factories and their default route registration.
  - **Dependencies**: existing connect/callback paths remain unchanged; browser UI continues using them.

#### From `business/volt-price/public/tray-connection.js`

- The single-Shop Shopee render path based on `firstConnection(channel)` / `['tray','shopee']`.
  - **Why removing**: it hides additional shops and risks actioning the wrong account.
  - **Replacement**: Step 8 per-connection Shopee rendering.

#### From `business/volt-price/public/app.js` and `public/orders-reconciliation.js`

- Any fee call or manual Shopee link that accepts only `order_sn` and no persisted shop identity.
  - **Why removing**: account selection must derive from the tenant-owned order, not UI default state.
  - **Replacement**: Steps 5, 7 and 8 strict resolver plus order UUID fee call.

### Removal Checklist

- [ ] No inline Shopee OAuth handler remains.
- [ ] No `firstConnection('shopee')`, `[0]` Shopee default, or fee route caller using only external `order_sn` remains.
- [ ] No fallback from missing `marketplace_account_id` to a latest/default Shopee connection remains.
- [ ] No state/code/token/partner key appears in redirect, audit, UI, API list, test fixture output or provider error record.
- [ ] No changes to already-applied migrations.

**Verification**: run `rg -n "firstConnection\(.*shopee|shopee.*\[0\]|data-fee-shopee=.*marketplace_order_id|vp_shopee_oauth_state.*consumeOAuthState" business/volt-price` and manually review intentional secure occurrences before handoff.

## Anti-Patterns to Avoid

- Do not use a tenant-wide/default/latest Shopee connection for a linked order.
- Do not put Partner Key, tokens, callback code, raw state or raw provider error into browser state, URL, logs or audit metadata.
- Do not accept arbitrary callback/redirect hosts; the registered callback is canonical.
- Do not refresh outside a row lock, retain a stale rotating refresh token, or retry indefinitely.
- Do not run Shopee order synchronization automatically as a side effect of token maintenance.
- Do not overwrite manual order reconciliation during a direct Shopee sync.
- Do not edit applied migrations or create a duplicate account-id migration when `012` already supplies the generic model.
- Do not retain compatibility code that silently permits Shopee links without an account for financial operations; require repair/reconciliation.

## Validation Criteria

### Pre-Implementation Checklist

- [x] Existing Shopee, OAuth, finance, maintenance, Tray sync and ML multi-account patterns audited.
- [x] Relevant `CLAUDE.md` search completed (none found).
- [x] Existing generic account migration and migration runner audited.
- [x] Real integration UI override (`tray-connection.js`) identified.
- [ ] Open Platform authenticated-console contract and `order_sn` uniqueness confirmed.
- [ ] Conditional migration decision recorded before implementation.

### Post-Implementation Checklist

- [ ] Two Shopee shops can coexist under one tenant; each can be refresh/disconnected independently.
- [ ] OAuth state is carried/validated safely, single use, expiring, and failure redirects are generic and same-origin.
- [ ] Tokens are encrypted, not disclosed, auto-refresh before expiry with row lock, and surface reauthorization status safely.
- [ ] Sync persists redacted Shopee orders idempotently, with per-shop account id/run/checkpoint and no cross-tenant data.
- [ ] Escrow/taxes for an internal order always select its persisted shop connection and fail closed if absent/disconnected.
- [ ] Fee snapshots remain compatible with Profit and account scope is confirmed by Open Platform contract or conditional migration.
- [ ] UI lists all Shopee shops, displays safe lifecycle data, passes exact connection IDs and provides no secret fields.
- [ ] `npm --prefix business run test:volt-price` passes.
- [ ] `npm --prefix business run migrate:volt-price` and VoltPrice verification pass against non-production direct DB.
- [ ] Browser/server syntax checks and `git diff --check` pass.
- [ ] Non-production two-shop OAuth/sync/escrow/refresh/disconnect QA passes.

## Final Audit Recommendation

The only material unknown is Open Platform’s app-specific production contract (region/path/permissions and whether `order_sn` is globally unique). Resolve it in the authenticated partner console before Step 3; it governs callback registration, configured paths and whether a real schema migration is required. All other work follows proven VoltPrice patterns and can proceed once that decision is recorded.
