# VoltPrice Prototype UX/UI Refactor Design

**Status:** Approved for specification; implementation begins only after this document is reviewed.

## Objective

Refactor every authenticated VoltPrice screen so the production application follows the visual system and information hierarchy in `C:\Users\USER\Downloads\voltprice-prototype.html`, while preserving the existing routes, API contracts, RBAC, tenant isolation, authentication, and real data flows. The Tray connection work remains out of scope until this visual refactor is complete.

## Reference and visual system

The supplied prototype is the authoritative UX/UI reference. Its style is a compact financial-operations console:

- light application background (`#f7f8fc`) with white surfaces;
- 202px desktop sidebar and a 54px top bar;
- Inter/system typography, dense labels and tables, restrained 10–13px secondary text;
- violet as the single primary accent (`#6c4cf4`), with green, red, amber and blue reserved for meaningful states;
- 14px cards with thin neutral borders and soft shadow (`0 8px 24px rgba(34,39,69,.05)`);
- rounded compact controls, segmented controls, filter toolbars, status chips, and AI/insight callouts;
- responsive sidebar collapse at approximately 1200px and single-column content behavior at narrow viewports.

The production UI must reuse these visual tokens instead of introducing page-specific palette, spacing, or component variants. Icons may stay text-based until a shared icon source is adopted; the visual hierarchy matters more than replacing every symbol.

## Application shell

`public/index.html` and `public/styles.css` will become the shared shell. The dark 230px navigation rail is replaced with the prototype’s white 202px rail, compact active state, and supporting intelligence/footer card. The top bar becomes a 54px utility row: search/utility space at the left, refresh, support status, user identity and logout at the right. Page title and subtitle move into each page’s content header where the prototype places them.

The shell remains usable for the password-change flow and keeps existing DOM ids required by `app.js`: `#nav`, `#tenantName`, `#userName`, `#logoutBtn`, `#refreshPage`, `#supportBadge`, and `#content`. It also keeps `/volt-price` asset paths and all existing script tags.

## Shared production components

The current renderers will use a small shared set of class contracts in `styles.css` rather than isolated inline styles:

| Component | Responsibility |
| --- | --- |
| `pagehead` | h1, contextual subtitle and optional actions |
| `grid kpis` / `kpi` | four compact metrics with title, value, trend and optional state/icon |
| `card section` | shared bordered data panel with 12–14px inner spacing |
| `toolbar`, `filter`, `seg` | filters, period controls and primary page actions |
| `table` / `table-wrap` | dense data grids with horizontal overflow instead of clipping |
| `chip` | semantic status (`green`, `red`, `amber`, `blue`, neutral/purple) |
| `metric-row` | compact comparisons, alerts, source breakdowns and list rows |
| `banner-ai` | contextual explanation/decision support without fabricating data |
| `empty`, `notice`, `form-error` | loading, empty and accessible error states |

Production pages may render only information returned by their APIs. Prototype KPIs, charts and insights that do not have real backing data are represented as an explicit empty/no-data state, never as prototype sample values.

## Module migration map

### Shell, Dashboard and Orders

The Dashboard receives the prototype page header, KPIs based on its existing counts, and connection/order health cards. Orders receives the prototype’s toolbar/table density and preserves sync, date/status filters, linking and reconciliation actions. No automatic sync action is introduced.

### Products, Profit, Pricing and Market

Products adopts the operational table and product-detail split pattern where existing data supports it. Profit uses expected-versus-real margin panels. Pricing keeps the current simulation and decision controls but renders its price range, safeguards and recommendation reasons using the prototype’s matrix/cards. Market uses its existing sources, listings, match review and signal data with the prototype’s comparison panels and status chips. Every pricing action remains human-confirmed; the UI must not imply automatic price publication.

### Ads, Cash, Audit, Actions and Reports

These modules share period/filter toolbars, dense financial cards and source breakdowns. Ads emphasizes media cost versus contribution margin; Cash emphasizes available cash, commitments and projections; Audit emphasizes severity and next action; Actions becomes a timeline/table; Reports uses comparison and scenario cards. Empty APIs render an honest message and the control surface remains available when the user has permission.

### Integrations, Users and Admin Master

Integrations becomes a configuration list matching the reference Settings pattern, without changing OAuth endpoints or starting the Tray work. Users retains its current account-management permissions. Admin Master receives the same white cards, compact tenant table, filters/form pattern, and accessible Master user-management panel; support access, tenant creation, user provision, password reset confirmation, and all password handling semantics remain unchanged.

## Interaction, accessibility and responsive rules

- Buttons retain visible keyboard focus, native labels and semantic types.
- Error/operation feedback keeps `role="alert"`/`aria-live`; refresh and async operations announce only non-sensitive outcomes.
- Existing permission gates remain server-authoritative. Hidden/disabled controls are never a substitute for authorization.
- The layout must keep horizontally wide real-data tables scrollable.
- At <=1200px, the sidebar reduces to icon/compact form and dense grids become two columns; at <=650px, content grids/forms become one column and the top bar stops being sticky.
- Animations are limited to subtle non-essential hover/focus transitions and respect `prefers-reduced-motion`.

## Deliberate non-goals

- no new backend routes, migrations, provider credentials, OAuth behavior, or Tray connection work;
- no synthetic dashboard/financial values, charts or recommendations;
- no role, authentication, CSRF, session, audit or RLS changes;
- no new framework or frontend build system.

## Verification strategy

The refactor adds focused static UI-contract tests for the shared shell and representative module patterns, without weakening the existing login, password-change, authorization, provisioning, and domain tests. Verification runs:

```sh
npm --prefix business run test:volt-price
node --check business/volt-price/public/app.js
git diff --check
```

Manual browser QA uses the reference at desktop, collapsed-sidebar and mobile widths, verifies keyboard navigation and checks login, first-access, regular tenant, Admin Master, and support-access states.
