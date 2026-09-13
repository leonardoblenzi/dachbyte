# VoltPrice Master User Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Admin Master manage users inside a selected VoltPrice company through the existing Admin Master page, including manual temporary-password provisioning and reset.

**Architecture:** Add one read-only Master API for a company's memberships and reuse the existing Master-only provisioning endpoint for both creation and password reset. Extend the existing `admin(root)` renderer in `public/app.js` with an inline selected-company panel; it fetches only safe user metadata and never retains or re-renders a temporary password after submission.

**Tech Stack:** Node.js, Express, PostgreSQL (`pg`), native `node:test`, static HTML/CSS/browser JavaScript.

## Global Constraints

- The UI remains inside the existing **Admin Master** page; no parallel administration area or tenant-user creation route is added.
- Only a global Admin Master with a completed password change may list or provision users through `/api/admin`; tenant users and tenant administrators remain forbidden.
- A regular user can have exactly one active membership. The server remains authoritative and the UI must not offer a company reassignment action.
- Provisioning and reset use `POST /api/admin/tenants/:tenantId/users` with `{ email, fullName, role, temporaryPassword }`, CSRF, session invalidation, audit logging, and `mustChangePassword: true`.
- Temporary passwords, hashes, tokens, cookies, and sessions must never appear in GET responses, audit metadata, rendered HTML, toast messages, browser state, or test output.
- The Master manually shares the temporary password; e-mail delivery, password generation, password recovery, and Tray changes are out of scope.
- Preserve the existing VoltPrice industrial cards, tables, toolbar, responsiveness, and accessible feedback patterns.

---

### Task 1: Add Master-only safe user listing by company

**Files:**

- Modify: `business/volt-price/src/routes/admin.routes.js`
- Modify: `business/volt-price/tests/admin-provisioning.test.js`

**Interfaces:**

- Consumes: `createAdminRouter({ authenticate, requirePasswordChangeComplete, requireCsrf })` and `withPlatformAdmin(actorUserId, callback)`.
- Produces: `GET /api/admin/tenants/:tenantId/users` returning:

  ```json
  {
    "tenant": { "id": "uuid", "name": "Empresa", "slug": "empresa", "status": "active" },
    "users": [{ "id": "uuid", "fullName": "Nome", "email": "user@example.com", "role": "admin", "status": "active", "mustChangePassword": true, "createdAt": "timestamp", "updatedAt": "timestamp" }]
  }
  ```

- [x] **Step 1: Write a failing route test for the safe listing contract**

  Extend `admin-provisioning.test.js` with a `createAdminRouter` test that injects Master authentication and a `withPlatformAdmin` stub returning one tenant/member row. Assert HTTP 200, the exact camelCase metadata above, and that serialized response text excludes `password_hash`, `temporaryPassword`, `token`, `csrf`, and `session`.

  ```js
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.users[0], {
    id: "user-1", fullName: "Ana", email: "ana@empresa.com",
    role: "finance", status: "active", mustChangePassword: true,
    createdAt: "2026-08-13T12:00:00.000Z", updatedAt: "2026-08-13T12:00:00.000Z",
  });
  assert.equal(JSON.stringify(result.body).match(/password_hash|token|csrf|session/i), null);
  ```

- [x] **Step 2: Verify the test fails for the missing endpoint**

  Run: `npm run test:volt-price -- --test-name-pattern="safe user listing"`

  Expected: FAIL with HTTP 404 because `GET /tenants/:tenantId/users` is not registered.

- [x] **Step 3: Write a failing authorization test**

  Add a second HTTP test using the existing injected tenant-admin authentication. Request `GET /api/admin/tenants/tenant-1/users` and assert `{ status: 403, body: { error: "platform_admin_required" } }`.

