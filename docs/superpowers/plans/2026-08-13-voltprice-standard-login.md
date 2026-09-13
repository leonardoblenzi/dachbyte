# VoltPrice Standard Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace VoltPrice's MFA/workspace-code login with standard e-mail/password authentication, where the Platform Master is global and each regular user belongs to exactly one company. Platform Masters provision regular users with a temporary password that must be replaced before access to business data.

**Architecture:** Keep PostgreSQL as the source of truth for users, memberships, and sessions. Add a `must_change_password` user flag, enforce the one-active-membership policy in the server authentication flow, and guard every protected business route for temporary-password sessions. Keep the existing Platform Master and support-session architecture, but remove TOTP and workspace selection from the login contract and client UI.

**Tech Stack:** Node.js, Express, PostgreSQL/Neon (`pg`), bcryptjs, native `node:test`, static HTML and browser JavaScript.

## Global Constraints

- Do not add Prisma or another ORM; migrations continue to run directly against `DATABASE_DIRECT_URL` through the existing migration script.
- Do not modify the existing VoltCore integration or unrelated services.
- The login request accepts only `email` and `password`; it must ignore neither TOTP nor workspace because those fields are removed from both the client and documented API contract.
- A Platform Master is authenticated globally and may use the existing administrative/support-session tenant controls.
- A regular user must have exactly one active membership. Zero active memberships return `no_workspace`; more than one return an explicit configuration error and create no session.
- A session belonging to a user with `must_change_password = true` may use only the logout, CSRF, current-session, and password-change endpoints. It must not access tenant data, administration, support sessions, or integration callbacks protected by authentication.
- Password changes must use CSRF protection, bcrypt hashing, revoke all prior sessions for the user, clear `must_change_password`, and issue a fresh standard session.
- Do not log passwords, temporary passwords, tokens, database URLs, TOTP secrets, or session cookies.

---

### Task 1: Add the persistence model and testable authentication policy

**Files:**

- Create: `business/volt-price/db/migrations/011_standard_login.sql`
- Create: `business/volt-price/src/auth-policy.js`
- Create: `business/volt-price/tests/auth-policy.test.js`
- Modify: `business/volt-price/src/auth.js`

- [ ] **Step 1: Write the failing policy tests**

  Add native `node:test` coverage for a pure policy module with these cases:

  - A Platform Master resolves to global access even if the database row still has legacy MFA columns populated.
  - A regular user with one active membership resolves to that membership's tenant and role.
  - A regular user with no active memberships produces an error with code `no_workspace`.
  - A regular user with two active memberships produces a non-sensitive configuration error with code `multiple_workspaces_not_allowed`.
  - A user marked `must_change_password` is denied by the protected-resource policy with code `password_change_required`; a normal user is allowed.

  Run: `npm run test:volt-price -- --test-name-pattern="auth policy"`

  Expected: FAIL because the policy module does not exist.

- [ ] **Step 2: Create the database migration**

  In `011_standard_login.sql`, add `volt_price.users.must_change_password boolean NOT NULL DEFAULT false`. Backfill existing users as `false` explicitly, then add an index only if query analysis shows this flag is used in a selective database filter (the normal session lookup reads a single user by id, so an index is not expected).

  The migration must be additive and idempotent enough for the repository's direct migration runner: guard the column addition with `ADD COLUMN IF NOT EXISTS` and use a deterministic `UPDATE` for nullable legacy rows before enforcing `NOT NULL`.

- [ ] **Step 3: Implement the pure policy functions**

  In `src/auth-policy.js`, export narrowly scoped functions such as:

  ```js
  resolveLoginScope({ platformRole, memberships })
  assertPasswordChangeComplete({ mustChangePassword })
  ```

  `resolveLoginScope` returns a global scope for a Platform Master, the sole active membership for a regular user, or throws errors with the exact codes from Step 1. It must never silently choose the first membership. `assertPasswordChangeComplete` must return normally only when the user is not pending a password change.

- [ ] **Step 4: Update authentication data reads to carry the new state**

  In `src/auth.js`, include `u.must_change_password` in login and session-user queries, use `resolveLoginScope`, and expose `passwordChangeRequired` on the authenticated request/session payload. Remove all TOTP verification and MFA-confirmation conditions from `login`; the legacy `platform_admins.mfa_required`, `totp_secret_cipher`, and `mfa_confirmed` columns remain untouched but are no longer read for authentication decisions.

- [ ] **Step 5: Run focused tests and commit**

  Run: `npm run test:volt-price -- --test-name-pattern="auth policy"`

  Expected: PASS.

  Commit:

  ```text
  feat(volt-price): enforce standard login account policy
  ```

### Task 2: Implement temporary-password completion and route-level protection

**Files:**

