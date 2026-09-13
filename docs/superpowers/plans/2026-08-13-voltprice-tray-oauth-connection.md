# VoltPrice Tray OAuth Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a tenant-safe Tray OAuth connection experience where Render holds app credentials, users authorize a verified store URL, encrypted tokens refresh automatically, and the UI reports only safe connection state.

**Architecture:** Keep the existing Express `/integrations` routes and Tray protocol, but extract the Tray connect/callback handlers behind injectable factories so their authorization, callback, token persistence and failure behavior are testable. The frontend keeps the prototype-led Integrations page and adds a dedicated Tray authorization form/status flow; `connectUrl` remains for Mercado Livre/Shopee. The Tray client receives a small dependency-injection seam for deterministic refresh/retry tests while retaining its public functions used by order sync.

**Tech Stack:** Node.js, Express, PostgreSQL/Neon, native `node:test`, browser JavaScript, existing VoltPrice encryption and OAuth-state infrastructure.

## Global Constraints

- Render environment variables exclusively hold `VOLT_PRICE_TRAY_CONSUMER_KEY`, `VOLT_PRICE_TRAY_CONSUMER_SECRET`, `VOLT_PRICE_PUBLIC_BASE_URL`, and `VOLT_PRICE_TRAY_ALLOWED_HOSTS`; no UI/database field for app credentials exists.
- Preserve tenant isolation, RLS, authentication, password-change guard, `integrations.manage`, CSRF, encrypted token storage, audit behavior and all existing non-Tray integration routes.
- The Tray store URL and Tray callback API host must be HTTPS and satisfy the configured host allowlist; reject private, arbitrary and non-HTTPS hosts.
- Never expose Consumer Key/Secret, authorization code, access token or refresh token in frontend state, API list responses, HTML, toast, audit metadata or error text. The opaque single-use OAuth state may appear only inside the generated provider authorization/callback URL required by the protocol; it is never rendered or logged.
- OAuth state is tenant/user/channel scoped, single use and expires in 15 minutes. Callback failures redirect to a constant, same-origin integration URL with only a generic failure indicator.
- Automatic token renewal has a five-minute pre-expiry margin, serializes refresh by row lock, persists replacement tokens encrypted, retries a provider 401 once only, and never schedules automatic order synchronization.
- Maintain the approved prototype UX/UI classes; all connection metrics and health labels derive from actual API metadata or an explicit unavailable state.

---

### Task 1: Make Tray OAuth endpoints safe, testable and callback-friendly

**Files:**
- Modify: `business/volt-price/src/routes/integrations.routes.js`
- Modify: `business/volt-price/src/integrations/tray.js`
- Create: `business/volt-price/tests/tray-oauth.test.js`

**Interfaces:**
- Consumes: `createOAuthState(auth, "tray", { storeHost })`, `consumeOAuthState(state, "tray")`, `tray.buildAuthUrl(req, storeHost, state)`, `tray.exchangeCode({ code, apiAddress })`, `upsertConnection`, `withTenant`, `audit`.
- Produces: `createTrayConnectHandler(deps?)`, `createTrayCallbackHandler(deps?)`, and `createTrayClient(deps?)`; existing imports continue to call default `tray.buildAuthUrl`, `exchangeCode`, `refreshLocked`, `listOrders`, `getOrder`, `getOrderComplete` unchanged.

- [ ] **Step 1: Write failing endpoint and client tests**

Create `tray-oauth.test.js` using injected handler/client dependencies and a small response recorder. Cover connect success, configuration failure, callback success, callback failure and one-refresh retry:

