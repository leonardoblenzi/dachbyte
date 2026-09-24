# Calculadora UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aplicar interação automática e padrão visual da Margem de venda à Calculadora ML.

**Architecture:** O script da Calculadora centralizará a seleção de tarifa, modalidade de frete e agendamento de cálculo em helpers testáveis. O HTML remove o submit manual e o CSS passa a derivar cores e superfície dos tokens Financeiro ML.

**Tech Stack:** HTML, CSS, JavaScript do navegador, `node:test`.

---

### Task 1: Regras de comissão e frete

**Files:**
- Modify: `apps/seller-ml/public/js/financeiro-ml-calculadora.js`
- Modify: `apps/seller-ml/views/financeiro-ml-calculadora.html`
- Test: `apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js`

- [ ] **Step 1: Escrever testes RED**

```js
assert.deepEqual(manualListingFee("gold_special"), { commissionRatePct: 12, commissionFixed: 0 });
assert.equal(manualListingFee("gold_pro").commissionRatePct, 17);
assert.deepEqual(shippingVisibility("mercado_envios"), { seller: true, buyer: false });
```

- [ ] **Step 2: Rodar RED**

Run: `node --test apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js`

Expected: FAIL porque os helpers e as regras ainda não existem.

- [ ] **Step 3: Implementar GREEN**

Adicionar helpers exportados para teste, preencher e desabilitar comissão no
modo manual, travar o tipo somente para anúncio carregado e mostrar apenas o
campo de frete selecionado.

- [ ] **Step 4: Rodar GREEN**

Run: `node --test apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js`

Expected: PASS.

### Task 2: Cálculo automático e estrutura visual

**Files:**
- Modify: `apps/seller-ml/public/js/financeiro-ml-calculadora.js`
- Modify: `apps/seller-ml/views/financeiro-ml-calculadora.html`
- Modify: `apps/seller-ml/public/css/financeiro-ml-calculadora.css`
- Test: `apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js`

- [ ] **Step 1: Escrever testes RED**

```js
const scheduler = createCalculationScheduler(() => calls.push("calculate"), 300);
scheduler.schedule();
scheduler.schedule();
await wait(350);
assert.deepEqual(calls, ["calculate"]);
```

- [ ] **Step 2: Rodar RED**

Run: `node --test apps/seller-ml/tests/financeiro-ml-calculator-ux.test.js`

Expected: FAIL porque o agendador não existe.

- [ ] **Step 3: Implementar GREEN**

Remover o botão de cálculo, deixar Limpar, escutar campos relevantes e
agendar cálculo apenas com dados válidos. Trocar `calc-shell` pelo padrão
`container`, compartilhar os tokens `--fml-*` e substituir o verde próprio
por azul/amarelo e estados da Margem de venda nos dois temas.

- [ ] **Step 4: Rodar regressão**

Run: `node --test apps/seller-ml/tests/financeiro-ml-calculator-*.test.js apps/seller-ml/tests/pricing-engine.test.js`

Expected: PASS.
