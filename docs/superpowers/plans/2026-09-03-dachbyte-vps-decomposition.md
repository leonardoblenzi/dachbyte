# DACHBYTE VPS Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the DACHBYTE repository into independently runnable DACHBYTE Seller and DACHBYTE Business services, ready for deployment on one VPS without changing current production traffic or data.

**Architecture:** Move executable products under `apps/`, retain shared code under root-level shared directories, and make the gateway a standalone authentication and routing service. Caddy becomes the only public entry point and routes stable URLs to separate containers; PostgreSQL and Redis remain private services with named volumes.

**Tech Stack:** Node.js 20, Express, PostgreSQL, Redis, Bull/BullMQ, Docker Compose, Caddy, existing Python/Uvicorn Volt Chat API, Node test runner.

---

## Delivery phases

1. Lock the current behavior with route and path-contract tests.
2. Rename the repository tree atomically with `git mv` and repair all source references.
3. Extract standalone startup entrypoints, health endpoints, and product boundaries.
4. Add Docker images, the private Compose network, Caddy routing, and persistent data services.
5. Validate locally and in an isolated VPS staging stack; only then prepare a separate production cutover checklist.

The work stops after Phase 4 validation. Database migration, DNS changes, OAuth callback changes, and service shutdown are separate, explicitly approved operations.

## Target file structure

```text
apps/
  gateway/
    server.js
    package.json
  seller-ml/
  seller-shopee/
  seller-madeira/
  seller-tracking/
  seller-log/
  seller-leader/
  business/
    core/
    stock/
    chat/
    price/
infra/
  Caddyfile
  compose.vps.yml
  env/
    gateway.env.example
    seller-ml.env.example
    business.env.example
  docker/
    node.Dockerfile
    chat-api.Dockerfile
scripts/
  verify-vps-stack.ps1
tests/
  app-layout-contract.test.js
  gateway-product-boundary.test.js
  vps-compose-contract.test.js
```

### Task 1: Add contracts before moving files

**Files:**
- Create: `tests/app-layout-contract.test.js`
- Create: `tests/gateway-product-boundary.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write the failing repository-layout test.**

```js
// tests/app-layout-contract.test.js
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.join(__dirname, "..");
const products = [
  "apps/gateway/server.js",
  "apps/seller-ml/index.js",
  "apps/seller-shopee/src/server.js",
  "apps/seller-madeira/index.js",
  "apps/seller-tracking/index.cjs",
  "apps/seller-log/index.cjs",
  "apps/seller-leader/index.js",
  "apps/business/app.js",
  "apps/business/core/index.js",
  "apps/business/stock/index.js",
  "apps/business/chat/index.js",
  "apps/business/price/index.js",
];

test("DACHBYTE products live under apps with no legacy product directories", () => {
  for (const file of products) assert.equal(fs.existsSync(path.join(root, file)), true, file);
  for (const legacy of ["ml", "shopee", "MadeiraMadeira", "avantracking", "davanttilog", "LeaderSku", "business"]) {
    assert.equal(fs.existsSync(path.join(root, legacy)), false, legacy);
  }
});
```

- [ ] **Step 2: Write the failing gateway-boundary test.**

```js
// tests/gateway-product-boundary.test.js
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

