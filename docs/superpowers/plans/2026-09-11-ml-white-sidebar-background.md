# ML White Sidebar Background Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Mercado Livre sidebar background white in White Mode without changing its DachByte content or Dark Mode styling.

**Architecture:** The Seller brand stylesheet owns the DachByte-specific sidebar background override. Replace its unconditional selector with two theme-scoped selectors: pure white for `body.theme-light` and the existing gradient for `body.theme-dark`. No markup, JavaScript, routes, or logo assets change.

**Tech Stack:** CSS, static assets, Node.js architecture test suite.

---

## File structure

- Modify: `public/brand/dachbyte/theme.css` — scope the Seller sidebar background to the selected light or dark theme.
- Modify: `tests/dachbyte-visual-contract.test.js` — assert the brand stylesheet keeps a light and dark Seller sidebar rule so a future global selector cannot reintroduce the regression.

### Task 1: Lock the white-mode contract with a regression test

**Files:**

- Modify: `tests/dachbyte-visual-contract.test.js`

- [ ] **Step 1: Add a failing stylesheet-contract assertion**

Add an assertion in the existing brand stylesheet test that requires these exact selector/value fragments:

```js
assert.match(brandTheme, /html\\[data-dachbyte-line="seller"\\] body\\.theme-light \\.ml-shell__sidebar\\s*\\{\\s*background:\\s*#ffffff;/);
assert.match(brandTheme, /html\\[data-dachbyte-line="seller"\\] body\\.theme-dark \\.ml-shell__sidebar\\s*\\{\\s*background:\\s*linear-gradient\\(165deg, #102b3d, #07131d 65%\\);/);
```

- [ ] **Step 2: Run the focused test to confirm it fails before the CSS change**

Run `node --test tests/dachbyte-visual-contract.test.js`.

Expected: FAIL because `theme.css` currently has one unconditional `.ml-shell__sidebar` rule.

- [ ] **Step 3: Commit the failing test**

Run `git add tests/dachbyte-visual-contract.test.js` followed by `git commit -m "test: cover ML white sidebar theme"`.

### Task 2: Scope the Seller sidebar background by theme

**Files:**

- Modify: `public/brand/dachbyte/theme.css:98-100`

- [ ] **Step 1: Replace the unconditional Seller sidebar override**

Replace the current rule with:

```css
html[data-dachbyte-line="seller"] body.theme-light .ml-shell__sidebar {
  background: #ffffff;
}

html[data-dachbyte-line="seller"] body.theme-dark .ml-shell__sidebar {
  background: linear-gradient(165deg, #102b3d, #07131d 65%);
}
```

- [ ] **Step 2: Run the focused test to confirm it passes**

Run `node --test tests/dachbyte-visual-contract.test.js`.

Expected: PASS with no failing subtests.

- [ ] **Step 3: Run the full architecture suite**

Run `npm run test:architecture`.

Expected: PASS with zero failed tests.

- [ ] **Step 4: Commit the implementation and planning records**

Run `git add public/brand/dachbyte/theme.css docs/superpowers/specs/2026-09-11-ml-white-sidebar-background-design.md docs/superpowers/plans/2026-09-11-ml-white-sidebar-background.md` followed by `git commit -m "fix: keep ML sidebar white in white mode"`.

## Self-review

- Spec coverage: Task 2 modifies only the Seller sidebar background; it preserves brand content, cards, navigation, logo, and Dark Mode gradient. Task 1 protects the two theme-specific values.
- Placeholder scan: no TODO, TBD, or unspecified testing steps remain.
- Consistency: both the test and implementation use `html[data-dachbyte-line="seller"]`, `body.theme-light`, `body.theme-dark`, and `.ml-shell__sidebar`.
