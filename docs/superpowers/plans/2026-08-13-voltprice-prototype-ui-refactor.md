# VoltPrice Prototype UI Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every authenticated VoltPrice page use the supplied prototype’s compact financial-console UX/UI without changing real data flows, APIs, authorization, or tenant isolation.

**Architecture:** Establish the prototype’s visual tokens and reusable class contracts in the existing static shell, then migrate existing renderers by coherent product areas. `public/app.js` remains the routing coordinator; feature scripts (`*-financial.js`, `pricing-engine.js`, `users.js`) keep their endpoint responsibilities and consume shared CSS contracts. Tests remain native `node:test` static contracts plus the existing end-to-end route/domain suite.

**Tech Stack:** Static HTML/CSS, browser JavaScript, Node.js native `node:test`, Express APIs already present in VoltPrice.

## Global Constraints

- `C:\Users\USER\Downloads\voltprice-prototype.html` is the visual authority: white 202px sidebar, 54px topbar, `#f7f8fc` canvas, `#6c4cf4` accent, 14px cards, dense tables and status chips.
- Preserve all existing `/volt-price/api/*` contracts, script URLs, DOM ids used by JavaScript, RBAC, CSRF, authentication, session, audit, RLS and tenant behavior.
- Do not add Tray credentials, OAuth behavior, migrations, routes, a framework, a bundler, fabricated KPIs, sample financial numbers, automatic price publication, or automatic synchronization.
- Render only API-backed values; use explicit honest empty states where the prototype has sample-only content.
- Keep semantic labels, focus indicators, `aria-live` feedback and horizontal scrolling for wide tables.
- At <=1200px collapse the sidebar/metric grids; at <=650px use one-column content/forms and non-sticky topbar.

---

### Task 1: Establish prototype shell and shared component contracts

**Files:**
- Modify: `business/volt-price/public/index.html`
- Modify: `business/volt-price/public/styles.css`
- Create: `business/volt-price/tests/prototype-shell-ui.test.js`

**Interfaces:**
- Consumes: existing shell ids `#nav`, `#tenantName`, `#userName`, `#logoutBtn`, `#refreshPage`, `#supportBadge`, `#content`.
- Produces: CSS classes `pagehead`, `grid kpis`, `card section`, `toolbar`, `filter`, `seg`, `table`, `chip`, `metric-row`, `banner-ai`, `form-error`, and responsive media queries for all later renderers.

- [ ] **Step 1: Write the failing shell contract test**

Create `prototype-shell-ui.test.js` that reads `index.html` and `styles.css` and asserts the new contract exists while old dark-shell tokens do not drive the sidebar.

```js
assert.match(styles, /--purple:\s*#6c4cf4/i);
assert.match(styles, /\.app\{[^}]*grid-template-columns:\s*202px 1fr/i);
assert.match(styles, /\.topbar\{[^}]*height:\s*54px/i);
assert.match(styles, /\.sidebar\{[^}]*background:\s*#fff/i);
assert.match(styles, /\.card\{[^}]*border-radius:\s*14px/i);
assert.match(styles, /\.chip\.green/);
assert.match(styles, /@media\(max-width:1200px\)/);
assert.match(html, /id="nav"/);
assert.match(html, /id="content"/);
```

- [ ] **Step 2: Verify the shell test fails**

Run: `node --test volt-price/tests/prototype-shell-ui.test.js`

Expected: FAIL because the current shell is 230px and dark.

- [ ] **Step 3: Replace only the visual shell and token layer**

Update `styles.css` using the prototype’s concrete values. Preserve selectors that existing renderers need, while adding these semantic rules:

```css
:root { --bg:#f7f8fc; --surface:#fff; --border:#e8eaf2; --text:#171a2c;
  --muted:#72778a; --purple:#6c4cf4; --green:#16a36a; --red:#ef4c56;
  --amber:#f59e0b; --blue:#3b82f6; --radius:14px;
  --shadow:0 8px 24px rgba(34,39,69,.05); }
.app { grid-template-columns:202px 1fr; height:100vh; }
.sidebar { background:#fff; border-right:1px solid var(--border); color:var(--text); }
.topbar { height:54px; padding:0 20px; }
.card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); box-shadow:var(--shadow); }
.chip.green { background:#e9f8f1; color:var(--green); }
```

Adjust `index.html` only to expose a prototype-aligned topbar utility/search container and user/tenant identity in the sidebar/footer. Do not rename existing ids, remove scripts, or alter login/first-access form ids.

- [ ] **Step 4: Verify shell contract and syntax**

