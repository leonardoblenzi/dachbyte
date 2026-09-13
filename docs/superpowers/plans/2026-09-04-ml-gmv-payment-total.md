# GMV pelo Total do Pagamento ML Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer a Margem de Venda do Mercado Livre usar o total financeiro do pagamento como GMV realizado, mantendo custos e métricas de precificação separados.

**Architecture:** `financeiroMlService` resolverá o GMV de cada pedido a partir de `order.payments`, com fallback determinístico baseado nos componentes financeiros da venda. A mesma função de cálculo alimentará resumo, linhas por período e exportação XLSX; a tela só atualiza sua linguagem de ajuda. Funções puras expostas em `_test` permitirão testes de regressão sem chamadas à API nem banco.

**Tech Stack:** Node.js CommonJS, `node:test`, `node:assert/strict`, SheetJS (`xlsx`), HTML estático.

---

### Task 1: Criar testes de regressão para a resolução do GMV

**Files:**
- Create: `ml/tests/financeiro-ml-gmv.test.js`
- Modify: `ml/services/financeiroMlService.js: módulo exportado, adicionando somente `_test` para funções puras`

- [ ] **Step 1: Escrever o teste que deve falhar para o total direto do pagamento**

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveOrderPaymentGmv } = require("../services/financeiroMlService")._test;

test("resolve GMV pelo net_received_amount dos pagamentos aprovados", () => {
  const result = resolveOrderPaymentGmv({
    payments: [
      { id: 11, status: "approved", transaction_details: { net_received_amount: 1200.66 } },
      { id: 12, status: "approved", transaction_details: { net_received_amount: 700 } },
      { id: 13, status: "cancelled", transaction_details: { net_received_amount: 900 } },
    ],
  });

  assert.deepEqual(result, {
    amount: 1900.66,
    source: "order.payments.total",
    payment_ids: ["11", "12"],
  });
});
```

- [ ] **Step 2: Executar o teste e confirmar a falha esperada**

Run: `node --test tests/financeiro-ml-gmv.test.js`

Expected: FAIL porque `_test.resolveOrderPaymentGmv` ainda não existe.

- [ ] **Step 3: Escrever testes para a fonte alternativa e ausência de pagamento utilizável**

```js
test("resolve GMV por total pago menos marketplace fee", () => {
  const result = resolveOrderPaymentGmv({
    payments: [{ id: 21, status: "approved", total_paid_amount: 200, marketplace_fee: 25 }],
  });

  assert.deepEqual(result, {
    amount: 175,
    source: "order.payments.total",
    payment_ids: ["21"],
  });
});

test("nao resolve GMV quando nao ha pagamento utilizavel", () => {
  assert.deepEqual(resolveOrderPaymentGmv({ payments: [{ id: 31, status: "rejected" }] }), {
    amount: null,
    source: "unavailable",
    payment_ids: [],
  });
});
```

- [ ] **Step 4: Executar novamente e confirmar que ambos os casos falham pela mesma API ausente**

Run: `node --test tests/financeiro-ml-gmv.test.js`

Expected: FAIL com erro de acesso a `resolveOrderPaymentGmv`, sem erro de ambiente.

- [ ] **Step 5: Implementar as funções puras mínimas e expô-las apenas para teste**

Adicionar após os helpers existentes em `ml/services/financeiroMlService.js`:

```js
function paymentIsUsable(payment = {}) {
  const status = normalizeString(payment?.status).toLowerCase();
  return !["rejected", "cancelled", "canceled"].includes(status);
}

function readPaymentTotalAmount(payment = {}) {
  const direct = maybeNumber(payment?.transaction_details?.net_received_amount ?? payment?.net_received_amount);
  if (direct != null) return Math.max(0, direct);
  const totalPaid = maybeNumber(payment?.total_paid_amount ?? payment?.transaction_details?.total_paid_amount);
  const marketplaceFee = maybeNumber(payment?.marketplace_fee);
  return totalPaid != null && marketplaceFee != null ? Math.max(0, totalPaid - marketplaceFee) : null;
}