- Modify: `business/volt-price/src/auth.js`
- Modify: `business/volt-price/src/routes/auth.routes.js`
- Modify: `business/volt-price/src/routes/admin.routes.js`
- Modify: `business/volt-price/src/routes/app-data.routes.js`
- Modify: `business/volt-price/src/routes/commissions.routes.js`
- Modify: `business/volt-price/src/routes/dashboard.routes.js`
- Modify: `business/volt-price/src/routes/decision.routes.js`
- Modify: `business/volt-price/src/routes/domain.routes.js`
- Modify: `business/volt-price/src/routes/finance.routes.js`
- Modify: `business/volt-price/src/routes/integrations.routes.js`
- Modify: `business/volt-price/src/routes/market.routes.js`
- Modify: `business/volt-price/src/routes/marketing.routes.js`
- Modify: `business/volt-price/src/routes/orders.routes.js`
- Modify: `business/volt-price/src/routes/users.routes.js`
- Create: `business/volt-price/tests/password-change.test.js`

- [ ] **Step 1: Write failing password-change and access-gate tests**

  Add focused tests for the extracted/auth-route handlers or their injected database boundary proving:

  - A successful standard login for a temporary-password user returns `passwordChangeRequired: true` and a session that is usable only for the allowed auth endpoints.
  - A pending user is blocked from one representative tenant endpoint and one representative Platform Master endpoint with `password_change_required`.
  - `POST /api/auth/change-password` rejects a missing or invalid CSRF token, rejects an invalid new password according to the existing production password rules, hashes the replacement password, clears the flag, and revokes old sessions.
  - The response to a successful password change establishes a fresh session that can access protected resources.

  Run: `npm run test:volt-price -- --test-name-pattern="password change"`

  Expected: FAIL because the endpoint and guard are missing.

- [ ] **Step 2: Add an explicit temporary-password guard**

  Export a `requirePasswordChangeComplete` middleware from `src/auth.js` that uses `req.vpAuth` and `assertPasswordChangeComplete`. It must return the existing API error envelope with HTTP 403 and code `password_change_required`.

  Apply it immediately after `authenticate` on every protected route listed above. Do not place it in front of unauthenticated provider callbacks in `integrations.routes.js`; instead attach it only to integration routes that already require authenticated VoltPrice sessions. This keeps external webhook/OAuth callbacks reachable while blocking a pending user from tenant operations.

- [ ] **Step 3: Add the password-change endpoint**

  In `auth.routes.js`, add `POST /change-password` with `authenticate` and `requireCsrf`. Accept `{ currentPassword, newPassword }`, verify the current bcrypt password, validate the new password using the same deployment-safe minimum already used for bootstrap credentials, update `users.password_hash` and `must_change_password = false`, delete every existing user session, then create and set a new session cookie/CSRF token using the existing session helper.

  Make the update and session revocation transactional. Audit the action without including either password. Return `{ success: true, csrfToken, passwordChangeRequired: false, user }` so the UI can enter the normal application without reusing a privileged temporary session.

- [ ] **Step 4: Restrict the temporary-password session surface**

  Keep `POST /login`, `POST /logout`, `GET /me`, `GET /csrf`, and `POST /change-password` accessible inside `auth.routes.js`. Remove the login-time workspace switching endpoints (`GET /workspaces` and `POST /switch-workspace`) rather than preserving an alternate path to multi-company standard access.

  Ensure `GET /me` accurately returns `passwordChangeRequired`, the global-Master status, and no tenant context for a global Master. It must not leak a temporary password or password hash.

- [ ] **Step 5: Run focused tests and commit**

  Run: `npm run test:volt-price -- --test-name-pattern="password change"`

  Expected: PASS.

  Commit:

  ```text
  feat(volt-price): require first-login password change
  ```

### Task 3: Let the Platform Master provision single-company users

**Files:**

- Modify: `business/volt-price/src/routes/admin.routes.js`
- Modify: `business/volt-price/src/routes/users.routes.js`
- Modify: `business/volt-price/src/auth.js`
- Create: `business/volt-price/tests/admin-provisioning.test.js`

- [ ] **Step 1: Write failing provisioning tests**

  Cover the Platform Master administrative API with a testable handler/database boundary:

  - A Platform Master can create a user for a selected tenant with e-mail, name, role, and temporary password; the user is active, has exactly one active membership, and is marked `must_change_password = true`.
  - A tenant admin cannot call the provisioning endpoint.
  - Provisioning fails cleanly if the e-mail already belongs to a user with an active membership in another tenant; it must not move or silently duplicate the user.
  - Re-provisioning/resetting a user within the same tenant resets the temporary password flag and invalidates that user's active sessions.
  - The existing tenant-creation owner account is also marked for password change because it is a newly provisioned regular account.

  Run: `npm run test:volt-price -- --test-name-pattern="admin provisioning"`

  Expected: FAIL because the dedicated provisioning flow is absent.

