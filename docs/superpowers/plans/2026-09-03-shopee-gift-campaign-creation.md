# Campanhas de Brindes Shopee Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar no Precificador Inteligente um fluxo seguro para configurar, precificar, validar logística e publicar campanhas Shopee de brinde grátis com gasto mínimo.

**Architecture:** Um módulo de campanhas de brindes terá persistência, cálculo e orquestração próprios, mas reutilizará o motor V7, as políticas de conflito, o cliente Shopee autenticado e a Central de Logística existentes. A publicação será uma fila BullMQ idempotente; uma prévia salva não faz chamadas externas e a alteração logística só ocorre após confirmação explícita.

**Tech Stack:** Node.js/CommonJS, Express 5, PostgreSQL/SQL, BullMQ/Redis, Shopee Open Platform v2, HTML/CSS/JavaScript sem framework, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-03-shopee-gift-campaign-creation-design.md`

## Global Constraints

- A campanha é “brinde com gasto mínimo”; um único gasto mínimo vale para todos os produtos principais.
- O comprador escolhe um brinde entre as opções; a provisão é sempre o maior CMV unitário selecionado.
- Rascunhos não podem alterar preço, estoque, logística nem criar recursos na Shopee.
- Mostrar todas as alternativas logísticas, inclusive as inviáveis e seus motivos; não alterar logística sem confirmação explícita.
- Iniciar, por padrão, no maior período permitido; permitir reduzir, mas bloquear prazo acima do limite conhecido e revalidar na Shopee.
- Produtos participantes exibem a tag `Campanha de brinde` enquanto a campanha estiver ativa.
- Valores monetários são inteiros em centavos; todos os acessos são obrigatoriamente filtrados por `shopId` no servidor.
- Não adicionar dependências; usar `requestShopeeAuthed`, BullMQ e helpers existentes.

---

## File structure

| Arquivo | Responsabilidade |
| --- | --- |
| `shopee/db/migrations/20260903110000_add_gift_campaigns/migration.sql` | Tabelas, chaves, índices e FKs das campanhas, itens e auditoria. |
| `shopee/src/repositories/giftCampaignSqlRepository.js` | Persistir e consultar rascunhos, itens, ações e a tag de campanha ativa. |
| `shopee/src/services/GiftCampaignPricingService.js` | Validar condições, resolver período e gerar prévia financeira com o motor V7. |
| `shopee/src/services/GiftCampaignLogisticsService.js` | Construir matriz e opções de compatibilidade logística sem efeitos externos. |
| `shopee/src/services/ShopeeAddOnDealService.js` | Chamadas autenticadas e normalizadas da API Add-on Deal. |
| `shopee/src/services/GiftCampaignService.js` | Orquestrar rascunho, prévia, confirmação, publicação, falha e recuperação. |
| `shopee/src/jobs/giftCampaignPublish.job.js` | Processador BullMQ da publicação. |
| `shopee/src/controllers/GiftCampaignController.js` | Adaptar HTTP para o serviço, sempre resolvendo a loja autenticada. |
| `shopee/src/routes/giftCampaign.routes.js` | Rotas protegidas de campanhas de brinde. |
| `shopee/src/config/queue.js` | Fila, scheduler, worker e lifecycle de `giftCampaignPublish`. |
| `shopee/src/routes/index.js` | Registrar as rotas de brindes. |
| `shopee/src/repositories/pricingV6SqlRepository.js` | Acrescentar dados de campanha de brinde às linhas do Precificador. |
| `shopee/src/services/PricingV6Service.js` | Expor a tag e o resumo de campanha sem recalcular catálogo remoto. |
| `shopee/public/index.html` | Nova subaba do Precificador e estrutura do assistente de brindes. |
| `shopee/public/app.js` | Estado, renderização, modais, chamadas HTTP e acompanhamento do job. |
| `shopee/public/styles.css` | Layout responsivo do assistente, tabela financeira e matriz logística. |
| `shopee/test/giftCampaign*.test.js` | Testes unitários e de integração por responsabilidade. |
| `shopee/test/pricingV6Engine.test.js` | Regressão da tag ativa no payload do Precificador. |

## Task 1: Persistência de campanha e repositório com escopo de loja

**Files:**
- Create: `shopee/db/migrations/20260903110000_add_gift_campaigns/migration.sql`
- Create: `shopee/src/repositories/giftCampaignSqlRepository.js`
- Create: `shopee/test/giftCampaignRepository.test.js`

**Interfaces:**
- Produces `createGiftCampaign(input)`, `replaceCampaignItems(input)`, `getGiftCampaign({ shopId, campaignId })`, `listGiftCampaigns({ shopId })`, `appendGiftCampaignAction(input)`, `setGiftCampaignState(input)`, `getActiveGiftCampaignByPricingKeys({ shopId, keys })`.
- Consumes `query`, `queryOne` and `withClient` from `src/config/postgres`.
- Later tasks consume campaign IDs as UUID strings and item keys in the existing `productId:modelId-or-0` format.

- [ ] **Step 1: Write failing repository/migration tests**

Create `test/giftCampaignRepository.test.js` with explicit schema and scoping expectations:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { _test } = require("../src/repositories/giftCampaignSqlRepository");

test("migration vincula campanha, itens e auditoria a loja e campanha", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "migrations", "20260903110000_add_gift_campaigns", "migration.sql"), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "GiftCampaign"/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "GiftCampaignMainItem"/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "GiftCampaignGiftItem"/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "GiftCampaignAction"/);
  assert.match(sql, /FOREIGN KEY \("shopId"\) REFERENCES "Shop"\(id\) ON DELETE CASCADE/);
});

test("consulta de campanha sempre inclui shopId", () => {
  const query = _test.buildGiftCampaignByIdQuery({ shopId: 42, campaignId: "a0d2c8c3-5f58-4b4d-9a17-3cf7de51ef10" });
  assert.match(query.text, /WHERE gc\.id = \$1::uuid AND gc\."shopId" = \$2/);
  assert.deepEqual(query.values, ["a0d2c8c3-5f58-4b4d-9a17-3cf7de51ef10", 42]);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test test/giftCampaignRepository.test.js` from `shopee`.