Run: `node --test volt-price/tests/prototype-shell-ui.test.js`

Expected: PASS.

Run: `node --check volt-price/public/app.js`

Expected: PASS.

- [ ] **Step 5: Commit the shared system**

```bash
git add business/volt-price/public/index.html business/volt-price/public/styles.css business/volt-price/tests/prototype-shell-ui.test.js
git commit -m "feat(volt-price): adopt prototype application shell"
```

### Task 2: Migrate Dashboard, Orders, Commissions and Integrations presentation

**Files:**
- Modify: `business/volt-price/public/app.js:21-28`
- Modify: `business/volt-price/public/orders-reconciliation.js`
- Create: `business/volt-price/tests/prototype-operations-ui.test.js`

**Interfaces:**
- Consumes: shared Task 1 CSS contracts and current `api`, `money`, `date`, `toast`, `escapeHtml`, `connectUrl` helpers.
- Produces: prototype-style operations pages without changing `/dashboard/`, `/orders/`, `/orders/sync/tray`, `/integrations/`, or reconciliation requests.

- [ ] **Step 1: Write failing operations UI contract tests**

Create tests that assert `app.js` has page headers and shared classes in each existing renderer, retains its action paths, and does not add automatic sync.

```js
assert.match(source, /async function dashboard[\s\S]*class="pagehead"/);
assert.match(source, /async function orders[\s\S]*class="toolbar"/);
assert.match(source, /async function integrations[\s\S]*class="card section"/);
assert.match(source, /\/orders\/sync\/tray/);
assert.doesNotMatch(source, /setInterval\([\s\S]*sync\/tray/);
```

- [ ] **Step 2: Verify the operations UI test fails**

Run: `node --test volt-price/tests/prototype-operations-ui.test.js`

Expected: FAIL because the existing renderers have no `pagehead` contract.

- [ ] **Step 3: Rework the four renderers around real data**

Update the existing Dashboard to use `pagehead`, four `kpi` cards using only `d.integrations`, `d.orders`, `d.fees`, and `d.commissionReferences`, then two `card section` panels for real sync/data guidance. Convert Orders controls into a `toolbar`/`filter` structure and preserve every existing `data-hydrate`, `data-link`, `data-profit`, fee and manual sync handler. Convert Integrations into compact integration cards resembling the prototype Settings list while retaining connect, refresh and disconnect requests. Convert Commissions into a dense table/filter card using its real response.

Use explicit states such as:

```js
const noRows = '<tr><td colspan="7" class="muted">Nenhum pedido importado para os filtros informados.</td></tr>';
const emptyIntegration = '<p class="muted">Nenhuma conexão ativa. Conecte um canal quando estiver pronto.</p>';
```

- [ ] **Step 4: Verify operations contracts and existing focused behavior**

Run: `node --test volt-price/tests/prototype-operations-ui.test.js volt-price/tests/orders.test.js volt-price/tests/regressions.test.js`

Expected: PASS.

- [ ] **Step 5: Commit operations presentation**

```bash
git add business/volt-price/public/app.js business/volt-price/public/orders-reconciliation.js business/volt-price/tests/prototype-operations-ui.test.js
git commit -m "feat(volt-price): restyle operations pages from prototype"
```

### Task 3: Migrate Products, Profit, Pricing and Market views

**Files:**
- Modify: `business/volt-price/public/app.js:72-86`
- Modify: `business/volt-price/public/profit-financial.js`
- Modify: `business/volt-price/public/pricing-engine.js`
- Modify: `business/volt-price/public/pricing-engine.css`
- Modify: `business/volt-price/public/market-financial.js`
- Modify: `business/volt-price/public/market.css`
- Create: `business/volt-price/tests/prototype-decision-ui.test.js`

**Interfaces:**
- Consumes: Task 1 visual contracts, current module render hook (`modulePage`), `window.VoltPrice*` feature-script bindings, existing domain endpoints.
- Produces: decision-oriented tables/panels with real content and no automatic price action.

- [ ] **Step 1: Write failing decision UI contracts**

Test the source files for prototype class contracts, current real routes, and the guard against auto-publication.

```js
assert.match(appSource, /key==="products"[\s\S]*class="pagehead"/);
assert.match(profitSource, /class="card section"/);
assert.match(pricingSource, /class="price-sim"|class="matrix"/);
assert.match(marketSource, /class="chip/);
assert.doesNotMatch(pricingSource, /fetch\([^)]*(publish|auto-apply|automatic)/i);
```

- [ ] **Step 2: Verify decision UI test fails**

