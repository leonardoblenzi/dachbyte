# Motor V6: Selecao Economica e Previa Persistente Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Recomendar o menor preco elegivel que conserva o melhor repasse liquido nos saltos de taxa, reutilizar a previa V6 ate atualizacao manual e disponibilizar um simulador livre por produto.

**Architecture:** O motor encontra o menor candidato elegivel em cada intervalo economico, incluindo limites de taxa e cupom, e consolida os resultados com o mesmo buildBreakdown usado pela aplicacao. As previas recebem uma chave deterministica no banco e sao reutilizadas enquanto a selecao, os filtros e a versao das regras forem os mesmos. Um endpoint de simulacao livre le somente o produto local e devolve sua decomposicao financeira para a interface.

**Tech Stack:** Node.js CommonJS, Express 5, PostgreSQL, HTML/CSS/JavaScript sem framework, node:test e node:assert/strict.

## Global Constraints

- Dados de produtos para o Motor V6 sao lidos apenas do banco Shopee local; a carga e o simulador nao chamam a API da Shopee.
- Apenas anuncios NORMAL participam da lista, das previas e das aplicacoes V6.
- Nenhuma simulacao, atualizacao de previa ou calculo livre cria job ou altera preco na Shopee.
- Previa reutilizavel exige mesma loja, selecao, filtros normalizados e versao das configuracoes.
- A atualizacao manual invalida somente a previa correspondente, sem alterar produtos, configuracoes ou jobs existentes.
- Cada alteracao de comportamento segue RED, GREEN, verificacao da suite e commit proprio.

---

## File Structure

- shopee/src/services/PricingV6Engine.js: gera candidatos economicos e escolhe o preco sugerido por margem minima, preco e repasse.
- shopee/src/services/PricingV6Service.js: administra a reutilizacao de previas e compoe a simulacao livre de um produto.
- shopee/src/repositories/pricingV6SqlRepository.js: persiste, encontra e invalida previas por chave; recupera uma linha de produto pelo identificador V6.
- shopee/src/controllers/PricingV6Controller.js e shopee/src/routes/pricingV6.routes.js: expõem os contratos HTTP autenticados.
- shopee/db/migrations/20260811170000_persist_pricing_v6_previews/migration.sql: adiciona chave de cache, invalidacao e permite previa sem expiracao.
- shopee/public/index.html, shopee/public/app.js e shopee/public/styles.css: controles compactos e resultado da simulacao na tabela.
- shopee/test/pricingV6Engine.test.js: regressao do motor, do cache e do simulador.

## Task 1: Selecionar o menor preco elegivel por faixa economica

**Files:**
- Modify: shopee/src/services/PricingV6Engine.js:196-275
- Test: shopee/test/pricingV6Engine.test.js

**Interfaces:**
- Consumes: buildBreakdown({ priceCents, costCents, logisticsCostCents, otherFixedCostCents, settings }).
- Produces: calculatePrice(input) com recommendedPriceCents, secondBestPriceCents, netPayoutCents e breakdown consistentes.

- [ ] **Step 1: Write the failing test**

    test("prefere o menor preco elegivel quando a faixa menor deixa mais repasse liquido", () => {
      const result = calculatePrice({
        costCents: 600,
        targetMarginRate: 0.1,
        settings: {
          ...DEFAULT_PRICING_SETTINGS,
          coupons: [],
          campaignEnabled: false,
          psychologicalEndings: [0],
          feeRules: [
            { maxCents: 900, commissionRate: 0.1, fixedFeeCents: 200 },
            { maxCents: null, commissionRate: 0.1, fixedFeeCents: 350 },
          ],
        },
      });

      assert.equal(result.recommendedPriceCents, 900);
      assert.equal(result.breakdown.contributionCents, 210);
      assert.equal(result.netPayoutCents, 810);
    });

- [ ] **Step 2: Run test to verify it fails**