- [x] **Step 4: Implement the Master-only listing route**

  Add the route after `GET /tenants` and before the provisioning POST in `createAdminRouter`:

  ```js
  router.get("/tenants/:tenantId/users", async (req, res, next) => {
    try {
      const result = await withPlatformAdmin(req.vpAuth.userId, async (client) => {
        const tenant = (await client.query(
          "SELECT id,name,slug,status FROM volt_price.tenants WHERE id=$1", [req.params.tenantId],
        )).rows[0];
        if (!tenant) throw Object.assign(new Error("Empresa nao encontrada."), { statusCode: 404, code: "tenant_not_found" });
        const users = (await client.query(`SELECT u.id,u.full_name,u.email,m.role,m.status,u.must_change_password,u.created_at,u.updated_at
          FROM volt_price.memberships m JOIN volt_price.users u ON u.id=m.user_id
          WHERE m.tenant_id=$1 ORDER BY u.full_name ASC,u.email ASC`, [tenant.id])).rows;
        return { tenant, users };
      });
      res.json({ tenant: result.tenant, users: result.users.map((row) => ({
        id: row.id, fullName: row.full_name, email: row.email, role: row.role, status: row.status,
        mustChangePassword: Boolean(row.must_change_password), createdAt: row.created_at, updatedAt: row.updated_at,
      })) });
    } catch (error) { next(error); }
  });
  ```

- [x] **Step 5: Verify the route tests pass**

  Run: `npm run test:volt-price -- --test-name-pattern="safe user listing|tenant admin"`

  Expected: PASS for the safe metadata and 403 authorization cases.

- [x] **Step 6: Commit the API task**

  ```bash
  git add business/volt-price/src/routes/admin.routes.js business/volt-price/tests/admin-provisioning.test.js
  git commit -m "feat(volt-price): list tenant users for master console"
  ```

### Task 2: Render selected-company user management in Admin Master

**Files:**

- Modify: `business/volt-price/public/app.js`
- Create: `business/volt-price/tests/master-user-console-ui.test.js`

**Interfaces:**

- Consumes: `GET /api/admin/tenants/:tenantId/users` from Task 1 and existing `api(path, options)`, `toast(message, error)`, `escapeHtml(value)`, `state.csrf`, and `state.me` globals.
- Produces: an inline company-user panel invoked by a `data-manage-users` action; creation/reset calls `POST /api/admin/tenants/:tenantId/users` with the selected company id.

- [x] **Step 1: Write failing static UI contract tests**

  Create `master-user-console-ui.test.js` to load `public/app.js` and assert that it contains:

  - a `data-manage-users` action in the company table;
  - a `GET /admin/tenants/${tenantId}/users` read path;
  - a `POST /admin/tenants/${tenantId}/users` write path containing exactly `email`, `fullName`, `role`, and `temporaryPassword`;
  - reset confirmation text that says existing sessions will be closed;
  - code that clears `temporaryPassword` after a successful POST;
  - no `POST /api/users`, no `tenantId` assignment in the request body, and no interpolation that displays the submitted temporary password.

  ```js
  assert.match(appSource, /data-manage-users/);
  assert.match(appSource, /temporaryPassword:\s*\$\("#masterUserPassword"\)\.value/);
  assert.match(appSource, /\$\("#masterUserPassword"\)\.value\s*=\s*""/);
  assert.doesNotMatch(appSource, /api\/users["']/);
  ```

- [x] **Step 2: Verify the UI contract fails**

  Run: `npm run test:volt-price -- --test-name-pattern="master user console ui"`

  Expected: FAIL because no selected-company management UI exists.

- [x] **Step 3: Add a selected-company panel helper**

  In `public/app.js`, introduce an `async function masterTenantUsers(root, tenant)` helper. It fetches `api(`/admin/tenants/${tenant.id}/users`)`, replaces the Admin content with:

  - a header containing **Usuários · {empresa}** and a **Voltar para empresas** button;
  - a table of the safe API fields, with a badge for `mustChangePassword` (`Senha temporária pendente` or `Ativo`);
  - a provision form with `#masterUserName`, `#masterUserEmail`, `#masterUserRole`, `#masterUserPassword`, `#masterUserError`, and `#masterUserSubmit`;
  - per-row `data-reset-user` buttons that populate name/e-mail/role and change the submit label to **Redefinir senha temporária**.

  Escape every API-provided name/e-mail/role before inserting it into HTML. Do not render or store any password in an object, data attribute, table, or toast.

