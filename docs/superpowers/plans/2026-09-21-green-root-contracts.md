# Green Root Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the root test suite by synchronizing canonical design tokens and updating stale migration contracts to the live DACH routing architecture.

**Architecture:** The design-system source remains the canonical token source, so it must include the Ads accent already exposed publicly. Legacy Seller paths are preserved at the Caddy edge instead of being mounted in the Node Gateway. Business marketing links use `/business/*` canonical paths, while legacy aliases remain Caddy redirects.

**Tech Stack:** Node.js built-in test runner, CSS tokens, Caddy configuration, static HTML.

---

### Task 1: Synchronize canonical Ads design tokens

**Files:**
- Modify: `packages/design-system/src/tokens.css`
- Test: `tests/dachbyte-visual-contract.test.js`

- [ ] Add the Ads accent block matching the public token file, then run `node --test tests/dachbyte-visual-contract.test.js` and expect PASS.

### Task 2: Align legacy-route assertions to the edge proxy

**Files:**
- Modify: `platform/compatibility/legacySurfaceRegistry.js`
- Modify: `tests/legacy-surface-compatibility.test.js`

- [ ] Mark the registry as canonical-domain active while retaining the route inventory, and verify the Seller aliases are Caddy `path` matchers with product reverse proxies. Run `node --test tests/legacy-surface-compatibility.test.js` and expect PASS.

### Task 3: Align the Business landing contract to canonical URLs

**Files:**
- Modify: `tests/seller-landing-contract.test.js`

- [ ] Replace old `/voltstock`, `/chat`, and `/core` expectations with the corresponding `/business/*` paths already used by the landing. Run `node --test tests/seller-landing-contract.test.js` and expect PASS.

### Task 4: Verify all root contracts

**Files:**
- Verify: `tests/*.test.js`

- [ ] Run `node --test tests/*.test.js` and inspect the summary for zero failures.
