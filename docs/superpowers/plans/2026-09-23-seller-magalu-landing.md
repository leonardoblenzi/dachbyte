# DACHBYTE Seller Magalu Landing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a provisional DACHBYTE Seller Magalu landing and public legal pages, with stable URLs for IDM client registration, while adding Magalu consistently to Seller landing navigation.

**Architecture:** Gateway owns the new public routes and sends static HTML from `apps/seller-ml/views`, reusing the Seller design system. `/magalu/auth/callback` is explicitly a controlled placeholder and must not handle OAuth input or secrets until the future product exists.

**Tech Stack:** Node.js/CommonJS, Express, static HTML/CSS, Node built-in test runner.

---

## File structure

- Create: `apps/seller-ml/views/landing-magalu.html` — commercial pre-launch page at `/seller/magalu`.
- Create: `apps/seller-ml/views/legal-magalu-terms.html` — Magalu-specific Terms.
- Create: `apps/seller-ml/views/legal-magalu-privacy.html` — Magalu-specific Privacy.
- Create: `tests/seller-magalu-public-pages.test.js` — route/content/navigation contracts.
- Modify: `apps/gateway/server.js` — public static page handlers and callback placeholder.
- Modify: `apps/seller-ml/views/landing-general.html` — fourth module card and Magalu nav item.
- Modify: `apps/seller-ml/views/landing-mercado-livre.html` — Magalu nav item.
- Modify: `apps/seller-ml/views/landing-shopee.html` — Magalu nav item.
- Modify: `apps/seller-ml/views/landing-tracking.html` — Magalu nav item.

No Caddy, Compose, Hub, container, schema, Redis, token, webhook or authenticated selection-page change is in scope.

### Task 1: Define failing public-page contracts

**Files:**
- Create: `tests/seller-magalu-public-pages.test.js`

- [ ] **Step 1: Write the failing Gateway contract**

```js
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const root = path.join(__dirname, "..");
const gateway = fs.readFileSync(path.join(root, "apps", "gateway", "server.js"), "utf8");

test("Gateway exposes public Magalu pages and a safe callback placeholder", () => {
  for (const route of ['"/seller/magalu"', '"/seller/magalu/termos"', '"/seller/magalu/privacidade"', '"/magalu/auth/callback"']) assert.ok(gateway.includes(route), route);
  assert.match(gateway, /magalu_oauth_not_configured/);
  assert.doesNotMatch(gateway, /MAGALU_CLIENT_SECRET/);
});
```

- [ ] **Step 2: Write the failing page and navigation contracts**

```js
test("Magalu pages disclose the provisional integration scope", () => {
  const landing = fs.readFileSync(path.join(root, "apps", "seller-ml", "views", "landing-magalu.html"), "utf8");
  const terms = fs.readFileSync(path.join(root, "apps", "seller-ml", "views", "legal-magalu-terms.html"), "utf8");
  const privacy = fs.readFileSync(path.join(root, "apps", "seller-ml", "views", "legal-magalu-privacy.html"), "utf8");
  assert.match(landing, /Catálogo/i); assert.match(landing, /Preços/i); assert.match(landing, /Estoque/i); assert.match(landing, /Em breve/i);
  assert.match(landing, /\/seller\/magalu\/termos/); assert.match(landing, /\/seller\/magalu\/privacidade/);
  assert.match(terms, /tokens OAuth/i); assert.match(terms, /revogar/i);
  assert.match(privacy, /webhooks/i); assert.match(privacy, /dados de catálogo, preços e estoque/i);
});

test("every Seller landing links to Magalu", () => {
  for (const file of ["landing-general.html", "landing-mercado-livre.html", "landing-shopee.html", "landing-tracking.html", "landing-magalu.html"]) {
    const source = fs.readFileSync(path.join(root, "apps", "seller-ml", "views", file), "utf8");
    assert.match(source, /href="\/seller\/magalu"/, file);
  }
});
```

- [ ] **Step 3: Run the red test**

Run: `node --test tests/seller-magalu-public-pages.test.js`

Expected: FAIL because files and routes are absent.

- [ ] **Step 4: Commit test contract**

Run: `git add tests/seller-magalu-public-pages.test.js; git commit -m "test: define public Magalu landing contracts"`

