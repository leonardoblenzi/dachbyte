"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  _test: { buildUnlistItemBody },
} = require("../src/services/ShopeeProductWriteService");

test("unlist_item usa item_list para pausar um anuncio", () => {
  assert.deepEqual(buildUnlistItemBody({ item_id: 19397751567, unlist: true }), {
    item_list: [{ item_id: 19397751567, unlist: true }],
  });
});

test("unlist_item preserva false para reativar um anuncio", () => {
  assert.deepEqual(buildUnlistItemBody({ itemId: "19397751567", unlist: false }), {
    item_list: [{ item_id: 19397751567, unlist: false }],
  });
});

test("unlist_item rejeita item_id invalido antes da chamada externa", () => {
  assert.throws(() => buildUnlistItemBody({ item_id: "invalido" }), /item_id invalido/);
});
