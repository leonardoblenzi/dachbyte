# VoltPrice Mercado Livre Multi-Conta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir múltiplas contas Mercado Livre por empresa e usar, com segurança, a conta indicada em cada pedido importado da Tray.

**Architecture:** A coluna de conta do marketplace passa a ser persistida no pedido junto à origem da associação. O callback OAuth do ML cria/atualiza uma conexão por `user_id`, e a consulta financeira resolve a conexão pelo pedido interno, nunca por uma escolha implícita. A interface lista cada conexão ML e informa o canal Tray mesmo sem integração ativa.

**Tech Stack:** Node.js 20, Express 5, PostgreSQL/Neon, SQL migrations sem Prisma, OAuth 2.0 Authorization Code + PKCE, JavaScript estático e `node:test`.

## Global Constraints

- Trabalhar na branch `voltdev`; não alterar módulos fora de `business/volt-price` e da documentação desta funcionalidade.
- Não aceitar, exibir, registrar em auditoria ou devolver access token, refresh token, código OAuth, client secret ou senha do Mercado Livre.
- Preservar RLS, `authenticate`, `requirePasswordChangeComplete`, CSRF e permissões existentes em todas as rotas mutáveis.
- A conta ML é identificada pelo `user_id` retornado pelo OAuth e armazenada como `external_account_id` da conexão.
- Não existe conta ML padrão: pedido sem conta identificada não pode fazer consulta remota de taxas.
- Usar `DB_VOLTPRICE_DIRECT`/`VOLT_PRICE_DIRECT_DATABASE_URL` somente pelo migrador existente; não introduzir Prisma.
- Usar os valores de ambiente já suportados: `VOLT_PRICE_MELI_CLIENT_ID`, `VOLT_PRICE_MELI_CLIENT_SECRET` e `VOLT_PRICE_PUBLIC_BASE_URL`.

---

## File Structure

- `business/volt-price/db/012_meli_order_account.sql`: adiciona identificador/origem da conta do marketplace e índice de busca por tenant/canal/conta.
- `business/volt-price/src/orders/normalization.js`: extrai canal, pedido externo e conta seller de payloads Tray conhecidos sem inferir conta quando ausente.
- `business/volt-price/src/orders/meliAccount.js`: resolve uma conta ML persistida no pedido para uma conexão do tenant.
- `business/volt-price/src/orders/traySync.js`: persiste e atualiza a conta extraída, preservando vínculos manuais.
- `business/volt-price/src/routes/orders.routes.js`: expõe a conta no pedido e permite vínculo manual explícito de conta ML válida.
- `business/volt-price/src/integrations/mercadoLivre.js`: disponibiliza consulta de perfil por token recém-autorizado e mantém refresh atômico por conexão.
- `business/volt-price/src/routes/integrations.routes.js`: encapsula callback ML seguro e testável, com redirecionamento constante em erro.
- `business/volt-price/src/routes/finance.routes.js`: resolve a conexão ML pelo pedido VoltPrice antes de chamar a API externa.
- `business/volt-price/public/tray-connection.js`: lista cada conta Mercado Livre e permite adicionar uma conta sem substituir as demais.
- `business/volt-price/public/app.js` e `business/volt-price/public/orders-reconciliation.js`: exibem rótulos de canal/conta e orientam quando a ação remota está bloqueada.
- `business/volt-price/tests/orders.test.js`, `business/volt-price/tests/meli-oauth.test.js`, `business/volt-price/tests/meli-account.test.js` e `business/volt-price/tests/meli-multiconta-ui.test.js`: contratos de normalização, OAuth, resolução e interface.
- `business/volt-price/.env.example` e `business/volt-price/README.md`: configuração e callback de staging.

### Task 1: Persistir e normalizar a conta de marketplace do pedido Tray

**Files:**
- Create: `business/volt-price/db/012_meli_order_account.sql`
- Modify: `business/volt-price/src/orders/normalization.js`
- Modify: `business/volt-price/src/orders/traySync.js`
- Modify: `business/volt-price/src/routes/orders.routes.js`
- Modify: `business/volt-price/tests/orders.test.js`

**Interfaces:**
- Consumes: `normalizeTrayOrder(wrapper)` e a tabela `volt_price.orders`.
- Produces: `normalizeTrayOrder(wrapper).marketplaceAccountId` e `.marketplaceAccountSource`; a API de pedidos retorna `marketplace_account_id` e `marketplace_account_source`.

- [ ] **Step 1: Escrever os testes vermelhos de normalização**

