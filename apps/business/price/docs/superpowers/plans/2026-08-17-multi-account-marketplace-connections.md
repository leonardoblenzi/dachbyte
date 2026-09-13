# Multi-account Marketplace Connections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each tenant manage several Mercado Livre and Shopee connections, launch OAuth from one-time links, and select the exact marketplace account for each order.

**Architecture:** Keep `integration_connections` as the source of truth for named accounts and add a one-time invitation table for public OAuth links. Add connection-aware helpers to the integration layer, then pass `connectionId` from order association through fee lookup. Replace the single-connection integrations view with channel groups on the left and per-channel account management on the right.

**Tech Stack:** Node.js, Express, PostgreSQL/Neon with RLS, node:test, vanilla JavaScript, CSS.

---

## File map

- Create: `db/011_multi_account_marketplace_connections.sql` for OAuth invitations and the order-to-connection foreign key.
- Create: `src/integrations/authorizationLink.js` for opaque link tokens, expiry checks, and public-page state.
- Modify: `src/integrations/tokenStore.js` to list, rename, disconnect, and resolve explicit connections.
- Modify: `src/routes/integrations.routes.js` to expose account CRUD, authenticated OAuth, and public link routes.
- Modify: `src/routes/admin.routes.js` to let an Admin Master generate a link for a selected tenant without an active tenant session.
- Modify: `src/routes/orders.routes.js` and `src/routes/finance.routes.js` to validate and propagate `connectionId`.
- Create: `src/orders/marketplaceLink.js` for validated marketplace-account payloads and conservative auto-assignment.
- Modify: `src/integrations/mercadoLivre.js` and `src/integrations/shopee.js` to refuse an ambiguous channel when several active accounts exist.
- Modify: `public/app.js` and `public/styles.css` for the master-detail integrations workspace and account picker on marketplace links.
- Create: `tests/integrations.test.js` and extend `tests/orders.test.js`, `tests/authorization.test.js`, and `tests/regressions.test.js`.

### Task 1: Add the tenant-scoped persistence model

**Files:**
- Create: `db/011_multi_account_marketplace_connections.sql`
- Test: `tests/regressions.test.js`

- [ ] **Step 1: Write migration-shape regression assertions**

Add assertions that read migration `011` and verify the invitation table, hashed token, tenant foreign key, RLS policy, `orders.marketplace_connection_id`, and an index for the new lookup.

```js
test("multi-account migration protects OAuth links and order account bindings", () => {
  const migration = read("db/011_multi_account_marketplace_connections.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS volt_price\.integration_authorization_links/i);
  assert.match(migration, /token_hash text NOT NULL UNIQUE/i);
  assert.match(migration, /tenant_id uuid NOT NULL REFERENCES volt_price\.tenants/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS marketplace_connection_id uuid REFERENCES volt_price\.integration_connections/i);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/i);
});
```

- [ ] **Step 2: Run the assertion before the migration exists**

Run: `node --test tests/regressions.test.js`

Expected: FAIL because migration `011` is missing.

- [ ] **Step 3: Create migration `011`**

Create the table and column with the following semantics:

```sql
CREATE TABLE IF NOT EXISTS volt_price.integration_authorization_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES volt_price.tenants(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('meli','shopee')),
  token_hash text NOT NULL UNIQUE,
  created_by_user_id uuid NOT NULL REFERENCES volt_price.users(id) ON DELETE CASCADE,
  support_reason text,
  expires_at timestamptz NOT NULL,
  opened_at timestamptz,
  used_at timestamptz,
  cancelled_at timestamptz,
  connection_id uuid REFERENCES volt_price.integration_connections(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE volt_price.orders
  ADD COLUMN IF NOT EXISTS marketplace_connection_id uuid
  REFERENCES volt_price.integration_connections(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_vp_auth_links_pending
  ON volt_price.integration_authorization_links(tenant_id, channel, expires_at DESC)
  WHERE used_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_vp_orders_marketplace_connection
  ON volt_price.orders(tenant_id, marketplace_connection_id);
```

