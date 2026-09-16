"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...values) { values.forEach((value) => this.values.add(value)); }
  remove(...values) { values.forEach((value) => this.values.delete(value)); }
  toggle(value, force) {
    if (force === undefined ? !this.values.has(value) : force) this.values.add(value);
    else this.values.delete(value);
  }
}

class FakeNode {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.innerHTML = "";
    this.textContent = "";
    this.value = "";
    this.className = "";
    this.classList = new FakeClassList();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.queryResults = new Map();
  }

  addEventListener(type, listener) { this.listeners[type] = listener; }
  append(...nodes) { this.children.push(...nodes); }
  focus() {}
  remove() {}
  reset() {}
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      this.dataset[key] = String(value);
    }
  }

  querySelectorAll(selector) {
    if (this.queryResults.has(selector)) return this.queryResults.get(selector);
    const match = /^\[data-([a-z-]+)\]$/.exec(selector);
    if (!match) return [];
    const attribute = `data-${match[1]}`;
    const expression = new RegExp(`<button[^>]*${attribute}="([^"]+)"[^>]*>`, "g");
    const results = [...this.innerHTML.matchAll(expression)].map((buttonMatch) => {
      const node = new FakeNode("button");
      node.setAttribute(attribute, buttonMatch[1]);
      return node;
    });
    this.queryResults.set(selector, results);
    return results;
  }
}

class FakeDocument {
  constructor() {
    this.nodes = new Map();
    for (const id of [
      "appView", "loginView", "loginForm", "passwordChangeForm", "loginError",
      "passwordChangeError", "currentPassword", "nav", "tenantName", "userName",
      "supportBadge", "pageTitle", "pageSubtitle", "content", "toast", "logoutBtn",
      "refreshPage", "integrationList", "createTenant", "exitSupport",
    ]) this.nodes.set(`#${id}`, new FakeNode());
  }

  createElement(tagName) { return new FakeNode(tagName); }
  querySelector(selector) {
    if (!this.nodes.has(selector)) this.nodes.set(selector, new FakeNode());
    return this.nodes.get(selector);
  }
}

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
  };
}

function createHarness(respond) {
  const document = new FakeDocument();
  const requests = [];
  const history = [];
  const context = vm.createContext({
    console,
    document,
    fetch: async (url, options = {}) => {
      const request = { path: url.replace("/business/price/api", ""), options };
      requests.push(request);
      const result = await respond(request);
      return response(result?.body ?? result, result?.status ?? 200);
    },
    history: { pushState: (_state, _title, url) => history.push(url) },
    location: { pathname: "/business/price/app/admin" },
    window: { addEventListener() {} },
    prompt: () => "Auditoria solicitada",
    confirm: () => true,
    setTimeout: () => 0,
    clearTimeout() {},
    Intl,
  });
  const sourceWithoutBoot = appSource.replace(/boot\(\);\s*$/, "");
  vm.runInContext(sourceWithoutBoot, context, { filename: "public/app.js" });
  return { context, document, history, requests };
}

async function renderAdmin(harness, user) {
  const root = harness.document.querySelector("#content");
  harness.context.__root = root;
  harness.context.__user = user;
  vm.runInContext("state.me=__user;state.csrf='initial-csrf';state.page='admin'", harness.context);
  await vm.runInContext("admin(__root)", harness.context);
  return root;
}

test("active Admin Master renderer consumes audit {logs} and renders an empty response safely", async () => {
  const harness = createHarness(async ({ path: requestPath }) => {
    if (requestPath === "/admin/tenants") return { tenants: [] };
    if (requestPath === "/admin/audit?limit=50") return { logs: [] };
    throw new Error(`unexpected request: ${requestPath}`);
  });

  const root = await renderAdmin(harness, { isPlatformAdmin: true, fullName: "Master", role: "owner" });

  assert.match(root.innerHTML, /0 evento\(s\)/);
  assert.match(root.innerHTML, /Sem eventos\./);
});

test("active Admin Master renderer displays audit rows from the real {logs} response", async () => {
  const harness = createHarness(async ({ path: requestPath }) => {
    if (requestPath === "/admin/tenants") return { tenants: [] };
    if (requestPath === "/admin/audit?limit=50") return {
      logs: [{ action: "tenant.status_change", actor_email: "master@example.com", tenant_name: "Loja Azul" }],
    };
    throw new Error(`unexpected request: ${requestPath}`);
  });

  const root = await renderAdmin(harness, { isPlatformAdmin: true, fullName: "Master", role: "owner" });

  assert.match(root.innerHTML, /tenant\.status_change/);
  assert.match(root.innerHTML, /master@example\.com/);
  assert.match(root.innerHTML, /Loja Azul/);
});