Run: `node --test volt-price/tests/prototype-decision-ui.test.js`

Expected: FAIL because the existing renderers do not consistently use page headers/cards/chips.

- [ ] **Step 3: Apply prototype information hierarchy without inventing data**

Products: use a page header, compact KPI/count summary only from current result fields, dense product table and existing create form in a `card section`.

Profit: retain calculation/snapshot actions and use expected-versus-real comparison cards; render `—` or the existing empty state where no snapshot exists.

Pricing: preserve manual simulation, safeguard/reason content and confirmation controls; adopt prototype `price-sim`, range/matrix and insight card presentation. Do not create a button that calls a provider publish route.

Market: retain source configuration, listing/match review and signals. Present health/match status using `chip` states and compact table/panel layouts.

- [ ] **Step 4: Verify focused contracts and domain behavior**

Run: `node --test volt-price/tests/prototype-decision-ui.test.js volt-price/tests/pricing-engine.test.js volt-price/tests/market.test.js volt-price/tests/finance.test.js`

Expected: PASS.

- [ ] **Step 5: Commit decision views**

```bash
git add business/volt-price/public/app.js business/volt-price/public/profit-financial.js business/volt-price/public/pricing-engine.js business/volt-price/public/pricing-engine.css business/volt-price/public/market-financial.js business/volt-price/public/market.css business/volt-price/tests/prototype-decision-ui.test.js
git commit -m "feat(volt-price): restyle decision views from prototype"
```

### Task 4: Migrate Ads, Cash, Audit, Actions and Reports views

**Files:**
- Modify: `business/volt-price/public/app.js:88-100`
- Modify: `business/volt-price/public/ads-financial.js`
- Modify: `business/volt-price/public/cash-financial.js`
- Create: `business/volt-price/tests/prototype-finance-ui.test.js`

**Interfaces:**
- Consumes: Task 1 classes and the current real financial module APIs.
- Produces: prototype-style financial workspaces with existing save/create actions retained.

- [ ] **Step 1: Write failing financial UI contracts**

```js
assert.match(appSource, /key==="ads"[\s\S]*class="pagehead"/);
assert.match(appSource, /key==="cash"[\s\S]*class="toolbar"/);
assert.match(appSource, /key==="audit"[\s\S]*class="chip/);
assert.match(appSource, /key==="actions"[\s\S]*class="timeline"/);
assert.match(appSource, /key==="reports"[\s\S]*class="scenario/);
assert.match(cashSource, /\/cash/);
assert.match(adsSource, /\/ads\/sources/);
```

- [ ] **Step 2: Verify financial UI test fails**

Run: `node --test volt-price/tests/prototype-finance-ui.test.js`

Expected: FAIL because the financial renderers do not yet use all target presentation contracts.

- [ ] **Step 3: Migrate visual composition and retain real source actions**

Use real financial response values for KPI cards. Implement prototype-style toolbars and source cards in Ads, cash projection/commitment cards in Cash, severity chips and next-action tables in Audit, a data-backed Actions timeline/table, and Reports comparison/scenario cards. If a chart API is not available, use a compact data table/list or an explicit no-history state rather than sample series. Keep `cashNew`, `cashSave`, Ads source actions and all original API bodies unchanged.

- [ ] **Step 4: Verify financial contracts and domain tests**

Run: `node --test volt-price/tests/prototype-finance-ui.test.js volt-price/tests/cash.test.js volt-price/tests/marketing.test.js`

Expected: PASS.

- [ ] **Step 5: Commit financial views**

```bash
git add business/volt-price/public/app.js business/volt-price/public/ads-financial.js business/volt-price/public/cash-financial.js business/volt-price/tests/prototype-finance-ui.test.js
git commit -m "feat(volt-price): restyle financial workspaces from prototype"
```

### Task 5: Migrate Users and Admin Master without weakening provisioning controls

**Files:**
- Modify: `business/volt-price/public/app.js:30-70`
- Modify: `business/volt-price/public/users.js`
- Modify: `business/volt-price/tests/master-user-console-ui.test.js`
- Create: `business/volt-price/tests/prototype-admin-ui.test.js`

**Interfaces:**
- Consumes: existing `masterTenantUsers(root, tenant)`, `admin(root)`, users route behavior, Master-only routes, login/password constraints.
- Produces: prototype-aligned administration screens while preserving safe password semantics.

- [ ] **Step 1: Write failing admin UI contracts**