Run: node --test shopee/test/pricingV6Engine.test.js

Expected: FAIL because netPayoutCents is absent and the existing candidate generator does not guarantee the exact fee-boundary candidate.

- [ ] **Step 3: Write minimal implementation**

Add a pure selectRecommendedCandidate(rows, targetMarginRate) helper:

    function selectRecommendedCandidate(rows, targetMarginRate) {
      return rows
        .filter((row) => row.marginRate + 0.000001 >= targetMarginRate)
        .sort((left, right) =>
          left.priceCents - right.priceCents ||
          right.contributionCents - left.contributionCents,
        )[0] || null;
    }

Replace the candidate construction with a helper that adds exact start and end points for every fee range and coupon transition, then adds the closest configured price ending at or above each mathematical margin floor. Evaluate every candidate through buildBreakdown, never with a separate tax approximation. Return netPayoutCents as revenueAfterCouponCents minus totalFeesCents.

- [ ] **Step 4: Run test to verify it passes**

Run: node --test shopee/test/pricingV6Engine.test.js

Expected: PASS; the R$ 9,00 candidate wins over a more expensive fee range and exposes the calculated net payout.

- [ ] **Step 5: Add boundary regressions**

    test("mantem a margem minima ao escolher acabamento psicologico", () => {
      const result = calculatePrice({
        costCents: 1000,
        targetMarginRate: 0.2,
        settings: { ...DEFAULT_PRICING_SETTINGS, coupons: [], psychologicalEndings: [90] },
      });
      assert.ok(result.breakdown.marginRate >= result.targetMarginRate);
    });

    test("desempata o mesmo preco pelo maior repasse liquido", () => {
      const selected = pricingEngineTest.selectRecommendedCandidate([
        { priceCents: 900, marginRate: 0.2, contributionCents: 100 },
        { priceCents: 900, marginRate: 0.2, contributionCents: 110 },
      ], 0.2);
      assert.equal(selected.contributionCents, 110);
    });

Export only selectRecommendedCandidate through _test if the assertion needs it.

- [ ] **Step 6: Run the focused suite and commit**

Run: node --test shopee/test/pricingV6Engine.test.js

Expected: PASS with existing V6 precision and active-listing tests.

    git add shopee/src/services/PricingV6Engine.js shopee/test/pricingV6Engine.test.js
    git commit -m "fix(shopee): choose V6 prices by economic payoff"

## Task 2: Persistir e reutilizar a previa V6 ate atualizacao manual

**Files:**
- Create: shopee/db/migrations/20260811170000_persist_pricing_v6_previews/migration.sql
- Modify: shopee/src/repositories/pricingV6SqlRepository.js:165-179
- Modify: shopee/src/services/PricingV6Service.js:1-245
- Modify: shopee/src/controllers/PricingV6Controller.js:42-50
- Modify: shopee/src/routes/pricingV6.routes.js:14-16
- Test: shopee/test/pricingV6Engine.test.js

**Interfaces:**
- Consumes: simulate({ shopId, userId, selection, filters, forceRefresh }).
- Produces: simulate returns { snapshotId, reused, createdAt, settings, summary, items }; refresh invalidates only the active request key.

- [ ] **Step 1: Write failing service and repository-contract tests**

    test("reutiliza a previa com a mesma selecao, filtros e versao", async () => {
      const first = await pricingServiceTest.simulateWithRepository(fakeRepository, request);
      const second = await pricingServiceTest.simulateWithRepository(fakeRepository, request);

      assert.equal(second.snapshotId, first.snapshotId);
      assert.equal(second.reused, true);
      assert.equal(fakeRepository.createSnapshotCalls, 1);
    });

    test("atualizacao manual invalida a previa antes de recalcular", async () => {
      await pricingServiceTest.simulateWithRepository(fakeRepository, request);
      const refreshed = await pricingServiceTest.simulateWithRepository(
        fakeRepository,
        { ...request, forceRefresh: true },
      );

      assert.equal(refreshed.reused, false);
      assert.equal(fakeRepository.invalidateSnapshotCalls, 1);
    });