- [x] **Step 4: Wire provision/reset behavior**

  Submit this exact request body from the helper:

  ```js
  const body = {
    email: $("#masterUserEmail").value,
    fullName: $("#masterUserName").value,
    role: $("#masterUserRole").value,
    temporaryPassword: $("#masterUserPassword").value,
  };
  ```

  For a selected existing user, call `confirm("Redefinir a senha temporária encerrará as sessões atuais deste usuário. Continuar?")`; cancel leaves the form unchanged. On success, immediately set `$("#masterUserPassword").value = ""`, clear reset selection, show the generic toast `Usuário provisionado. Entregue a senha temporária manualmente.`, and rerender `masterTenantUsers(root, tenant)`. On failure, put `error.message` in `#masterUserError` with `role="alert"`; do not show the password.

- [x] **Step 5: Add company-table entry point and preserve existing support access**

  In `admin(root)`, add a **Gerenciar usuários** button with `data-manage-users` beside the existing `data-support` action. Its listener calls `masterTenantUsers(root, matchingTenant)`. Do not alter the access-assisted flow, global Master checks, tenant creation form, or audit list.

- [x] **Step 6: Verify UI contract and full suite**

  Run: `npm run test:volt-price -- --test-name-pattern="master user console ui"`

  Expected: PASS.

  Run: `npm run test:volt-price`

  Expected: PASS with all existing VoltPrice tests and the new UI contract test.

- [x] **Step 7: Commit the UI task**

  ```bash
  git add business/volt-price/public/app.js business/volt-price/tests/master-user-console-ui.test.js
  git commit -m "feat(volt-price): manage tenant users from master console"
  ```

### Task 3: Document operation and complete verification

**Files:**

- Modify: `business/volt-price/README.md`
- Modify: `business/volt-price/tests/master-user-console-ui.test.js`

**Interfaces:**

- Consumes: Task 1 safe read endpoint and Task 2 selected-company panel.
- Produces: operational instructions aligned with the actual Master-only workflow.

- [x] **Step 1: Write a failing documentation contract assertion**

  Add a test in `master-user-console-ui.test.js` reading `README.md`. Assert it names the Master console route, manual sharing of the temporary password, forced first-login password change, no automatic e-mail, and the fact that reset revokes active sessions.

  ```js
  assert.match(readme, /Gerenciar usu[aá]rios/i);
  assert.match(readme, /entregue.*senha tempor[aá]ria.*manualmente/i);
  assert.match(readme, /encerra.*sess[oõ]es/i);
  assert.match(readme, /n[aã]o envia e-mail automaticamente/i);
  ```

- [x] **Step 2: Verify the documentation assertion fails**

  Run: `npm run test:volt-price -- --test-name-pattern="master user console ui"`

  Expected: FAIL because the current README describes only the API provisioning contract.

- [x] **Step 3: Document the visible Master workflow**

  Add a concise README subsection after the existing provision endpoint description:

  ```markdown
  ### Console do Admin Master

  Em **Admin Master**, selecione **Gerenciar usuários** na empresa desejada.
  Informe nome, e-mail, perfil e uma senha temporária; entregue-a manualmente
  ao usuário. O VoltPrice não envia e-mail automaticamente. A conta deverá
  trocar essa senha no primeiro acesso. Redefinir uma senha temporária encerra
  as sessões ativas do usuário.
  ```

- [x] **Step 4: Run final code and documentation verification**

  Run: `npm run test:volt-price`

  Expected: PASS.

  Run: `node --check volt-price/public/app.js`

  Expected: PASS.

  Run: `git diff --check`

  Expected: no output and exit code 0.

- [x] **Step 5: Commit documentation and verification artifacts**

  ```bash
  git add business/volt-price/README.md business/volt-price/tests/master-user-console-ui.test.js
  git commit -m "docs(volt-price): explain master user provisioning"
  ```