### Task 2: Create the Seller-styled landing and legal pages

**Files:**
- Create: `apps/seller-ml/views/landing-magalu.html`
- Create: `apps/seller-ml/views/legal-magalu-terms.html`
- Create: `apps/seller-ml/views/legal-magalu-privacy.html`

- [ ] **Step 1: Write the landing using existing Seller assets**

Copy the HTML shell, favicon, stylesheet links and `seller-landing.js` script contract from `apps/seller-ml/views/landing-mercado-livre.html`. Use the existing CSS files `/seller-assets/seller-landing.css?v=5` and `/brand/dachbyte/theme.css?v=20260904`.

```html
<div class="seller-kicker">DACHBYTE Magalu · em breve</div>
<h1 class="seller-title">Sua operação Magalu.<br><em>Mais visível desde o catálogo.</em></h1>
<p class="seller-lead">Catálogo, preços e estoque em uma leitura operacional para sua equipe acompanhar o que precisa de ação.</p>
<div class="seller-hero__actions"><a class="seller-button" href="#contato">Quero participar do piloto</a><a class="seller-button seller-button--ghost" href="/seller">Conhecer DACHBYTE Seller</a></div>
```

Create three `seller-scenario` cards titled `Catálogo organizado`, `Preços acompanhados`, and `Estoque sincronizado`. Add a trust section that says the future connection uses official seller authorization and only permissions consented by the seller. Do not include login, OAuth, or “Entrar no módulo” links. Footer must link to `/seller/magalu/termos`, `/seller/magalu/privacidade`, and `/seller`.

- [ ] **Step 2: Write the terms page**

Reuse the same public visual shell, include link back to `/seller/magalu`, `mailto:contato@dachbyte.tech`, and `Última atualização: 23 de setembro de 2026.`. Include exactly these content blocks:

```html
<h1>Termos de uso — DACHBYTE Magalu</h1>
<h2>Escopo da integração</h2><p>A integração será disponibilizada para consulta e sincronização de catálogo, preços e estoque mediante autorização do seller.</p>
<h2>Autorização e desconexão</h2><p>O seller poderá revogar a autorização no ambiente Magalu ou solicitar a desconexão à DACHBYTE. A revogação impede novas consultas e sincronizações após o processamento da solicitação.</p>
<h2>Credenciais e tokens OAuth</h2><p>Tokens OAuth são credenciais técnicas usadas exclusivamente para executar as permissões autorizadas pelo seller; não são exibidos em telas do produto.</p>
```

- [ ] **Step 3: Write the privacy page**

Reuse the same public visual shell and link back to `/seller/magalu` and `/seller/magalu/termos`. Include exactly:

```html
<h1>Privacidade — DACHBYTE Magalu</h1>
<h2>Dados tratados</h2><p>Quando autorizado, o DACHBYTE Magalu trata dados de catálogo, preços e estoque necessários para apresentar a integração e executar sincronizações solicitadas.</p>
<h2>Tokens, eventos e webhooks</h2><p>Tokens OAuth e segredos de webhook são armazenados de forma protegida. Eventos de webhooks são usados para atualizar dados autorizados e investigar falhas de integração.</p>
<h2>Finalidade e retenção</h2><p>Os dados são utilizados para fornecer a integração, manter a segurança, detectar falhas e cumprir obrigações aplicáveis. A retenção segue a necessidade operacional e os direitos legais do titular.</p>
```

- [ ] **Step 4: Run the focused test**

Run: `node --test tests/seller-magalu-public-pages.test.js`

Expected: content tests pass and only Gateway assertions fail.

- [ ] **Step 5: Commit page assets**

Run: `git add apps/seller-ml/views/landing-magalu.html apps/seller-ml/views/legal-magalu-terms.html apps/seller-ml/views/legal-magalu-privacy.html; git commit -m "feat: add provisional Seller Magalu public pages"`

### Task 3: Add Magalu to existing Seller landing navigation

**Files:**
- Modify: `apps/seller-ml/views/landing-general.html`
- Modify: `apps/seller-ml/views/landing-mercado-livre.html`
- Modify: `apps/seller-ml/views/landing-shopee.html`
- Modify: `apps/seller-ml/views/landing-tracking.html`
- Modify: `apps/seller-ml/views/landing-magalu.html`