```js
test("Tray connect creates one opaque state cookie and returns only an authorization URL", async () => {
  const result = await invoke(createTrayConnectHandler({
    createOAuthState: async () => "opaque-state",
    buildAuthUrl: () => "https://loja.commercesuite.com.br/auth.php?state=opaque-state",
  }), authenticatedRequest({ storeHost: "https://loja.commercesuite.com.br" }));
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { authorizationUrl: "https://loja.commercesuite.com.br/auth.php?state=opaque-state" });
  assert.match(result.cookies[0].value, /opaque-state/);
  assert.doesNotMatch(JSON.stringify(result.body), /consumer|secret|token|code/i);
});

test("Tray callback stores exchanged tokens without returning or auditing them", async () => {
  const auditEvents = [];
  const result = await invoke(createTrayCallbackHandler({
    consumeOAuthState: async () => ({ tenant_id: "tenant-1", user_id: "user-1", payload: { storeHost: "https://loja.commercesuite.com.br" } }),
    exchangeCode: async () => ({ access_token: "access-secret", refresh_token: "refresh-secret", api_host: "https://api.commercesuite.com.br", store_id: "42" }),
    upsertConnection: async (_db, _tenantId, _channel, row) => { assert.equal(row.accessToken, "access-secret"); assert.equal(row.refreshToken, "refresh-secret"); },
    audit: async (_db, event) => auditEvents.push(event),
  }), callbackRequest({ state: "opaque", code: "provider-code", api_address: "https://api.commercesuite.com.br" }));
  assert.equal(result.redirectedTo, "/volt-price/app/integrations?connected=tray");
  assert.equal(JSON.stringify(auditEvents), JSON.stringify(auditEvents).replace(/access-secret|refresh-secret|provider-code/g, ""));
});

test("Tray callback failure redirects with a generic indicator and never leaks provider input", async () => {
  const result = await invoke(createTrayCallbackHandler({ consumeOAuthState: async () => null }), callbackRequest({ state: "bad-secret" }));
  assert.equal(result.redirectedTo, "/volt-price/app/integrations?tray=error");
  assert.doesNotMatch(result.redirectedTo, /bad-secret/);
});
```

For `createTrayClient`, inject `fetchJson` so a first 401 and a successful replacement request prove exactly two provider calls, one locked refresh and no second retry.

- [ ] **Step 2: Verify the new tests fail**

Run: `node --test volt-price/tests/tray-oauth.test.js`

Expected: FAIL because handler/client factories do not exist and callback errors use the general error path.

- [ ] **Step 3: Extract dependency-injected Tray handlers without changing route contracts**

In `integrations.routes.js`, add factories with defaults from the existing imports:

```js
function createTrayConnectHandler({ createOAuthState: createState = createOAuthState, buildAuthUrl = tray.buildAuthUrl } = {}) {
  return async (req, res, next) => {
    try {
      const storeHost = String(req.body?.storeHost || "").trim();
      const state = await createState(req.vpAuth, "tray", { storeHost });
      res.cookie("vp_tray_oauth_state", state, trayStateCookieOptions());
      res.json({ authorizationUrl: buildAuthUrl(req, storeHost, state) });
    } catch (error) { next(error); }
  };
}
```

`trayStateCookieOptions()` preserves existing HttpOnly, production-secure, `sameSite:"lax"`, 15-minute and callback-only path settings. `createTrayCallbackHandler` must consume only the provided state, require both code and callback API address, call `exchangeCode`, upsert encrypted token values through existing `upsertConnection`, audit only `{ store_id }`, clear the cookie and redirect exactly to `/volt-price/app/integrations?connected=tray`.

In its `catch`, clear the callback cookie and redirect exactly to `/volt-price/app/integrations?tray=error`; do not place provider error text, callback query values or secrets in that URL. Keep callback authentication-free because the state/cookie is the callback authorization mechanism.

Register the default factories on the existing routes, preserving `authenticate`, `requirePasswordChangeComplete`, `requireCsrf`, `requirePermission("integrations.manage")` on connect and existing routes for Meli/Shopee/refresh/disconnect. Export factories only for test use.

- [ ] **Step 4: Add an injectable Tray client seam and preserve refresh behavior**

Refactor `tray.js` around:

```js
function createTrayClient({ trayConfig = config.tray, getConnectionFn = getConnection,
  tokenValuesFn = tokenValues, upsertConnectionFn = upsertConnection,
  withTenantFn = withTenant, fetchJsonFn = fetchJson, baseUrlFn = baseUrl } = {}) {
  // return buildAuthUrl, exchangeCode, refreshLocked, listOrders, getOrder, getOrderComplete
}
const defaultTrayClient = createTrayClient();
module.exports = { ...defaultTrayClient, createTrayClient, parseTrayDate };
```

Retain `assertSafeHttpsUrl`/allowlist validation before all authorization, exchange, refresh and order URLs. In `trayCall`, retry only once after a 401/token failure and reuse the refreshed connection ID. `refreshLocked` continues to obtain the connection with `{ forUpdate:true, client }`, so simultaneous calls serialize at the database row.

- [ ] **Step 5: Run endpoint/client tests and security regressions**

Run: `node --test volt-price/tests/tray-oauth.test.js volt-price/tests/security.test.js volt-price/tests/orders.test.js`

Expected: PASS, including generic callback redirect, non-disclosure and single retry.

- [ ] **Step 6: Commit the secure OAuth runtime**