```js
assert.match(appSource, /async function admin[\s\S]*class="pagehead"/);
assert.match(appSource, /async function masterTenantUsers[\s\S]*class="card section"/);
assert.match(usersSource, /class="table"/);
assert.match(appSource, /data-manage-users/);
assert.match(appSource, /Redefinir a senha temporária encerrará as sessões atuais/);
assert.doesNotMatch(appSource, /temporaryPassword[^\n]*toast/i);
```

- [ ] **Step 2: Verify admin UI test fails**

Run: `node --test volt-price/tests/prototype-admin-ui.test.js volt-price/tests/master-user-console-ui.test.js`

Expected: FAIL for the new prototype presentation assertions while existing password safety assertions continue to pass.

- [ ] **Step 3: Apply the administrative visual system**

Admin Master gets a `pagehead`, compact tenant table, a `card section` tenant form, an audit table/metric list, and a styled support-access notice. The selected-company user panel uses the same page header, table, form controls and chips; it continues to omit passwords from table, state and toast, retains reset confirmation and clears the password input after success. `users.js` gains the same table/form treatment but does not acquire a tenant-user creation path.

- [ ] **Step 4: Verify admin safety and presentation**

Run: `node --test volt-price/tests/prototype-admin-ui.test.js volt-price/tests/master-user-console-ui.test.js volt-price/tests/admin-provisioning.test.js volt-price/tests/legacy-user-provisioning.test.js`

Expected: PASS.

- [ ] **Step 5: Commit administrative views**

```bash
git add business/volt-price/public/app.js business/volt-price/public/users.js business/volt-price/tests/master-user-console-ui.test.js business/volt-price/tests/prototype-admin-ui.test.js
git commit -m "feat(volt-price): restyle user administration from prototype"
```

### Task 6: Responsive/browser QA, documentation and final verification

**Files:**
- Modify: `business/volt-price/README.md`
- Modify: `business/volt-price/tests/prototype-shell-ui.test.js`
- Modify: `business/volt-price/public/responsive-shell.css`

**Interfaces:**
- Consumes: all Task 1–5 class contracts and existing application route shell.
- Produces: documented visual-reference policy, viewport-safe UI, and final suite proof.

- [ ] **Step 1: Write failing responsive/documentation assertions**

Append test assertions for both responsive breakpoints and README reference policy.

```js
assert.match(styles, /@media\(max-width:1200px\)/);
assert.match(styles, /@media\(max-width:650px\)/);
assert.match(readme, /voltprice-prototype\.html/i);
assert.match(readme, /não fabrica dados|nao fabrica dados/i);
```

- [ ] **Step 2: Verify the assertions fail**

Run: `node --test volt-price/tests/prototype-shell-ui.test.js`

Expected: FAIL until the README statement is present and responsive rules are consolidated.

- [ ] **Step 3: Consolidate responsive CSS and document the invariant**

Move any conflicting shell overrides from `responsive-shell.css` into the shared breakpoint strategy or make that stylesheet express the same 1200px/650px policy. Add a concise README section identifying the supplied prototype as visual reference, stating that production screens use real API data and that provider integration behavior is unchanged by this phase.

- [ ] **Step 4: Run final automated verification**

Run: `npm --prefix business run test:volt-price`

Expected: PASS for the full VoltPrice suite.

Run: `node --check business/volt-price/public/app.js`

Expected: PASS.

Run: `git diff --check`

Expected: no output and exit code 0.

- [ ] **Step 5: Run manual viewport and permission QA**

Serve the existing business app and validate `/volt-price/login`, first-access, dashboard, orders, integrations, pricing, Admin Master and Master selected-company panel at 1440px, 1024px and 390px. Confirm keyboard focus, table scrolling, support access, password reset confirmation and no password disclosure in rendered UI.

- [ ] **Step 6: Commit final UX/UI verification**

```bash
git add business/volt-price/README.md business/volt-price/public/responsive-shell.css business/volt-price/tests/prototype-shell-ui.test.js
git commit -m "docs(volt-price): document prototype UI standard"
```

## Plan self-review

- **Coverage:** Task 1 implements tokens/shell/responsiveness; Tasks 2–5 cover every currently routed page plus feature scripts; Task 6 covers documentation, browser QA and full verification. Tray/OAuth work, backend changes and fabricated data are excluded in every applicable task.
- **No placeholders:** Task APIs, files, assertions, commands and commits are specified. There are no unassigned decisions.
- **Type consistency:** All tasks retain the existing JavaScript renderer names, DOM ids, endpoint strings and `api()` helper; new shared elements are CSS class contracts rather than a new runtime component API.
