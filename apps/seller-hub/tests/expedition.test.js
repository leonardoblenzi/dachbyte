"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { expandUnits, matchCode, checkCounts, pickingList } = require("../src/modules/expedition/units");
const { decodePhoto } = require("../src/modules/expedition/service");

const lines = [
  { id: 1, quantity: 2, itemId: 10, sku: "SOFA-1", name: "Sofá", ean: "7891234567895", kind: "simple", channelSku: "SOFA-1", title: "Sofá" },
  { id: 2, quantity: 1, itemId: 20, sku: "KIT-SALA", name: "Kit", ean: null, kind: "kit", channelSku: "KIT", title: "Kit",
    components: [{ itemId: 10, sku: "SOFA-1", name: "Sofá", ean: "7891234567895", quantity: 1 }, { itemId: 11, sku: "MESA", name: "Mesa", ean: null, quantity: 2 }] },
  { id: 3, quantity: 1, itemId: null, sku: null, name: null, ean: null, kind: null, channelSku: "SEM-VINC", title: "Anúncio sem vínculo" },
];

test("unidades: kit abre nos componentes e soma com o item avulso; sem vínculo entra pelo SKU do canal", () => {
  const units = expandUnits(lines);
  assert.deepEqual(units.map((u) => [u.key, u.sku, u.quantity, u.fromKit]), [["item:10", "SOFA-1", 3, null], ["item:11", "MESA", 2, "KIT-SALA"], ["line:3", "SEM-VINC", 1, null]]);
  assert.equal(matchCode(units, "7891234567895").key, "item:10", "pelo EAN");
  assert.equal(matchCode(units, "mesa").key, "item:11", "pelo SKU, sem diferenciar maiúscula");
  assert.equal(matchCode(units, "sem vinc").key, "line:3");
  assert.equal(matchCode(units, "XPTO"), null);
});

test("contagem: precisa bater item a item; item de fora é recusado", () => {
  const units = expandUnits(lines);
  assert.match(checkCounts(units, [{ key: "item:10", scanned: 2 }, { key: "item:11", scanned: 2 }, { key: "line:3", manual: 1 }]), /SOFA-1: conferido 2 de 3/);
  assert.equal(checkCounts(units, [{ key: "item:10", scanned: 2, manual: 1 }, { key: "item:11", scanned: 2 }, { key: "line:3", manual: 1 }]), null);
  assert.match(checkCounts(units, [{ key: "item:10", scanned: 3 }, { key: "item:11", scanned: 2 }, { key: "line:3", manual: 1 }, { key: "item:99", scanned: 1 }]), /não é deste pedido/);
});

test("lista de separação soma por produto e conta pedidos", () => {
  const list = pickingList([{ orderId: 1, units: expandUnits(lines) }, { orderId: 2, units: expandUnits([lines[0]]) }]);
  assert.deepEqual(list.map((r) => [r.sku, r.quantity, r.orders]), [["MESA", 2, 1], ["SEM-VINC", 1, 1], ["SOFA-1", 5, 2]]);
});

test("foto: só imagem de verdade (pelos primeiros bytes) e até 3 MB", () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(50)]);
  assert.equal(decodePhoto(`data:image/jpeg;base64,${jpeg.toString("base64")}`).mime, "image/jpeg");
  assert.equal(decodePhoto(null), null);
  assert.throws(() => decodePhoto(Buffer.from("<script>alert(1)</script>").toString("base64")), (e) => e.code === "photo_invalid");
  assert.throws(() => decodePhoto(Buffer.concat([jpeg, Buffer.alloc(3_100_000)]).toString("base64")), (e) => e.code === "photo_too_large");
});