- [ ] **Step 1: Insert the common link into the existing four Seller navs**

Insert after Shopee and before Rastreio:

```html
<a href="/seller/magalu">Magalu <small>em breve</small></a>
```

The new landing uses the active version:

```html
<a class="is-active" aria-current="page" href="/seller/magalu">Magalu <small>em breve</small></a>
```

- [ ] **Step 2: Add the fourth module card to `landing-general.html`**

Insert after Tracking:

```html
<article class="seller-card"><span class="seller-card__index">04 / EM BREVE</span><h3>Magalu</h3><p>Catálogo, preços e estoque organizados para a rotina do seller Magalu.</p><ul class="seller-card__features"><li>Catálogo e SKUs acompanhados</li><li>Preços com contexto</li><li>Estoque pronto para sincronizar</li></ul><a href="/seller/magalu">Conhecer DACHBYTE Magalu →</a></article>
```

Replace the nearby heading `Três módulos. Uma operação mais clara.` with `Quatro módulos. Uma operação mais clara.`

- [ ] **Step 3: Verify and commit navigation**

Run: `node --test tests/seller-magalu-public-pages.test.js`

Expected: all non-Gateway assertions pass.

Run: `git add apps/seller-ml/views/landing-general.html apps/seller-ml/views/landing-mercado-livre.html apps/seller-ml/views/landing-shopee.html apps/seller-ml/views/landing-tracking.html apps/seller-ml/views/landing-magalu.html; git commit -m "feat: add Magalu to Seller landing navigation"`

### Task 4: Serve pages through Gateway and reserve callback URL

**Files:**
- Modify: `apps/gateway/server.js`

- [ ] **Step 1: Add static handlers beside existing public Seller routes and before `registerCanonicalRoutes`**

```js
app.get(["/seller/magalu", "/seller/magalu/"], sendSellerLanding("landing-magalu.html"));
app.get(["/seller/magalu/termos", "/seller/magalu/termos/"], sendSellerLanding("legal-magalu-terms.html"));
app.get(["/seller/magalu/privacidade", "/seller/magalu/privacidade/"], sendSellerLanding("legal-magalu-privacy.html"));
```

Do not update `platform/gateway/canonicalRoutes.js`; `/seller/magalu` is a Gateway-owned canonical public page, not a legacy adapter.

- [ ] **Step 2: Add controlled callback route before final 404 middleware**

```js
app.get("/magalu/auth/callback", (_req, res) => res.status(503).json({
  ok: false,
  error: "magalu_oauth_not_configured",
  message: "A integração DACHBYTE Magalu ainda não está disponível.",
}));
```

The callback must not read `code`, `state`, query values, environment variables, credentials, or tokens.

- [ ] **Step 3: Run validation and commit**

Run: `node --test tests/seller-magalu-public-pages.test.js; npm run test:architecture; git diff --check; node --check apps/gateway/server.js`

Expected: all tests pass, static checks exit 0 with no output.

Run: `git add apps/gateway/server.js tests/seller-magalu-public-pages.test.js; git commit -m "feat: publish Seller Magalu legal routes"`

### Task 5: Verify actual anonymous HTTP behavior

**Files:** none unless verification identifies a defect.

- [ ] **Step 1: Start Gateway and request all new routes**

Run `node apps/gateway/server.js` in one terminal. In a second terminal run:

```powershell
curl.exe -i http://localhost:3000/seller/magalu
curl.exe -i http://localhost:3000/seller/magalu/termos
curl.exe -i http://localhost:3000/seller/magalu/privacidade
curl.exe -i http://localhost:3000/magalu/auth/callback
```

Expected: first three are `200` HTML. Callback is `503` JSON with `magalu_oauth_not_configured`.

- [ ] **Step 2: Perform final clean verification**

Run: `node --test tests/seller-magalu-public-pages.test.js; npm run test:architecture; git diff --check; git status --short`

Expected: suites pass; do not stage pre-existing Product Ads files, `.codex/`, or `.superpowers/` files.

## Self-review

The plan implements every approved public page, legal disclosure, navigation change, and stable callback URL. It deliberately excludes OAuth exchange, secrets, schema, containers, Hub, queues and webhooks until the client exists.
