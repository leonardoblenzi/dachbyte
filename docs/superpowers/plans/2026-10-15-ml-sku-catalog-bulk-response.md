# ML SKU Catalog Bulk Response Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir a sincronização de Custos por SKU quando `/items/bulk` retorna `body` sem `code`, preservando erros explícitos e mostrando a contagem sem SKU.

**Architecture:** Um helper pequeno interpreta as entradas bulk. O job usa esse helper e não reconstrói a base quando qualquer ID descoberto fica sem detalhe válido. A aba lê os números da última execução já presentes no payload `meta.latest_sync`.

**Tech Stack:** Node.js, Bull, API Mercado Livre, JavaScript no navegador, `node:test`.

---

### Task 1: Contrato de resposta bulk

**Files:** Create `apps/seller-ml/services/financeiroMlCatalogBulk.js`; Create `apps/seller-ml/tests/financeiro-ml-catalog-bulk.test.js`.

- [x] Escrever testes que esperam `body.id` para entrada sem código, código 200 e `status_code: 200`; esperar rejeição para código 4xx/5xx e body sem ID.
- [x] Rodar `node --test tests/financeiro-ml-catalog-bulk.test.js` e confirmar falha pela ausência do helper.
- [x] Implementar `successfulBodies(payload)` validando `body.id` e códigos explícitos de sucesso.
- [x] Rodar o mesmo teste e confirmar sucesso.

### Task 2: Job não pode concluir falsamente vazio

**Files:** Modify `apps/seller-ml/services/financeiroMlSkuCatalogSyncService.js`; Test `apps/seller-ml/tests/financeiro-ml-catalog-bulk.test.js`.

- [x] Testar que IDs descobertos com detalhes vazios ou parciais provocam erro antes da reconstrução do catálogo.
- [x] Rodar o teste e confirmar falha pelo comportamento atual.
- [x] Usar `successfulBodies` em `fetchItemDetails`, propagar falhas HTTP e validar a coleta antes do upsert/rebuild.
- [x] Rodar testes de catálogo e billing shadow.

### Task 3: Contagem visível

**Files:** Modify `apps/seller-ml/public/js/financeiro-ml-custos.js`; Test `apps/seller-ml/tests/financeiro-ml-catalog-bulk.test.js`.

- [x] Testar que o status da aba mostra `total_skus` e `no_sku_items` da última sincronização.
- [x] Rodar o teste e confirmar falha.
- [x] Renderizar a contagem ao carregar a base e após concluir a sincronização.
- [x] Rodar os testes e `node --check` nos JS alterados.

### Task 4: Verificação

- [x] Rodar `node --test tests/financeiro-ml-catalog-bulk.test.js tests/finance-catalog-sync-shadow-billing.test.js tests/meli-bulk-contract.test.js`.
- [x] Rodar `npm run test:credits` e `npm run test:stage3-queues` no Seller ML.
- [x] Conferir diff e status; não executar migration, push ou deploy sem pedido.
