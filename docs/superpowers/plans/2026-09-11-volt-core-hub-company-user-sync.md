# Volt Core Hub Company and User Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que o Volt Core crie empresas e usuarios operacionais, persistindo primeiro a identidade, empresa e acesso `volt_core` no Hub.

**Architecture:** O Hub ganha comandos internos idempotentes para provisionar empresa e usuario de produto. O Volt Core chama esses comandos antes de persistir seu espelho local; o banco Core continua guardando somente configuracao operacional, perfil e permissoes por tela.

**Tech Stack:** Cloudflare Worker TypeScript, Neon/PostgreSQL, Node.js/Express, React, Node test runner.

## Checkpoint de implementação — 2026-09-11

- Hub: concluído o endpoint interno `POST /v1/internal/identity/company`, com criação idempotente de tenant e ativação de `volt_core`.
- Hub: concluída a proteção que impede sincronizar usuário `volt_core` quando o produto não está ativo no tenant.
- Core: concluído o cliente interno Hub, a criação Hub-first de empresa e a sincronização/convite Hub-first de usuário.
- Interface: o master não recebe mais uma empresa pré-selecionada silenciosamente no modal de usuário; os modais informam a sincronização central.
- Migration aplicada: `C:/Users/USER/Documents/Projetos/hub pagamento/sql/053_internal_identity_provisioning.sql`, na branch Neon `payment` (2026-09-11).
- Validações locais: Hub `npm run test:identity` 58/58 e `tsc --noEmit`; Core `npm test` 235/235 e build Vite aprovados.
- Ainda não realizado: commit, push, deploy ou teste ponta a ponta no staging desta alteração.

---

### Task 1: Contrato interno de provisionamento de empresa no Hub

**Files:**
- Modify: `C:/Users/USER/Documents/Projetos/hub pagamento/src/modules/identity/contracts.ts`
- Modify: `C:/Users/USER/Documents/Projetos/hub pagamento/src/modules/identity/internalRoutes.ts`
- Modify: `C:/Users/USER/Documents/Projetos/hub pagamento/src/modules/identity/service.ts`
- Modify: `C:/Users/USER/Documents/Projetos/hub pagamento/src/modules/identity/repository.ts`
- Create: `C:/Users/USER/Documents/Projetos/hub pagamento/sql/053_internal_identity_provisioning.sql`
- Test: `C:/Users/USER/Documents/Projetos/hub pagamento/tests/identity/internalRoutes.test.ts`

- [x] **Step 1: Write the failing test**

Add a request for `POST /v1/internal/identity/company` authenticated with `HUB_INTERNAL_TOKEN`. The request contains `idempotency_key`, `company_name`, optional document fields and `module: "volt_core"`. Assert one tenant, one active `volt_core` product and the same tenant ID after a replay with the same idempotency key.

- [x] **Step 2: Run test to verify it fails**

Run: `npm run test:identity`

Expected: FAIL because `/v1/internal/identity/company` does not exist.

- [x] **Step 3: Write minimal implementation**

Add `InternalCompanyProvisionRequest`, validate its fields, generate the Hub tenant ID, upsert `tenants`, resolve billing product `volt_core`, and upsert `tenant_products` with `status: "active"` and source `module_provision:volt_core`. Add migration `051_internal_identity_provisioning.sql` with `internal_identity_provisioning_operations` keyed by `(origin_module, idempotency_key)` and storing request fingerprint, status and response JSON. Store and replay the result by idempotency key without creating duplicate tenant/product rows. A key reused with a different payload returns `409 identity_provisioning_idempotency_conflict`.

- [x] **Step 4: Run test to verify it passes**

