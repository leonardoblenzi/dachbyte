# ML Margin Unified Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer Resumo, Margem por período, Equilíbrio estimado e XLSX usarem a mesma busca por MLB, EAN, SKU ou nome.

**Architecture:** Resolver correspondências de anúncios no snapshot, na consulta direta de SKU e na base sincronizada de EAN. Filtrar cada item do pedido por MLB/SKU/EAN/nome, mantendo o fallback histórico de MLB/SKU/nome restrito à conta dos pedidos. A estimativa usa somente anúncios com detalhes disponíveis.

**Tech Stack:** Node.js, PostgreSQL, `node:test`, HTML.

**Spec:** `docs/superpowers/specs/2026-10-19-ml-margin-unified-search-design.md`

---

### Task 1: Resolver EAN e ampliar candidatos de anúncio

**Files:**
- Modify: `apps/seller-ml/services/financeiroMlService.js`
- Modify: `apps/seller-ml/tests/financeiro-ml-margin-search.test.js`

- [x] Teste RED: `selectMarginCandidates` deve retornar a união de SKU exato, EAN exato e título parcial; deve ignorar EAN parcial e outro seller.
- [x] Teste RED: busca na base `ml.mercadolivre_sku_catalog_items` usa `account_key`, `seller_id` e `eans ? $code` e preserva `variation_id`.
- [x] Implementar `itemHasExactEan(item, term)` e `lookupMarginEanMatches(accountKey, sellerId, term)`; usar `fetchItemDetails` para MLBs encontrados na base. A consulta direta de SKU continua estrita.
- [x] Rodar `node --test apps/seller-ml/tests/financeiro-ml-margin-search.test.js`; confirmar GREEN.

### Task 2: Filtrar os itens da venda, inclusive históricos

**Files:**
- Modify: `apps/seller-ml/services/financeiroMlService.js`
- Modify: `apps/seller-ml/tests/financeiro-ml-margin-search.test.js`

- [x] Teste RED: `buildOrderFinancials` com MLB sem candidato retorna somente pedido do MLB; SKU da venda seleciona sua variação; nome parcial encontra título da venda; EAN seleciona somente o MLB/variação identificado; termo inexistente mantém pedidos vazios.
- [x] Criar predicado `matchesMarginOrderItem(row, detail, searchScope)`, usado em `buildOrderFinancials` e `summarizeOrderRevenue`. Para EAN comparar o par MLB/variação da base; para SKU comparar `resolveOrderItemSkuCandidates`; para nome comparar título do anúncio e do pedido. Com status específico, exigir candidato elegível.
- [x] Passar o escopo à consulta de pedidos pagos e à consulta por data de criação em `listMargin`; manter os filtros financeiros existentes.
- [x] Rodar testes de margem e GMV; confirmar GREEN.

### Task 3: UI, exportação e regressão

**Files:**
- Modify: `apps/seller-ml/views/financeiro-ml-margem.html`
- Modify: `apps/seller-ml/public/js/financeiro-ml-margem.js` somente se a mensagem precisar distinguir pedido histórico de anúncio atual.
- Modify: `apps/seller-ml/tests/financeiro-ml-margem-ui.test.js`
- Modify: `apps/seller-ml/tests/financeiro-ml-margin-search.test.js`

- [x] Teste RED: campo informa MLB/SKU/EAN/nome; exportação reutiliza `listMargin` com `q` e não abre escopo.
- [x] Ajustar texto do campo e mensagem de resultado histórico sem estimativa de anúncio.
- [x] Executar `node --check apps/seller-ml/services/financeiroMlService.js`, `node --test apps/seller-ml/tests/financeiro-ml-margin-search.test.js apps/seller-ml/tests/financeiro-ml-margem-ui.test.js apps/seller-ml/tests/financeiro-ml-gmv.test.js`, `git diff --check`.
- [x] Revisar diff e preservar arquivos preexistentes; não fazer push ou deploy sem pedido específico.
