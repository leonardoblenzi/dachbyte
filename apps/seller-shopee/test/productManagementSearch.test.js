"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  _test: { buildProductsListWhereClause },
} = require("../src/repositories/productSqlRepository");

test("busca de produtos aceita varios item IDs separados por virgula", () => {
  const params = [];
  const whereSql = buildProductsListWhereClause(9, "19397751567, 19397751568, 19397751567", params);

  assert.match(whereSql, /p\."itemId" = ANY\(\$\d+::bigint\[\]\)/);
  assert.deepEqual(params.at(-1), ["19397751567", "19397751568"]);
});

test("busca por nome continua usando correspondencia textual", () => {
  const params = [];
  const whereSql = buildProductsListWhereClause(9, "mesa de jantar", params);

  assert.match(whereSql, /COALESCE\(p\.title, ''\) ILIKE/);
  assert.equal(params.at(-1), "%mesa de jantar%");
});