- [ ] **Step 2: Run tests to verify they fail**

Run: node --test shopee/test/pricingV6Engine.test.js

Expected: FAIL because there is no request key, reusable lookup or explicit invalidation contract.

- [ ] **Step 3: Add the migration**

    ALTER TABLE "PricingV6Snapshot"
      ALTER COLUMN "expiresAt" DROP NOT NULL,
      ADD COLUMN IF NOT EXISTS "requestKey" TEXT,
      ADD COLUMN IF NOT EXISTS "invalidatedAt" TIMESTAMP(3);

    UPDATE "PricingV6Snapshot"
    SET "requestKey" = CONCAT('legacy:', id::text)
    WHERE "requestKey" IS NULL;

    ALTER TABLE "PricingV6Snapshot"
      ALTER COLUMN "requestKey" SET NOT NULL;

    CREATE INDEX IF NOT EXISTS "PricingV6Snapshot_reusable_idx"
      ON "PricingV6Snapshot" ("shopId", "settingsVersion", "requestKey", "createdAt" DESC)
      WHERE "invalidatedAt" IS NULL;

- [ ] **Step 4: Implement deterministic reuse**

    function buildPreviewRequestKey({ selection, filters }) {
      return crypto.createHash("sha256")
        .update(JSON.stringify({
          selection: normalizeSelection(selection),
          filters: normalizeFilters(filters),
        }))
        .digest("hex");
    }

    async function simulate({ shopId, userId, selection, filters, forceRefresh = false }) {
      const settings = await getSettings(shopId);
      const requestKey = buildPreviewRequestKey({ selection, filters });
      if (!forceRefresh) {
        const cached = await repository.findReusableSnapshot({
          shopId,
          settingsVersion: settings.version,
          requestKey,
        });
        if (cached) return toReusableSimulation(cached);
      }
      if (forceRefresh) await repository.invalidateReusableSnapshots({ shopId, requestKey });
      // Calculate local rows, persist the result with expiresAt: null, and return reused: false.
    }

Add findReusableSnapshot and invalidateReusableSnapshots to the repository. Preserve getSnapshot for jobs and remove only the expiry rejection in createJob; explicit invalidation supersedes the fixed 30-minute TTL.

- [ ] **Step 5: Expose explicit refresh**

Keep POST /shops/:shopId/pricing/simulate and pass forceRefresh from req.body through PricingV6Controller.simulate. Do not add Shopee billing middleware because this endpoint reads only local data.

- [ ] **Step 6: Run migration and focused tests**

Run: npm --prefix shopee run db:migrate:status && node --test shopee/test/pricingV6Engine.test.js

Expected: migration status identifies the new local Shopee migration and the test suite passes.

- [ ] **Step 7: Commit**

    git add shopee/db/migrations/20260811170000_persist_pricing_v6_previews/migration.sql shopee/src/repositories/pricingV6SqlRepository.js shopee/src/services/PricingV6Service.js shopee/src/controllers/PricingV6Controller.js shopee/src/routes/pricingV6.routes.js shopee/test/pricingV6Engine.test.js
    git commit -m "feat(shopee): persist V6 pricing previews"

## Task 3: Criar a simulacao livre por produto

**Files:**
- Modify: shopee/src/services/PricingV6Service.js
- Modify: shopee/src/repositories/pricingV6SqlRepository.js
- Modify: shopee/src/controllers/PricingV6Controller.js
- Modify: shopee/src/routes/pricingV6.routes.js
- Test: shopee/test/pricingV6Engine.test.js

**Interfaces:**
- Consumes: simulateSalePrice({ shopId, key, salePrice }).
- Produces: POST /shops/:shopId/pricing/price-simulation accepts { key, salePrice } and returns { product, salePriceCents, breakdown, netPayoutCents, marginRate, targetMarginRate }.