function resolveOrderPaymentGmv(order = {}) {
  const payments = (Array.isArray(order?.payments) ? order.payments : []).filter(paymentIsUsable);
  const payment_ids = payments.map((payment) => String(payment?.id || "")).filter(Boolean);
  if (!payments.length) return { amount: null, source: "unavailable", payment_ids };
  const values = payments.map(readPaymentTotalAmount);
  if (values.some((value) => value == null)) return { amount: null, source: "unavailable", payment_ids };
  return { amount: values.reduce((sum, value) => sum + value, 0), source: "order.payments.total", payment_ids };
}
```

No fim do módulo, expor somente estas funções:

```js
FinanceiroMlService._test = { resolveOrderPaymentGmv };
```

- [ ] **Step 6: Executar os testes e confirmar que passam**

Run: `node --test tests/financeiro-ml-gmv.test.js`

Expected: PASS com três subtestes.

- [ ] **Step 7: Criar o commit da unidade testada**

```bash
git add ml/services/financeiroMlService.js ml/tests/financeiro-ml-gmv.test.js
git commit -m "test: cover ML payment-total GMV resolution"
```

### Task 2: Aplicar o GMV de pagamento às linhas e ao resumo de margem

**Files:**
- Modify: `ml/services/financeiroMlService.js: buildOrderFinancials`
- Modify: `ml/tests/financeiro-ml-gmv.test.js`

- [ ] **Step 1: Escrever o teste que deve falhar para a fórmula de GMV, resultado e margem**

Adicionar e testar uma função pura de cálculo:

```js
const { resolveRealizedGmv } = require("../services/financeiroMlService")._test;

test("usa o total do pagamento no resultado e mantém custos separados", () => {
  const result = resolveRealizedGmv({
    paymentGmv: { amount: null, source: "unavailable", payment_ids: [] },
    fullOrderRevenue: 1144.08,
    revenueBase: 1144.08,
    buyerShippingFull: 935.27,
    fullOrderCommissions: 173.05,
    sellerCouponDiscountFull: 5.64,
    selectionRatio: 1,
    totalCosts: 300,
  });

  assert.equal(result.gmv, 1900.66);
  assert.equal(result.profit, 1600.66);
  assert.equal(result.marginPct, 84.22);
  assert.equal(result.source, "fallback_ml_payment_total_components");
});
```

- [ ] **Step 2: Executar o teste e confirmar a falha esperada**

Run: `node --test tests/financeiro-ml-gmv.test.js`

Expected: FAIL porque `_test.resolveRealizedGmv` ainda não existe.

- [ ] **Step 3: Implementar o cálculo mínimo de GMV realizado**

Adicionar uma função pura que receba o GMV resolvido, os componentes de fallback, a proporção do filtro e o custo total; ela deve retornar `gmv`, `source`, `payment_ids`, `product_revenue`, `profit` e `marginPct`. O fallback deve ser:

```js
const fallbackFullGmv = Math.max(
  0,
  (fullOrderRevenue || revenueBase) + buyerShippingFull - fullOrderCommissions - sellerCouponDiscountFull,
);
const fullPaymentGmv = paymentGmv?.amount != null ? Math.max(0, Number(paymentGmv.amount)) : fallbackFullGmv;
const gmv = fullPaymentGmv * selectionRatio;
const profit = gmv - totalCosts;
const marginPct = gmv > 0 ? (profit / gmv) * 100 : 0;
```

- [ ] **Step 4: Executar o teste e confirmar que passa**

Run: `node --test tests/financeiro-ml-gmv.test.js`

Expected: PASS; o fallback retorna `1900.66`, resultado `1600.66` e margem `84.22`.

- [ ] **Step 5: Integrar a função em `buildOrderFinancials` sem alterar a base fiscal ou o equilíbrio**

Na rotina de cada pedido:

```js
const [shipment, discounts, paymentGmv] = await Promise.all([
  fetchShipmentCosts(state, shipmentId, seller.id).catch(/* fallback atual de shipment */),
  fetchOrderDiscount(state, orderId).catch(/* fallback atual de descontos */),
  Promise.resolve(resolveOrderPaymentGmv(order)),
]);
const fullOrderCommissions = extractOrderItems(order)
  .reduce((sum, row) => sum + numberOrZero(row.sale_fee), 0);
