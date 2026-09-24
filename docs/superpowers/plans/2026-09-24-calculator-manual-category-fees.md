# Calculadora ML: categoria manual e comissão oficial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No modo manual, usar 11,5%/16,5% como estimativa explícita até categoria e preço permitirem consultar a comissão real do Mercado Livre.

**Architecture:** A Calculadora expõe sugestões pelo preditor oficial de categorias MLB. O cálculo existente é a única fonte da taxa: com categoria, preço e tipo usa `listing_prices`; no manual, se essa consulta falhar, refaz integralmente a simulação com a estimativa e declara a origem no payload. O navegador conserva o ID da categoria separado do texto pesquisado.

**Tech Stack:** Express, JavaScript CommonJS/browser, API Mercado Livre, `node:test`.

---

## Estrutura de arquivos

- `apps/seller-ml/services/financeiroMlCalculatorService.js`: preditor oficial, `listing_prices` e fallback.
- `apps/seller-ml/controllers/FinanceiroMlCalculatorController.js`: handler da busca.
- `apps/seller-ml/routes/financeiroMlRoutes.js`: rota protegida como a Calculadora.
- `apps/seller-ml/public/js/financeiro-ml-calculator-rules.js`: estimativas e elegibilidade da cotação.
- `apps/seller-ml/public/js/financeiro-ml-calculadora.js`: combobox, selo e recálculo.
- `apps/seller-ml/views/financeiro-ml-calculadora.html` e `apps/seller-ml/public/css/financeiro-ml-calculadora.css`: interface acessível.
- `apps/seller-ml/tests/financeiro-ml-calculator-manual-fees.test.js`: API e fallback.
- Testes existentes de rota, UX e HTML: contrato da tela.

### Task 1: Publicar sugestões oficiais de categoria

**Files:**
- Modify: `apps/seller-ml/controllers/FinanceiroMlCalculatorController.js`
- Modify: `apps/seller-ml/routes/financeiroMlRoutes.js`
- Modify: `apps/seller-ml/services/financeiroMlCalculatorService.js`
- Modify: `apps/seller-ml/tests/financeiro-ml-calculator-routes.test.js`
- Create: `apps/seller-ml/tests/financeiro-ml-calculator-manual-fees.test.js`

- [ ] **Step 1: Escrever testes RED**

```js
const categories = routes.find((row) => row.method === "get" && row.args[0] === "/calculator/categories");
assert.equal(categories.args[1], permission);
assert.deepEqual(Calculator._test.normalizeCategorySuggestions([
  { category_id: "MLB1055", category_name: "Celulares", domain_id: "MLB-CELLPHONES", domain_name: "Celulares" },
  { category_id: "", category_name: "Inválida" },
]), [{ id: "MLB1055", name: "Celulares", domain_id: "MLB-CELLPHONES", domain_name: "Celulares" }]);
```

- [ ] **Step 2: Rodar RED**

Run: `node --test apps/seller-ml/tests/financeiro-ml-calculator-routes.test.js apps/seller-ml/tests/financeiro-ml-calculator-manual-fees.test.js`

Expected: FAIL porque a rota e o normalizador não existem.

- [ ] **Step 3: Implementar a rota e o serviço**

```js
// FinanceiroMlCalculatorController.js
async categories(req, res) {
  try { return res.json(await FinanceiroMlCalculatorService.categories(req.query || {}, context(req, res))); }
  catch (error) { return handleError(res, error, "Falha ao buscar categorias para a calculadora."); }
}

// financeiroMlRoutes.js
router.get("/calculator/categories", allowMarginCalculator, FinanceiroMlCalculatorController.categories);

// financeiroMlCalculatorService.js
function buildCategoryDiscoveryUrl(query) {
  const url = new URL(`${ML_API}/sites/MLB/domain_discovery/search`);
  url.searchParams.set("q", text(query)); url.searchParams.set("limit", "3"); return url;
}
function normalizeCategorySuggestions(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: text(row?.category_id), name: text(row?.category_name),
    domain_id: text(row?.domain_id), domain_name: text(row?.domain_name),
  })).filter((row) => row.id && row.name);
}
```

Implementar `categories()`: exigir `accountKey`, retornar `{ success: true, categories: [] }` com menos de três caracteres sem chamar ML, preparar autenticação e retornar no máximo três sugestões normalizadas. Expor os dois helpers em `_test`.

- [ ] **Step 4: Rodar GREEN**

Run: `node --check apps/seller-ml/controllers/FinanceiroMlCalculatorController.js; node --check apps/seller-ml/services/financeiroMlCalculatorService.js; node --test apps/seller-ml/tests/financeiro-ml-calculator-routes.test.js apps/seller-ml/tests/financeiro-ml-calculator-manual-fees.test.js`

Expected: PASS.

- [ ] **Step 5: Commitar**

```bash
git add apps/seller-ml/controllers/FinanceiroMlCalculatorController.js apps/seller-ml/routes/financeiroMlRoutes.js apps/seller-ml/services/financeiroMlCalculatorService.js apps/seller-ml/tests/financeiro-ml-calculator-routes.test.js apps/seller-ml/tests/financeiro-ml-calculator-manual-fees.test.js
git commit -m "Add ML calculator category suggestions"
```

