"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  itemsBulkPath,
  normalizeBulkResponse,
} = require("../services/meliBulk");

test("itemsBulkPath usa endpoint novo e prefixa atributos com body", () => {
  const path = itemsBulkPath(
    ["MLB1", "MLB2"],
    "id,title,body.price",
    { include_internal_attributes: true },
  );
  const url = new URL(path, "https://api.mercadolibre.com");

  assert.equal(url.pathname, "/items/bulk");
  assert.equal(url.searchParams.get("ids"), "MLB1,MLB2");
  assert.equal(url.searchParams.get("attributes"), "body.id,body.title,body.price");
  assert.equal(url.searchParams.get("include_internal_attributes"), "true");
});

test("normalizeBulkResponse preserva o contrato interno code/body", () => {
  const rows = normalizeBulkResponse([
    { id: "MLB1", status_code: 200, body: { id: "MLB1" } },
    { id: "MLB2", status_code: 404, body: { message: "not found" } },
  ]);

  assert.equal(rows[0].code, 200);
  assert.equal(rows[1].code, 404);
  assert.equal(rows[0].body.id, "MLB1");
});

test("consultas bulk do Seller ML respeitam o limite oficial de 20 IDs", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(
    path.join(__dirname, "../services/sellerPromotionsService.js"),
    "utf8",
  );

  assert.match(source, /const chunk = 20;/);
  assert.doesNotMatch(source, /const chunk = 50;/);
});
