"use strict";

const { query, withClient } = require("../config/postgres");

const MODEL_TABLES = {
  account: "Account",
  user: "User",
  shop: "Shop",
  oAuthToken: "OAuthToken",
  product: "Product",
  productImage: "ProductImage",
  productModel: "ProductModel",
  order: "Order",
  orderGeoAddress: "OrderGeoAddress",
  orderAddressSnapshot: "OrderAddressSnapshot",
  orderAddressChangeAlert: "OrderAddressChangeAlert",
  orderItem: "OrderItem",
  adsCampaignGroup: "AdsCampaignGroup",
  adsCampaignGroupCampaign: "AdsCampaignGroupCampaign",
};

const TABLES_IN_RESTORE_ORDER = [
  "Account",
  "User",
  "Shop",
  "OAuthToken",
  "Product",
  "ProductImage",
  "ProductModel",
  "Order",
  "OrderGeoAddress",
  "OrderAddressSnapshot",
  "OrderAddressChangeAlert",
  "OrderItem",
  "AdsCampaignGroup",
  "AdsCampaignGroupCampaign",
];

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, "\"\"")}"`;
}

function getTableNameForModel(modelKey) {
  const tableName = MODEL_TABLES[modelKey];
  if (!tableName) {
    throw new Error(`Tabela SQL nao mapeada para o modelo: ${modelKey}`);
  }

  return tableName;
}

function normalizeParamValue(value) {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value;
  }

  if (Array.isArray(value)) {
    return JSON.stringify(value);
  }

  if (value && typeof value === "object") {
    return JSON.stringify(value);
  }

  return value;
}

function buildColumnGroups(rows) {
  const groups = new Map();

  for (const row of rows) {
    const columns = Object.keys(row).sort();
    const signature = columns.join("|");

    if (!groups.has(signature)) {
      groups.set(signature, { columns, rows: [] });
    }

    groups.get(signature).rows.push(row);
  }

  return Array.from(groups.values());
}

async function listRowsForBackup(modelKey) {
  const tableName = getTableNameForModel(modelKey);
  const result = await query(
    `SELECT * FROM ${quoteIdentifier(tableName)} ORDER BY id ASC`,
  );

  return result.rows;
}

async function truncateAllTables(client) {
  await client.query(`
    TRUNCATE TABLE
      "AdsCampaignGroupCampaign",
      "AdsCampaignGroup",
      "OrderItem",
      "OrderAddressChangeAlert",
      "OrderAddressSnapshot",
      "OrderGeoAddress",
      "Order",
      "ProductModel",
      "ProductImage",
      "Product",
      "OAuthToken",
      "Shop",
      "User",
      "Account"
    RESTART IDENTITY CASCADE
  `);
}

async function insertRowsBatched(client, modelKey, rows, batchSize = 1000) {
  const tableName = getTableNameForModel(modelKey);
  const groups = buildColumnGroups(rows);

  for (const group of groups) {
    const { columns, rows: groupedRows } = group;
    if (!columns.length || !groupedRows.length) {
      continue;
    }

    const columnSql = columns.map(quoteIdentifier).join(", ");

    for (let start = 0; start < groupedRows.length; start += batchSize) {
      const batch = groupedRows.slice(start, start + batchSize);
      const values = [];
      const tuples = batch.map((row) => {
        const placeholders = columns.map((column) => {
          values.push(normalizeParamValue(row[column]));
          return `$${values.length}`;
        });

        return `(${placeholders.join(", ")})`;
      });

      await client.query(
        `INSERT INTO ${quoteIdentifier(tableName)} (${columnSql}) VALUES ${tuples.join(", ")}`,
        values,
      );
    }
  }
}

async function resetSequencesPostgres(client) {
  for (const tableName of TABLES_IN_RESTORE_ORDER) {
    await client.query(
      `
        SELECT setval(
          pg_get_serial_sequence($1, 'id'),
          COALESCE((SELECT MAX(id) FROM ${quoteIdentifier(tableName)}), 1)
        )
      `,
      [quoteIdentifier(tableName)],
    );
  }
}

async function restoreModels({ models, data }) {
  return withClient(async (client) => {
    await client.query("BEGIN");

    try {
      await truncateAllTables(client);

      for (const modelKey of models) {
        const rows = Array.isArray(data[modelKey]) ? data[modelKey] : [];
        if (!rows.length) {
          continue;
        }

        await insertRowsBatched(client, modelKey, rows, 1000);
      }

      await resetSequencesPostgres(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

module.exports = {
  listRowsForBackup,
  restoreModels,
};