const realized = resolveRealizedGmv({
  paymentGmv,
  fullOrderRevenue,
  revenueBase,
  buyerShippingFull,
  fullOrderCommissions,
  sellerCouponDiscountFull: numberOrZero(discounts.seller_coupon_discount),
  selectionRatio,
  totalCosts,
});
```

Usar `realized.gmv` para `summary.period_revenue`, `order.gmv`, `profit` e `marginPct`; manter `revenueBase` para `sold_unit_price`, `commissionRate`, `taxBaseExtra` e `breakEvenTotal`. Incluir na linha `gmv_source`, `payment_ids` e `product_revenue`.

- [ ] **Step 6: Executar os testes específicos e a verificação de sintaxe**

Run: `node --test tests/financeiro-ml-gmv.test.js && node --check services/financeiroMlService.js`

Expected: PASS para os quatro testes e nenhuma saída de erro de sintaxe.

- [ ] **Step 7: Criar o commit da integração de cálculo**

```bash
git add ml/services/financeiroMlService.js ml/tests/financeiro-ml-gmv.test.js
git commit -m "fix: calculate ML margin from payment-total GMV"
```

### Task 3: Exportar auditoria do GMV e alinhar os textos da tela

**Files:**
- Modify: `ml/services/financeiroMlService.js: buildMarginExportWorkbook`
- Modify: `ml/views/financeiro-ml-margem.html: tooltips do resumo e tabela de período`
- Modify: `ml/tests/financeiro-ml-gmv.test.js`

- [ ] **Step 1: Escrever o teste que deve falhar para os cabeçalhos do XLSX**

```js
const { buildMarginExportWorkbook } = require("../services/financeiroMlService")._test;

test("exporta colunas de auditoria do GMV no periodo", () => {
  const workbook = buildMarginExportWorkbook({
    period_rows: [{
      order_id: "2000018084427526",
      gmv: 1900.66,
      gmv_source: "order.payments.total",
      payment_ids: ["11", "12"],
      product_revenue: 1144.08,
    }],
  }, "period");
  const headers = XLSX.utils.sheet_to_json(workbook.Sheets["Margem por periodo"], { header: 1 })[0];

  assert.deepEqual(headers.slice(9, 14), ["GMV", "FONTE_GMV", "IDS_PAGAMENTO", "VALOR_PRODUTOS", "PRECO_MEDIO_UNITARIO"]);
});
```

Adicionar no início do teste `const XLSX = require("xlsx");`.

- [ ] **Step 2: Executar o teste e confirmar a falha esperada**

Run: `node --test tests/financeiro-ml-gmv.test.js`

Expected: FAIL porque a função de geração não está exposta para teste e os novos cabeçalhos ainda não existem.

- [ ] **Step 3: Incluir os campos e cabeçalhos no exportador**

Na serialização de `period_rows`, adicionar:

```js
GMV: numberOrZero(row.gmv),
FONTE_GMV: row.gmv_source || "",
IDS_PAGAMENTO: Array.isArray(row.payment_ids) ? row.payment_ids.join(" | ") : "",
VALOR_PRODUTOS: numberOrZero(row.product_revenue),
PRECO_MEDIO_UNITARIO: numberOrZero(row.sold_unit_price),
```

Inserir os três cabeçalhos de auditoria imediatamente depois de `GMV`, ajustar as larguras para as 31 colunas e expor `buildMarginExportWorkbook` em `_test`.

- [ ] **Step 4: Executar o teste de exportação e confirmar que passa**

Run: `node --test tests/financeiro-ml-gmv.test.js`

Expected: PASS; a sequência de cabeçalhos começa por `GMV`, `FONTE_GMV`, `IDS_PAGAMENTO`, `VALOR_PRODUTOS` e `PRECO_MEDIO_UNITARIO`.

- [ ] **Step 5: Atualizar somente os tooltips impactados da interface**

Em `ml/views/financeiro-ml-margem.html`, alterar os textos de ajuda de:

- `GMV considerado` para explicar que é o total do pagamento e que custos são separados;
- `Base do imposto` para indicar que ela é independente do GMV;
- `GMV` da tabela por período para indicar total do pagamento;
- `Frete comprador` para explicar participação no total financeiro e na base do imposto.

Não alterar colunas, IDs, estrutura HTML ou comportamento do JavaScript da tela.

- [ ] **Step 6: Validar regressões relevantes**

Run: `node --test tests/financeiro-ml-gmv.test.js && npm run test:jobs-panel && node --check services/financeiroMlService.js`

Expected: todos os testes passam; a validação sintática não gera saída.

- [ ] **Step 7: Revisar o diff e criar o commit final**

Run: `git diff --check && git diff -- ml/services/financeiroMlService.js ml/views/financeiro-ml-margem.html ml/tests/financeiro-ml-gmv.test.js`

Expected: nenhum erro de whitespace; diff limitado ao cálculo, exportação, tooltips e testes.

```bash
git add ml/services/financeiroMlService.js ml/views/financeiro-ml-margem.html ml/tests/financeiro-ml-gmv.test.js
git commit -m "fix: audit payment-total GMV in ML margin export"
```