Enable and force RLS on `integration_authorization_links`, then create the standard `tenant_isolation` policy used by the existing tenant-owned tables.

- [ ] **Step 4: Re-run the regression assertion**

Run: `node --test tests/regressions.test.js`

Expected: PASS.

- [ ] **Step 5: Commit the migration and test**

```bash
git add db/011_multi_account_marketplace_connections.sql tests/regressions.test.js
git commit -m "feat: persist marketplace account links"
```

### Task 2: Build connection and invitation domain helpers

**Files:**
- Create: `src/integrations/authorizationLink.js`
- Modify: `src/integrations/tokenStore.js:18-68`
- Create: `tests/integrations.test.js`
- Test: `tests/authorization.test.js`

- [ ] **Step 1: Write failing unit tests for opaque tokens and connection selection**

Cover a random 32-byte URL-safe token, SHA-256 storage hash, a 15-minute expiry calculation, and the three connection-resolution outcomes.

```js
test("OAuth link stores a hash and expires in fifteen minutes", () => {
  const link = createLinkToken(new Date("2026-08-17T12:00:00Z"));
  assert.match(link.token, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(link.token, link.tokenHash);
  assert.equal(link.expiresAt.toISOString(), "2026-08-17T12:15:00.000Z");
});

test("connection selection rejects an ambiguous channel", () => {
  assert.throws(() => selectConnectionId(null, [{ id: "a" }, { id: "b" }]),
    (error) => error.code === "connection_selection_required" && error.statusCode === 409);
});
```

- [ ] **Step 2: Run tests before implementation**

Run: `node --test tests/integrations.test.js tests/authorization.test.js`

Expected: FAIL because `authorizationLink.js` and the exported selectors do not exist.

- [ ] **Step 3: Implement pure invitation helpers**

Implement `createLinkToken(now)`, `isLinkUsable(link, now)`, and `publicLinkState(link, now)`. Use `randomToken(32)` and `sha256()` from `src/crypto.js`; return only `token`, `tokenHash`, and `expiresAt` from token creation. `publicLinkState` must return `expired`, `cancelled`, `used`, or `ready` without exposing the hash.

- [ ] **Step 4: Extend the token store with explicit account operations**

Add these functions with tenant transactions:

```js
async function listChannelConnections(auth, channel) { /* active and disconnected rows, no token columns */ }
async function renameConnection(auth, connectionId, displayName) { /* trim, require 1..120 chars, audit caller handles event */ }
async function disconnectConnection(auth, connectionId) { /* status='disconnected', token_cipher=NULL, refresh_token_cipher=NULL */ }
function selectConnectionId(connectionId, rows) { /* zero=not_connected, one=return it, many=409 selection required */ }
```

Change `getConnection()` so a missing `connectionId` first loads active rows for that channel and delegates to `selectConnectionId`. Existing single-account tenants keep working; multi-account tenants receive `connection_selection_required`.

- [ ] **Step 5: Run focused tests**

Run: `node --test tests/integrations.test.js tests/authorization.test.js`

Expected: PASS.

- [ ] **Step 6: Commit domain helpers**

```bash
git add src/integrations/authorizationLink.js src/integrations/tokenStore.js tests/integrations.test.js tests/authorization.test.js
git commit -m "feat: add marketplace connection helpers"
```

### Task 3: Add connection CRUD and safe OAuth routes

**Files:**
- Modify: `src/routes/integrations.routes.js:11-20`
- Modify: `src/routes/admin.routes.js`
- Modify: `src/integrations/oauthState.js:5-15`
- Modify: `src/integrations/mercadoLivre.js:9-45`
- Modify: `src/integrations/shopee.js:10-16`
- Test: `tests/integrations.test.js`
- Test: `tests/regressions.test.js`

- [ ] **Step 1: Add failing route-contract assertions**

Add source-level contract checks for the public link routes and per-connection routes, preserving one authenticated start route per channel.

