# Public OAuth Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the browser-default public OAuth link page with an accessible VoltPrice confirmation screen without changing OAuth semantics.

**Architecture:** Keep the server-rendered `publicLinkPage` helper as the single rendering boundary. It will emit self-contained, CSP-compatible inline CSS and static markup; callers will provide only escaped copy and the already-safe form action markup.

**Tech Stack:** Express, server-rendered HTML, inline CSS, Node.js test runner.

---

### Task 1: Lock the public-page visual contract

**Files:**
- Modify: `tests/integrations.test.js`
- Modify: `src/routes/integrations.routes.js:22`

- [x] **Step 1: Write the failing test**

```js
test("public OAuth page uses the VoltPrice visual shell", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "integrations.routes.js"), "utf8");
  assert.match(source, /vp-public-shell/);
  assert.match(source, /Conexão segura/);
  assert.match(source, /vp-public-continue/);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/integrations.test.js`

Expected: FAIL because the browser-default renderer has no VoltPrice shell classes.

- [x] **Step 3: Implement the self-contained public page**

```js
function publicLinkPage({ title, message, action = "", tone = "default" }) {
  return `<!doctype html><html lang="pt-BR"><head>...VoltPrice inline CSS...</head><body>
    <main class="vp-public-shell">
      <section class="vp-public-card vp-public-card--${tone}" aria-labelledby="vp-public-title">
        ...
        ${action}
      </section>
    </main>
  </body></html>`;
}
```

The card contains brand, secure-connection label, title, escaped message, controlled action markup and a short provider redirect notice. Success and unavailable states set a matching `tone` while retaining no actionable OAuth data.

- [x] **Step 4: Run focused test**

Run: `node --test tests/integrations.test.js`

Expected: PASS.

- [x] **Step 5: Run full verification**

Run: `node --test tests/*.test.js; git diff --check`

Expected: all tests pass and no whitespace errors.
