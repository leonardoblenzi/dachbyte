# Magalu Cost XLSX Simplified Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exportar e importar custos Magalu em XLSX com apenas SKU, Produto, Preço atual e Custo produto, no padrão simplificado do Meli.

**Architecture:** O serviço de workbook define as quatro colunas e transforma apenas SKU e custo em entrada de importação. O repositório já preserva campos omitidos, então suas rotas, o esquema do banco e a edição detalhada da tela permanecem inalterados.

**Tech Stack:** Node.js, ExcelJS, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-08-magalu-cost-xlsx-without-tax-design.md`

---

## Arquivos

- Modificar `apps/seller-magalu/src/services/costWorkbookService.js`: modelo e validação da planilha.
- Modificar `apps/seller-magalu/src/controllers/financialController.js`: exportação deixa de consultar a alíquota global que não aparece na planilha.
- Modificar `apps/seller-magalu/tests/cost-workbook.test.js`: cabeçalho, round-trip e preservação dos demais campos.
- Modificar a especificação acima para registrar as quatro colunas aprovadas.

## Task 1: Contrato de quatro colunas

- [ ] **Step 1: Escrever teste vermelho.** Exportar um SKU e ler o workbook com ExcelJS; conferir os cabeçalhos `["SKU","Produto","Preço atual","Custo produto"]`, quatro colunas, e que `parseCostWorkbook` devolve somente `{sku:"SKU-1",unit_cost:60}`.
- [ ] **Step 2: Confirmar falha.** Rodar `node --test tests/cost-workbook.test.js` em `apps/seller-magalu`; a planilha atual tem dez colunas.
- [ ] **Step 3: Implementar.** Definir `COLUMNS` com os quatro pares `["SKU","sku"]`, `["Produto","title"]`, `["Preço atual","price"]`, `["Custo produto","unit_cost"]`; `EDITABLE=["unit_cost"]`; remover `globalTax` da escrita; usar `D1` no autofiltro; não ler observações.
- [ ] **Step 4: Confirmar verde.** Rodar `node --test tests/cost-workbook.test.js`; round-trip e validação numérica devem passar.

## Task 2: Rejeição do modelo antigo e isolamento dos outros custos

- [ ] **Step 1: Escrever teste vermelho.** Montar um workbook com cabeçalho antigo e verificar erro 400 com mensagem `Modelo de custos desatualizado`; no teste de importação válida, conferir que `tax_rate`, embalagem, operacional, outros e observações existentes continuam iguais após enviar só custo.
- [ ] **Step 2: Confirmar falha esperada.** Rodar `node --test tests/cost-workbook.test.js`; a mensagem especial para formato antigo ainda não existe.
- [ ] **Step 3: Implementar.** Antes do erro genérico de cabeçalho, detectar os cabeçalhos antigos `Imposto legado %` ou `Alíquota global (informativa)` e lançar erro 400 orientando nova exportação; rejeitar qualquer quinta coluna; não passar outros campos para `importCosts`; em `exportCosts`, chamar `buildCostWorkbook(rows)` sem consultar a taxa global.
- [ ] **Step 4: Verificar.** Rodar teste direcionado, `npm test` em `apps/seller-magalu`, `node --check src/services/costWorkbookService.js` e `git diff --check`.
- [ ] **Step 5: Commit local.** Incluir apenas especificação, plano, workbook, controlador e teste no commit `fix(magalu): simplify cost workbook like ML`. Não fazer push/deploy sem novo pedido.