test("gateway does not mount product applications in-process", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "apps", "gateway", "server.js"), "utf8");
  for (const forbidden of [
    'require("../seller-ml")',
    'require("../seller-shopee")',
    'require("../business/app")',
    "app.use(\"/ml\"",
    "app.use(\"/shopee\"",
  ]) assert.equal(source.includes(forbidden), false, forbidden);
  assert.match(source, /app\.get\(\[?"\/health/);
});
```

- [ ] **Step 3: Run the tests and confirm they fail because `apps/` does not exist.**

Run: `node --test tests/app-layout-contract.test.js tests/gateway-product-boundary.test.js`

Expected: FAIL with missing `apps/gateway/server.js` and missing product directories.

- [ ] **Step 4: Add a focused test script.**

```json
{
  "scripts": {
    "test:architecture": "node --test tests/app-layout-contract.test.js tests/gateway-product-boundary.test.js tests/vps-compose-contract.test.js"
  }
}
```

- [ ] **Step 5: Commit the red tests.**

```powershell
git add tests/app-layout-contract.test.js tests/gateway-product-boundary.test.js package.json
git commit -m "test: define DACHBYTE application boundaries"
```

### Task 2: Rename product directories to the DACHBYTE tree

**Files:**
- Move: `server.js` → `apps/gateway/server.js`
- Move: `ml/` → `apps/seller-ml/`
- Move: `shopee/` → `apps/seller-shopee/`
- Move: `MadeiraMadeira/` → `apps/seller-madeira/`
- Move: `avantracking/` → `apps/seller-tracking/`
- Move: `davanttilog/` → `apps/seller-log/`
- Move: `LeaderSku/` → `apps/seller-leader/`
- Move: `business/` → `apps/business/`
- Move: `apps/business/volt_core/` → `apps/business/core/`
- Move: `apps/business/volt_stock/` → `apps/business/stock/`
- Move: `apps/business/volt_chat/` → `apps/business/chat/`
- Move: `apps/business/volt-price/` → `apps/business/price/`
- Modify: `package.json`, all affected JavaScript/CJS/TypeScript files, tests, README files, and package-lock workspace paths

- [ ] **Step 1: Create a move manifest test that documents every old-to-new mapping.**

```js
const moves = {
  "ml": "apps/seller-ml",
  "shopee": "apps/seller-shopee",
  "MadeiraMadeira": "apps/seller-madeira",
  "avantracking": "apps/seller-tracking",
  "davanttilog": "apps/seller-log",
  "LeaderSku": "apps/seller-leader",
  "business": "apps/business",
};
```

Add this object to `tests/app-layout-contract.test.js` and assert each destination exists while each source does not.

- [ ] **Step 2: Run the layout test and confirm the new move assertions fail.**

Run: `node --test tests/app-layout-contract.test.js`

Expected: FAIL because the legacy directories still exist.

- [ ] **Step 3: Perform only Git-aware moves.**

```powershell
New-Item -ItemType Directory -Force apps
git mv server.js apps/gateway/server.js
git mv ml apps/seller-ml
git mv shopee apps/seller-shopee
git mv MadeiraMadeira apps/seller-madeira
git mv avantracking apps/seller-tracking
git mv davanttilog apps/seller-log
git mv LeaderSku apps/seller-leader
git mv business apps/business
git mv apps/business/volt_core apps/business/core
git mv apps/business/volt_stock apps/business/stock
git mv apps/business/volt_chat apps/business/chat
git mv apps/business/volt-price apps/business/price
```

- [ ] **Step 4: Update root workspace scripts and path references.**

```json
{
  "workspaces": ["apps/seller-ml", "apps/seller-shopee"],
  "scripts": {
    "start": "node apps/gateway/server.js",
    "worker:seller-ml": "node --max-old-space-size=384 apps/seller-ml/worker.js",
    "seller-ml:migrate": "npm --workspace apps/seller-ml run migrate",
    "business:build": "npm --prefix apps/business run build"
  }
}
```

Update every relative import discovered by `rg -n '(^|["'"'"'])\.?\.?/(ml|shopee|MadeiraMadeira|avantracking|davanttilog|LeaderSku|business)'` so it points to the new source location. Do not change HTTP URLs in this step.

- [ ] **Step 5: Run syntax and layout verification.**

Run: `node --test tests/app-layout-contract.test.js && node --check apps/gateway/server.js && node --check apps/seller-ml/worker.js && node --check apps/business/app.js`

Expected: PASS.

- [ ] **Step 6: Commit the mechanical rename separately.**

```powershell
git add -A
git commit -m "refactor: organize DACHBYTE products under apps"
```

### Task 3: Extract gateway and product startup boundaries

**Files:**
- Create: `apps/gateway/app.js`
- Create: `apps/gateway/server.js`
- Create: `apps/seller-ml/server.js`
- Create: `apps/seller-shopee/standalone.js`
- Create: `apps/seller-madeira/server.js`
- Create: `apps/seller-tracking/server.js`
- Create: `apps/seller-log/server.js`
- Create: `apps/seller-leader/server.js`
- Create: `apps/business/server.js`
- Create: `apps/business/chat/api-server.js`
- Modify: `apps/gateway/server.js`, product entry modules, `apps/business/app.js`, `apps/business/lib/voltChatRuntime.js`
- Modify: `tests/gateway-product-boundary.test.js`

- [ ] **Step 1: Write a failing standalone-server contract for every Node product.**

```js
const standaloneEntrypoints = [
  "apps/seller-ml/server.js",
  "apps/seller-shopee/standalone.js",
  "apps/seller-madeira/server.js",
  "apps/seller-tracking/server.js",
  "apps/seller-log/server.js",
  "apps/seller-leader/server.js",
  "apps/business/server.js",
];

test("every product exports a standalone starter", () => {
  for (const entry of standaloneEntrypoints) {
    const source = fs.readFileSync(path.join(root, entry), "utf8");
    assert.match(source, /async function start|const start = async/);
    assert.match(source, /process\.env\.PORT/);
    assert.match(source, /health/);
  }
});
```

- [ ] **Step 2: Run the server-boundary tests and confirm they fail.**

Run: `node --test tests/gateway-product-boundary.test.js`

Expected: FAIL because the standalone entrypoint files do not exist.

- [ ] **Step 3: Implement a common Node product starter in `platform/runtime/startExpressApp.js`.**

```js
"use strict";

function startExpressApp({ createApp, name, port = Number(process.env.PORT || 3000) }) {
  return Promise.resolve(createApp()).then((app) => {
    app.get(["/health", "/healthz"], (_req, res) => res.json({ ok: true, service: name }));
    return app.listen(port, "0.0.0.0", () => console.log(`[${name}] listening on ${port}`));
  });
}

module.exports = { startExpressApp };
```

- [ ] **Step 4: Implement each product wrapper with the shared starter.**

```js
"use strict";

const { startExpressApp } = require("../../platform/runtime/startExpressApp");
const createApp = require("./index");

async function start() {
  return startExpressApp({ createApp, name: "dachbyte-seller-ml" });
}

if (require.main === module) start();
module.exports = { start };
```

Use the same shape for Seller products and Business. Their `createApp` import must point to their actual factory module. Where an existing file only calls `listen`, split it into `createApp()` plus a `require.main` startup block before creating its wrapper.

- [ ] **Step 5: Remove product mounting and Volt Chat child-process startup from the gateway.**

Move gateway-only Express creation to `apps/gateway/app.js`. Delete imports of Seller and Business application factories from `apps/gateway/server.js`; retain login, root landing, `/go/*`, and public support routes. Replace the direct `startVoltChatApi()` call with no process startup. The Chat web service uses `DACHBYTE_CHAT_API_URL=http://dachbyte-business-chat-api:8001`.

- [ ] **Step 6: Run focused boundary tests and existing runtime tests.**

Run: `node --test tests/gateway-product-boundary.test.js apps/business/lib/voltChatProxy.test.js apps/business/lib/startRuntime.test.js`

Expected: PASS. The gateway contains no product `app.use` mount and Business proxy tests target a URL supplied by `DACHBYTE_CHAT_API_URL`.

- [ ] **Step 7: Commit startup separation.**

```powershell
git add apps/gateway apps/seller-* apps/business platform/runtime tests/gateway-product-boundary.test.js
git commit -m "refactor: run DACHBYTE products independently"
```

### Task 4: Build the private VPS stack

**Files:**
- Create: `infra/docker/node.Dockerfile`
- Create: `infra/docker/chat-api.Dockerfile`
- Create: `infra/compose.vps.yml`
- Create: `infra/Caddyfile`
- Create: `infra/env/gateway.env.example`
- Create: `infra/env/seller-ml.env.example`
- Create: `infra/env/business.env.example`
- Create: `tests/vps-compose-contract.test.js`

- [ ] **Step 1: Write a failing Compose contract test.**

```js
const fs = require("node:fs");
const test = require("node:test");
const assert = require("node:assert/strict");

test("VPS compose keeps data stores private and declares all DACHBYTE services", () => {
  const compose = fs.readFileSync("infra/compose.vps.yml", "utf8");
  for (const service of ["caddy", "gateway", "seller-ml-web", "seller-ml-worker", "seller-shopee", "business-chat-api", "postgres", "redis"]) {
    assert.match(compose, new RegExp(`^  ${service}:`, "m"));
  }
  assert.doesNotMatch(compose, /postgres:[\\s\\S]{0,900}ports:/);
  assert.doesNotMatch(compose, /redis:[\\s\\S]{0,900}ports:/);
  assert.match(compose, /postgres_data:/);
  assert.match(compose, /redis_data:/);
});
```

- [ ] **Step 2: Run the contract test and confirm it fails because Compose is absent.**

Run: `node --test tests/vps-compose-contract.test.js`

Expected: FAIL with `ENOENT` for `infra/compose.vps.yml`.

- [ ] **Step 3: Create the generic Node image.**

```dockerfile
# infra/docker/node.Dockerfile
FROM node:20-bookworm-slim
WORKDIR /app
COPY package*.json ./
COPY apps/seller-ml/package*.json ./apps/seller-ml/
COPY apps/seller-shopee/package*.json ./apps/seller-shopee/
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
CMD ["node", "apps/gateway/server.js"]
```

- [ ] **Step 4: Create Compose services with one internal network and named volumes.**

```yaml
services:
  caddy:
    image: caddy:2.8-alpine
    ports: ["80:80", "443:443"]
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile:ro", "caddy_data:/data", "caddy_config:/config"]
    depends_on: [gateway]
    restart: unless-stopped
  gateway:
    build: { context: "..", dockerfile: infra/docker/node.Dockerfile }
    command: ["node", "apps/gateway/server.js"]
    env_file: ["./env/gateway.env"]
    restart: unless-stopped
  seller-ml-web:
    build: { context: "..", dockerfile: infra/docker/node.Dockerfile }
    command: ["node", "apps/seller-ml/server.js"]
    env_file: ["./env/seller-ml.env"]
    depends_on: { postgres: { condition: service_healthy }, redis: { condition: service_healthy } }
    restart: unless-stopped
  seller-ml-worker:
    build: { context: "..", dockerfile: infra/docker/node.Dockerfile }
    command: ["node", "apps/seller-ml/worker.js"]
    env_file: ["./env/seller-ml.env"]
    depends_on: { postgres: { condition: service_healthy }, redis: { condition: service_healthy } }
    restart: unless-stopped
  postgres:
    image: postgres:16
    env_file: ["./env/postgres.env"]
    volumes: ["postgres_data:/var/lib/postgresql/data"]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB"], interval: 10s, timeout: 5s, retries: 10 }
  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]
    volumes: ["redis_data:/data"]
    healthcheck: { test: ["CMD", "redis-cli", "ping"], interval: 10s, timeout: 5s, retries: 10 }
volumes: { postgres_data: {}, redis_data: {}, caddy_data: {}, caddy_config: {} }
```

Add the other Seller and Business services using their Task 3 wrappers. No `ports:` key is allowed on those services, PostgreSQL, or Redis.

- [ ] **Step 5: Route stable URLs in Caddy.**

```caddyfile
{$DACHBYTE_DOMAIN} {
  encode zstd gzip
  handle /ml* { reverse_proxy seller-ml-web:3000 }
  handle /shopee* { reverse_proxy seller-shopee:3000 }
  handle /madeiramadeira* { reverse_proxy seller-madeira:3000 }
  handle /avantracking* { reverse_proxy seller-tracking:3000 }
  handle /davanttilog* { reverse_proxy seller-log:3000 }
  handle /skuleader* { reverse_proxy seller-leader:3000 }
  handle /business* { reverse_proxy business:3000 }
  handle /chat* { reverse_proxy business-chat-web:3000 }
  handle { reverse_proxy gateway:3000 }
}
```

- [ ] **Step 6: Add secret-safe examples and validate.**

Each `*.env.example` must contain names only, never real values. For example:

```env
PORT=3000
ML_DATABASE_URL=postgresql://dachbyte:CHANGE_ME@postgres:5432/dachbyte
REDIS_URL=redis://redis:6379
SUITE_JWT_SECRET=CHANGE_ME
DACHBYTE_CHAT_API_URL=http://business-chat-api:8001
```

Run: `node --test tests/vps-compose-contract.test.js && docker compose -f infra/compose.vps.yml config`

Expected: PASS and normalized Compose output with no public data-store ports.

- [ ] **Step 7: Commit the deployable infrastructure.**

```powershell
git add infra tests/vps-compose-contract.test.js
git commit -m "feat: add private DACHBYTE VPS stack"
```

### Task 5: Validate the complete stack and document handoff

**Files:**
- Create: `scripts/verify-vps-stack.ps1`
- Create: `docs/operations/dachbyte-vps-staging-runbook.md`
- Modify: `README.md`

- [ ] **Step 1: Write a failing smoke-test script assertion.**

```js
test("VPS verification script checks every public DACHBYTE route", () => {
  const source = fs.readFileSync("scripts/verify-vps-stack.ps1", "utf8");
  for (const route of ["/health", "/ml/health", "/shopee/health", "/madeiramadeira/health", "/avantracking/health", "/davanttilog/health", "/skuleader/health", "/business/health", "/chat/health"]) {
    assert.match(source, new RegExp(route.replaceAll("/", "\\\\/")));
  }
});
```

- [ ] **Step 2: Run the test and confirm it fails because the script is absent.**

Run: `node --test tests/vps-compose-contract.test.js`

Expected: FAIL with `ENOENT` for `scripts/verify-vps-stack.ps1`.

- [ ] **Step 3: Implement bounded staging verification.**

```powershell
param([string]$BaseUrl = "http://localhost")
$routes = @("/health", "/ml/health", "/shopee/health", "/madeiramadeira/health", "/avantracking/health", "/davanttilog/health", "/skuleader/health", "/business/health", "/chat/health")
foreach ($route in $routes) {
  $response = Invoke-WebRequest -Uri "$BaseUrl$route" -UseBasicParsing -TimeoutSec 15
  if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) { throw "$route returned $($response.StatusCode)" }
}
docker compose -f infra/compose.vps.yml ps
```

- [ ] **Step 4: Run local staging checks.**

Run:

```powershell
docker compose -f infra/compose.vps.yml up -d --build
pwsh -File scripts/verify-vps-stack.ps1
docker compose -f infra/compose.vps.yml logs --tail=100 --no-color
docker compose -f infra/compose.vps.yml down
```

Expected: every health route returns 2xx, ML web and worker connect to Redis/PostgreSQL, and `down` stops containers without deleting volumes.

- [ ] **Step 5: Document the staging-to-production boundary and rollback.**

`docs/operations/dachbyte-vps-staging-runbook.md` must state:

```markdown
1. Populate real VPS environment files outside Git.
2. Restore a sanitized backup into the staging PostgreSQL volume.
3. Run `pwsh -File scripts/verify-vps-stack.ps1` against the VPS staging domain.
4. Keep Render/Neon active during the full test window.
5. For a failed future cutover, restore the prior DNS/proxy target; do not delete VPS volumes or hosted services.
```

- [ ] **Step 6: Run the full regression suite and commit.**

Run: `npm run test:architecture && npm --workspace apps/seller-ml run test:jobs-panel && npm --prefix apps/business test`

Expected: PASS.

```powershell
git add scripts/verify-vps-stack.ps1 docs/operations/dachbyte-vps-staging-runbook.md README.md tests/vps-compose-contract.test.js
git commit -m "docs: add DACHBYTE VPS validation runbook"
```

## Acceptance checklist

- [ ] All executable products live in the approved `apps/` tree; no duplicate legacy directories remain.
- [ ] The gateway does not load product applications or start the Volt Chat API.
- [ ] Every product has an independent process and a health endpoint.
- [ ] Caddy is the only public network service.
- [ ] PostgreSQL and Redis have named volumes and no published ports.
- [ ] Compose, product boundaries, and repository layout have automated contract tests.
- [ ] Existing application test suites and the staging smoke test pass.
- [ ] Current hosted services, DNS, OAuth callbacks, and Neon production data remain untouched.
