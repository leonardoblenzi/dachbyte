# DACHBYTE Core: Data da Venda Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Registrar vendas no dia operacional da empresa e rejeitar datas futuras na criação e edição.

**Architecture:** O runtime passa o fuso IANA da empresa para as regras de venda e dashboard. Um helper de domínio resolve `soldAt` com fallback para agora e rejeita instantes futuros; o cliente antecipa essa regra com valor e limite no campo nativo.

**Tech Stack:** Node.js/CommonJS, PostgreSQL, React/Vite e `node:test`.

---

## File structure

- `apps/business/core/src/modules/core/runtime/services/configurationService.js`: incluir o fuso no workspace.
- `apps/business/core/src/modules/core/runtime/services/salesService.js`: resolver e validar timestamps de venda.
- `apps/business/core/src/modules/core/runtime/services/dashboardService.js`: calcular “hoje” no fuso da empresa.
- `apps/business/core/src/client/core/formatters.js`: converter um instante em valor `datetime-local`.
- `apps/business/core/src/client/modals/config.js`, `ActionModalSections.jsx`, `extensions/optical/OpticalSalesPdv.jsx`, `extensions/optical/OpticalSalesPdvView.jsx` e `extensions/optical/opticalSaleState.js`: pré-preencher e limitar o campo usado pelo PDV ótico ativo.
- `round6Corrections.test.js` e novo `formatters.test.mjs`: regressão.

### Task 1: Expor o fuso da empresa

**Files:**
- Modify: `apps/business/core/src/modules/core/runtime/services/configurationService.js:12-25`
- Test: `apps/business/core/src/modules/core/round6Corrections.test.js`

- [ ] **Step 1: Write the failing test**

```js
test("company configuration exposes its timezone", () => {
  const configuration = source("src/modules/core/runtime/services/configurationService.js");
  assert.match(configuration, /c\.timezone as "timezone"/);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm --prefix apps/business/core test -- --test-name-pattern="company configuration exposes its timezone"`

Expected: FAIL because the select does not expose `c.timezone`.

- [ ] **Step 3: Implement the minimal query change**

```sql
select c.id as "companyId", c.name, c.document, c.phone, c.address,
  c.timezone as "timezone", c.segment_key as "segmentKey", c.plan_key as "planKey",
```

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm --prefix apps/business/core test -- --test-name-pattern="company configuration exposes its timezone"`

Expected: PASS.

Commit only the service and test with message: `Expose company timezone to Core runtime`.

### Task 2: Validar o instante comercial no backend

**Files:**
- Modify: `apps/business/core/src/modules/core/runtime/services/salesService.js:130-180,574,882,1260`
- Test: `apps/business/core/src/modules/core/round6Corrections.test.js`

- [ ] **Step 1: Write failing domain tests**

```js
test("sale timestamp defaults to now when omitted", () => {
  assert.equal(__test.resolveSaleTimestamp(null, "2026-10-16T15:00:00.000Z"), "2026-10-16T15:00:00.000Z");
});

test("sale timestamp rejects future instants", () => {
  assert.throws(
    () => __test.resolveSaleTimestamp("2026-10-16T15:00:01.000Z", "2026-10-16T15:00:00.000Z"),
    (error) => error.code === "SALE_DATE_IN_FUTURE" && error.statusCode === 400,
  );
});
```

- [ ] **Step 2: Verify RED**

Run: `npm --prefix apps/business/core test -- --test-name-pattern="sale timestamp"`

Expected: FAIL because `resolveSaleTimestamp` does not exist.

- [ ] **Step 3: Implement one resolver and call it on creation and edition**

```js
function resolveSaleTimestamp(value, now = new Date().toISOString()) {
  const reference = new Date(now);
  const resolved = String(value || "").trim() ? new Date(value) : reference;
  if (Number.isNaN(resolved.getTime())) throw Object.assign(new Error("Informe uma data/hora de venda valida"), { statusCode: 400, code: "SALE_DATE_INVALID" });
  if (resolved.getTime() > reference.getTime()) throw Object.assign(new Error("A data/hora da venda nao pode ser futura"), { statusCode: 400, code: "SALE_DATE_IN_FUTURE" });
  return resolved.toISOString();
}
```

Replace both existing `soldAt` fallback expressions with that helper and expose it in `__test`.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm --prefix apps/business/core test -- --test-name-pattern="sale timestamp"`

