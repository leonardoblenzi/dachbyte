# Avantracking Admin Session And Integration Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the master administrator's selected company and notify company users when an enabled integration needs reconnection or configuration.

**Architecture:** Keep master-session policy and integration configuration evaluation as pure helpers covered by Node tests. Persist integration incidents in PostgreSQL so notification delivery is deduplicated across restarts; the health service owns scheduling, Tray token validation and incident resolution.

**Tech Stack:** TypeScript, Express, PostgreSQL (`pg`), Node test runner, Brevo e-mail transport, React.

## Global Constraints

- Run the automatic health monitor only when `MOD_SITUATION=PRODUCTION`.
- Send e-mail only to users whose `receivePlatformEmails` is not `false`.
- Do not send repeated alerts for an unchanged incident more than once every 24 hours.
- Preserve unrelated worktree changes.

---

### Task 1: Add policy regression tests

**Files:**
- Create: `avantracking/server/src/tests/integrationHealthPolicy.test.ts`
- Create: `avantracking/server/src/services/integrationHealthPolicy.ts`

**Interfaces:**
- Produces `shouldPreserveMasterCompanySelection(email, masterEmail): boolean`.
- Produces `evaluateIntegrationConfiguration(company): IntegrationHealthIssue[]`.

- [ ] Write Node tests for master e-mail normalization, inactive integrations, and every missing enabled credential case.
- [ ] Run `npx tsc --noEmit` and confirm the test fails before the policy module exists.
- [ ] Implement the pure policy helpers and run `npx tsc && node --test dist/tests/integrationHealthPolicy.test.js`.

### Task 2: Persist and notify health incidents

**Files:**
- Create: `avantracking/server/db/migrations/20260811160000_add_integration_health_incidents/migration.sql`
- Modify: `avantracking/server/src/services/notificationService.ts`
- Create: `avantracking/server/src/services/integrationHealthService.ts`

**Interfaces:**
- Produces `integrationHealthService.initialize(): Promise<void>`.
- Produces `integrationHealthService.checkCompany(companyId): Promise<void>`.

- [ ] Create an incident table keyed by company, integration and issue code.
- [ ] Add a notification method that inserts a GENERAL feed item and sends Brevo e-mail to opted-in users.
- [ ] Implement opening, daily reminder and automatic resolution of persisted incidents.
- [ ] Add Tray proactive validation and permanent refresh-token failure classification.

### Task 3: Wire the monitor and fix session switching

**Files:**
- Modify: `avantracking/server/src/index.ts`
- Modify: `avantracking/server/src/services/trayAuthService.ts`
- Modify: `avantracking/server/src/controllers/userController.ts`
- Modify: `avantracking/components/CompanySwitcher.tsx`

- [ ] Initialize integration health independently from other schedulers.
- [ ] Refresh Tray tokens with a 30-minute safety window and expose a reconnect-required error to the health monitor.
- [ ] Preserve the master admin's selected company when provisioning from the Hub and set the super-admin claim consistently.
- [ ] Remove the browser reload after a successful company switch so context-driven queries refresh normally.

### Task 4: Verify

**Files:**
- Test: `avantracking/server/src/tests/integrationHealthPolicy.test.ts`

- [ ] Run TypeScript compilation and the Node policy tests.
- [ ] Run the Avantracking frontend build.
- [ ] Inspect the final diff to ensure no unrelated business or Shopee files are staged.