- [ ] **Step 2: Implement Master-only user provisioning**

  Add `POST /api/admin/tenants/:tenantId/users`, protected by the existing Platform Master middleware and CSRF validation. Its request body is:

  ```json
  { "email": "user@company.com", "fullName": "Nome", "role": "admin", "temporaryPassword": "temporary-password-value" }
  ```

  Validate the tenant, normalized e-mail, supported membership role, and password policy. In one transaction, create or update the user only within the requested tenant, enforce that no other active membership exists, insert or reactivate the requested membership, set `must_change_password = true`, hash the temporary password, and delete prior sessions for that user.

  Add an audit event such as `platform.user.provisioned` containing actor id, target user id, tenant id, and role only. Return the user metadata and `mustChangePassword: true`, never the temporary password.

- [ ] **Step 3: Align existing tenant-owner creation and tenant user controls**

  Update `POST /api/admin/tenants` to treat its owner credential as a temporary password and set `must_change_password = true`. Keep `users.routes.js` tenant-scoped: it may manage roles/statuses inside its tenant but must not assign a user to another tenant or clear the first-login-password flag.

- [ ] **Step 4: Run focused tests and commit**

  Run: `npm run test:volt-price -- --test-name-pattern="admin provisioning"`

  Expected: PASS.

  Commit:

  ```text
  feat(volt-price): provision tenant users from platform admin
  ```

### Task 4: Simplify the login UI and validate the service end to end

**Files:**

- Modify: `business/volt-price/public/index.html`
- Modify: `business/volt-price/public/app.js`
- Create: `business/volt-price/tests/login-ui-contract.test.js`
- Modify: `business/volt-price/README.md`

- [ ] **Step 1: Write failing UI-contract tests**

  Add lightweight Node tests that assert the static login shell contains e-mail and password inputs plus a first-access password-change form, and no longer contains `loginWorkspace`, `loginOtp`, MFA labels, workspace-picker markup, or requests that send `workspace`/`otp` during login.

  Run: `npm run test:volt-price -- --test-name-pattern="login ui contract"`

  Expected: FAIL because the current page still presents workspace and MFA controls.

- [ ] **Step 2: Remove MFA and company selection from the sign-in experience**

  In `index.html`, retain only e-mail and password in the login form. Remove the workspace code field, MFA/TOTP field, workspace picker, and their explanatory text. Add an initially hidden first-access form with current password, new password, confirmation, clear validation/error state, and an explicit note that the temporary password must be replaced before continuing.

  In `app.js`, submit exactly `{ email, password }` to the login endpoint. Delete workspace-selection and OTP rendering/handling. When the response or `/me` reports `passwordChangeRequired`, render only the first-access form; submit it to `/api/auth/change-password` with the current CSRF token, update client session state from the success response, and then load the ordinary application shell.

- [ ] **Step 3: Update operational documentation**

  In the VoltPrice README, document the new login behavior, initial Platform Master bootstrap requirements, Master provisioning endpoint/contract, first-login password change, and the direct migration command. State that legacy TOTP columns are not part of the runtime authentication flow and may be removed only in a separately approved cleanup migration.

- [ ] **Step 4: Run the complete automated suite**

  Run: `npm run test:volt-price`

  Expected: PASS, including policy, password-change, provisioning, and login UI contract tests.

- [ ] **Step 5: Perform local smoke verification**

  Start VoltPrice with safe local test configuration and verify manually or via HTTP:

  1. the login page has only e-mail/password;
  2. Master login succeeds without an OTP and reaches global admin controls;
  3. a newly provisioned regular user is redirected to first-access password replacement;
  4. that user receives HTTP 403 / `password_change_required` for a tenant API call before replacement;
  5. after replacement, the same user can access only the assigned tenant;
  6. a deliberately legacy multi-membership user is rejected at login.

  Record only pass/fail results and response codes; do not include credentials or cookies in terminal output.

- [ ] **Step 6: Commit the interface and documentation**

  Commit:

  ```text
  feat(volt-price): simplify login and first access flow
  ```

### Task 5: Deploy-safe database migration and Render verification

**Files:**

- No source changes expected beyond Tasks 1–4.

- [ ] **Step 1: Inspect migration status without exposing secrets**

  Use the repository migration command against the configured direct database URL, first in its status/listing mode if available. Confirm migrations `001` through `010` are present and that `011_standard_login.sql` is the only pending VoltPrice migration.

- [ ] **Step 2: Apply the direct migration once**

  Execute the existing VoltPrice migration script using `DATABASE_DIRECT_URL` from the deployment environment. Confirm the migration ledger records `011_standard_login.sql`; do not print the connection string.

- [ ] **Step 3: Verify deployed staging behavior**

  After Render deploys the selected branch, check:

  - `https://volt-staging.onrender.com/volt-price/health` returns HTTP 200 and `database: "ready"`;
  - `/volt-price/login` loads without MFA or company-code controls;
  - login behavior follows the smoke cases in Task 4 using non-production test accounts.

- [ ] **Step 4: Report the release evidence**

  Report the commit hashes, test command results, migration identifier, health result, and staging route. Flag any pre-existing bootstrap account whose password is shorter than the current production minimum rather than weakening the password policy.