```js
test("integration routes expose account CRUD and public OAuth link flow", () => {
  const routes = read("src/routes/integrations.routes.js");
  assert.match(routes, /router\.patch\("\/:connectionId"/);
  assert.match(routes, /router\.post\("\/:connectionId\/disconnect"/);
  assert.match(routes, /router\.post\("\/:channel\/links"/);
  assert.match(routes, /router\.get\("\/link\/:token"/);
  assert.match(routes, /router\.post\("\/link\/:token\/continue"/);
});
```

- [ ] **Step 2: Run contract tests before route work**

Run: `node --test tests/integrations.test.js tests/regressions.test.js`

Expected: FAIL because the routes do not exist.

- [ ] **Step 3: Add authenticated CRUD routes**

Implement, in this order:

```text
GET    /api/integrations/:channel/accounts
PATCH  /api/integrations/:connectionId        { displayName }
POST   /api/integrations/:connectionId/refresh
POST   /api/integrations/:connectionId/disconnect
POST   /api/integrations/:channel/links
```

Require `authenticate`, `requireCsrf`, and `integrations.manage` for mutations. Validate `channel` against `meli` and `shopee`, validate the connection belongs to the active tenant, and append an audit event for each mutation. Return `409 tenant_required` before creating an OAuth state when `req.vpAuth.tenantId` is missing.

- [ ] **Step 4: Add public invitation routes**

Implement:

```text
GET  /volt-price/api/integrations/link/:token
POST /volt-price/api/integrations/link/:token/continue
```

The GET reads only the hashed token and returns/render a minimal confirmation page with tenant display name and channel. The POST atomically verifies pending status, writes `opened_at`, creates the normal `oauth_states` row with the invitation tenant and creator user, and redirects to the provider URL. Store `authorizationLinkId` in the OAuth payload. The callback must mark the invitation `used_at` and `connection_id` in the same transaction that upserts the provider connection. It must reject expired, cancelled, and previously used invitations with a neutral public page.

Use the existing static callbacks that the provider registered:

```text
/volt-price/api/integrations/meli/callback
/volt-price/api/integrations/shopee/callback
```

For Mercado Livre, build the provider URL with PKCE and the stored OAuth state. For Shopee, keep its existing HttpOnly state cookie but create the stored OAuth state with `authorizationLinkId` in its payload before redirecting. Both static callbacks consume that payload and mark the invitation completed. Do not put raw invitation tokens in audit metadata, database rows, cookies, or provider state.

- [ ] **Step 5: Add the Admin Master link route**

Add `POST /api/admin/tenants/:tenantId/integration-links` in `src/routes/admin.routes.js`. Require a platform-admin session, CSRF, a valid active tenant, a channel of `meli` or `shopee`, and a reason with at least five characters. Use `withPlatformAdmin()` to create the same invitation row as the tenant route and audit `integration.link.create` with the selected tenant and reason. The admin page calls this route from the selected tenant row and displays only the one-time URL.

- [ ] **Step 6: Keep legacy routes compatible**

Keep `/meli/connect` and `/shopee/connect` for direct connections. Replace the current raw database `23502` path with:

```js
if (!req.vpAuth.tenantId) {
  throw Object.assign(new Error("Selecione uma empresa antes de conectar um canal."), {
    statusCode: 409,
    code: "tenant_required",
  });
}
```

Update `oauthState.createOAuthState()` to accept a validated `{ tenantId, userId }` context from the invitation continuation without requiring a browser session.

- [ ] **Step 7: Run route contracts and unit tests**

Run: `node --test tests/integrations.test.js tests/regressions.test.js`

Expected: PASS.

- [ ] **Step 8: Commit routes**

```bash
git add src/routes/integrations.routes.js src/integrations/oauthState.js src/integrations/mercadoLivre.js src/integrations/shopee.js tests/integrations.test.js tests/regressions.test.js
git commit -m "feat: manage marketplace accounts and OAuth links"
```

### Task 4: Bind orders and fee lookups to exact accounts