```js
test("pedido Tray ML preserva seller explícito", () => {
  const result = normalizeTrayOrder({ Order: {
    id: "42", MarketplaceOrder: [{ marketplace: "Mercado Livre", platform_order_id: "2001", seller_id: "987" }],
  } });
  assert.equal(result.marketplace, "meli");
  assert.equal(result.marketplaceAccountId, "987");
  assert.equal(result.marketplaceAccountSource, "tray_explicit");
});

test("pedido ML sem seller não recebe conta padrão", () => {
  const result = normalizeTrayOrder({ Order: { id: "43", MlOrder: [{ order_id: "2002" }] } });
  assert.equal(result.marketplace, "meli");
  assert.equal(result.marketplaceAccountId, null);
  assert.equal(result.marketplaceAccountSource, null);
});
```

- [ ] **Step 2: Rodar o teste para confirmar a falha**

Run: `node --test business/volt-price/tests/orders.test.js`

Expected: FAIL porque `marketplaceAccountId` e `marketplaceAccountSource` ainda não existem.

- [ ] **Step 3: Criar migração idempotente**

```sql
ALTER TABLE volt_price.orders
  ADD COLUMN IF NOT EXISTS marketplace_account_id text,
  ADD COLUMN IF NOT EXISTS marketplace_account_source text;

CREATE INDEX IF NOT EXISTS idx_vp_orders_marketplace_account
  ON volt_price.orders(tenant_id, marketplace, marketplace_account_id)
  WHERE marketplace_account_id IS NOT NULL;
```

O `INSERT ... ON CONFLICT` em `traySync.persistPage` e o `hydrate-tray` devem preencher esses campos somente quando `match_reason <> 'manual'`; vínculo manual preserva a conta e marca `marketplace_account_source='manual'`.

- [ ] **Step 4: Implementar extração explícita e as projeções da API**

```js
function marketplaceAccountId(order, marketplaceOrder, mlOrder) {
  return text(
    marketplaceOrder?.seller_id || marketplaceOrder?.sellerId || marketplaceOrder?.user_id ||
    mlOrder?.seller_id || mlOrder?.sellerId || mlOrder?.user_id ||
    order.marketplace_seller_id || order.marketplace_user_id,
  );
}
```

Retorne `null` quando nenhum campo explícito existir. Inclua as duas novas colunas nos `SELECT` de lista, detalhe e não conciliados; amplie `PATCH /:id/link-marketplace` para aceitar `marketplaceAccountId` opcional, validar texto de até 100 caracteres e gravar a origem manual quando fornecido.

- [ ] **Step 5: Rodar os testes focados e a migração de teste**

Run: `node --test business/volt-price/tests/orders.test.js business/volt-price/tests/migration-runner.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add business/volt-price/db/012_meli_order_account.sql business/volt-price/src/orders/normalization.js business/volt-price/src/orders/traySync.js business/volt-price/src/routes/orders.routes.js business/volt-price/tests/orders.test.js
git commit -m "feat(volt-price): persist Tray marketplace account"
```

### Task 2: Tornar o OAuth Mercado Livre seguro e multi-conta

**Files:**
- Modify: `business/volt-price/src/integrations/mercadoLivre.js`
- Modify: `business/volt-price/src/routes/integrations.routes.js`
- Create: `business/volt-price/tests/meli-oauth.test.js`

**Interfaces:**
- Consumes: `createOAuthState(auth, "meli", { verifier })`, `consumeOAuthState(state, "meli")`, `upsertConnection` e `withTenant`.
- Produces: `createMeliConnectHandler(dependencies)` e `createMeliCallbackHandler(dependencies)`, usados pelas rotas `POST /meli/connect` e `GET /meli/callback`.

- [ ] **Step 1: Escrever os contratos vermelhos do callback**

```js
test("callback ML persiste uma conexão por user_id e redireciona sem tokens", async () => {
  const stored = [];
  const handler = createMeliCallbackHandler({
    consumeOAuthState: async () => ({ tenant_id: "t-1", user_id: "u-1", payload: { verifier: "v" } }),
    exchangeCode: async () => ({ access_token: "secret-a", refresh_token: "secret-r", user_id: 987, expires_in: 21600 }),
    withTenant: async (_tenant, _user, work) => work({}),
    upsertConnection: async (_db, _tenant, channel, value) => stored.push({ channel, value }),
    audit: async () => {},
  });
  const { res } = await invoke(handler, request({ query: { state: "opaque", code: "provider-code" } }));
  assert.equal(res.redirectedTo, "/volt-price/app/integrations?connected=meli");
  assert.equal(stored[0].value.externalAccountId, "987");
  assert.doesNotMatch(JSON.stringify({ res, stored: [] }), /secret-a|secret-r|provider-code/);
});

test("callback ML inválido redireciona para erro genérico", async () => {
  const { res } = await invoke(createMeliCallbackHandler({ consumeOAuthState: async () => null }), request());
  assert.equal(res.redirectedTo, "/volt-price/app/integrations?meli=error");
});
```