Run: `npm run test:identity`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sql/051_internal_identity_provisioning.sql src/modules/identity/contracts.ts src/modules/identity/internalRoutes.ts src/modules/identity/service.ts src/modules/identity/repository.ts tests/identity/internalRoutes.test.ts
git commit -m "Add Hub provisioning for Volt Core companies"
```

### Task 2: Criacao de usuario de produto e convite central no Hub

**Files:**
- Modify: `C:/Users/USER/Documents/Projetos/hub pagamento/src/modules/identity/contracts.ts`
- Modify: `C:/Users/USER/Documents/Projetos/hub pagamento/src/modules/identity/internalRoutes.ts`
- Modify: `C:/Users/USER/Documents/Projetos/hub pagamento/src/modules/identity/service.ts`
- Test: `C:/Users/USER/Documents/Projetos/hub pagamento/tests/identity/internalInviteRoutes.test.ts`

- [ ] **Step 1: Write the failing test**

Add a `POST /v1/internal/identity/sync` request for an existing tenant with `module: "volt_core"`, `invite: true` and a new e-mail. Assert that the Hub returns the canonical `tenant_id`/`user_id`, creates `tenant_users`, grants pending `tenant_user_module_access` for `volt_core`, and creates a module invite.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:identity`

Expected: FAIL until the company-provisioned `volt_core` product is accepted by the identity path.

- [ ] **Step 3: Write minimal implementation**

Reuse `upsertTenantAndUserIdentity` after validating that the target tenant exists and has active `volt_core`. Preserve the existing e-mail deduplication behavior, create one product grant, and return the Hub IDs plus invite outcome.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:identity`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/identity/contracts.ts src/modules/identity/internalRoutes.ts src/modules/identity/service.ts tests/identity/internalInviteRoutes.test.ts
git commit -m "Grant Volt Core users through Hub identity sync"
```

### Task 3: Cliente Hub no Volt Core e persistencia sem usuario solto

**Files:**
- Create: `C:/Users/USER/Documents/Projetos/davantti/apps/business/core/src/modules/auth/hubProvisioningClient.js`
- Modify: `C:/Users/USER/Documents/Projetos/davantti/apps/business/core/src/modules/core/runtime/services/platformService.js`
- Modify: `C:/Users/USER/Documents/Projetos/davantti/apps/business/core/src/modules/core/runtime/services/userService.js`
- Modify: `C:/Users/USER/Documents/Projetos/davantti/apps/business/core/src/controllers/RuntimeController.js`
- Test: `C:/Users/USER/Documents/Projetos/davantti/apps/business/core/src/modules/core/platformFoundation.test.js`
- Test: `C:/Users/USER/Documents/Projetos/davantti/apps/business/core/src/modules/auth/authService.test.js`

- [x] **Step 1: Write failing tests**

Cover these behaviors:

```js
test("creates a Core company only after Hub returns its tenant id", async () => {
  // Stub Hub company provisioning with { tenant_id: "tenant-hub-1" }.
  // Assert the Core company uses tenant-hub-1 and the Hub call occurs first.
});

test("does not persist a Core user when Hub invite provisioning fails", async () => {
  // Stub Hub identity sync as unavailable.
  // Assert createCompanyUser rejects and no users/user_companies rows are inserted.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test apps/business/core/src/modules/core/platformFoundation.test.js apps/business/core/src/modules/auth/authService.test.js`

Expected: FAIL because local services currently write before calling the Hub.

- [x] **Step 3: Write minimal implementation**

Create `hubProvisioningClient.js` to POST bearer-authenticated, timeout-bound calls to `/v1/internal/identity/company` and `/v1/internal/identity/sync`. `createCompany` calls the company endpoint before `applySegmentTemplate`, stores the returned Hub tenant ID in `volt_core.companies.tenant_global_id`, and uses a generated idempotency key. `createCompanyUser` verifies that the Core company has a tenant global ID, calls identity sync with `volt_core` and invite requested, then writes the local user with the returned global user ID and random unusable local password.

- [x] **Step 4: Run tests to verify they pass**

Run: `node --test apps/business/core/src/modules/core/platformFoundation.test.js apps/business/core/src/modules/auth/authService.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/business/core/src/modules/auth/hubProvisioningClient.js apps/business/core/src/modules/core/runtime/services/platformService.js apps/business/core/src/modules/core/runtime/services/userService.js apps/business/core/src/controllers/RuntimeController.js apps/business/core/src/modules/core/platformFoundation.test.js apps/business/core/src/modules/auth/authService.test.js
git commit -m "Provision Volt Core companies and users through Hub"
```

