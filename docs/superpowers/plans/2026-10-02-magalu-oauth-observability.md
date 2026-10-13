# Magalu OAuth Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OAuth failures diagnosable without persisting credentials and guarantee a revoked Magalu account is reactivated by reconnection.

**Architecture:** The OAuth controller will append best-effort sanitized audit receipts at the authorization start and callback terminal paths. Account reconnection remains inside the existing transactional `upsertConnectedAccount` boundary; tests prove that a revoked same-tenant account retains its primary key when reauthorized.

**Tech Stack:** Node.js, Express, PostgreSQL, node:test, existing `auditService`.

---

### Task 1: Audit OAuth lifecycle safely

**Files:**
- Modify: `apps/seller-magalu/src/controllers/oauthController.js`
- Modify: `apps/seller-magalu/tests/oauth-hardening.test.js`

- [ ] **Step 1: Write failing controller tests**

Add stubs for `recordBestEffort` and assert that start emits `oauth_started`, a successful callback emits `oauth_connected`, and an error callback emits `oauth_failed`. Assert each detail object has only flow mode, scope count, safe error code/status and account/tenant ids when available.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/oauth-hardening.test.js`

Expected: failing assertions because no OAuth lifecycle audit events are emitted.

- [ ] **Step 3: Add minimal audited helpers and calls**

Import `recordBestEffort`, add a local best-effort helper that accepts only metadata, then emit:

```js
await recordBestEffort({
  eventKey: "oauth_started",
  source: "oauth",
  outcome: "info",
  dachTenantId: identity.dachTenantId,
  dachUserId: identity.dachUserId,
  details: { flow_mode: flowMode, requested_scope_count: scopeCount },
}).catch(() => {});
```

Use equivalent non-secret fields for the terminal callback events. Keep audit failure non-blocking.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/oauth-hardening.test.js`

Expected: all tests pass.

### Task 2: Protect revoked-account reconnection

**Files:**
- Modify: `apps/seller-magalu/tests/oauth-hardening.test.js`

- [ ] **Step 1: Write failing repository test**

Use a query stub representing a same-tenant account with `status: "revoked"`. Assert `upsertConnectedAccount` executes the existing update path, returns the same `id`, changes status to `active`, and receives the new scope list.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/oauth-hardening.test.js`

Expected: failure before the explicit contract test exists.

- [ ] **Step 3: Keep or add only the minimal repository behavior**

The current `updateExistingAccount` already sets `status = 'active'`; no repository change is made unless the failing test exposes a real gap.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/oauth-hardening.test.js`

Expected: all tests pass.

### Task 3: Regression verification

**Files:**
- Verify: `apps/seller-magalu/tests/oauth.test.js`
- Verify: `apps/seller-magalu/tests/oauth-hardening.test.js`
- Verify: `apps/seller-magalu/tests/oauth-account-access.test.js`
- Verify: `apps/seller-magalu/tests/entry-gate.test.js`
- Verify: `apps/seller-magalu/tests/hub-resource-access.test.js`

- [ ] **Step 1: Run the OAuth regression suite**

Run: `node --test tests/oauth.test.js tests/oauth-hardening.test.js tests/oauth-account-access.test.js tests/entry-gate.test.js tests/hub-resource-access.test.js`

Expected: zero failures.

- [ ] **Step 2: Check modified JavaScript and diff hygiene**

Run: `node --check src/controllers/oauthController.js; git diff --check`

Expected: both commands exit 0.
