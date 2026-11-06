"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { computeAvailability, planListings } = require("../src/modules/stock/plan");
const { normalizeRule, ruleFromRow } = require("../src/modules/stock/rules");
const { parseCsv, parseSpreadsheet, parseQuantity, toCsv } = require("../src/modules/stock/spreadsheet");
const { createStockService } = require("../src/modules/stock/service");
const { skuKey } = require("../src/modules/catalog/normalize");

test("disponível: físico − reservado; kit pelo menor componente; sem saldo = não informado", () => {
  const map = computeAvailability({
    items: [{ id: 1, kind: "simple" }, { id: 2, kind: "simple" }, { id: 3, kind: "kit" }, { id: 4, kind: "simple" }, { id: 5, kind: "kit" }],
    balances: [{ itemId: 1, onHand: 10, reserved: 2 }, { itemId: 2, onHand: 3, reserved: 0 }],
    components: [{ kitItemId: 3, componentItemId: 1, quantity: 4 }, { kitItemId: 3, componentItemId: 2, quantity: 1 }, { kitItemId: 5, componentItemId: 4, quantity: 1 }],
  });
  assert.deepEqual(map.get(1), { available: 8, onHand: 10, reserved: 2, hasStock: true });
  assert.equal(map.get(3).available, 2, "8/4 = 2 e 3/1 = 3 → 2");
  assert.equal(map.get(3).hasStock, true);
  assert.equal(map.get(4).hasStock, false);
  assert.equal(map.get(5).hasStock, false, "kit com componente sem estoque informado não é calculado");
});

const base = { accountId: 1, channel: "mercadolivre", accountLabel: "Loja", accountMode: "observe", listingId: "MLB1", variationId: "", title: "Sofá", fulfillment: false, syncEnabled: true, sku: "SOFA", itemName: "Sofá", accountRule: null, listingRule: null };

test("plano: sobe, desce, igual e casos fora do cálculo", () => {
  const availability = new Map([[1, { available: 10, onHand: 10, reserved: 0, hasStock: true }], [2, { available: 0, onHand: 0, reserved: 0, hasStock: false }]]);
  const { rows, summary } = planListings({
    availability,
    listings: [
      { ...base, id: 1, itemId: 1, channelStock: 4 },
      { ...base, id: 2, itemId: 1, channelStock: 20, accountRule: { mode: "percent", value: 50, cap: null, minLock: 0, safetyReserve: 0 } },
      { ...base, id: 3, itemId: 1, channelStock: 10 },
      { ...base, id: 4, itemId: 1, channelStock: 3, fulfillment: true },
      { ...base, id: 5, itemId: 1, channelStock: 3, syncEnabled: false },
      { ...base, id: 6, itemId: 1, channelStock: 3, accountMode: "off" },
      { ...base, id: 7, itemId: 2, channelStock: 3 },
      { ...base, id: 8, itemId: 1, channelStock: 7, accountRule: { mode: "same", value: 0, cap: null, minLock: 0, safetyReserve: 0 }, listingRule: { mode: "same", value: 0, cap: null, minLock: 10, safetyReserve: 0 } },
    ],
  });
  assert.deepEqual(rows.map((r) => [r.id, r.state, r.desired]), [
    [1, "increase", 10], [2, "decrease", 5], [3, "same", 10], [4, "fulfillment", null],
    [5, "sync_off", null], [6, "account_off", null], [7, "no_stock", null], [8, "decrease", 0],
  ]);
  assert.equal(rows[7].ruleSource, "listing");
  assert.equal(rows[1].ruleSource, "account");
  assert.deepEqual(summary, { total: 8, increase: 1, decrease: 2, same: 1, zeroed: 1, skipped: 4 });
});

