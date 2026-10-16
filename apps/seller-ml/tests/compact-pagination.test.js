"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildCompactPagination } = require("../public/js/compact-pagination");

test("paginação compacta mantém extremos, vizinhos e lacunas", () => {
  const pagination = buildCompactPagination({ currentPage: 103, totalPages: 207 });

  assert.equal(pagination.previousPage, 102);
  assert.equal(pagination.nextPage, 104);
  assert.deepEqual(
    pagination.items,
    [
      { type: "page", page: 1 },
      { type: "ellipsis" },
      { type: "page", page: 102 },
      { type: "page", page: 103 },
      { type: "page", page: 104 },
      { type: "ellipsis" },
      { type: "page", page: 207 },
    ],
  );
});

test("paginação compacta desabilita a navegação nos limites", () => {
  const first = buildCompactPagination({ currentPage: 1, totalPages: 207 });
  const last = buildCompactPagination({ currentPage: 207, totalPages: 207 });

  assert.equal(first.previousPage, null);
  assert.equal(first.nextPage, 2);
  assert.equal(last.previousPage, 206);
  assert.equal(last.nextPage, null);
});
