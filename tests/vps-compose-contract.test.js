"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("yaml");
const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const compose = parse(read("infra/compose.vps.yml"), {merge: true});

test("only Caddy publishes ports and data stores are isolated", () => {
  for (const [name, service] of Object.entries(compose.services)) {
    assert.equal(service.restart, "unless-stopped", name);
    if (name !== "caddy") assert.equal(service.ports, undefined, name);
    assert.ok(service.healthcheck, name);
  }
  assert.equal(compose.networks.data.internal, true);
  for (const name of ["postgres", "redis"]) {
    assert.deepEqual(compose.services[name].networks, ["data"]);
    assert.ok(compose.services[name].volumes.length);
  }
});

test("VPS PostgreSQL matches the newest Neon source major version", () => {
  assert.equal(compose.services.postgres.image, "postgres:18-bookworm");
  assert.deepEqual(compose.services.postgres.volumes, ["postgres_data:/var/lib/postgresql"]);
});

test("service commands, Dockerfiles and environment examples exist", () => {
  for (const [name, service] of Object.entries(compose.services)) {
    if (service.build) assert.ok(fs.existsSync(path.join(root, service.build.dockerfile)), name);
    if (service.command?.[0] === "node") assert.ok(fs.existsSync(path.join(root, service.command[1])), name);
    for (const file of service.env_file || []) {
      const example = path.join(root, "infra", file + ".example");
      assert.ok(fs.existsSync(example), example);
    }
  }
});

test("gateway declares its independent suite and support database", () => {
  const gatewayEnv = read("infra/env/gateway.env.example");
  assert.match(gatewayEnv, /^DATABASE_URL=/m);
});

test("Hub shared environment overrides service-specific legacy settings", () => {
  const applicationServices = [
    "gateway",
    "seller-ml-web",
    "seller-ml-worker",
    "seller-shopee",
    "seller-madeira",
    "seller-tracking",
    "seller-log",
    "seller-leader",
    "business-portal",
    "business-core",
    "business-stock",
    "business-chat",
    "business-price",
    "business-chat-api",
  ];

  for (const name of applicationServices) {
    const envFiles = compose.services[name].env_file;
    assert.equal(envFiles.at(-1), "./env/hub.env", name);
  }
});

test("Business products run separately and Python is private", () => {
  for (const product of ["portal", "core", "stock", "chat", "price"]) {
    assert.equal(compose.services["business-" + product].environment.DACHBYTE_PRODUCT, product);
  }
  assert.ok(compose.services["business-chat-api"]);
  const nodeDockerfile = read("infra/docker/node.Dockerfile");
  assert.match(nodeDockerfile, /npm --prefix apps\/business\/stock ci --include=dev(?:\s|\\)/);
  assert.doesNotMatch(nodeDockerfile, /apps\/business\/stock ci[^\n]*--workspaces=false/);
  assert.doesNotMatch(nodeDockerfile, /apps\/business\/stock install[^\n]*--package-lock=false/);
  assert.match(read("infra/docker/chat-api.Dockerfile"), /"--workers", "1"/);
});

test("Caddy preserves route boundaries, Core assets and websocket API", () => {
  const source = read("infra/Caddyfile");
  for (const prefix of ["ml", "shopee", "madeiramadeira", "avantracking", "davanttilog", "skuleader", "voltstock", "volt-price", "chat", "business"]) {
    assert.ok(source.includes(`path /${prefix} /${prefix}/*`), prefix);
  }
  assert.match(source, /\/api\/core/);
  assert.match(source, /\/assets\/\*/);
  assert.match(source, /uri strip_prefix \/chat-api/);
  assert.match(source, /path \/dach\/seller \/dach\/seller\/\*/);
  assert.match(source, /path \/dach\/business \/dach\/business\/\*/);
  assert.doesNotMatch(source, /header_up\s+(Cookie|Authorization)/i);
});

test("ML web and worker share persisted result files", () => {
  assert.deepEqual(compose.services["seller-ml-web"].volumes, compose.services["seller-ml-worker"].volumes);
  assert.ok(compose.volumes.ml_results);
});

test("Business portal and nested canonical links keep query strings", async () => {
  const { createProductApp } = require("../apps/business/product-server.cjs");
  const app = await createProductApp("portal");
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const base = "http://127.0.0.1:" + server.address().port;
    const portal = await fetch(base + "/business", {redirect: "manual"});
    assert.equal(portal.status, 200);
    assert.match(await portal.text(), /DACHBYTE/);
    const response = await fetch(base + "/business/core/app?x=1", {redirect: "manual"});
    assert.equal(response.headers.get("location"), "/core/app?x=1");
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