test("regra: validação da tela e leitura do banco", () => {
  assert.deepEqual(normalizeRule({ mode: "percent", value: "30", cap: "", minLock: "2", safetyReserve: "1" }).rule, { mode: "percent", value: 30, cap: null, minLock: 2, safetyReserve: 1 });
  assert.equal(normalizeRule({ mode: "percent", value: 120 }).error, "O percentual vai de 0 a 100.");
  assert.match(normalizeRule({ mode: "fixed", value: -1 }).error, /maior ou igual a zero/);
  assert.equal(normalizeRule({ mode: "xpto" }).rule, null);
  assert.deepEqual(ruleFromRow({ mode: "fixed", value: "5.0000", cap: null, min_lock: "0", safety_reserve: "2" }), { mode: "fixed", value: 5, cap: null, minLock: 0, safetyReserve: 2 });
});

test("planilha CSV: cabeçalho em português, ; e decimal com vírgula; erros com linha", () => {
  const { rows, errors } = parseCsv("﻿Código;Nome;Estoque\nSOFA-1;Sofá;12\n\nMESA;\"Mesa; redonda\";1.200\nCAD;x;abc\nPOL;x;2,5\n;x;3\n");
  assert.deepEqual(rows, [{ line: 2, sku: "SOFA-1", quantity: 12 }, { line: 4, sku: "MESA", quantity: 1200 }], "colunas pelo nome; 1.200 = mil e duzentos");
  assert.deepEqual(errors.map((e) => e.line), [5, 6, 7]);
  assert.match(errors[1].message, /inteiro/);
  const named = parseCsv("sku;quantidade\nSOFA-1;12\nMESA;1.200\nCAD;abc\nPOL;2,5\n;3\n");
  assert.deepEqual(named.rows, [{ line: 2, sku: "SOFA-1", quantity: 12 }, { line: 3, sku: "MESA", quantity: 1200 }]);
  assert.deepEqual(named.errors.map((e) => e.line), [4, 5, 6]);
  assert.deepEqual(parseCsv("A1,5\nB2,-3\n").rows, [{ line: 1, sku: "A1", quantity: 5 }, { line: 2, sku: "B2", quantity: -3 }], "sem cabeçalho");
  assert.equal(parseQuantity("1.234,0"), 1234);
  assert.ok(Number.isNaN(parseQuantity("12a")));
});

test("planilha Excel (.xlsx) e exportação CSV", async () => {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Estoque");
  ws.addRow(["SKU", "Quantidade"]);
  ws.addRow(["SOFA-1", 7]);
  ws.addRow(["MESA", { formula: "2+3", result: 5 }]);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const parsed = await parseSpreadsheet({ fileName: "estoque.xlsx", contentBase64: buffer.toString("base64") });
  assert.deepEqual(parsed.rows, [{ line: 2, sku: "SOFA-1", quantity: 7 }, { line: 3, sku: "MESA", quantity: 5 }]);
  assert.match((await parseSpreadsheet({ fileName: "velho.xls", contentBase64: "AAAA" })).errors[0].message, /\.xls antigo/);
  const csv = toCsv(["sku", "nome", "qtd"], [["A;1", 'Sofá "retrô"', 2.5]]);
  assert.equal(csv, '﻿sku;nome;qtd\r\n"A;1";"Sofá ""retrô""";2,5\r\n');
});

/** Repositório falso com o mínimo para os casos de uso. */
function fakeRepo({ items = [], balances = [], components = [], channelTargets = [] } = {}) {
  const calls = { entries: [], audits: [], rules: [], modes: [], kits: [] };
  return {
    calls,
    async availabilityInputs() { return { items: items.map(({ id, kind }) => ({ id, kind })), balances, components }; },
    async findItemsBySkuKeys(_t, keys) { return items.filter((i) => keys.includes(i.skuKey)); },
    async applyEntries(_t, entries, options) { calls.entries.push({ entries, options }); return { applied: entries.length, unchanged: 0, duplicates: 0, changes: [] }; },
    async audit(event) { calls.audits.push(event); },
    async channelStockByItem() { return channelTargets; },
    async setAccountMode(_t, id, mode) { calls.modes.push([id, mode]); return { id, mode }; },
    async saveRule(_t, input) { calls.rules.push(input); return { scope: input.scope, targetId: input.targetId, rule: input.rule && { mode: input.rule.mode, value: input.rule.value, cap: input.rule.cap, min_lock: input.rule.minLock, safety_reserve: input.rule.safetyReserve } }; },
    async getItem(_t, id) { const i = items.find((x) => x.id === id); return i ? { ...i, onHand: i.onHand || 0, usedInKits: Boolean(i.usedInKits), components: [] } : null; },
    async replaceKit(_t, id, comps) { calls.kits.push([id, comps]); return { id, kind: comps.length ? "kit" : "simple" }; },
  };
}