test("support start rotates CSRF and refreshes /auth/me before navigating", async () => {
  const supportUser = {
    isPlatformAdmin: true,
    tenantId: "tenant-1",
    tenantName: "Loja Azul",
    fullName: "Master",
    role: "owner",
    supportReason: "Auditoria solicitada",
  };
  const harness = createHarness(async ({ path: requestPath }) => {
    if (requestPath === "/admin/tenants") return { tenants: [{ id: "tenant-1", name: "Loja Azul", slug: "loja-azul", status: "active", users_count: 1 }] };
    if (requestPath === "/admin/audit?limit=50") return { logs: [] };
    if (requestPath === "/admin/tenants/tenant-1/support-session") return { success: true, csrfToken: "support-csrf", tenant: { id: "tenant-1", name: "Loja Azul" } };
    if (requestPath === "/auth/me") return { user: supportUser };
    if (requestPath === "/dashboard/") return { integrations: 0, orders: 0, fees: 0, commissionReferences: 0, lastSync: null };
    throw new Error(`unexpected request: ${requestPath}`);
  });
  const root = await renderAdmin(harness, { isPlatformAdmin: true, fullName: "Master", role: "owner" });
  const supportButton = root.querySelectorAll("[data-support]")[0];

  await supportButton.onclick();

  assert.deepEqual(harness.requests.slice(2).map(({ path: requestPath }) => requestPath), [
    "/admin/tenants/tenant-1/support-session",
    "/auth/me",
    "/dashboard/",
  ]);
  assert.equal(harness.requests[2].options.headers["X-CSRF-Token"], "initial-csrf");
  assert.equal(vm.runInContext("state.csrf", harness.context), "support-csrf");
  assert.equal(vm.runInContext("state.me.tenantId", harness.context), "tenant-1");
  assert.equal(harness.history.at(-1), "/business/price/app/dashboard");
});

test("support exit uses /admin/exit-support, rotates CSRF, and refreshes /auth/me before navigation", async () => {
  const globalUser = { isPlatformAdmin: true, tenantId: null, fullName: "Master", role: "owner" };
  const harness = createHarness(async ({ path: requestPath }) => {
    if (requestPath === "/admin/tenants") return { tenants: [] };
    if (requestPath === "/admin/audit?limit=50") return { logs: [] };
    if (requestPath === "/admin/exit-support") return { success: true, csrfToken: "global-csrf" };
    if (requestPath === "/auth/me") return { user: globalUser };
    return { status: 404, body: { message: `unexpected request: ${requestPath}` } };
  });
  await renderAdmin(harness, {
    isPlatformAdmin: true,
    tenantId: "tenant-1",
    tenantName: "Loja Azul",
    fullName: "Master",
    role: "owner",
    supportReason: "Auditoria solicitada",
  });
  const exitButton = harness.document.querySelector("#exitSupport");

  await exitButton.onclick();

  assert.deepEqual(harness.requests.slice(2).map(({ path: requestPath }) => requestPath), [
    "/admin/exit-support",
    "/auth/me",
    "/admin/tenants",
    "/admin/audit?limit=50",
  ]);
  assert.equal(vm.runInContext("state.csrf", harness.context), "global-csrf");
  assert.equal(vm.runInContext("state.me.tenantId", harness.context), null);
  assert.equal(harness.history.at(-1), "/business/price/app/admin");
  assert.equal(harness.requests.some(({ path: requestPath }) => requestPath === "/admin/support-session/exit"), false);
});

test("integration rows render logo, details, and actions in the declared three-column layout", async () => {
  const harness = createHarness(async ({ path: requestPath }) => {
    if (requestPath === "/integrations/") return {
      connections: [{ channel: "meli", display_name: "Conta principal", connection_status: "connected", token_expires_at: null }],
    };
    throw new Error(`unexpected request: ${requestPath}`);
  });
  const root = harness.document.querySelector("#content");
  harness.context.__root = root;

  await vm.runInContext("integrations(__root)", harness.context);

  const rows = harness.document.querySelector("#integrationList").children;
  assert.equal(rows.length, 3);
  assert.match(rows[1].innerHTML, /^<div class="logo" aria-hidden="true">M<\/div><div><strong>Mercado Livre<\/strong>/);
  assert.match(rows[1].innerHTML, /<\/div><div><span class="chip green">connected<\/span>/);
});
