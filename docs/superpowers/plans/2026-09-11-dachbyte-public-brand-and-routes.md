# DachByte Public Brand and Compatible Routes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert customer-facing product names to DachByte while preserving Volt and D'avantti technical contracts.

**Architecture:** `platform/branding` is the only public vocabulary registry. New `/dach/*` paths are aliases that redirect to existing product mounts; routes, cookies, environment variables, database names, OAuth callbacks and Render/Neon resources are untouched.

**Tech Stack:** Node.js, Express 5, Caddy, Docker Compose, Node test runner.

---

## File map

| File | Change |
| --- | --- |
| `platform/branding/index.js` | Approved DachByte public catalog. |
| `platform/gateway/canonicalRoutes.js` | `/dach/*` to legacy path aliases. |
| `apps/gateway/server.js` | Seller canonical redirect registration and public fallback labels. |
| `apps/business/product-server.cjs` | Business canonical redirects and existing health mounts. |
| `infra/Caddyfile` | Private reverse-proxy matchers for canonical paths. |
| `tests/platform-foundation.test.js` | Catalog and visible-language regression tests. |
| `tests/gateway-product-boundary.test.js` | Canonical and legacy redirect tests. |
| `tests/vps-compose-contract.test.js` | Caddy and private-port contract tests. |

## Task 1: Public catalog

**Files:** Modify `platform/branding/index.js:10-27`; modify `tests/platform-foundation.test.js:7-17`.

- [ ] Add failing assertions for `DachByte`, `Dach Seller`, `Dach Business`, `Dach Core`, `Dach Stock`, `Dach Chat`, `Dach Price`, `Dach Tracking`, `Dach Log`, `Dach Leader` and `Dach Hub`.
- [ ] Run `node --test tests/platform-foundation.test.js`; expect failure because the existing values are all-caps `DACHBYTE` and there is no `hub` entry.
- [ ] Replace only public values in `DACHBYTE_BRAND` with the approved catalog. Keep `DACHBYTE_BRAND` as the exported identifier and keep the object frozen.
- [ ] Run `node --test tests/platform-foundation.test.js`; expect pass.
- [ ] Commit with `git add platform/branding/index.js tests/platform-foundation.test.js` and `git commit -m "Rename public products to DachByte"`.

## Task 2: Canonical path adapter

**Files:** Modify `platform/gateway/canonicalRoutes.js:8-27`; modify `tests/gateway-product-boundary.test.js`.

- [ ] Add failing test cases: `/dach/seller/mercado-livre?account=1` must resolve to `/ml?account=1`; `/dach/business/stock?tab=labels` must resolve to `/voltstock?tab=labels`; `/dach/business/price/orders` must resolve to `/volt-price/orders`.
- [ ] Run `node --test tests/gateway-product-boundary.test.js`; expect failure because `/dach/*` has no route group.
- [ ] Add canonical entries for `/dach/seller/{mercado-livre,shopee,madeira,tracking,log,leader}` and `/dach/business/{core,stock,chat,price}`. Retain every existing `/seller/*`, `/business/*`, `/voltstock`, `/volt-price`, `/davanttilog` and `/skuleader` mapping.
- [ ] Extend root matching so both `/seller` and `/dach/seller` use the Seller group, and both `/business` and `/dach/business` use the Business group. Preserve longest-prefix matching and query strings.
- [ ] Re-run `node --test tests/gateway-product-boundary.test.js`; expect pass; commit `Add DachByte canonical route aliases`.

## Task 3: Gateway, product host and Caddy wiring

**Files:** Modify `apps/gateway/server.js:677-820`; modify `apps/business/product-server.cjs:10-39`; modify `infra/Caddyfile:3-61`; modify `tests/gateway-product-boundary.test.js`; modify `tests/vps-compose-contract.test.js`.

- [ ] Add failing HTTP tests that expect a 302 from `/dach/business/core/app?x=1` to `/core/app?x=1`, while `/business/core/app?x=1` continues returning the same location.
- [ ] Run `node --test tests/gateway-product-boundary.test.js`; expect the new Dach path to fail.
- [ ] Register `createCanonicalRedirectHandler("seller")` in the gateway before Seller product mounts and retain `/go/*` handlers. Keep the Business handler before Business mounts; do not change `/voltchat`, `/volt_chat` or `/stock` aliases.
- [ ] Add Caddy matchers for `/dach/seller` and `/dach/seller/*` to `gateway:3000`, and `/dach/business` and `/dach/business/*` to `business-portal:3000`. Do not add a `ports` key to any service.
- [ ] Run `node --test tests/gateway-product-boundary.test.js tests/vps-compose-contract.test.js`; expect pass; commit `Proxy DachByte canonical paths`.

## Task 4: Visible fallback text only

**Files:** Modify `apps/gateway/server.js:295-534,733`; modify `apps/seller-leader/index.js:188`; modify `apps/seller-log/index.cjs:288-362,851-899`; modify `tests/platform-foundation.test.js`.

- [ ] Add failing assertions that public fallback text contains `Empresa DachByte` and does not contain `Empresa Davantti`.
- [ ] Run `node --test tests/platform-foundation.test.js`; expect failure.
- [ ] Replace only user-visible labels and errors with `DACHBYTE_BRAND` values. Do not rename `davanttilog_token`, `DAVANTTILOG_JWT_SECRET`, `MODULE_ID`, table/column names, source fields or audit keys.
- [ ] Run `npm run test:architecture`; expect 15 passing tests. Commit `Use DachByte public product vocabulary`.

## Task 5: Private VPS validation

**Files:** Modify `docs/architecture/migration-dachbyte.md:58-133`.

- [ ] Add a checklist covering the new `/dach/*` aliases, existing legacy aliases, query-string preservation, no published data-store ports and rollback to Render/Neon.
- [ ] Run `git diff --check` and `npm run test:architecture`; expect zero whitespace errors and 15 passing tests.
- [ ] On the VPS, run `git pull --ff-only origin dach`, then `docker compose --env-file env/compose.env -f compose.vps.yml build gateway business-portal` and `docker compose --env-file env/compose.env -f compose.vps.yml up -d --no-deps gateway business-portal`.
- [ ] Confirm both services are healthy. Do not start Caddy or alter DNS in this release.
- [ ] Probe inside the Compose network: `/dach/seller/mercado-livre?account=1` must return 302 to `/ml?account=1`; `/dach/business/stock?tab=labels` must return 302 to `/voltstock?tab=labels`.
- [ ] Commit the validation checklist with `Document DachByte route validation`.

## Later plans explicitly excluded

- `DACH_*` environment-variable aliases with legacy fallback.
- Cloudflare DNS, canonical DachByte domains, OAuth callback and webhook registration.
- Removal of legacy names after telemetry and rollback approval.