```bash
git add business/volt-price/src/routes/integrations.routes.js business/volt-price/src/integrations/tray.js business/volt-price/tests/tray-oauth.test.js
git commit -m "feat(volt-price): harden Tray OAuth connection flow"
```

### Task 2: Complete Tray authorization and connection status UX

**Files:**
- Modify: `business/volt-price/public/app.js:23-25`
- Modify: `business/volt-price/public/styles.css`
- Modify: `business/volt-price/tests/prototype-operations-ui.test.js`
- Create: `business/volt-price/tests/tray-connection-ui.test.js`

**Interfaces:**
- Consumes: `POST /integrations/tray/connect { storeHost }`, `GET /integrations/` safe connection metadata, `POST /integrations/tray/refresh`, `POST /integrations/tray/disconnect` and `api`, `toast`, `escapeHtml`, `date`.
- Produces: `startTrayAuthorization()` and `consumeIntegrationRedirect()` inside `app.js`; Meli/Shopee keep using the existing `connectUrl` helper.

- [ ] **Step 1: Write failing Tray UI contract tests**

Create `tray-connection-ui.test.js` and assert the specialized Tray UX has no sensitive fields and uses browser navigation only after the CSRF-protected request succeeds:

```js
assert.match(source, /id="trayConnectForm"/);
assert.match(source, /id="trayHost"[^>]*type="url"/);
assert.match(source, /Autorizar na Tray/);
assert.match(source, /async function startTrayAuthorization/);
assert.match(source, /api\("\/integrations\/tray\/connect",\{method:"POST"/);
assert.match(source, /location\.assign\(result\.authorizationUrl\)/);
assert.match(source, /new URLSearchParams\(location\.search\).*connected/);
assert.match(source, /history\.replaceState/);
assert.doesNotMatch(source, /trayConsumerSecret|consumer_secret|refreshToken.*trayHost|accessToken.*trayHost/i);
```

Add a static assertion that `connection_status`, `token_expires_at`, `last_refresh_at` and `last_error` are the only token-lifecycle values rendered by the Tray card; no raw `token_cipher`, `refresh_token_cipher`, `access_token`, or `refresh_token` may appear.

- [ ] **Step 2: Verify the Tray UI tests fail**

Run: `node --test volt-price/tests/tray-connection-ui.test.js`

Expected: FAIL because generic `connectUrl` currently controls Tray and there is no callback-success cleanup.

- [ ] **Step 3: Build the specialized Tray form and status card**

In `integrations(root)`, render Tray separately from Meli/Shopee:

```html
<form id="trayConnectForm" class="card section">
  <div class="section-title"><h3>Tray</h3><span class="chip blue">OAuth</span></div>
  <p class="muted">Informe a URL da loja para abrir a autorização segura da Tray.</p>
  <label>URL da loja
    <input id="trayHost" type="url" inputmode="url" autocomplete="url"
      placeholder="https://sualoja.commercesuite.com.br" required>
  </label>
  <p id="trayConnectError" class="form-error hidden" role="alert" aria-live="assertive"></p>
  <button class="primary" id="connectTray" type="submit">Autorizar na Tray</button>
</form>
```

The connected Tray card uses actual `display_name`, `connection_status`, `token_expires_at`, `refresh_expires_at`, `last_refresh_at`, and redacted `last_error`; it uses the existing semantic chip mapping and existing refresh/disconnect API calls. Do not display an access or refresh token, app secret, callback URL, authorization URL, raw provider payload or unredacted technical error.

- [ ] **Step 4: Add authorization and callback-return browser behavior**

Implement:

```js
async function startTrayAuthorization(event) {
  event.preventDefault();
  const button = $("#connectTray");
  setFormError("#trayConnectError");
  button.disabled = true;
  try {
    const result = await api("/integrations/tray/connect", {
      method: "POST", body: JSON.stringify({ storeHost: $("#trayHost").value.trim() }),
    });
    location.assign(result.authorizationUrl);
  } catch (error) {
    setFormError("#trayConnectError", error.message);
    button.disabled = false;
  }
}

function consumeIntegrationRedirect() {
  const params = new URLSearchParams(location.search);
  if (params.get("connected") === "tray") toast("Tray conectada com sucesso.");
  if (params.get("tray") === "error") toast("Não foi possível concluir a autorização da Tray. Tente novamente.", true);
  if (params.has("connected") || params.has("tray")) history.replaceState({}, "", location.pathname);
}
```

Call `consumeIntegrationRedirect()` only after a successful authenticated boot and before rendering Integration content. Meli/Shopee query indicators, if added later, are not consumed by this Tray-specific implementation.