const ITEMS = [
  { id: 1, sku: "SOFA-1", skuKey: skuKey("SOFA-1"), kind: "simple", name: "Sofá" },
  { id: 2, sku: "MESA", skuKey: skuKey("MESA"), kind: "simple", name: "Mesa" },
  { id: 3, sku: "KIT-SALA", skuKey: skuKey("KIT-SALA"), kind: "kit", name: "Kit sala" },
];
const identity = { tenantId: "t1", userId: "u1" };
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

test("planilha: prévia aponta SKU inexistente, kit, repetido e saldo negativo; aplicar exige zero erros", async () => {
  const repo = fakeRepo({ items: ITEMS, balances: [{ itemId: 2, onHand: 2, reserved: 0 }] });
  const service = createStockService({ repository: repo });
  const file = { fileName: "e.csv", contentBase64: b64("sku;quantidade\nsofa 1;5\nMESA;-5\nKIT-SALA;1\nXPTO;3\nSOFA-1;9\n") };
  const preview = await service.previewSpreadsheet({ identity, file, mode: "add" });
  assert.deepEqual(preview.rows.map((r) => [r.sku, r.before, r.after]), [["SOFA-1", null, 5], ["MESA", 2, -3]]);
  assert.deepEqual(preview.errors.map((e) => e.line), [3, 4, 5, 6]);
  await assert.rejects(() => service.applySpreadsheet({ identity, file, mode: "add" }), (e) => e.code === "spreadsheet_errors" && e.details.length === 4);
  assert.equal(repo.calls.entries.length, 0);
});

test("planilha válida: soma com chave de idempotência pelo arquivo; definir não precisa", async () => {
  const repo = fakeRepo({ items: ITEMS, balances: [{ itemId: 2, onHand: 2, reserved: 0 }] });
  const service = createStockService({ repository: repo });
  const file = { fileName: "entrada.csv", contentBase64: b64("sku;quantidade\nSOFA-1;5\nMESA;3\n") };
  await service.applySpreadsheet({ identity, file, mode: "add" });
  const [{ entries }] = repo.calls.entries;
  assert.deepEqual(entries.map((e) => [e.itemId, e.op, e.quantity, e.kind]), [[1, "add", 5, "spreadsheet"], [2, "add", 3, "spreadsheet"]]);
  assert.ok(entries.every((e) => /^sheet:[0-9a-f]{32}:\d+$/.test(e.idempotencyKey)));
  await service.applySpreadsheet({ identity, file, mode: "set" });
  assert.deepEqual(repo.calls.entries[1].entries.map((e) => [e.op, e.quantity, e.idempotencyKey]), [["set", 5, null], ["set", 3, null]]);
});

test("ajuste manual: motivo obrigatório; definir vira inventário", async () => {
  const repo = fakeRepo({ items: ITEMS });
  const service = createStockService({ repository: repo });
  await assert.rejects(() => service.adjust({ identity, itemId: 1, op: "add", quantity: 2, note: " " }), (e) => e.code === "note_required");
  await assert.rejects(() => service.adjust({ identity, itemId: 1, op: "add", quantity: 0, note: "x" }), (e) => e.code === "invalid_quantity");
  await assert.rejects(() => service.adjust({ identity, itemId: 1, op: "set", quantity: 1.5, note: "x" }), (e) => e.code === "invalid_quantity");
  await service.adjust({ identity, itemId: 1, op: "set", quantity: 7, note: "contagem" });
  assert.equal(repo.calls.entries[0].entries[0].kind, "inventory");
  assert.equal(repo.calls.audits[0].action, "stock_adjusted");
});

