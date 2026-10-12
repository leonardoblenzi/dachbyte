import test from "node:test";
import assert from "node:assert/strict";
import { fetchAllPages } from "./fetchAllPages.mjs";

test("exportacao percorre todas as paginas com o mesmo filtro", async () => {
  const queries = [];
  const rows = await fetchAllPages(async (query) => {
    queries.push(query);
    return { data: { customers: [{ id: query.page }] }, pagination: { page: query.page, totalPages: 3 } };
  }, { search: "Ana", filter: "Ativos" }, "customers");
  assert.deepEqual(rows.map((row) => row.id), [1, 2, 3]);
  assert.deepEqual(queries.map((query) => query.pageSize), [100, 100, 100]);
  assert.ok(queries.every((query) => query.search === "Ana" && query.filter === "Ativos"));
});

test("exportacao falha sem paginacao em vez de gerar arquivo parcial", async () => {
  await assert.rejects(fetchAllPages(async () => ({ data: { customers: [] } }), {}, "customers"), /integridade/);
});

test("exportacao nao entrega conjunto incompleto", async () => {
  await assert.rejects(fetchAllPages(async () => ({ data: { customers: [{ id: 1 }] }, pagination: { page: 1, totalPages: 1, total: 2 } }), {}, "customers"), /mudaram/);
});