- [ ] **Step 2: Rodar o teste para confirmar a falha**

Run: `node --test business/volt-price/tests/meli-oauth.test.js`

Expected: FAIL porque os factories de handler ML ainda não existem.

- [ ] **Step 3: Implementar os factories e substituir as rotas inline**

```js
function createMeliCallbackHandler({ consumeOAuthState: consumeState = consumeOAuthState, exchangeCode = meli.exchangeCode, withTenant: withTenantFn = withTenant, upsertConnection: upsert = upsertConnection, audit: auditFn = audit } = {}) {
  return async (req, res) => {
    try {
      const oauth = await consumeState(String(req.query.state || ""), "meli");
      if (!oauth || !req.query.code) throw new Error("invalid meli oauth callback");
      const data = await exchangeCode(req, String(req.query.code), oauth.payload?.verifier);
      if (!data.access_token || !data.refresh_token || !data.user_id) throw new Error("incomplete meli oauth response");
      await withTenantFn(oauth.tenant_id, oauth.user_id, async (client) => {
        await upsert(client, oauth.tenant_id, "meli", {
          status: "active", displayName: `Mercado Livre ${data.user_id}`,
          externalAccountId: String(data.user_id), apiBaseUrl: config.meli.apiBase,
          accessToken: data.access_token, refreshToken: data.refresh_token,
          tokenExpiresAt: new Date(Date.now() + Number(data.expires_in || 21600) * 1000),
          metadata: { scope: data.scope || null, token_type: data.token_type || null }, lastRefreshAt: new Date(),
        });
        await auditFn(client, { tenantId: oauth.tenant_id, actorUserId: oauth.user_id, action: "integration.connect", resourceType: "integration", resourceId: `meli:${data.user_id}`, metadata: { user_id: data.user_id } });
      });
      res.redirect("/volt-price/app/integrations?connected=meli");
    } catch (_) { res.redirect("/volt-price/app/integrations?meli=error"); }
  };
}
```

`upsertConnection` já usa a chave `(tenant_id, channel, external_account_id)`, portanto não alterar sua semântica. Manter o refresh travado por conexão e persistir sempre o refresh token retornado pelo ML.

- [ ] **Step 4: Rodar contratos OAuth e sintaxe**

Run: `node --test business/volt-price/tests/meli-oauth.test.js business/volt-price/tests/tray-oauth.test.js; node --check business/volt-price/src/routes/integrations.routes.js; node --check business/volt-price/src/integrations/mercadoLivre.js`

Expected: PASS; callbacks Tray continuam com comportamento inalterado.

- [ ] **Step 5: Commit**

```bash
git add business/volt-price/src/integrations/mercadoLivre.js business/volt-price/src/routes/integrations.routes.js business/volt-price/tests/meli-oauth.test.js
git commit -m "feat(volt-price): secure Mercado Livre multi-account OAuth"
```

### Task 3: Impedir consulta ML com conexão errada

**Files:**
- Create: `business/volt-price/src/orders/meliAccount.js`
- Modify: `business/volt-price/src/routes/finance.routes.js`
- Create: `business/volt-price/tests/meli-account.test.js`

**Interfaces:**
- Consumes: `auth`, `orderId`, `withTenant`, `getConnection`.
- Produces: `resolveMeliConnectionForOrder(auth, orderId, dependencies)` que retorna `{ order, connection }` ou lança erros `meli_order_account_missing`/`meli_order_account_not_connected` com status 409.

- [ ] **Step 1: Escrever os testes vermelhos de resolução**

```js
test("resolve somente a conexão da conta persistida no pedido", async () => {
  const result = await resolveMeliConnectionForOrder(auth, "order-1", {
    withTenant: async (_t, _u, work) => work({ query: async () => ({ rows: [{ id: "order-1", marketplace: "meli", marketplace_order_id: "ML-9", marketplace_account_id: "987" }] }) }),
    getConnection: async (_auth, channel, accountId) => ({ id: "connection-987", channel, external_account_id: accountId }),
  });
  assert.equal(result.connection.id, "connection-987");
});

test("pedido ML sem conta não seleciona conexão padrão", async () => {
  await assert.rejects(() => resolveMeliConnectionForOrder(auth, "order-2", missingAccountDeps), { code: "meli_order_account_missing", statusCode: 409 });
});
```

