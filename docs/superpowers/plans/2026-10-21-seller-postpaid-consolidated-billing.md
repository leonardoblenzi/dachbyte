# Seller Postpaid Consolidated Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Work inline in the current checkouts; the user explicitly requested no subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a Seller company to accept a Hub-priced ML/Shopee account, use it before payment, and receive one itemized company invoice on its monthly anniversary, with fail-closed access after an unpaid due date.

**Architecture:** The Hub owns company billing cycles, immutable accepted account terms, invoice items, payment state, and resource authorization. The Seller owns OAuth, account alias, order measurement, and presentation. Asaas processes one charge per company invoice; the Hub maps its events back to the invoice idempotently. Existing prepaid ML credits and seven-day trials remain separate.

**Tech Stack:** Hub TypeScript, PostgreSQL migrations in `sql/`, Asaas API/Webhooks, Node test runner; Seller Express/CommonJS, PostgreSQL, Bull workers, gateway portal service, vanilla HTML/CSS/JS.

**Approved design:** `docs/superpowers/specs/2026-10-21-seller-postpaid-consolidated-accounts-design.md` in Dach. Related trial and commercial matrix specs remain authoritative except where the approved design supersedes payment-before-access.

---

## Repository map and safety gates

Hub checkout: `C:/Users/USER/Documents/Projetos/hub pagamento/src/modules/checkout/`; resource access: `src/modules/billing/resources/accessPolicy.ts`; Seller portal: `src/modules/portal/{service,internalRoutes}.ts`; Asaas: `src/infrastructure/payments/asaas.ts` and `src/modules/checkout/asaasPaymentWebhookService.ts`; scheduler: `src/app/scheduler.ts` wired in `src/index.ts`. Hub's next migration is after `sql/067_seller_order_measurement.sql`; confirm the latest number at execution time rather than reusing it blindly.

Seller ML OAuth: `apps/seller-ml/routes/meliOAuthRoutes.js`; order measurement: `apps/seller-ml/services/mlTrialOrderMeasurementJob.js`; account UI: `apps/seller-ml/views/selecao-plataforma.html`; gateway: `apps/gateway/services/sellerPortalService.js`. Shopee's OAuth routes start at `apps/seller-shopee/src/routes/auth.routes.js` and measurement tests live under `apps/seller-shopee/tests/`.

Before each edit, inspect `git status --short` in **both** existing checkouts. Preserve all unrelated staged, unstaged, and untracked files; stage exact paths for each commit. Do not push, deploy, apply migrations, charge a real card, or activate production flags as part of implementation. Those are separate release gates. Do not run both the old recurring checkout and postpaid invoicing for the same resource/cycle.

## Phase A — Hub ledger and authority

### Task 1: Schema and database invariants

**Files:** Create `C:/Users/USER/Documents/Projetos/hub pagamento/sql/068_seller_postpaid_company_billing.sql` only after confirming `068` is unused. Test `tests/migrations/sellerPostpaidBillingMigration.test.ts`.

- [ ] Write a migration test that asserts the tables, unique indexes, foreign keys, cent-based amounts, and invoice-item provenance exist; run `npm run test:migrations` and observe failure.
- [ ] Add separate tables for `seller_company_billing_cycles` (tenant, anchor day, method, status), `seller_postpaid_terms` (resource, quote snapshot, accepted_by/at, effective range and monthly price), `seller_postpaid_invoices` (tenant, cycle start/end, due local date, total cents, state, Asaas reference), `seller_postpaid_invoice_items` (invoice, resource, period, amount cents, matrix/measurement snapshot), and `seller_postpaid_events` (provider event id, invoice, event type). Use uniqueness on tenant+cycle, invoice+resource+period, and provider event id. Use check constraints for positive prices, nonnegative item totals and valid cycle boundaries.
- [ ] Run the migration test green, `npm run db:migrate:plan` read-only, and `npm run verify`; commit only the new migration/test. Do **not** apply the migration yet.

### Task 2: Pure anniversary and proportional pricing

**Files:** Create `src/modules/postpaid/cycleMath.ts`, `tests/postpaid/cycleMath.test.ts`.

