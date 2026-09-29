# Magalu UX Parity Rebase Design

## Goal

Rebuild the Seller Magalu presentation layer around the established Seller ML product language while retaining the current Magalu runtime, security boundaries, and business behavior.

## Baseline and scope

The source package was built against commit `4a7d61a`. The integration target is the current `main`, which includes later Magalu UX fixes and ML security work. Its applicator must not be forced: every replacement is rebased manually onto the current files.

The rebase may change Magalu HTML, CSS, client-side presentation code, and frontend contract tests. It does not change API routes, database migrations, repositories, workers, queues, OAuth, Hub access checks, or remote Magalu write behavior.

## Product structure

The visual hierarchy follows Seller ML without importing its runtime or assets:

1. Dashboard: commercial KPIs, priorities, commercial/operational blocks, integrations, and audit context.
2. Catalogue, prices, and stock: a common operational workspace with selection, action, preview, confirmation, and history.
3. Orders: dense operational table, status chips, detail surfaces, and protected fulfillment actions.
4. Pricing: common internal tabs for costs, margin, and calculator; explicit estimate language and no invented Magalu fees.

Magalu keeps its own blue/cyan visual identity. Shared product language means equivalent information hierarchy, density, feedback, responsiveness, and navigation—not shared ML code or contracts.

## Compatibility rules

- Preserve the current exact-SKU resolution and account-change selection reset.
- Preserve dashboard period race protection, dynamic labels, prior-window comparisons, and valid cost coverage.
- Preserve financial-search debounce, loading indicators, and last-valid-result behavior.
- Preserve every protected write control: Hub WRITE check, live remote GET, stale-state guard, persisted dispatching state, explicit confirmation, and reconciliation-only handling of uncertainty.
- Retain feature-local theme behavior and remove feature-level `prefers-color-scheme` dependencies when the theme token already controls the UI.

## Validation

New or updated contracts must assert that the Magalu frontend does not import Seller ML code, routes, services, or assets. Existing protected-write, OAuth, order, dashboard, and finance tests must continue to pass. The completed rebase requires JavaScript syntax checks, `git diff --check`, and the full Seller Magalu test suite.

## Out of scope

No new Magalu API scopes, external endpoints, business metrics, rate limits, migrations, billing behavior, or remote write types are introduced.
