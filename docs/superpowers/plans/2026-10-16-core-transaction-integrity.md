# Core Transaction Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Core sales, receivables, stock, and cash state transitions atomic, traceable, and safe against duplicate or future-dated operations.

**Architecture:** Extract shared transactional helpers for operational timestamps and locked cash sessions. Sales delegates delivery-only finance to the delivery transition; all ledger writers receive an explicit session. Database constraints enforce invariants that application locks cannot guarantee alone.

**Tech Stack:** Node.js CommonJS services, PostgreSQL migrations, React/Vite, Node test runner.

---

### Task 1: Reproduce and protect sale/order state boundaries

**Files:**
- Modify: `apps/business/core/src/modules/core/round6Corrections.test.js`
- Modify: `apps/business/core/src/modules/core/runtime/services/salesService.js`

- [ ] Write a failing regression test asserting that `updateSale` rejects a sale whose status is `pending_delivery` and produces no financial records.
- [ ] Run `node --test apps/business/core/src/modules/core/round6Corrections.test.js` and confirm the test fails with the current acceptance path.
- [ ] Reject non-finalized sale edits with `SALE_ORDER_EDIT_RESTRICTED`; retain a separate metadata-only order update only if the route already needs it.
- [ ] Re-run the focused test and commit the green change.

### Task 2: Enforce cash-session invariants and explicit linkage

**Files:**
- Create: `apps/business/core/db/017_cash_session_integrity.sql`
- Modify: `apps/business/core/src/modules/core/runtime/services/cashService.js`
- Modify: `apps/business/core/src/modules/core/runtime/services/salesService.js`
- Modify: `apps/business/core/src/modules/core/runtime/services/financeService.js`
- Modify: `apps/business/core/src/modules/core/runtimeHttp.test.js`

- [ ] Add failing tests for an automatic movement requiring/using a locked open session and duplicate open-session conflict handling.
- [ ] Run the focused runtime tests and observe the missing `session_id` behavior.
- [ ] Add a partial unique index on `(company_id) where status='open'`; expose a helper that locks an open session and assign its id to each new movement.
- [ ] Use that helper in sale completion, receivable settlement, expense payment, and manual movement according to company cash rules.
- [ ] Re-run focused tests and commit.

### Task 3: Validate operational timestamps and make settlements idempotent

**Files:**
- Modify: `apps/business/core/src/modules/core/runtime/services/financeService.js`
- Modify: `apps/business/core/src/modules/core/runtime/services/cashService.js`
- Modify: `apps/business/core/src/modules/core/runtime/services/salesService.js`
- Modify: `apps/business/core/src/modules/core/round6Corrections.test.js`

- [ ] Add failing tests for future/invalid operational timestamps and for a repeated receivable idempotency key.
- [ ] Run the focused tests and confirm each fails for the absent validation/deduplication.
- [ ] Add a shared resolver that rejects invalid/future instants and record settlement idempotency data atomically with the movement.
- [ ] Re-run focused tests and commit.

### Task 4: Preserve stock and audit history

**Files:**
- Modify: `apps/business/core/src/modules/core/runtime/services/salesService.js`
- Modify: `apps/business/core/src/modules/core/runtime/services/productService.js` or the owning product update service
- Modify: `apps/business/core/src/modules/core/stockReservationService.test.js`
- Modify: `apps/business/core/src/routes/core.routes.js`

- [ ] Add failing tests for deterministic multi-product locking, prohibited track-stock disable with active reservation, and archival-only cancelled-sale removal.
- [ ] Run the stock/service test set and confirm failures.
- [ ] Sort product IDs before `FOR UPDATE`, reject tracking changes while active reservations exist, preserve cancelled sale ledger history, and enforce dedicated cancel/archive permissions.
- [ ] Re-run focused tests and commit.

### Task 5: Complete sale-date frontend behavior and verify integration

**Files:**
- Modify: `apps/business/core/src/client/modals/config.js`
- Modify: `apps/business/core/src/client/extensions/optical/opticalSaleState.js`
- Modify: `apps/business/core/src/client/extensions/optical/OpticalSalesPdvView.jsx`
- Modify: `apps/business/core/src/modules/core/dashboardRound2.test.js`

- [ ] Add failing assertions for current datetime defaults and maximum datetime input.
- [ ] Run client-focused tests and confirm the behavior is absent.
- [ ] Initialize sale drafts in company-local current time and pass `max` to both sale datetime inputs.
- [ ] Run the complete Core test suite and Vite build; inspect diff; commit the finished work.