- [ ] Write failing tests for anchor day 20, account accepted on day 12 (8 of the cycle's civil days), anchor 31 through February, leap year, and cents rounding.
- [ ] Implement `nextAnchorDate(anchorDay: number, after: Date): string` and `proratedCents(monthlyCents: number, startDate: string, endExclusive: string, cycleStart: string): number`. Both use `America/Sao_Paulo` civil dates; clamp day 29–31 to a short month's last day without losing the original anchor. Assert `0 <= proratedCents <= monthlyCents` for an in-cycle start.
- [ ] Run `npm run test:checkout` (its runner bundles TypeScript tests through esbuild), confirm the new test passes, then commit.

### Task 3: Hub-only quote and explicit acceptance

**Files:** Create `src/modules/postpaid/{quoteService,acceptanceService,repository,internalRoutes}.ts`; modify `src/index.ts`; test `tests/postpaid/{quote,acceptance,internalRoutes}.test.ts`.

- [ ] Write failing tests for `POST /v1/internal/postpaid/quote` and `/accept`: tenant/user/resource identity, current successful measurement, 0 and 3,001 orders, published price, company anchor, proportional first period, stale quote, duplicate acceptance, and company debt. A browser-supplied range or price must not affect the result.
- [ ] Implement quote as a short-lived, server-snapshotted offer containing `quote_id`, `resource_key`, `measurement_period`, `orders`, `range_code`, `matrix_version`, `monthly_cents`, `first_period_cents`, `cycle_end`, and `expires_at`. Derive it from Hub measurement and published matrix. For >3,000 orders return `commercial_contact_required`; for missing/stale apuração return `order_measurement_required`.
- [ ] Keep the internal API contract explicit; the request carries identity and resource only, while the response carries the authoritative price:

```json
{"request":{"tenant_id":"tenant-1","user_id":"user-1","resource_key":"ml:1012445923"},"response":{"quote_id":"pq_123","resource_key":"ml:1012445923","measurement_period":"2026-09","orders":1086,"range_code":"from_701_to_1500","monthly_cents":7490,"first_period_cents":2416,"cycle_end":"2026-10-31","expires_at":"2026-10-21T20:00:00Z"}}
```

- [ ] Implement acceptance in a database transaction: verify billing manager, current quote and no company debt; insert accepted terms idempotently by quote/resource; create the company anchor only if it does not exist; activate only that resource's paid entitlement without touching its purchased credit balance. A repeated request returns the existing terms, not another billable item. Keep the old checkout endpoint unchanged behind a postpaid feature flag, and explicitly reject simultaneous old/new financial contracts for the same resource.
- [ ] Run focused postpaid tests, `npm run test:checkout`, and `tsc --noEmit --pretty false`; commit exact paths.

### Task 4: One immutable invoice per company cycle

**Files:** Create `src/modules/postpaid/{invoiceService,invoiceRepository}.ts`; test `tests/postpaid/invoiceService.test.ts`.

- [ ] Write failing tests for two ML accounts plus Shopee, addition mid-cycle, account disabled mid-cycle, zero items, rounded-cent sum, duplicate scheduler execution, and previously invoiced cycle.
- [ ] In a transaction, lock the company's cycle row; collect accepted terms effective within `[cycle_start, cycle_end)`; insert one invoice and one item per `(resource, effective period)` with stored monthly price, proration, matrix and measurement snapshot; calculate `total_cents = SUM(item.amount_cents)`; mark the cycle closed. A second call returns the same invoice unchanged. A term deactivated at cycle end remains billable for the used cycle.
- [ ] Run focused tests and `npm run test:checkout`; commit. Never recompute a closed invoice from a newer commercial matrix.

### Task 5: Asaas charge and payment reconciliation

**Files:** Create `src/modules/postpaid/{asaasInvoiceService,paymentEvents}.ts`; modify `src/infrastructure/payments/asaas.ts`, `src/modules/checkout/asaasPaymentWebhookService.ts`, `src/index.ts`; test `tests/postpaid/{asaasInvoice,paymentEvents}.test.ts`.

- [ ] Write failing contract tests: one Asaas customer/charge per company invoice, exact cents, `externalReference` equal to an immutable invoice id, PIX and CREDIT_CARD, provider timeout/retry, duplicate/out-of-order paid events, refund/reversal, and amount mismatch. A browser return or uploaded receipt must not mark an invoice paid.
- [ ] Add a **detached monthly invoice charge** adapter, not another per-resource recurring checkout. First validate in Asaas sandbox whether this account supports card token reuse in production; when unavailable, offer hosted card payment without promising automatic capture. Pix always creates a pay-by-user charge unless Pix Automático is separately designed. Store provider ids before treating a charge as issued and reconcile ambiguous timeouts by external reference before retrying.
- [ ] Use one provider reference per invoice, never per account item:

```ts
type PostpaidCharge = {
  invoiceId: string;
  tenantId: string;
  amountCents: number;
  dueDate: string;
  method: "pix" | "credit_card";
  externalReference: string; // `seller-postpaid:${invoiceId}`
};
```

- [ ] Route verified Asaas events to the postpaid invoice by immutable provider reference. Record provider event id uniquely; apply paid/failed/refunded transitions transactionally; refuse wrong amount/customer; reconcile late confirmations without a second charge. Preserve the existing checkout/top-up webhook branches.
- [ ] Run focused tests, existing `tests/checkout/asaasWebhook.test.ts`, `npm run test:checkout`, and `tsc --noEmit --pretty false`; commit.

### Task 6: Due-date cutoff and operational access

**Files:** Create `src/modules/postpaid/{accessGate,cycleRunner}.ts`; modify `src/modules/billing/resources/accessPolicy.ts`, `src/app/scheduler.ts`, `src/index.ts`, portal service; test `tests/postpaid/{accessGate,cycleRunner}.test.ts`.

- [ ] Write failing tests for invoice due at local 23:59, unpaid at next local midnight, payment confirmation, all paid ML/Shopee resources covered by one invoice, partial provider payment, trial still active, and job admitted just before cutoff.
- [ ] Evaluate delinquency at request time from Hub invoice state and local due cutoff so an hourly scheduler delay cannot grant access. Deny new paid operations and job admission for covered modules when overdue; permit Seleção de plataforma/billing routes and jobs already admitted under a valid snapshot. Return a distinct `company_invoice_overdue` reason, rather than rewriting all resource `access_policy` values. A paid webhook clears the gate idempotently.
- [ ] Preserve the domain decision shape for every enforcement caller:

```ts
type PostpaidAccessDecision =
  | { allow: true; reason: "ok" | "trial_active" }
  | { allow: false; reason: "company_invoice_overdue"; invoiceId: string };
```

- [ ] Add an idempotent hourly runner to create invoices for closed cycles and reconcile provider status. Keep its schedule/flag separate from old Pix-renewal processing. Run focused tests, `npm run verify`; commit.

### Task 7: Monthly remeasurement, notice, deactivation, reactivation

**Files:** Create `src/modules/postpaid/{repricingService,noticeService}.ts`; extend `internalRoutes.ts`, repository and portal overview; test `tests/postpaid/{repricing,accountLifecycle}.test.ts`.

- [ ] Write failing tests for lower range, higher range with seven-day notice, higher range measured too late, measurement failure, deactivate-at-cycle-end, Reactivate without second trial, revoked OAuth, and overdue company.
- [ ] Snapshot the latest closed month available at quote cutoff; decreased price begins next cycle. Queue an increase only after seven full calendar days' notice; if the cutoff is missed, retain the current price one more cycle. Expose old/new range and amount, measurement period, effective date and notice state in portal overview. Send notice once per price-change id and persist delivery result; a failed delivery remains visible in-panel and must not silently shorten notice.
- [ ] Implement per-resource `deactivate_at_cycle_end` without deleting OAuth or old invoice items. Reenable only after a new Hub quote/acceptance and verification of connection and no overdue invoice. Run focused tests and `npm run verify`; commit.

## Phase B — Seller connections and customer experience

### Task 8: Connected-but-not-activated accounts, aliases, and measurement

**Files:** Modify `apps/seller-ml/routes/meliOAuthRoutes.js`, `apps/seller-ml/services/mlTrialOrderMeasurementJob.js`; add `apps/seller-ml/services/accountAliasService.js` and a narrowly scoped migration for alias if no existing column; parallel Shopee changes in `apps/seller-shopee/src/routes/auth.routes.js` and its account repository; test ML/Shopee OAuth and measurement suites.

- [ ] Write failing tests: logged-in billing user adds an ML account, OAuth callback returns to Seleção de plataforma, account is visible but cannot run paid operations, rename changes only alias, duplicate callback does not duplicate resource, account already owned by another company is rejected, measurement failure remains pending. Repeat for Shopee using its existing OAuth paths.
- [ ] On OAuth success, persist the marketplace identity/credential and upsert its Hub billing resource in a non-entitled state; enqueue existing closed-month measurement. Redirect to `selecao-plataforma` Contas with the resource selected. Store alias separately from immutable `resource_key` and external account id. Do not start a new module trial for an existing company that already used it.
- [ ] Run focused OAuth/measurement tests and Seller credit/access tests; commit exact paths. Do not make OAuth callback itself accept a paid term.

### Task 9: Gateway contract and Seleção de plataforma UI

**Files:** Modify `apps/gateway/services/sellerPortalService.js`, `apps/seller-ml/views/selecao-plataforma.html`, `apps/seller-ml/public/css/selecao-plataforma.css`; test `apps/seller-ml/tests/seller-postpaid-portal.test.js` and gateway contract tests.

- [ ] Write failing tests for `Validando faixa`, measurement error, quoted proportional first period, card/Pix parity, acceptance without immediate payment, increase notice/deactivation, consolidated invoice rows, overdue navigation restriction, paid reactivation, and no editable range/price fields.
- [ ] Proxy authenticated Hub quote, accept, deactivate, reactivate, invoice list/detail, and payment-link operations. Bind every call to trusted tenant/user identity. Render Hub-returned price/period only. After acceptance show `Ativa · primeira cobrança em DD/MM`; after overdue keep only portal/billing access. Show account alias edit independently of plan. Never infer activation from a front-end redirect or Asaas checkout page.
- [ ] Make pending and blocked states explicit in the view-model, rather than inferring them from button visibility:

```js
const accountBillingStates = [
  "validating_range",
  "measurement_failed",
  "awaiting_acceptance",
  "active_postpaid",
  "deactivating_at_cycle_end",
  "inactive_connected",
  "company_invoice_overdue",
];
```

- [ ] Run focused tests, `node --check` on changed JS, full relevant Seller test suites, and `git diff --check`; commit exact paths.

### Task 10: End-to-end reconciliation and release gate

**Files:** Add contract/e2e tests under Hub `tests/postpaid/` and Seller `apps/seller-ml/tests/`; update operational runbook in Dach `docs/` only if the release procedure differs from existing deployment instructions.

- [ ] In test/sandbox, exercise OAuth → measurement → Hub quote → acceptance → active access → cycle invoice with two accounts → Asaas charge → unpaid cutoff → blocked operations/portal available → webhook paid → restored access. Compare item sum, Hub total and provider amount in cents. Test duplicated webhook, retry, replay, out-of-order event, payment confirmation after cutoff, and legacy checkout coexistence rejection.
- [ ] Run Hub `npm run verify`, Seller focused suites including `npm run test:credits`, Shopee's applicable tests, migration-plan checks, and read-only inspection of pending/live contracts. Record exact output and failures.
- [ ] Prepare a separate migration/rollout checklist: Hub schema first, Hub dark launch, Seller UI, one pilot company, sandbox payment, controlled real payment only after explicit approval, monitoring/rollback. Production migration, push and deploy remain **out of scope** until separately authorized.

## Self-review checklist

- [ ] Every approved spec requirement maps to a task: new OAuth account and alias (8–9), measurement and Hub quote (3/8), postpaid terms and proration (2–3), consolidated fatura (1/4–5), card/Pix (5), cutoff and payment unlock (6), repricing/notice/deactivate/reactivate (7), trial/credits preservation and rollout (all/10).
- [ ] No implementation assumes Asaas card tokenization in production; verify capability before offering automatic card charging.
- [ ] Do not move user-owned dirty files into a commit unintentionally, and do not apply any migration or real charge during planning or ordinary test execution.