### Task 4: Corrigir o modal master e comunicar sincronizacao

**Files:**
- Modify: `C:/Users/USER/Documents/Projetos/davantti/apps/business/core/src/client/modals/config.js`
- Modify: `C:/Users/USER/Documents/Projetos/davantti/apps/business/core/src/client/main.jsx`
- Test: `C:/Users/USER/Documents/Projetos/davantti/apps/business/core/src/modules/core/platformFoundation.test.js`

- [ ] **Step 1: Write the failing test**

Assert that a user modal in master context starts with `companyId: ""`, requires an explicit selection, and that the company modal explains `Hub primeiro, Core depois`. Assert that a user modal inside an opened company has one immutable company context.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test apps/business/core/src/modules/core/platformFoundation.test.js`

Expected: FAIL because `defaultUserCompanyId` currently supplies the first company automatically.

- [ ] **Step 3: Write minimal implementation**

Remove the master default company, render the selected company as immutable for company-context creation, and add progress feedback: `Validando empresa no Hub`, `Enviando convite` and `Acesso criado`. Surface Hub failures as user-safe errors with retry action; do not expose transport error codes.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test apps/business/core/src/modules/core/platformFoundation.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/business/core/src/client/modals/config.js apps/business/core/src/client/main.jsx apps/business/core/src/modules/core/platformFoundation.test.js
git commit -m "Require Hub company context for Volt Core users"
```

### Task 5: Reconciliacao, seguranca e validacao ponta a ponta

**Files:**
- Modify: `C:/Users/USER/Documents/Projetos/davantti/apps/business/core/src/modules/auth/hubProvisioningClient.js`
- Modify: `C:/Users/USER/Documents/Projetos/davantti/apps/business/core/src/modules/core/runtime/services/platformService.js`
- Modify: `C:/Users/USER/Documents/Projetos/davantti/apps/business/core/src/modules/core/runtime/services/userService.js`
- Test: `C:/Users/USER/Documents/Projetos/davantti/apps/business/core/src/modules/auth/authService.test.js`
- Test: `C:/Users/USER/Documents/Projetos/hub pagamento/tests/identity/internalInviteRoutes.test.ts`

- [ ] **Step 1: Write failing tests**

Add replay tests asserting that the same idempotency key does not duplicate a Hub tenant, Hub user, Core company or Core membership. Add an access test proving an inactive Hub tenant or revoked `volt_core` grant denies the Core login even when a local membership remains.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test apps/business/core/src/modules/auth/authService.test.js` and `npm run test:identity`

Expected: FAIL until idempotency response handling and effective access revalidation are connected.

- [ ] **Step 3: Write minimal implementation**

Persist the Hub tenant/user IDs and idempotency key with the local operation, reuse it on retry, and treat Hub effective access as authoritative at login and authenticated request boundaries. Keep the technical master bootstrap exempt from tenant lookup only.

- [ ] **Step 4: Run complete verification**

Run in Hub: `npm run test:identity`

Run in DACH: `node --test apps/business/core/src/modules/auth/authService.test.js apps/business/core/src/modules/core/platformFoundation.test.js tests/vps-compose-contract.test.js`

Expected: PASS with no duplicate records or local-only operational users.

- [ ] **Step 5: Manual staging validation**

1. Create `QA Volt Hub Sync` through the Core master.
2. Confirm it appears in Hub with active `Volt Core` product.
3. Create a user in that company through Core.
4. Confirm user, company membership, `volt_core` grant and invite in Hub.
5. Accept invite, log in to Core, then revoke `volt_core` in Hub and confirm Core blocks the next request.

- [ ] **Step 6: Commit**

```bash
git add apps/business/core/src/modules/auth/hubProvisioningClient.js apps/business/core/src/modules/core/runtime/services/platformService.js apps/business/core/src/modules/core/runtime/services/userService.js apps/business/core/src/modules/auth/authService.test.js apps/business/core/src/modules/core/platformFoundation.test.js
git commit -m "Make Hub authoritative for Volt Core provisioning"
```