- [ ] **Step 2: Rodar o teste para confirmar a falha**

Run: `node --test business/volt-price/tests/meli-account.test.js`

Expected: FAIL porque o resolvedor não existe.

- [ ] **Step 3: Implementar o resolvedor isolado e conectar a rota financeira**

```js
async function resolveMeliConnectionForOrder(auth, orderId, { withTenantFn = withTenant, getConnectionFn = getConnection } = {}) {
  const order = await withTenantFn(auth.tenantId, auth.userId, async (client) => (
    await client.query("SELECT id,marketplace,marketplace_order_id,marketplace_account_id FROM volt_price.orders WHERE id=$1", [orderId])
  ).rows[0]);
  if (!order || order.marketplace !== "meli" || !order.marketplace_order_id) throw Object.assign(new Error("Pedido Mercado Livre não vinculado."), { statusCode: 409, code: "meli_order_not_linked" });
  if (!order.marketplace_account_id) throw Object.assign(new Error("Conta Mercado Livre do pedido não identificada."), { statusCode: 409, code: "meli_order_account_missing" });
  const connection = await getConnectionFn(auth, "meli", order.marketplace_account_id);
  if (!connection || String(connection.external_account_id) !== order.marketplace_account_id) throw Object.assign(new Error("Conecte a conta Mercado Livre indicada no pedido."), { statusCode: 409, code: "meli_order_account_not_connected" });
  return { order, connection };
}
```

Altere somente `POST /orders/fees/meli/:orderId`: interprete `:orderId` como ID interno VoltPrice, obtenha o resolvedor e chame `meli.orderFees(auth, order.marketplace_order_id, connection.id)`. Shopee permanece sem alteração. Preserve cache usando o ID externo ML.

- [ ] **Step 4: Rodar testes de domínio e regressão de rotas**

Run: `node --test business/volt-price/tests/meli-account.test.js business/volt-price/tests/finance.test.js business/volt-price/tests/regressions.test.js`

Expected: PASS; não há endpoint de fees duplicado no router de pedidos.

- [ ] **Step 5: Commit**

```bash
git add business/volt-price/src/orders/meliAccount.js business/volt-price/src/routes/finance.routes.js business/volt-price/tests/meli-account.test.js
git commit -m "feat(volt-price): resolve Mercado Livre fee account by order"
```

### Task 4: Exibir canais e contas no fluxo operacional

**Files:**
- Modify: `business/volt-price/public/tray-connection.js`
- Modify: `business/volt-price/public/app.js`
- Modify: `business/volt-price/public/orders-reconciliation.js`
- Create: `business/volt-price/tests/meli-multiconta-ui.test.js`

**Interfaces:**
- Consumes: `GET /integrations/` com lista de conexões e `GET /orders/` com campos de conta.
- Produces: uma linha de integração por conta ML, `POST /integrations/meli/connect` para adicionar conta e `POST /orders/fees/meli/:voltPriceOrderId` apenas para pedidos elegíveis.

- [ ] **Step 1: Escrever o contrato vermelho da interface**

```js
test("Integrações lista cada conta ML e permite adicionar outra", () => {
  assert.match(source, /connections\.filter\(connection=>connection\.channel==="meli"\)/);
  assert.match(source, /Adicionar conta Mercado Livre/);
  assert.match(source, /data-refresh="meli"/);
});

test("Pedidos mostram canal legível e bloqueiam taxa ML sem conexão correspondente", () => {
  assert.match(appSource, /Mercado Livre/);
  assert.match(appSource, /conta não identificada|conta nao identificada/);
  assert.match(appSource, /data-fee-meli="\$\{o\.id\}"/);
  assert.doesNotMatch(appSource, /fee\("meli",b\.dataset\.feeMeli\)/);
});
```

- [ ] **Step 2: Rodar o teste para confirmar a falha**

Run: `node --test business/volt-price/tests/meli-multiconta-ui.test.js`

Expected: FAIL porque a tela atual reduz conexões por canal e envia o ID externo diretamente.

- [ ] **Step 3: Implementar lista multi-conta e estado de pedido**