test("estoque inicial pelos canais: só quem falta, prévia sem gravar e aplicação como 'initial'", async () => {
  const repo = fakeRepo({ items: ITEMS, balances: [{ itemId: 2, onHand: 9, reserved: 0 }], channelTargets: [{ itemId: 1, sku: "SOFA-1", quantity: 4.7, listings: 2 }, { itemId: 2, sku: "MESA", quantity: 1, listings: 1 }] });
  const service = createStockService({ repository: repo });
  await assert.rejects(() => service.initialFromChannels({ identity, source: "account" }), (e) => e.code === "account_required");
  const preview = await service.initialFromChannels({ identity, source: "lowest" });
  assert.deepEqual([preview.preview, preview.count, preview.rows[0].quantity], [true, 1, 4]);
  assert.equal(repo.calls.entries.length, 0);
  await service.initialFromChannels({ identity, source: "account", accountId: 8, onlyMissing: false, apply: true });
  assert.deepEqual(repo.calls.entries[0].entries.map((e) => [e.itemId, e.op, e.quantity, e.kind, e.channelAccountId]), [[1, "set", 4, "initial", 8], [2, "set", 1, "initial", 8]]);
});

test("modo da conta: ativo ainda bloqueado; regra validada antes de gravar", async () => {
  const repo = fakeRepo({ items: ITEMS });
  const service = createStockService({ repository: repo });
  await assert.rejects(() => service.setAccountMode({ identity, accountId: 1, mode: "active" }), (e) => e.code === "active_not_available");
  await service.setAccountMode({ identity, accountId: 1, mode: "observe" });
  assert.deepEqual(repo.calls.modes, [[1, "observe"]]);
  await assert.rejects(() => service.saveRule({ identity, scope: "account", targetId: 1, rule: { mode: "percent", value: 200 } }), (e) => e.code === "invalid_rule");
  const saved = await service.saveRule({ identity, scope: "listing", targetId: 9, rule: { mode: "fixed", value: 3 } });
  assert.deepEqual(saved.rule, { mode: "fixed", value: 3, cap: null, minLock: 0, safetyReserve: 0 });
  await service.saveRule({ identity, scope: "listing", targetId: 9, rule: null });
  assert.equal(repo.calls.rules.at(-1).rule, null, "remover exceção");
});

test("kit: sem kit dentro de kit, sem o próprio item, sem estoque próprio", async () => {
  const items = [...ITEMS, { id: 4, sku: "POLTRONA", skuKey: skuKey("POLTRONA"), kind: "simple", onHand: 3 }];
  const service = createStockService({ repository: fakeRepo({ items }) });
  await assert.rejects(() => service.setKit({ identity, itemId: 2, components: [{ sku: "KIT-SALA", quantity: 1 }] }), (e) => e.code === "nested_kit");
  await assert.rejects(() => service.setKit({ identity, itemId: 2, components: [{ sku: "MESA", quantity: 1 }] }), (e) => e.code === "self_component");
  await assert.rejects(() => service.setKit({ identity, itemId: 4, components: [{ sku: "MESA", quantity: 1 }] }), (e) => e.code === "kit_has_stock");
  await assert.rejects(() => service.setKit({ identity, itemId: 2, components: [{ sku: "SOFA-1", quantity: 0 }] }), (e) => e.code === "invalid_quantity");
  const saved = await service.setKit({ identity, itemId: 2, components: [{ sku: "sofa-1", quantity: 4 }] });
  assert.deepEqual(saved.components, [{ itemId: 1, quantity: 4 }]);
});