### Task 2: Aplicar estimativa e fallback seguro

**Files:**
- Modify: `apps/seller-ml/services/financeiroMlCalculatorService.js`
- Modify: `apps/seller-ml/public/js/financeiro-ml-calculator-rules.js`
- Modify: `apps/seller-ml/tests/financeiro-ml-calculator-manual-fees.test.js`
- Modify: `apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js`

- [ ] **Step 1: Escrever testes RED**

```js
assert.deepEqual(rules.manualListingFee("gold_special"), { commissionRatePct: 11.5, commissionFixed: 0 });
assert.equal(rules.manualListingFee("gold_pro").commissionRatePct, 16.5);
assert.equal(rules.canQuoteMarketplaceFee({ price: 100, categoryId: "MLB1055", listingTypeId: "gold_pro" }), true);
assert.equal(rules.canQuoteMarketplaceFee({ price: 0, categoryId: "MLB1055", listingTypeId: "gold_pro" }), false);

const result = await Calculator.calculate({
  mode: "manual", price: 100, category_id: "MLB1055", listing_type_id: "gold_special",
  use_ml_fee: true, commission_rate_pct: 11.5, commission_fixed: 0,
}, { accountKey: "drossi", mlCreds: { access_token: "token" } });
assert.equal(result.fee_mode, "estimativa");
assert.match(result.note, /estimativa/i);
```

Configurar `listingPriceRequest` para lançar 503 no último teste e sempre restaurá-lo em `finally`.

- [ ] **Step 2: Rodar RED**

Run: `node --test apps/seller-ml/tests/financeiro-ml-calculator-manual-fees.test.js apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js`

Expected: FAIL porque os helpers usam 12%/17% e a indisponibilidade do ML ainda é propagada.

- [ ] **Step 3: Implementar o resolver de origem**

```js
const MANUAL_LISTING_FEES = Object.freeze({
  gold_special: Object.freeze({ commissionRatePct: 11.5, commissionFixed: 0 }),
  gold_pro: Object.freeze({ commissionRatePct: 16.5, commissionFixed: 0 }),
});
function canQuoteMarketplaceFee({ price, categoryId, listingTypeId } = {}) {
  return Number(price) > 0 && Boolean(String(categoryId || "").trim()) &&
    ["gold_special", "gold_pro"].includes(String(listingTypeId || ""));
}
function manualFeeMode({ price, categoryId, listingTypeId = "gold_special" } = {}) {
  return canQuoteMarketplaceFee({ price, categoryId, listingTypeId })
    ? { source: "consultando", quote: true }
    : { source: "estimativa", quote: false };
}
```

Refatorar `calculate()` para executar o algoritmo corrente em uma função interna que recebe `useMlFee`. Se `mode === "manual"`, a tarifa oficial foi solicitada e qualquer `listing_prices` ficar indisponível, executar de novo com `useMlFee: false`, preservando 11,5%/16,5% enviados pelo navegador. Retornar `fee_mode: "estimativa"` e a nota de fallback. Para `mode: "listing"`, não fazer fallback; para `fetchListingFee()`, preservar o erro explícito e nunca retornar comissão zero.

- [ ] **Step 4: Rodar GREEN**

Run: `node --check apps/seller-ml/services/financeiroMlCalculatorService.js; node --test apps/seller-ml/tests/financeiro-ml-calculator-manual-fees.test.js apps/seller-ml/tests/financeiro-ml-calculator-hardening.test.js apps/seller-ml/tests/pricing-engine.test.js`

Expected: PASS.

- [ ] **Step 5: Commitar**

```bash
git add apps/seller-ml/services/financeiroMlCalculatorService.js apps/seller-ml/public/js/financeiro-ml-calculator-rules.js apps/seller-ml/tests/financeiro-ml-calculator-manual-fees.test.js apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js
git commit -m "Use estimated calculator fees until ML quote succeeds"
```

### Task 3: Criar o combobox e os estados de interface

**Files:**
- Modify: `apps/seller-ml/views/financeiro-ml-calculadora.html`
- Modify: `apps/seller-ml/public/css/financeiro-ml-calculadora.css`
- Modify: `apps/seller-ml/public/js/financeiro-ml-calculadora.js`
- Modify: `apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js`
- Modify: `apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js`

- [ ] **Step 1: Escrever testes RED**

```js
assert.match(html, /id="calc-category-query"/);
assert.match(html, /id="calc-category-id"[^>]*type="hidden"/);
assert.match(html, /id="calc-category-suggestions"[^>]*role="listbox"/);
assert.doesNotMatch(html, /id="calc-use-ml-fee"/);
assert.deepEqual(rules.manualFeeMode({ price: 120, categoryId: "" }), { source: "estimativa", quote: false });
assert.deepEqual(rules.manualFeeMode({ price: 120, categoryId: "MLB1055" }), { source: "consultando", quote: true });
```

- [ ] **Step 2: Rodar RED**

Run: `node --test apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js`

Expected: FAIL porque categoria ainda é campo livre e o checkbox ainda existe.