```js
const meliConnections = connections.filter((connection) => connection.channel === "meli");
meliConnections.forEach((connection) => list.insertAdjacentHTML("beforeend", connectionRow("meli", connection)));

const account = order.marketplace_account_id
  ? ` · conta ${order.marketplace_account_id}`
  : " · conta não identificada";
```

Mantenha Tray e Shopee como uma linha por conexão existente. Para ML, mostre todas as contas e use `connection.id` em `data-refresh`/`data-disconnect`; o botão **Adicionar conta Mercado Livre** sempre inicia novo OAuth. Na tabela, transformar `meli` em `Mercado Livre`, usar o ID interno `o.id` no botão de taxas e só renderizá-lo quando o pedido possui conta; caso contrário, renderizar texto orientando vinculação. Ajustar o diálogo de vínculo manual para solicitar `marketplaceAccountId` em pedidos ML.

- [ ] **Step 4: Rodar contratos de UI e verificação de sintaxe**

Run: `node --test business/volt-price/tests/meli-multiconta-ui.test.js business/volt-price/tests/tray-connection-ui.test.js business/volt-price/tests/prototype-operations-ui.test.js; node --check business/volt-price/public/app.js; node --check business/volt-price/public/tray-connection.js; node --check business/volt-price/public/orders-reconciliation.js`

Expected: PASS; o fluxo Tray continua disponível e os scripts são válidos.

- [ ] **Step 5: Commit**

```bash
git add business/volt-price/public/tray-connection.js business/volt-price/public/app.js business/volt-price/public/orders-reconciliation.js business/volt-price/tests/meli-multiconta-ui.test.js
git commit -m "feat(volt-price): show Tray marketplace and Mercado Livre accounts"
```

### Task 5: Documentar, migrar e validar o fluxo completo

**Files:**
- Modify: `business/volt-price/.env.example`
- Modify: `business/volt-price/README.md`
- Modify: `business/volt-price/tests/config.test.js`

**Interfaces:**
- Consumes: configuração em `src/config.js` e redirect `/volt-price/api/integrations/meli/callback`.
- Produces: instruções reproduzíveis para cadastro do app ML e ambiente Render.

- [ ] **Step 1: Escrever o teste vermelho de documentação/configuração**

```js
test("configuração Mercado Livre informa credenciais e callback exato", () => {
  assert.match(envExample, /^VOLT_PRICE_MELI_CLIENT_ID=/m);
  assert.match(envExample, /^VOLT_PRICE_MELI_CLIENT_SECRET=/m);
  assert.match(readme, /VOLT_PRICE_PUBLIC_BASE_URL/);
  assert.match(readme, /\/volt-price\/api\/integrations\/meli\/callback/);
  assert.match(readme, /não.*(?:access token|refresh token|senha).*manual/i);
});
```

- [ ] **Step 2: Rodar o teste para confirmar a falha**

Run: `node --test business/volt-price/tests/config.test.js`

Expected: FAIL até que o README descreva o callback e o fluxo multi-conta.

- [ ] **Step 3: Documentar operação e executar migrador no ambiente configurado**

Adicionar ao README os três valores de ambiente, o callback HTTPS exato, a exigência de conta principal vendedora e o comportamento multi-conta. Não incluir valores secretos. Com `DB_VOLTPRICE_DIRECT` configurado para o banco alvo, executar:

```bash
npm --prefix business run migrate:volt-price
```

Confirmar no log a aplicação de `012_meli_order_account.sql`; não editar migrations já aplicadas.

- [ ] **Step 4: Rodar a suíte final e revisar o diff**

Run: `npm --prefix business run test:volt-price; git diff --check; git status --short --branch`

Expected: todos os testes VoltPrice PASS, sem whitespace errors e apenas arquivos desta funcionalidade no diff.

- [ ] **Step 5: Commit**

```bash
git add business/volt-price/.env.example business/volt-price/README.md business/volt-price/tests/config.test.js
git commit -m "docs(volt-price): document Mercado Livre multi-account setup"
```

## Self-review

- Cobertura da especificação: Task 1 cobre persistência e dados Tray; Task 2 cobre OAuth multi-conta, PKCE e refresh; Task 3 garante seleção segura para taxas; Task 4 cobre experiência de conexões e pedidos; Task 5 cobre configuração, migração e validação final.
- Não há conta padrão, token manual ou exposição de segredos em nenhuma tarefa.
- A interface de Task 4 envia o ID interno do pedido à rota financeira definida em Task 3, que resolve o ID externo e a conexão correspondente; os nomes e parâmetros são consistentes.
- A migração é nova e idempotente, preservando o checksum do migrador para arquivos já aplicados.