Expected: FAIL because migration and repository do not yet exist.

- [ ] **Step 3: Add migration and repository**

Create the four tables with UUID `GiftCampaign.id`, a `shopId` foreign key, `status`, `minSpendCents`, `targetMarginRate`, `startAt`, `endAt`, `useMaxDuration`, `conflictPolicy`, `logisticsResolution`, `logisticsPlan`, `preview`, `remoteAddOnDealId`, `idempotencyKey`, actor IDs and timestamps. Create child rows for main items, gift items and actions; use `ON DELETE CASCADE` from campaign to children.

Implement the exact query builder used by the test:

```js
function buildGiftCampaignByIdQuery({ shopId, campaignId }) {
  return {
    text: `SELECT gc.* FROM "GiftCampaign" gc
           WHERE gc.id = $1::uuid AND gc."shopId" = $2 LIMIT 1`,
    values: [String(campaignId), Number(shopId)],
  };
}
```

Wrap `createGiftCampaign` plus insertion of main/gift items in `withClient`, begin a transaction, insert only parameterized values, and commit only after all rows are stored. Add the `getActiveGiftCampaignByPricingKeys` query using `GiftCampaignMainItem` joined to `GiftCampaign` where `status = 'published'` and current time is within `startAt`/`endAt`.

- [ ] **Step 4: Run repository tests and migration drift check**

Run:

```bash
node --test test/giftCampaignRepository.test.js
npm run db:schema:check
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit the persistence slice**

```bash
git add shopee/db/migrations/20260903110000_add_gift_campaigns/migration.sql shopee/src/repositories/giftCampaignSqlRepository.js shopee/test/giftCampaignRepository.test.js
git commit -m "feat(shopee): persist gift campaign drafts"
```

## Task 2: Prévia financeira, margem e período máximo

**Files:**
- Create: `shopee/src/services/GiftCampaignPricingService.js`
- Create: `shopee/test/giftCampaignPricing.test.js`

**Interfaces:**
- Produces `buildGiftCampaignPreview({ mainItems, giftItems, settings, calibration, targetMarginRate, startAt, endAt, useMaxDuration, maximumDurationDays, now })`.
- Returns `{ period, giftProvisionCents, lines, summary }`; each line has `key`, `costCents`, `giftProvisionCents`, `costWithGiftCents`, `suggestedPriceCents`, `marginRate`, `warnings`.
- Consumes `calculateV7Price` from `PricingV7Engine` and never mutates product cost data.

- [ ] **Step 1: Write failing preview tests**

Create `test/giftCampaignPricing.test.js`:

```js
const assert = require("node:assert/strict");
const test = require("node:test");
const { buildGiftCampaignPreview } = require("../src/services/GiftCampaignPricingService");

