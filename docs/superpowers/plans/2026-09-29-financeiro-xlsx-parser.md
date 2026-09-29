# Parser seguro no importador financeiro ML Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remover a leitura SheetJS de XLSX enviado pelo cliente no importador de custos do Seller ML.

**Architecture:** O serviço financeiro reutiliza `parseXlsxRows`, o parser ExcelJS com limites da Etapa 5. A transformação de linhas para a estrutura atual do importador é preservada; apenas a leitura torna-se assíncrona e segura.

**Tech Stack:** Node.js CommonJS, node:test, ExcelJS, Express.

---

### Task 1: Regressão de importação financeira

**Files:**
- Create: `apps/seller-ml/tests/financeiro-ml-safe-import.test.js`
- Modify: `apps/seller-ml/services/financeiroMlService.js:1807-1819,3822-3824`

- [ ] **Step 1: Write the failing test**

Create a `node:test` test that loads `financeiroMlService` with a stub for
`./safeWorkbookParser`, calls `FinanceiroMlService.importCosts` with `.xlsx`
and base64 content, and asserts the stub was awaited. Stub database-facing
dependencies so the assertion is limited to parsing.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/seller-ml/tests/financeiro-ml-safe-import.test.js`

Expected: FAIL because the existing synchronous parser still loads SheetJS and
does not call `parseXlsxRows`.

- [ ] **Step 3: Write minimal implementation**

In `financeiroMlService.js`, import the shared parser and replace:

```js
const workbook = XLSX.read(buffer, { type: "buffer" });
const sheet = workbook.Sheets[workbook.SheetNames[0]];
if (!sheet) return [];
return XLSX.utils.sheet_to_json(sheet, { defval: "", raw: true });
```

with:

```js
return parseXlsxRows(buffer, { preferredSheet: "Custos" });
```

Make `parseImportRows` and its call from `importCosts` asynchronous.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test apps/seller-ml/tests/financeiro-ml-safe-import.test.js`

Expected: PASS with one test and zero failures.

### Task 2: Regression, commit and deploy

**Files:**
- Modify: tracked Stage 5 and webhook hotfix files already validated in this worktree

- [ ] **Step 1: Validate code and suites**

Run:

```powershell
npm --prefix apps/seller-ml run test:stage1-security
npm --prefix apps/seller-ml run test:stage2-tokens
npm --prefix apps/seller-ml run test:stage3-queues
npm --prefix apps/seller-ml run test:stage4-data
npm --prefix apps/seller-ml run test:stage5-infra
node --check apps/seller-ml/services/financeiroMlService.js
git diff --check
```

- [ ] **Step 2: Commit and publish**

Stage only the Stage 5 files, webhook hotfix, parser regression test and design/plan;
do not stage existing untracked backup folders. Commit with a security-focused
message and push `main` with the workstation's default GitHub SSH identity.

- [ ] **Step 3: Deploy the web service**

On the VPS, fast-forward `/opt/dachbyte/repository` to `origin/main`, rebuild
and force-recreate `seller-ml-web`, then inspect its status and recent logs.
The worker is not required for this parser/webhook-route change.