**Files:**
- Modify: `src/routes/orders.routes.js:24-215`
- Modify: `src/routes/finance.routes.js`
- Modify: `src/integrations/mercadoLivre.js`
- Modify: `src/integrations/shopee.js`
- Create: `src/orders/marketplaceLink.js`
- Modify: `tests/orders.test.js`
- Modify: `tests/regressions.test.js`

- [ ] **Step 1: Add failing tests for explicit connection binding**

Add order tests for a valid manual account binding and the rejected cases: missing connection, wrong tenant, disconnected account, and channel mismatch. Add a regression assertion that both fee routes forward `connectionId`.

```js
test("manual marketplace link carries the selected account", () => {
  const payload = validateMarketplaceLink({ marketplace: "meli", externalOrderId: "200", connectionId: "a" });
  assert.deepEqual(payload, { marketplace: "meli", externalOrderId: "200", connectionId: "a" });
});

test("manual marketplace link requires an account", () => {
  assert.throws(() => validateMarketplaceLink({ marketplace: "meli", externalOrderId: "200" }), /Conta vinculada/);
});
```

- [ ] **Step 2: Run tests before changing order behavior**

Run: `node --test tests/orders.test.js tests/regressions.test.js`

Expected: FAIL because validation and forwarding do not exist.

- [ ] **Step 3: Update order list and marketplace linking API**

Return `marketplace_connection_id`, connection display name, and external account ID from `GET /orders`. Extend `PATCH /:id/link-marketplace` to require `connectionId`, then verify inside the tenant transaction:

```sql
SELECT id FROM volt_price.integration_connections
WHERE id=$1 AND channel=$2 AND status='active'
```

Write the selected ID to `orders.marketplace_connection_id`. Clear it in `DELETE /:id/link-marketplace`. Keep automatic association conservative: assign only after an exact seller/shop identifier match against one active connection; otherwise retain `NULL` and require manual selection.

Create `src/orders/marketplaceLink.js` with the validation used by the route and tests:

```js
function validateMarketplaceLink({ marketplace, externalOrderId, connectionId } = {}) {
  const channel = String(marketplace || "").trim().toLowerCase();
  const orderId = String(externalOrderId || "").trim();
  const id = String(connectionId || "").trim();
  if (!['meli', 'shopee'].includes(channel)) throw Object.assign(new Error("Marketplace invalido. Use meli ou shopee."), { statusCode: 400 });
  if (!orderId) throw Object.assign(new Error("ID externo do pedido e obrigatorio."), { statusCode: 400 });
  if (!id) throw Object.assign(new Error("Conta vinculada obrigatoria."), { statusCode: 400 });
  return { marketplace: channel, externalOrderId: orderId, connectionId: id };
}
```

- [ ] **Step 4: Forward the selected ID through financial routes**

Make `POST /orders/fees/meli/:orderId` and `POST /orders/fees/shopee/:orderId` load the order’s `marketplace_connection_id`. Reject the request with `409 connection_selection_required` when the order has no account. Pass that ID to `meli.orderFees()` or `shopee.orderFees()` and persist it in the fee snapshot metadata for traceability.

- [ ] **Step 5: Enforce unambiguous provider calls**

Ensure every provider path that accepts `connectionId` passes it to `getConnection`. The fallback for an omitted ID must select the only active account or reject multiple active accounts; it must not use `ORDER BY updated_at DESC LIMIT 1` without an explicit ID.

- [ ] **Step 6: Run order tests**

Run: `node --test tests/orders.test.js tests/regressions.test.js`

Expected: PASS.

- [ ] **Step 7: Commit order binding**

```bash
git add src/routes/orders.routes.js src/routes/finance.routes.js src/integrations/mercadoLivre.js src/integrations/shopee.js tests/orders.test.js tests/regressions.test.js
git commit -m "feat: bind marketplace orders to accounts"
```

### Task 5: Replace the integrations UI with channel master-detail management

**Files:**
- Modify: `public/app.js:21-23`
- Modify: `public/styles.css`
- Modify: `tests/regressions.test.js`