Expected: PASS.

Commit only the service and test with message: `Reject future sale timestamps`.

### Task 3: Usar o dia operacional no dashboard

**Files:**
- Modify: `apps/business/core/src/modules/core/runtime/services/dashboardService.js:10-100`
- Test: `apps/business/core/src/modules/core/round6Corrections.test.js`

- [ ] **Step 1: Write the failing query contract**

```js
test("dashboard evaluates sales and cash dates in the company timezone", () => {
  const dashboard = source("src/modules/core/runtime/services/dashboardService.js");
  assert.match(dashboard, /sold_at at time zone \$2/);
  assert.match(dashboard, /operational_at at time zone \$2/);
  assert.match(dashboard, /now\(\) at time zone \$2/);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm --prefix apps/business/core test -- --test-name-pattern="dashboard evaluates sales and cash dates"`

Expected: FAIL because the SQL uses `sold_at::date` and `current_date`.

- [ ] **Step 3: Implement timezone-aware date boundaries**

```js
const timezone = configuration.timezone || "America/Sao_Paulo";
```

For sales today use:
```sql
and (sold_at at time zone $2)::date = (now() at time zone $2)::date
```

Pass `[companyId, timezone]`. Apply the equivalent conversion to `operational_at`, and to the 30-day sales series grouping and lower bound.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm --prefix apps/business/core test -- --test-name-pattern="dashboard evaluates sales and cash dates"`

Expected: PASS.

Commit only the service and test with message: `Use company timezone in Core dashboard`.

### Task 4: Pré-preencher e limitar o campo no cliente

**Files:**
- Modify: `apps/business/core/src/client/core/formatters.js`
- Create: `apps/business/core/src/client/core/formatters.test.mjs`
- Modify: `apps/business/core/src/client/modals/config.js`, `ActionModalSections.jsx`
- Modify: `apps/business/core/src/client/extensions/optical/opticalSaleState.js`, `apps/business/core/src/client/extensions/optical/OpticalSalesPdv.jsx`, `apps/business/core/src/client/extensions/optical/OpticalSalesPdvView.jsx`

- [ ] **Step 1: Write the failing formatter test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { toDateTimeLocal } from "./formatters.js";

test("toDateTimeLocal uses the company timezone", () => {
  assert.equal(toDateTimeLocal("2026-10-17T01:30:00.000Z", "America/Sao_Paulo"), "2026-10-16T22:30");
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test apps/business/core/src/client/core/formatters.test.mjs`

Expected: FAIL because `toDateTimeLocal` is not exported.

- [ ] **Step 3: Implement and wire shared field behavior**

Implement `toDateTimeLocal` with `Intl.DateTimeFormat(...).formatToParts()` and return `YYYY-MM-DDTHH:mm`. Build the generic sale default/max from `workspace?.configuration?.timezone || "America/Sao_Paulo"`; forward `field.max` in `ActionModalSections`; in `extensions/optical/OpticalSalesPdv.jsx`, derive the company timezone from `runtimeData.configuration`, pass its local-now value to `createEmptyOpticalSaleDraft(soldAt)`, and pass it as `saleDateMax` to the active optical view; assign that prop to the input `max`.

- [ ] **Step 4: Verify GREEN, build, and commit**

Run: `node --test apps/business/core/src/client/core/formatters.test.mjs`

Expected: PASS.

Run: `npm --prefix apps/business/core run build`

Expected: Vite finishes without module or export errors.

Commit only the listed client files with message: `Default Core sale dates in company timezone`.

### Task 5: Verificação final

- [ ] **Step 1: Run all Core tests**

Run: `npm --prefix apps/business/core test`

Expected: PASS.

- [ ] **Step 2: Run the production build**

Run: `npm --prefix apps/business/core run build`

Expected: PASS.

- [ ] **Step 3: Inspect whitespace**

Run: `git diff --check HEAD~4..HEAD`

Expected: no output.

