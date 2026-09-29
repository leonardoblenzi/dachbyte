"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..", "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("package exige Multer corrigido", () => {
  const pkg = JSON.parse(read("apps/seller-ml/package.json"));
  assert.equal(pkg.dependencies.multer, "2.4.0");
});

test("uploads substituidos possuem limites de multipart", () => {
  for (const file of [
    "apps/seller-ml/routes/anuncioCadastroRoutes.js",
    "apps/seller-ml/routes/caracteristicasRoutes.js",
  ]) {
    const source = read(file);
    assert.match(source, /fileSize:/);
    assert.match(source, /files: 1/);
    assert.match(source, /parts:/);
    assert.match(source, /fieldNestingDepth:/);
    assert.match(source, /fieldArrayIndexLimit:/);
  }
});

test("DB do ML nao faz fallback silencioso para Shopee", () => {
  const source = read("apps/seller-ml/db/db.js");
  assert.doesNotMatch(source, /SHOPEE_DATABASE_URL/);
  assert.match(source, /ML_DB_SSL_REJECT_UNAUTHORIZED/);
  assert.doesNotMatch(source, /isProd\s*\|\|\s*sslMode/);
});

test("gitignore cobre resultados e relatorios gerados do seller-ml", () => {
  const source = read(".gitignore");
  assert.match(source, /apps\/seller-ml\/results\//);
  assert.match(source, /apps\/seller-ml\/generated\//);
});
