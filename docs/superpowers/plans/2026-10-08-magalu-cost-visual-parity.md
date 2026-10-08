# Magalu Cost Visual Parity Implementation Plan

> **For agentic workers:** Implement inline with TDD and review checkpoints; no backend or behavior changes in this phase.

**Goal:** Align the visual hierarchy of Magalu's Custos por SKU tab with the ML cost workspace while preserving Magalu colors and existing actions.

**Architecture:** Keep the shared Margem hero and tabs. Recompose only the costs panel using existing IDs and handlers, then add scoped CSS loaded before the canonical stylesheet so the rest of the module is unchanged.

**Tech Stack:** Server-rendered HTML, CSS, vanilla JavaScript, Node test runner.

---

### Task 1: Markup contract

**Files:** `apps/seller-magalu/tests/cost-visual-parity.test.js`, `apps/seller-magalu/views/app.html`

- [ ] Write a failing test asserting the costs panel order: status, compact action toolbar, four KPIs, insights/ranking, filter surface, catalog table; assert existing action IDs remain unique.
- [ ] Run `node --test tests/cost-visual-parity.test.js` from `apps/seller-magalu`; confirm it fails on the old second hero/table toolbar.
- [ ] Move existing heading and button nodes into a compact costs toolbar and give the search/select controls visible labels. Do not rename IDs or change fetch/write behavior.
- [ ] Rerun the focused test until green.

### Task 2: Scoped spacing and surfaces

**Files:** `apps/seller-magalu/tests/cost-visual-parity.test.js`, `apps/seller-magalu/public/css/magalu-cost-visual-parity.css`, `apps/seller-magalu/views/app.html`

- [ ] Add failing assertions for the scoped costs stylesheet and its placement before `magalu-canonical-ui.css`.
- [ ] Run the focused test and confirm the stylesheet assertion fails.
- [ ] Add costs-panel-only CSS: 16px section rhythm, 18–20px surface padding, 20–22px radii, 38px controls, Meli-like two-column insight/ranking proportions, dense table, mobile stacking. Reuse Magalu tokens.
- [ ] Rerun the focused test and `npm test` (expected 0 failures), then run `git diff --check`.

### Task 3: Visual review

- [ ] Compare costs and margin at desktop and mobile widths using an authenticated local preview if available; verify no overflow, hidden-panel bleed, modal regression, or duplicate actions.
- [ ] Preserve the worktree for user review. Do not commit, push, or deploy without a separate request.
