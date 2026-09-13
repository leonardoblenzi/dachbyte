# DACHBYTE VPS Decomposition Design

## Objective

Make every DACHBYTE product independently deployable on one VPS while keeping the existing hosted environment, Neon data, and public traffic unchanged until a later cutover.

## Scope

This work establishes production-ready containers, private service networking, reverse-proxy routes, health checks, environment contracts, and operational documentation. It does not migrate production data, change DNS, redirect OAuth callbacks, or stop any current hosted service.

## Product Vocabulary

Public names and the executable source tree use the DACHBYTE identity. The migration renames product directories with `git mv` before Docker configuration is added. Public URLs remain unchanged.

- DACHBYTE Seller: Marketplace products, including ML, Shopee, MadeiraMadeira, Tracking, Log, and Leader.
- DACHBYTE Business: Core, Stock, Chat, and Price.

## Repository Layout

Executable products live under `apps/`. Shared platform code remains in the repository root under `packages/`, `platform/`, `lib/`, `routes/`, and `scripts/`.

```text
apps/
  gateway/          <- root server.js and its gateway-only dependencies
  seller-ml/        <- ml/
  seller-shopee/    <- shopee/
  seller-madeira/   <- MadeiraMadeira/
  seller-tracking/  <- avantracking/
  seller-log/       <- davanttilog/
  seller-leader/    <- LeaderSku/
  business/         <- business/
    core/           <- volt_core/
    stock/          <- volt_stock/
    chat/           <- volt_chat/
    price/          <- volt-price/
```

Every import, npm script, test fixture, static-asset path, migration command, and Docker build context is updated atomically with the move. Git detects the file history through the rename; no compatibility copies of the old folders remain.

## Target Runtime

Only Caddy exposes ports 80 and 443. Every application, PostgreSQL, and Redis service communicates over Docker-internal networks.

```text
Internet
  -> Caddy
     -> dachbyte-gateway
     -> dachbyte-seller-ml-web
     -> dachbyte-seller-shopee
     -> dachbyte-seller-madeira
     -> dachbyte-seller-tracking
     -> dachbyte-seller-log
     -> dachbyte-seller-leader
     -> dachbyte-business-core
     -> dachbyte-business-stock
     -> dachbyte-business-chat-web
     -> dachbyte-business-price

dachbyte-seller-ml-worker -> Redis and PostgreSQL
dachbyte-business-chat-api -> PostgreSQL; private dependency of chat-web
PostgreSQL and Redis -> named persistent volumes; no public ports
```

The gateway owns the landing page, login, suite session, global public routes, and module-entry routes. It must no longer import or mount the product applications. Caddy routes each product prefix directly to its own service.

## Identity and Routing

`suite_auth_token` remains a root-domain, secure cookie issued by the gateway. Products validate it with the shared suite signing secret and use the existing Hub access check when configured. Product-specific session cookies and existing callback routes remain supported during this migration.

The public product paths remain stable: `/ml`, `/shopee`, `/madeiramadeira`, `/avantracking`, `/davanttilog`, `/skuleader`, and the DACHBYTE Business canonical paths. Caddy preserves the request path while proxying so existing links and OAuth callback contracts do not change. Legacy Business paths continue to redirect through the canonical-route adapter already present on `dach`.

## Service Boundaries

Each web product gets its own startup entrypoint and Docker service. The ML worker is independent from the ML web process. Volt Chat is split into a web service and Python API service; no Node process starts Python as a child process. The current `server.js` becomes the gateway entrypoint rather than the application host for every product.

Each service receives only the environment variables it needs. Database and Redis hostnames use Docker service names, not `localhost`. PostgreSQL TLS is disabled for internal Docker connections and enabled only where an external connection explicitly requires it.

## Resilience and Operations

All services use `restart: unless-stopped`, health checks, and explicit dependency conditions. A failing product exposes an unhealthy response without taking down other products. Caddy returns the product's response or an upstream failure, while the gateway, database, Redis, and unaffected products continue running.

PostgreSQL and Redis use named volumes. Backups and point-in-time recovery configuration are documented but not activated against production in this phase. A production cutover must have a rollback procedure that restores the previous DNS/proxy target without modifying the existing hosted platform.

## Verification

Automated tests cover the gateway's product-route boundary, cookie/session forwarding behavior, Caddy route coverage, compose configuration, service health endpoints, and the absence of public PostgreSQL/Redis ports. Existing module tests and syntax checks continue to run. A local smoke test starts the compose stack and verifies each public route through Caddy plus ML queue connectivity.

## Explicit Non-Goals

- No database migration from Neon to the VPS.
- No deletion, shutdown, or modification of current hosted services.
- No DNS, OAuth-provider, or production environment change.
- No production data migration or service cutover before the VPS stack passes local and staging validation.