- [ ] **Step 1: Write the failing test**

    test("simulador livre usa o mesmo calculo financeiro do preco sugerido", async () => {
      const result = await pricingServiceTest.simulateSalePriceWithRepository(fakeRepository, {
        shopId: 7,
        key: "12:0",
        salePrice: "9.00",
      });

      assert.equal(result.salePriceCents, 900);
      assert.equal(
        result.netPayoutCents,
        result.breakdown.revenueAfterCouponCents - result.breakdown.totalFeesCents,
      );
      assert.equal(result.marginRate, result.breakdown.marginRate);
    });

- [ ] **Step 2: Run test to verify it fails**

Run: node --test shopee/test/pricingV6Engine.test.js

Expected: FAIL because the service does not expose a free-price simulator.

- [ ] **Step 3: Implement the local-only service and endpoint**

    async function simulateSalePrice({ shopId, key, salePrice }) {
      const row = await repository.getPricingRowByKey({ shopId, key });
      if (!row) throw httpError(404, "Produto ativo nao encontrado para simulacao.");

      const salePriceCents = parseBrazilianMoneyToCents(salePrice);
      if (salePriceCents <= 0) {
        throw httpError(422, "Informe um preco de venda maior que zero.");
      }

      const settings = await getSettings(shopId);
      const breakdown = buildBreakdown({
        priceCents: salePriceCents,
        costCents: row.costCents,
        logisticsCostCents: 0,
        otherFixedCostCents: 0,
        settings,
      });
      return {
        product: pickPublicProduct(row),
        salePriceCents,
        breakdown,
        netPayoutCents: breakdown.revenueAfterCouponCents - breakdown.totalFeesCents,
        marginRate: breakdown.marginRate,
        targetMarginRate: settings.targetMarginRate,
      };
    }

Import buildBreakdown from the engine, accept 9,00 and 9.00, and use the normal authenticated router. Do not call requestShopeeAuthed, create a snapshot or enqueue a job.

- [ ] **Step 4: Run test to verify it passes**

Run: node --test shopee/test/pricingV6Engine.test.js

Expected: PASS and the returned numbers equal the engine breakdown exactly.

- [ ] **Step 5: Add validation regression and commit**

    test("simulador livre rejeita preco vazio ou nao positivo", async () => {
      await assert.rejects(
        () => pricingServiceTest.simulateSalePriceWithRepository(fakeRepository, {
          shopId: 7,
          key: "12:0",
          salePrice: "0",
        }),
        /maior que zero/,
      );
    });

Run: node --test shopee/test/pricingV6Engine.test.js

    git add shopee/src/services/PricingV6Service.js shopee/src/repositories/pricingV6SqlRepository.js shopee/src/controllers/PricingV6Controller.js shopee/src/routes/pricingV6.routes.js shopee/test/pricingV6Engine.test.js
    git commit -m "feat(shopee): simulate V6 sale prices"

## Task 4: Integrar controles e resultados na aba Precificador

**Files:**
- Modify: shopee/public/index.html:7253-7276
- Modify: shopee/public/app.js:21261-21583
- Modify: shopee/public/styles.css:8591-8672

**Interfaces:**
- Consumes: POST /shops/active/pricing/simulate with optional forceRefresh, and POST /shops/active/pricing/price-simulation with { key, salePrice }.
- Produces: botao Atualizar dados, estado reutilizado da previa e simulador por linha que apresenta taxas, repasse e margem.

- [ ] **Step 1: Add the controls and accessible result region**

    <button id="btnPricingV6RefreshData" class="btn btn-ghost btn-sm" type="button">
      Atualizar dados
    </button>

    <div class="pricing-v6-sale-simulator" data-pricing-v6-simulator="PRODUCT_KEY">
      <label><span>Simular venda</span><input class="input" inputmode="decimal" type="text" placeholder="R$ 0,00" /></label>
      <button type="button" class="btn btn-ghost btn-sm" aria-label="Calcular preco de venda">Calcular</button>
      <output class="pricing-v6-sale-simulator__result" aria-live="polite"></output>
    </div>

