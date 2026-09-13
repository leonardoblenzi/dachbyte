const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { _test } = require("../src/repositories/giftCampaignSqlRepository");

const repositoryPath = require.resolve("../src/repositories/giftCampaignSqlRepository");
const postgresPath = require.resolve("../src/config/postgres");

function loadRepositoryWithPostgres(fakePostgres) {
  const postgres = require("../src/config/postgres");
  const originalExports = require.cache[postgresPath].exports;
  delete require.cache[repositoryPath];
  require.cache[postgresPath].exports = { ...postgres, ...fakePostgres };
  const repository = require("../src/repositories/giftCampaignSqlRepository");
  require.cache[postgresPath].exports = originalExports;
  delete require.cache[repositoryPath];
  return repository;
}

test("migration vincula campanha, itens e auditoria a loja e campanha", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "migrations", "20260903110000_add_gift_campaigns", "migration.sql"), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "GiftCampaign"/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "GiftCampaignMainItem"/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "GiftCampaignGiftItem"/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "GiftCampaignAction"/);
  assert.match(sql, /FOREIGN KEY \("shopId"\) REFERENCES "Shop"\(id\) ON DELETE CASCADE/);
  assert.match(sql, /UNIQUE \(id, "shopId"\)/);
  assert.match(sql, /FOREIGN KEY \("campaignId", "shopId"\) REFERENCES "GiftCampaign"\(id, "shopId"\) ON DELETE CASCADE/);
});

test("consulta de campanha sempre inclui shopId", () => {
  const query = _test.buildGiftCampaignByIdQuery({ shopId: 42, campaignId: "a0d2c8c3-5f58-4b4d-9a17-3cf7de51ef10" });
  assert.match(query.text, /WHERE gc\.id = \$1::uuid AND gc\."shopId" = \$2/);
  assert.deepEqual(query.values, ["a0d2c8c3-5f58-4b4d-9a17-3cf7de51ef10", 42]);
});

test("cria itens principais e brindes com o id da campanha", async () => {
  const calls = [];
  const client = {
    async query(text, values = []) {
      calls.push({ text, values });
      if (text.includes('INSERT INTO "GiftCampaign"')) return { rows: [{ id: values[0] }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
  const repository = loadRepositoryWithPostgres({
    query: async () => ({ rows: [] }),
    queryOne: async () => null,
    withClient: async (callback) => callback(client),
  });
  const id = "a0d2c8c3-5f58-4b4d-9a17-3cf7de51ef10";

  await repository.createGiftCampaign({
    id,
    shopId: 42,
    idempotencyKey: "gift-campaign:42:one",
    mainItems: [{ pricingKey: "12:0", itemId: "12", costCents: 12345 }],
    giftItems: [{ pricingKey: "13:7", itemId: "13", modelId: "7", costCents: 678, quantity: 2 }],
  });

  const childInsertions = calls.filter((call) => call.text.includes('INSERT INTO "GiftCampaignMainItem"') || call.text.includes('INSERT INTO "GiftCampaignGiftItem"'));
  assert.equal(childInsertions.length, 2);
  const [mainInsert, giftInsert] = childInsertions;
  assert.match(mainInsert.text, /\("campaignId", "shopId", "pricingKey", "productId", "itemId", "modelId", title, sku, "costCents", "priceCents"\)/);
  assert.match(mainInsert.text, /VALUES \(\$1::uuid, \$2, \$3, \$4, \$5::bigint, \$6::bigint, \$7, \$8, \$9, \$10\)/);
  assert.equal(mainInsert.values.length, 10);
  assert.deepEqual(mainInsert.values, [id, 42, "12:0", null, "12", null, null, null, 12345, null]);

  assert.match(giftInsert.text, /\("campaignId", "shopId", "pricingKey", "productId", "itemId", "modelId", title, sku, "costCents", "priceCents", quantity\)/);
  assert.match(giftInsert.text, /VALUES \(\$1::uuid, \$2, \$3, \$4, \$5::bigint, \$6::bigint, \$7, \$8, \$9, \$10, \$11\)/);
  assert.equal(giftInsert.values.length, 11);
  assert.deepEqual(giftInsert.values, [id, 42, "13:7", null, "13", "7", null, null, 678, null, 2]);
});
test("migracao adicional preserva nome e CMV da campanha", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "migrations", "20260904120000_add_gift_campaign_name", "migration.sql"), "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS name TEXT NOT NULL/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "costCents" INTEGER/);
});
test("migracao de itens preserva CMV de principais e brindes", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "migrations", "20260904130000_add_gift_campaign_item_costs", "migration.sql"), "utf8");
  assert.match(sql, /ALTER TABLE "GiftCampaignMainItem"\s+ADD COLUMN IF NOT EXISTS "costCents" INTEGER/);
  assert.match(sql, /ALTER TABLE "GiftCampaignGiftItem"\s+ADD COLUMN IF NOT EXISTS "costCents" INTEGER/);
});