- [ ] **Step 3: Implementar HTML e JavaScript**

```html
<label class="calc-field" id="calc-category-wrap">
  <span>Categoria ML <em>opcional para a estimativa</em></span>
  <input id="calc-category-query" type="search" autocomplete="off" role="combobox"
    aria-autocomplete="list" aria-expanded="false" aria-controls="calc-category-suggestions"
    placeholder="Digite o produto para buscar a categoria" />
  <input id="calc-category-id" name="category_id" type="hidden" />
  <ul id="calc-category-suggestions" class="calc-category-suggestions" role="listbox" hidden></ul>
  <small id="calc-category-hint" class="calc-field__hint">Sem categoria, usamos uma comissão estimada.</small>
</label>
```

Ao editar `calc-category-query`, limpar `calc-category-id`, reaplicar a estimativa e debounciar 300 ms `GET /api/financeiro-ml/calculator/categories?q={texto}`. Renderizar sugestões com `textContent`, nunca `innerHTML`; ao selecionar por clique ou Enter, salvar o ID oculto, fechar a lista e agendar o cálculo. Usar contador de requisição para ignorar respostas antigas. `buildPayload()` deve ler somente `calc-category-id` e definir `use_ml_fee` por `rules.canQuoteMarketplaceFee(...)`; remover o checkbox que forçava esse estado. Manter a categoria visível no manual e bloqueada para anúncio carregado.

- [ ] **Step 4: Implementar estilos e selo**

```css
.calc-category-suggestions { position: absolute; z-index: 3; width: 100%; margin-top: .35rem; border: 1px solid var(--fml-line); border-radius: 12px; background: var(--fml-surface); box-shadow: var(--fml-shadow); }
.calc-category-suggestions [role="option"]:is(:hover, [aria-selected="true"]) { background: color-mix(in srgb, var(--fml-blue) 10%, var(--fml-surface)); }
.calc-badge[data-tone="estimate"] { color: var(--fml-warning-text); background: var(--fml-warning-bg); }
```

Adicionar tokens `--fml-warning-text` e `--fml-warning-bg` equivalentes da Margem de venda nos temas claro/escuro. Exibir amarelo “Comissão estimada”, neutro “Consultando comissão…” e azul “Comissão Mercado Livre”. Quando `fee_mode === "estimativa"`, mostrar a nota de fallback; a tarifa fixa continua opcional e só recebe valor diferente de zero quando a resposta oficial retornar um.

- [ ] **Step 5: Rodar GREEN**

Run: `node --check apps/seller-ml/public/js/financeiro-ml-calculadora.js; node --test apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js`

Expected: PASS.

- [ ] **Step 6: Commitar**

```bash
git add apps/seller-ml/views/financeiro-ml-calculadora.html apps/seller-ml/public/css/financeiro-ml-calculadora.css apps/seller-ml/public/js/financeiro-ml-calculadora.js apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js
git commit -m "Add category-backed manual calculator fees"
```

### Task 4: Validar o fluxo completo

**Files:**
- Modify: `apps/seller-ml/tests/financeiro-ml-calculator-ui-payload.test.js`
- Test: `apps/seller-ml/tests/financeiro-ml-calculator-*.test.js`

- [ ] **Step 1: Escrever teste de contrato de payload**

```js
assert.equal(rules.canQuoteMarketplaceFee({ price: 0, categoryId: "MLB1055", listingTypeId: "gold_special" }), false);
assert.equal(rules.canQuoteMarketplaceFee({ price: 100, categoryId: "", listingTypeId: "gold_special" }), false);
assert.equal(rules.canQuoteMarketplaceFee({ price: 100, categoryId: "MLB1055", listingTypeId: "gold_special" }), true);
```

- [ ] **Step 2: Rodar a suíte completa**

Run: `node --test apps/seller-ml/tests/financeiro-ml-calculadora-ui.test.js apps/seller-ml/tests/financeiro-ml-calculator-hardening.test.js apps/seller-ml/tests/financeiro-ml-calculator-manual-fees.test.js apps/seller-ml/tests/financeiro-ml-calculator-routes.test.js apps/seller-ml/tests/financeiro-ml-calculator-ui-payload.test.js apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js apps/seller-ml/tests/pricing-engine.test.js`

Expected: PASS.

- [ ] **Step 3: Verificação manual**

```text
1. Manual/Clássico mostra 11,5% e selo de estimativa; Premium mostra 16,5%.
2. Digitar produto exibe até três sugestões; só a seleção habilita cotação oficial.
3. Sem preço, mantém estimativa; com preço, consulta e exibe comissão ML.
4. Alterar preço ou categoria reinicia o estado; apagar categoria retorna à estimativa.
5. Simular indisponibilidade mantém resultado calculado e mostra aviso de estimativa.
6. Carregar MLB mantém tipo, categoria e tarifas reais bloqueados.
```

- [ ] **Step 4: Verificar diff e commit final**

```bash
git diff --check
git status -sb
git add apps/seller-ml/tests/financeiro-ml-calculator-ui-payload.test.js
git commit -m "Test ML calculator manual fee flow"
```