- [ ] **Step 1: Add a failing UI contract check**

Assert that the integrations renderer contains grouped channel selectors, the visible count string, a link-generation action, and account-level edit/remove actions.

```js
test("integrations UI renders channel groups and account actions", () => {
  const app = read("public/app.js");
  assert.match(app, /contas vinculadas/);
  assert.match(app, /Gerar link/);
  assert.match(app, /data-rename-connection/);
  assert.match(app, /data-disconnect-connection/);
});
```

- [ ] **Step 2: Run the UI contract before implementation**

Run: `node --test tests/regressions.test.js`

Expected: FAIL because the current renderer only picks `(by[channel] || [])[0]`.

- [ ] **Step 3: Render selectable channel groups on the left**

Replace the current single-card loop with three channel rows. Render the channel name, `N conta(s) vinculada(s)`, connection health summary, selected state, and compact `Vincular` icon button. Stop propagation on the button so it starts OAuth without changing the selected group.

- [ ] **Step 4: Render account CRUD in the right panel**

When a user selects Mercado Livre or Shopee, fetch that channel’s accounts and render the account list. Each row must show the editable `display_name`, external ID, status, token expiry, last error, and controls for Save, Renew, Remove. The channel header renders `Vincular conta` and `Gerar link`; after creating a link, show a copyable readonly input plus an explicit `Copiar link` button.

Use `textContent` or existing `escapeHtml()` for account values. Never inject the public link into a URL preview, console, toast, or history. Clear the generated-link state when the page is re-rendered.

- [ ] **Step 5: Update marketplace order selection UI**

Replace the plain marketplace prompts in the order-link action with a second select populated from the active connections of the selected marketplace. Send `connectionId` with the existing `PATCH /orders/:id/link-marketplace` request. Display the selected account name in the orders table.

- [ ] **Step 6: Add responsive styles**

Add styles for `.integration-workspace`, `.integration-channel-list`, `.integration-channel`, `.integration-channel.selected`, `.connection-row`, `.connection-actions`, and `.oauth-link-output`. At narrow widths stack the two panels and keep account actions wrapped and keyboard reachable.

- [ ] **Step 7: Run UI contracts**

Run: `node --test tests/regressions.test.js`

Expected: PASS.

- [ ] **Step 8: Commit UI work**

```bash
git add public/app.js public/styles.css tests/regressions.test.js
git commit -m "feat: add multi-account integrations workspace"
```

### Task 6: Run migration and end-to-end verification

**Files:**
- Modify: `README.md` only if a deployment instruction changes.
- Test: `tests/*.test.js`

- [ ] **Step 1: Run the migration in the target environment**

From the Davantti repository root, run: `npm run migrate:volt-price`

Expected: migration `011_multi_account_marketplace_connections.sql` applies once and future runs skip it.

- [ ] **Step 2: Run the full unit suite**

Run: `node --test tests/*.test.js`

Expected: all tests pass.

- [ ] **Step 3: Verify direct OAuth manually**

In a tenant session, add two Mercado Livre accounts and two Shopee accounts. Confirm that each new authorization adds an account instead of replacing an existing account, then rename one account and refresh the page.

- [ ] **Step 4: Verify public links manually**

Generate a Mercado Livre link, open it in an incognito window, confirm the tenant label, authorize, and verify that the resulting account belongs to the intended tenant. Re-open the same link and verify the used state. Generate a second link, wait past its expiry in a controlled test environment or update its row, and verify the expired state.

- [ ] **Step 5: Verify account-specific order fees manually**

Link a Mercado Livre order to one of two active accounts and request fees. Confirm the request uses that connection ID. Clear the account link and confirm the interface requires a selection instead of selecting the newest account.

- [ ] **Step 6: Inspect the final diff and commit documentation only if changed**

Run: `git diff --check` and `git status -sb`

Expected: no whitespace errors; working tree contains only intentional changes.

If README changed:

```bash
git add README.md
git commit -m "docs: explain marketplace account links"
```