- [ ] **Step 5: Verify UI contracts and existing operations behavior**

Run: `node --test volt-price/tests/tray-connection-ui.test.js volt-price/tests/prototype-operations-ui.test.js volt-price/tests/login-ui-contract.test.js`

Expected: PASS; existing manual order synchronization and other provider connections remain intact.

- [ ] **Step 6: Commit Tray connection UX**

```bash
git add business/volt-price/public/app.js business/volt-price/public/styles.css business/volt-price/tests/prototype-operations-ui.test.js business/volt-price/tests/tray-connection-ui.test.js
git commit -m "feat(volt-price): add Tray authorization experience"
```

### Task 3: Document Render setup and complete verification

**Files:**
- Modify: `business/volt-price/.env.example`
- Modify: `business/volt-price/README.md`
- Modify: `business/volt-price/tests/tray-connection-ui.test.js`

**Interfaces:**
- Consumes: the runtime config names, constant callback route, endpoint/UI behavior from Tasks 1–2.
- Produces: a deployable, secret-safe configuration checklist and final verified flow.

- [ ] **Step 1: Write a failing deployment documentation test**

Add a README/.env contract test:

```js
assert.match(envExample, /^VOLT_PRICE_TRAY_CONSUMER_KEY=/m);
assert.match(envExample, /^VOLT_PRICE_TRAY_CONSUMER_SECRET=/m);
assert.match(readme, /VOLT_PRICE_PUBLIC_BASE_URL/);
assert.match(readme, /\/volt-price\/api\/integrations\/tray\/callback/);
assert.match(readme, /n[aã]o.*(?:exibe|envia).*token/i);
assert.match(readme, /renova.*automaticamente/i);
```

- [ ] **Step 2: Verify the deployment documentation test fails**

Run: `node --test volt-price/tests/tray-connection-ui.test.js`

Expected: FAIL until exact callback registration and non-disclosure/renewal instructions are documented.

- [ ] **Step 3: Document the exact Render and Tray setup**

Add a `### Conectar Tray por OAuth` README subsection that instructs an operator to:

1. set Consumer Key/Secret and public base URL in Render only;
2. set the exact callback `${VOLT_PRICE_PUBLIC_BASE_URL}/volt-price/api/integrations/tray/callback` in the Tray app;
3. allow only verified store hosts;
4. enter the store URL and use **Autorizar na Tray**;
5. confirm consent, then verify connection status/renewal;
6. never paste credentials/tokens into the browser or commit them.

Keep `.env.example` variable names and safe host comment aligned with `config.js`; do not add actual values or secrets.

- [ ] **Step 4: Run full automated verification**

Run: `npm --prefix business run test:volt-price`

Expected: PASS.

Run: `node --check business/volt-price/public/app.js`

Expected: PASS.

Run: `git diff --check`

Expected: no output and exit code 0.

- [ ] **Step 5: Run a non-production Tray authorization QA**

With a migrated test database, configured Render-equivalent environment values and a Tray test store, verify:

```text
1. /integrations shows no app secret/token fields.
2. Store URL opens the provider authorization page.
3. Consent returns to /app/integrations?connected=tray and renders a generic success message.
4. A connection row exposes only safe metadata.
5. Manual refresh changes only safe status/expiry metadata.
6. Disconnect removes access, and a subsequent order sync reports Tray not connected.
7. Invalid host and denied authorization show generic, non-secret errors.
```

At 1440px, 1024px and 390px, verify keyboard focus, form error announcement, readable connection status, no horizontal overflow and no sensitive text in rendered page source. If the test store/database is unavailable, record the exact missing dependency and do not fabricate provider callback/token data.

- [ ] **Step 6: Commit documentation and final verification**

```bash
git add business/volt-price/.env.example business/volt-price/README.md business/volt-price/tests/tray-connection-ui.test.js
git commit -m "docs(volt-price): document Tray OAuth setup"
```

## Plan self-review

- **Coverage:** Task 1 tests and hardens state/callback/token renewal; Task 2 completes user authorization/status behavior without secrets; Task 3 documents Render/provider setup and runs automated/non-production QA.
- **No placeholders:** each task names exact files, handlers, routes, test fixtures, commands and commit boundaries.
- **Type consistency:** all changes use current config names, current `/integrations/tray/*` route strings and current Tray client exports. `createTrayClient`, `createTrayConnectHandler` and `createTrayCallbackHandler` are introduced in Task 1 and consumed only by its tests/routes.