const settings = { targetMarginRate: 0.2, engineMode: "SAFE", feeRules: [{ maxCents: null, commissionRate: 0.1, fixedFeeCents: 0 }], coupons: [], psychologicalEndings: [0] };

test("provisiona somente o CMV do brinde mais caro para cada principal", () => {
  const result = buildGiftCampaignPreview({
    mainItems: [{ key: "10:0", costCents: 10000 }],
    giftItems: [{ key: "20:0", costCents: 900 }, { key: "21:0", costCents: 1750 }],
    settings, calibration: null, targetMarginRate: 0.2,
    startAt: "2026-09-10T12:00:00.000Z", useMaxDuration: true,
    maximumDurationDays: 30, now: new Date("2026-09-03T12:00:00.000Z"),
  });
  assert.equal(result.giftProvisionCents, 1750);
  assert.equal(result.lines[0].costWithGiftCents, 11750);
  assert.equal(result.period.endAt, "2026-10-10T12:00:00.000Z");
});

test("rejeita término acima do máximo quando o período máximo não está ativo", () => {
  assert.throws(() => buildGiftCampaignPreview({
    mainItems: [{ key: "10:0", costCents: 10000 }], giftItems: [{ key: "20:0", costCents: 900 }],
    settings, calibration: null, targetMarginRate: 0.2,
    startAt: "2026-09-10T12:00:00.000Z", endAt: "2026-11-10T12:00:00.000Z",
    useMaxDuration: false, maximumDurationDays: 30, now: new Date("2026-09-03T12:00:00.000Z"),
  }), /período máximo/i);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test test/giftCampaignPricing.test.js` from `shopee`.

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement pure calculation and period resolver**

Implement a deterministic period resolver that receives `maximumDurationDays` from server configuration or shop capability; do not hard-code a platform limit. Its core must be:

```js
const provision = Math.max(...giftItems.map((item) => Math.max(0, Number(item.costCents) || 0)));
const price = calculateV7Price({
  costCents: Number(main.costCents) + provision,
  logisticsCostCents: 0,
  otherFixedCostCents: 0,
  targetMarginRate,
  settings,
  calibration,
});
```

Require at least one main item, one gift item, positive CMV for all selected items, valid future start date and `maximumDurationDays >= 1`. With `useMaxDuration`, set `endAt` to start plus the received duration; otherwise reject an end after that cap. Preserve the original principal CMV and return the provisional CMV separately so it can be shown and audited.

- [ ] **Step 4: Run the financial test suite**

Run:

```bash
node --test test/giftCampaignPricing.test.js test/pricingV7Engine.test.js test/pricingV6Engine.test.js
```

Expected: all tests pass; suggested price is based on `costWithGiftCents`, not the persisted product CMV.

- [ ] **Step 5: Commit the preview slice**

```bash
git add shopee/src/services/GiftCampaignPricingService.js shopee/test/giftCampaignPricing.test.js
git commit -m "feat(shopee): calculate gift campaign price previews"
```

## Task 3: Matriz de logística e alternativas explícitas

**Files:**
- Create: `shopee/src/services/GiftCampaignLogisticsService.js`
- Create: `shopee/test/giftCampaignLogistics.test.js`

**Interfaces:**
- Produces `buildGiftCampaignLogisticsOptions({ mainItems, giftItems })`.
- Returns `{ compatible, matrix, options }`; each option has `id`, `label`, `feasible`, `reason`, `affectedItemIds`, `targetKinds`, `changes`.
- Consumes normalized item logistics from `LogisticsController.summarizeProduct` output: `itemId`, `availableKinds`, `enabledKinds`, `spxPhysicalEligible`, `spxEligibilityReasons`.

- [ ] **Step 1: Write failing logistics tests**

Create `test/giftCampaignLogistics.test.js`:

```js
const assert = require("node:assert/strict");
const test = require("node:test");
const { buildGiftCampaignLogisticsOptions } = require("../src/services/GiftCampaignLogisticsService");

test("mostra ajuste de brindes e de principais quando ambos são possíveis", () => {
  const result = buildGiftCampaignLogisticsOptions({
    mainItems: [{ itemId: "1", availableKinds: ["seller", "spx"], enabledKinds: ["seller"] }],
    giftItems: [{ itemId: "2", availableKinds: ["seller", "spx"], enabledKinds: ["spx"] }],
  });
  assert.equal(result.compatible, false);
  assert.deepEqual(result.options.map((option) => option.id), ["adjust_gifts", "adjust_main_items", "edit_selection"]);
  assert.equal(result.options[0].feasible, true);
  assert.equal(result.options[1].feasible, true);
});

test("mantém alternativa inviável visível com motivo físico", () => {
  const result = buildGiftCampaignLogisticsOptions({
    mainItems: [{ itemId: "1", availableKinds: ["spx"], enabledKinds: ["spx"] }],
    giftItems: [{ itemId: "2", availableKinds: ["seller"], enabledKinds: ["seller"], spxPhysicalEligible: false, spxEligibilityReasons: ["Peso excede o limite"] }],
  });
  assert.equal(result.options[0].feasible, false);
  assert.match(result.options[0].reason, /Peso excede o limite/);
  assert.equal(result.options[2].feasible, true);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test test/giftCampaignLogistics.test.js` from `shopee`.

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the option builder without remote writes**

Build a per-item matrix of available/active channels and compute shared target kinds. Always return the following options in this order:

```js
[
  { id: "adjust_gifts", label: "Preservar logística dos principais" },
  { id: "adjust_main_items", label: "Preservar logística dos brindes" },
  { id: "edit_selection", label: "Editar seleção" },
]
```

For the first two options, mark `feasible: false` when any affected item lacks the target channel or has an explicit physical restriction. Include every failed item and its reason in `changes`; never omit an infeasible option. `edit_selection` is always feasible and has no remote changes. This service must not import `ShopeeLogisticsService` and must not write to the database.

- [ ] **Step 4: Run logistics unit and existing policy tests**

Run:

```bash
node --test test/giftCampaignLogistics.test.js test/productLogistics.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit the logistics analysis slice**

```bash
git add shopee/src/services/GiftCampaignLogisticsService.js shopee/test/giftCampaignLogistics.test.js
git commit -m "feat(shopee): plan gift campaign logistics alternatives"
```

## Task 4: Cliente Shopee Add-on Deal autenticado e normalizado

**Files:**
- Create: `shopee/src/services/ShopeeAddOnDealService.js`
- Create: `shopee/test/shopeeAddOnDealService.test.js`

**Interfaces:**
- Produces `createGiftWithMinimumSpend`, `addMainItems`, `addGiftItems`, `endAddOnDeal`, and `_test.buildGiftDealPayload`.
- Consumes `requestShopeeAuthed` from `ShopeeAuthedHttp`; all methods accept `{ shopId, ... }` and use only authenticated API calls.
- Later tasks receive a normalized `{ addOnDealId, raw }` or throw an `Error` with `.shopee` payload.

- [ ] **Step 1: Write failing payload tests**

Create `test/shopeeAddOnDealService.test.js`:

```js
const assert = require("node:assert/strict");
const test = require("node:test");
const { _test } = require("../src/services/ShopeeAddOnDealService");

test("monta campanha de brinde com gasto mínimo e um brinde por pedido", () => {
  const body = _test.buildGiftDealPayload({
    name: "Brinde Setembro", startAt: "2026-09-10T12:00:00.000Z",
    endAt: "2026-10-10T12:00:00.000Z", minSpendCents: 19990,
  });
  assert.equal(body.promotion_type, 1);
  assert.equal(body.purchase_min_spend, 199.9);
  assert.equal(body.per_gift_num, 1);
  assert.equal(body.start_time, 1789041600);
});

test("rejeita resposta Shopee sem identificador de campanha", () => {
  assert.throws(() => _test.extractAddOnDealId({ response: {} }), /identificador/i);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test test/shopeeAddOnDealService.test.js` from `shopee`.

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement isolated remote client**

Use the same authenticated request path as the product writer:

```js
const payload = await requestShopeeAuthed({
  method: "post",
  path: "/api/v2/add_on_deal/add_add_on_deal",
  shopId: String(shopId),
  body,
});
```

Normalize Shopee errors exactly as `ShopeeProductWriteService` does: if `payload.error` is meaningful, throw an error with `error.shopee = payload`. Build `purchase_min_spend` from cents divided by 100, set `promotion_type: 1` and `per_gift_num: 1`, and convert dates to Unix seconds. Implement main/gift insertion as separate methods so the publisher can persist success after every remote call. Keep the endpoint paths in this service only; verify response shape against the enabled Open Platform contract in integration testing before production publication.

- [ ] **Step 4: Run client tests**

Run: `node --test test/shopeeAddOnDealService.test.js` from `shopee`.

Expected: PASS; no HTTP request is performed in unit tests.

- [ ] **Step 5: Commit the Shopee client**

```bash
git add shopee/src/services/ShopeeAddOnDealService.js shopee/test/shopeeAddOnDealService.test.js
git commit -m "feat(shopee): add authenticated gift campaign client"
```

## Task 5: Serviço, job e API de rascunho à publicação

**Files:**
- Create: `shopee/src/services/GiftCampaignService.js`
- Create: `shopee/src/jobs/giftCampaignPublish.job.js`
- Create: `shopee/src/controllers/GiftCampaignController.js`
- Create: `shopee/src/routes/giftCampaign.routes.js`
- Modify: `shopee/src/config/queue.js`
- Modify: `shopee/src/routes/index.js`
- Create: `shopee/test/giftCampaignService.test.js`

**Interfaces:**
- Produces HTTP routes under `/shops/:shopId/gift-campaigns` and queue `giftCampaignPublish`.
- `GiftCampaignService.createDraft`, `updateDraft`, `preview`, `logisticsOptions`, `confirm`, `runPublishJob`, `retry`, `cancel` each accept an explicit `{ shop, userId, campaignId, ... }` object.
- `runPublishJob({ campaignId, progress })` transitions exactly through `validating`, `applying_logistics`, `applying_prices`, `creating_campaign`, `published` or `partial_failed`.

- [ ] **Step 1: Write failing service and HTTP-scope tests**

Create `test/giftCampaignService.test.js`:

```js
const assert = require("node:assert/strict");
const test = require("node:test");
const { _test } = require("../src/services/GiftCampaignService");

test("rascunho não agenda publicação nem chama cliente Shopee", async () => {
  let remoteCalls = 0;
  const result = await _test.createDraftWithDependencies({
    repository: { createGiftCampaign: async (input) => ({ id: "draft-1", ...input }) },
    remote: { createGiftWithMinimumSpend: async () => { remoteCalls += 1; } },
    input: { shopId: 1, userId: 9, name: "Brinde", minSpendCents: 10000 },
  });
  assert.equal(result.status, "draft");
  assert.equal(remoteCalls, 0);
});

test("publicação interrompe após falha logística e não cria campanha", async () => {
  const calls = [];
  await assert.rejects(() => _test.publishWithDependencies({
    campaign: { id: "c1", status: "awaiting_confirmation", logisticsResolution: "adjust_gifts" },
    updateLogistics: async () => { calls.push("logistics"); throw new Error("canal indisponível"); },
    applyPrices: async () => calls.push("prices"),
    remote: { createGiftWithMinimumSpend: async () => calls.push("campaign") },
    repository: { setGiftCampaignState: async () => null, appendGiftCampaignAction: async () => null },
  }), /canal indisponível/);
  assert.deepEqual(calls, ["logistics"]);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test test/giftCampaignService.test.js` from `shopee`.

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement service states and guarded routes**

Implement route handlers using the existing pattern:

```js
router.use(requireAuth);
router.post("/shops/:shopId/gift-campaigns/drafts", asyncHandler(controller.createDraft));
router.post("/shops/:shopId/gift-campaigns/:campaignId/publish", asyncHandler(controller.publish));
```

Resolve the shop exclusively with `resolveShop(req, req.params.shopId || "active")`; never trust a `shopId` in request body. `confirm` persists the final preview and selected feasible logistics option. `publish` rejects drafts, unconfirmed plans and the `edit_selection` option, creates an idempotency key, sets `queued`, and enqueues only the campaign ID.

Add `giftCampaignPublishQueue`/scheduler/worker in `config/queue.js`, following the existing `pricingV6Apply` lifecycle. The job must re-fetch the campaign and live logistics, append an action before and after every remote effect, stop on the first failure, set `partial_failed` when any prior external step succeeded, and rethrow to BullMQ. Do not roll back external price or logistics automatically.

In order, execute: revalidate → apply the selected logistics changes with `ShopeeLogisticsService.updateProductLogistics` → apply approved prices through `ShopeeProductWriteService.updatePrice` under the selected conflict policy → create Add-on Deal → add main items → add gift items → set `published`. Persist the remote campaign ID immediately after its successful creation so retries never create a duplicate campaign.

- [ ] **Step 4: Run service tests and syntax checks**

Run:

```bash
node --test test/giftCampaignService.test.js test/giftCampaignPricing.test.js test/giftCampaignLogistics.test.js test/shopeeAddOnDealService.test.js
node --check src/services/GiftCampaignService.js
node --check src/controllers/GiftCampaignController.js
node --check src/routes/giftCampaign.routes.js
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit the orchestration slice**

```bash
git add shopee/src/services/GiftCampaignService.js shopee/src/jobs/giftCampaignPublish.job.js shopee/src/controllers/GiftCampaignController.js shopee/src/routes/giftCampaign.routes.js shopee/src/config/queue.js shopee/src/routes/index.js shopee/test/giftCampaignService.test.js
git commit -m "feat(shopee): publish gift campaigns through queued workflow"
```

## Task 6: Tag de campanha de brinde no Precificador Inteligente

**Files:**
- Modify: `shopee/src/repositories/pricingV6SqlRepository.js`
- Modify: `shopee/src/services/PricingV6Service.js`
- Modify: `shopee/test/pricingV6Engine.test.js`

**Interfaces:**
- Adds `giftCampaign` or `null` to every pricing row without changing `hasActiveCampaign` semantics for discount campaigns.
- `giftCampaign` has `{ id, name, status, minSpendCents, giftProvisionCents, startsAt, endsAt }`.

- [ ] **Step 1: Write failing tag regression test**

Append to `test/pricingV6Engine.test.js`:

```js
test("linha do precificador preserva a tag da campanha de brinde ativa", () => {
  const row = pricingRepositoryTest.mapProductRow({
    product_id: 12, item_id: "1200", model_id: null, title: "Mesa", cost_cents: 1000,
    current_price: 30, gift_campaign_id: "8d4a9b85-7f8b-4ea6-b2f5-2d5d8b9c805a",
    gift_campaign_name: "Brinde setembro", gift_campaign_status: "published",
    gift_campaign_min_spend_cents: 19990, gift_campaign_provision_cents: 1750,
  });
  assert.equal(row.giftCampaign.name, "Brinde setembro");
  assert.equal(row.giftCampaign.giftProvisionCents, 1750);
});
```

- [ ] **Step 2: Run the regression test and confirm it fails**

Run: `node --test test/pricingV6Engine.test.js` from `shopee`.

Expected: FAIL because `_test.mapProductRow` has not been exported.

- [ ] **Step 3: Extend the catalog query and mapper**

Add a left join/subquery that returns only the current active gift campaign associated with each `Product`/`ProductModel`, scoped by `p."shopId"` and time range. Map the nullable columns into:

```js
giftCampaign: row.gift_campaign_id ? {
  id: String(row.gift_campaign_id),
  name: row.gift_campaign_name,
  status: row.gift_campaign_status,
  minSpendCents: asNumber(row.gift_campaign_min_spend_cents, 0),
  giftProvisionCents: asNumber(row.gift_campaign_provision_cents, 0),
  startsAt: row.gift_campaign_starts_at,
  endsAt: row.gift_campaign_ends_at,
} : null,
```

Keep existing discount campaign filtering intact. `PricingV6Service` forwards the field as part of the existing product response and invalidates catalog snapshots when a campaign reaches `published`, `cancelled`, `ended` or `partial_failed`.

Expose `mapProductRow` in the existing `_test` object in the repository so the regression test can exercise the exact response mapper:

```js
_test: {
  buildProductFilters,
  mapProductRow,
  toPriceCents,
  toProductKey,
  CURRENT_PRICE_PROMOTION_STATUSES,
  PRICING_ACTIVE_PRODUCT_STATUSES,
},
```

- [ ] **Step 4: Run Precificador regressions**

Run: `node --test test/pricingV6Engine.test.js test/pricingV7Engine.test.js` from `shopee`.

Expected: PASS and all existing price calculations remain unchanged when `giftCampaign` is null.

- [ ] **Step 5: Commit the tag slice**

```bash
git add shopee/src/repositories/pricingV6SqlRepository.js shopee/src/services/PricingV6Service.js shopee/test/pricingV6Engine.test.js
git commit -m "feat(shopee): tag active gift campaigns in pricing"
```

## Task 7: Assistente visual de Criação de Brindes

**Files:**
- Modify: `shopee/public/index.html`
- Modify: `shopee/public/app.js`
- Modify: `shopee/public/styles.css`

**Interfaces:**
- Adds Pricing V6 subtab `gift-campaigns` and `GIFT_CAMPAIGN_STATE`.
- Calls only the routes from Task 5.
- Renders `GiftCampaignPreview`, `GiftCampaignLogisticsOptions` and job/action data returned by the API; no financial or logistics authority exists in the browser.

- [ ] **Step 1: Add a browser-level rendering test seam**

Export testable pure render helpers at the bottom of `public/app.js` only when `window.__DAVANTTI_TEST__` is present:

```js
if (window.__DAVANTTI_TEST__) {
  window.__DAVANTTI_GIFT_TEST__ = { giftCampaignStatusLabel, giftCampaignOptionSummary };
}
```

Add a small browser test harness in `test/giftCampaignUi.test.js` that loads these helpers with a minimal mocked `window` and asserts:

```js
assert.equal(window.__DAVANTTI_GIFT_TEST__.giftCampaignStatusLabel("partial_failed"), "Atenção necessária");
assert.match(window.__DAVANTTI_GIFT_TEST__.giftCampaignOptionSummary({ feasible: false, reason: "Peso excede o limite" }), /Peso excede o limite/);
```

- [ ] **Step 2: Run the UI seam test and confirm it fails**

Run: `node --test test/giftCampaignUi.test.js` from `shopee`.

Expected: FAIL because the helpers and test hook do not exist.

- [ ] **Step 3: Implement the wizard markup, state and handlers**

In `index.html`, add the `Campanhas de brinde` subtab next to `Precificador`; create one pane with sections for conditions, principal picker, gift picker, financial preview, logistics matrix and final review. Required controls:

```html
<label class="gift-campaign-toggle"><input id="giftCampaignUseMaxDuration" type="checkbox" checked /> Usar período máximo permitido</label>
<button id="btnGiftCampaignSaveDraft" class="btn btn-ghost" type="button">Salvar rascunho</button>
<button id="btnGiftCampaignPreview" class="btn btn-primary" type="button">Gerar prévia</button>
<button id="btnGiftCampaignPublish" class="btn btn-primary" type="button" disabled>Confirmar e publicar</button>
```

In `app.js`, hold only selection IDs, draft ID and API payloads in `GIFT_CAMPAIGN_STATE`. On each stage change call the server preview; do not calculate CMV, price or compatibility locally. Render the provisioned maximum CMV and price/margin for every principal. Render all three logistics options; disable the publish button unless one feasible non-`edit_selection` option is selected. The final confirmation modal must list affected items and enabled/disabled channels before calling `publish`.

Render `item.giftCampaign` in `renderPricingV6Products` as a clickable `Campanha de brinde` chip opening the campaign detail subtab. Keep existing “Em campanha” discount text and do not replace it.

Add responsive CSS classes `.gift-campaign-wizard`, `.gift-campaign-step`, `.gift-campaign-financial-grid`, `.gift-campaign-logistics-option`, `.gift-campaign-logistics-option--blocked`, `.gift-campaign-tag` and mobile rules that collapse columns into a single stack.

- [ ] **Step 4: Run UI test and manual smoke test**

Run:

```bash
node --test test/giftCampaignUi.test.js
npm start
```

Manual expected result in the browser: save a draft with selected principal/gifts; confirm no network request to Shopee occurs; generate preview; see the maximum CMV, all logistics alternatives, disabled publication for an unresolved conflict, and the tag in the main Precificador table.

- [ ] **Step 5: Commit the interface slice**

```bash
git add shopee/public/index.html shopee/public/app.js shopee/public/styles.css shopee/test/giftCampaignUi.test.js
git commit -m "feat(shopee): add gift campaign creation wizard"
```

## Task 8: End-to-end validation, migration deployment and operator guidance

**Files:**
- Modify: `shopee/README.md`
- Modify: `docs/superpowers/specs/2026-09-03-shopee-gift-campaign-creation-design.md`
- Create: `shopee/test/giftCampaignPublishFlow.test.js`

**Interfaces:**
- Tests the complete happy path and partial failure with injected repository, logistics, pricing and Shopee clients.
- Documents environment configuration `SHOPEE_GIFT_CAMPAIGN_MAX_DURATION_DAYS` as an operator-set maximum until the shop’s API contract provides a more restrictive value.

- [ ] **Step 1: Write failing workflow tests**

Create `test/giftCampaignPublishFlow.test.js`:

```js
const assert = require("node:assert/strict");
const test = require("node:test");
const { _test } = require("../src/services/GiftCampaignService");

test("publica logística, preço e campanha uma única vez e registra o ID remoto", async () => {
  const calls = [];
  const state = await _test.publishWithDependencies({
    campaign: { id: "c1", status: "awaiting_confirmation", logisticsResolution: "adjust_gifts", remoteAddOnDealId: null },
    updateLogistics: async () => calls.push("logistics"), applyPrices: async () => calls.push("prices"),
    remote: { createGiftWithMinimumSpend: async () => { calls.push("create"); return { addOnDealId: "77" }; }, addMainItems: async () => calls.push("main"), addGiftItems: async () => calls.push("gift") },
    repository: { setGiftCampaignState: async (input) => input, appendGiftCampaignAction: async () => null },
  });
  assert.deepEqual(calls, ["logistics", "prices", "create", "main", "gift"]);
  assert.equal(state.status, "published");
  assert.equal(state.remoteAddOnDealId, "77");
});
```

- [ ] **Step 2: Run the workflow test and confirm it fails**

Run: `node --test test/giftCampaignPublishFlow.test.js` from `shopee`.

Expected: FAIL until Task 5 exposes the complete dependency-injected publisher.

- [ ] **Step 3: Complete testability and document operation**

Refactor only as needed so `publishWithDependencies` returns the final state and skips `createGiftWithMinimumSpend` when `remoteAddOnDealId` is already persisted. Document migration deployment, the configured maximum-duration variable, how to inspect `GiftCampaignAction`, and the explicit rule that a failed external operation is resumed/retried rather than automatically rolled back.

- [ ] **Step 4: Run full targeted verification and deploy migration**

Run:

```bash
node --test test/giftCampaignRepository.test.js test/giftCampaignPricing.test.js test/giftCampaignLogistics.test.js test/shopeeAddOnDealService.test.js test/giftCampaignService.test.js test/giftCampaignPublishFlow.test.js test/giftCampaignUi.test.js test/pricingV6Engine.test.js test/pricingV7Engine.test.js test/productLogistics.test.js
npm run db:schema:check
npm run db:migrate:deploy
```

Expected: all tests pass; migration deploy succeeds. Then use one test shop to create a draft, validate incompatible logistics, publish a compatible campaign and verify the Add-on Deal ID and pricing tag.

- [ ] **Step 5: Commit documentation and validation assets**

```bash
git add shopee/README.md docs/superpowers/specs/2026-09-03-shopee-gift-campaign-creation-design.md shopee/test/giftCampaignPublishFlow.test.js
git commit -m "docs(shopee): document gift campaign operations"
```

## Self-review

### Spec coverage

- Assistente, rascunho, seleção de principais/brindes, gasto mínimo e período máximo: Tasks 1, 2 e 7.
- Um brinde escolhido e maior CMV provisionado: Task 2 and Task 7.
- Precificação V7, preço/margem editáveis e conflitos: Tasks 2, 5 e 7.
- Matriz de logística e escolha explícita de ajuste: Tasks 3, 5 e 7.
- Add-on Deal, fila, idempotência, auditoria, falha parcial e recuperação: Tasks 1, 4, 5 e 8.
- Tag de campanha no Precificador: Tasks 6 e 7.
- Escopo por loja, valores em centavos e validação: Tasks 1, 2, 5 and 8.

### Placeholder scan

Não há etapas adiadas ou instruções genéricas. Cada tarefa nomeia arquivos, interfaces, código de teste e comandos de verificação exatos.

### Type consistency

- Campaign IDs are UUID strings from Task 1 through Task 8.
- Pricing keys use `productId:modelId-or-0` in repository, preview and tag work.
- Logistics resolution IDs are consistently `adjust_gifts`, `adjust_main_items` and `edit_selection`.
- Published remote identifier is consistently `remoteAddOnDealId`.