Render the simulator in the existing expanded details row, not in every compact table cell. Place Atualizar dados beside Simular and keep the existing selection controls unchanged.

- [ ] **Step 2: Wire the refresh and simulator handlers**

    async function runPricingV6Simulation({ forceRefresh = false } = {}) {
      const payload = await apiPost("/shops/active/pricing/simulate", {
        selection: pricingV6Selection(),
        filters: PRICING_V6_STATE.filters,
        forceRefresh,
      });
      PRICING_V6_STATE.snapshot = payload;
      setPricingV6Feedback(
        "pricingV6SimulationFeedback",
        payload.reused ? "Previa salva reutilizada." : "Previa atualizada com dados locais.",
        "success",
      );
    }

    async function runPricingV6SalePriceSimulation(key, salePrice, output) {
      const payload = await apiPost("/shops/active/pricing/price-simulation", { key, salePrice });
      output.textContent = "Repasse liquido: " + pricingV6Money(payload.netPayoutCents)
        + " | Margem: " + pricingV6Percent(payload.marginRate);
    }

The refresh button calls runPricingV6Simulation({ forceRefresh: true }); normal Simular requests reuse. Render commission, fixed fee, coupon, campaign, cost, repasse liquido and margin percentage in the expanded result.

- [ ] **Step 3: Add responsive styling**

    .pricing-v6-sale-simulator {
      display:grid;
      grid-template-columns:minmax(130px, 1fr) auto;
      gap:8px;
      align-items:end;
    }
    .pricing-v6-sale-simulator__result {
      grid-column:1 / -1;
      min-height:18px;
      font-size:12px;
      color:var(--muted);
    }
    @media (max-width:700px) {
      .pricing-v6-sale-simulator { grid-template-columns:1fr; }
    }

Use the existing 8px radius and current button/input classes. Never create a request until the user presses Calcular or Atualizar dados.

- [ ] **Step 4: Manual browser verification**

Run: npm --prefix shopee run start

Use an authenticated local browser flow to confirm: opening V6 does not call Shopee; normal simulation shows Previa salva reutilizada on repeat; Atualizar dados creates a new snapshot; a R$ 9,00 free simulation shows all monetary components; no job is created until the existing confirmation flow is used.

- [ ] **Step 5: Run checks and commit**

Run: node --test shopee/test/pricingV6Engine.test.js && npm --prefix shopee run db:schema:check

Expected: all tests pass and schema check exits 0.

    git add shopee/public/index.html shopee/public/app.js shopee/public/styles.css
    git commit -m "feat(shopee): add V6 price payoff simulator"

## Task 5: Verify the finished change set

**Files:**
- Verify: all files changed in Tasks 1-4

**Interfaces:**
- Consumes: final branch content, migration status and V6 tests.
- Produces: evidence suitable for staging deployment without applying any Shopee price change.

- [ ] **Step 1: Run the full Shopee test suite**

Run: node --test shopee/test/*.test.js

Expected: exit 0 with all suites passing.

- [ ] **Step 2: Check static integrity and migration status**

Run: git diff --check && npm --prefix shopee run db:schema:check && npm --prefix shopee run db:migrate:status

Expected: no whitespace errors, schema check exit 0, and only the new Shopee migration pending before deployment.

- [ ] **Step 3: Inspect the final diff and commit**

Run: git status --short && git diff --stat HEAD~4..HEAD

Expected: only Motor V6 engine, persistence, endpoint, UI, CSS, migration and tests are included.

    git add -A
    git commit -m "test(shopee): verify V6 economic pricing flow"
