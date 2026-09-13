"use strict";

const { query } = require("../src/config/postgres");

const EXPECTED_COLUMNS = [
  { table: "Account", column: "id", allowedUdts: ["int4"] },
  { table: "Shop", column: "id", allowedUdts: ["int4"] },
  { table: "Shop", column: "shopId", allowedUdts: ["int8"] },
  { table: "Shop", column: "accountId", allowedUdts: ["int4"] },
  { table: "OAuthToken", column: "shopId", allowedUdts: ["int4"] },
  { table: "User", column: "id", allowedUdts: ["int4"] },
  { table: "User", column: "accountId", allowedUdts: ["int4"] },
  { table: "Session", column: "userId", allowedUdts: ["int4"] },
  { table: "Session", column: "activeShopId", allowedUdts: ["int4"] },
  { table: "Session", column: "realUserId", allowedUdts: ["int4"] },
  { table: "Product", column: "id", allowedUdts: ["int4"] },
  { table: "Product", column: "shopId", allowedUdts: ["int4"] },
  { table: "Order", column: "id", allowedUdts: ["int4"] },
  { table: "Order", column: "shopId", allowedUdts: ["int4"] },
  { table: "OrderItem", column: "id", allowedUdts: ["int4"] },
  { table: "OrderItem", column: "shopId", allowedUdts: ["int4"] },
  { table: "OrderItem", column: "orderId", allowedUdts: ["int4"] },
  { table: "OrderItem", column: "productId", allowedUdts: ["int4"] },
  { table: "ListingCloneDraft", column: "id", allowedUdts: ["int4"] },
  { table: "ListingCloneDraft", column: "shopId", allowedUdts: ["int4"] },
  { table: "ListingCloneDraft", column: "userId", allowedUdts: ["int4"] },
  { table: "ProductBoostBatch", column: "id", allowedUdts: ["int4"] },
  { table: "ProductBoostBatch", column: "shopId", allowedUdts: ["int4"] },
  { table: "ProductBoostBatch", column: "userId", allowedUdts: ["int4"] },
  { table: "ProductBoostBatchItem", column: "id", allowedUdts: ["int4"] },
  { table: "ProductBoostBatchItem", column: "batchId", allowedUdts: ["int4"] },
  { table: "ProductBoostBatchItem", column: "shopId", allowedUdts: ["int4"] },
];

const RELATION_MATCHES = [
  ["Shop.id", "OAuthToken.shopId"],
  ["Account.id", "Shop.accountId"],
  ["Account.id", "User.accountId"],
  ["User.id", "Session.userId"],
  ["Shop.id", "Session.activeShopId"],
  ["User.id", "Session.realUserId"],
  ["Shop.id", "Product.shopId"],
  ["Shop.id", "Order.shopId"],
  ["Order.id", "OrderItem.orderId"],
  ["Shop.id", "OrderItem.shopId"],
  ["Product.id", "OrderItem.productId"],
  ["Shop.id", "ListingCloneDraft.shopId"],
  ["User.id", "ListingCloneDraft.userId"],
  ["Shop.id", "ProductBoostBatch.shopId"],
  ["User.id", "ProductBoostBatch.userId"],
  ["ProductBoostBatch.id", "ProductBoostBatchItem.batchId"],
  ["Shop.id", "ProductBoostBatchItem.shopId"],
];

function key(tableName, columnName) {
  return `${tableName}.${columnName}`;
}

function parseRef(ref) {
  const [tableName, columnName] = String(ref).split(".");
  return { tableName, columnName };
}

async function main() {
  const result = await query(`
    SELECT
      c.table_name,
      c.column_name,
      c.udt_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
  `);

  const byColumn = new Map();
  for (const row of result.rows) {
    byColumn.set(key(row.table_name, row.column_name), String(row.udt_name || "").toLowerCase());
  }

  const issues = [];

  const externalFkResult = await query(`
    SELECT
      src.relname AS source_table,
      src_att.attname AS source_column
    FROM pg_constraint c
    JOIN pg_class src ON src.oid = c.conrelid
    JOIN pg_class tgt ON tgt.oid = c.confrelid
    JOIN pg_attribute src_att
      ON src_att.attrelid = c.conrelid
     AND src_att.attnum = c.conkey[1]
    WHERE c.contype = 'f'
      AND tgt.relname = 'User'
      AND src.relname IN ('UserAccessToken', 'MonitoredOrder')
      AND src_att.attname IN ('userId', 'createdById')
    ORDER BY src.relname, src_att.attname
  `);

  if (externalFkResult.rows.length) {
    const refs = externalFkResult.rows
      .map((row) => `${row.source_table}.${row.source_column}`)
      .join(", ");
    issues.push(
      `Banco incompativel com Shopee dedicado: FKs externas para User.id detectadas (${refs}).`,
    );
  }

  for (const expected of EXPECTED_COLUMNS) {
    const columnKey = key(expected.table, expected.column);
    const actualUdt = byColumn.get(columnKey);

    if (!actualUdt) {
      issues.push(`Coluna ausente: ${columnKey}`);
      continue;
    }

    if (!expected.allowedUdts.includes(actualUdt)) {
      issues.push(
        `Tipo divergente em ${columnKey}: esperado ${expected.allowedUdts.join(" ou ")}, atual ${actualUdt}`,
      );
    }
  }

  for (const [leftRef, rightRef] of RELATION_MATCHES) {
    const left = parseRef(leftRef);
    const right = parseRef(rightRef);
    const leftType = byColumn.get(key(left.tableName, left.columnName));
    const rightType = byColumn.get(key(right.tableName, right.columnName));

    if (!leftType || !rightType) continue;

    if (leftType !== rightType) {
      issues.push(
        `Incompatibilidade de relacao: ${leftRef}(${leftType}) <> ${rightRef}(${rightType})`,
      );
    }
  }

  if (issues.length) {
    console.error("[schema-check] Divergencias detectadas:");
    for (const issue of issues) {
      console.error(`- ${issue}`);
    }
    process.exit(1);
    return;
  }

  console.log("[schema-check] OK - sem divergencias de tipo nas colunas criticas.");
}

main().catch((error) => {
  console.error("[schema-check] Falha ao validar schema:", error?.message || error);
  process.exit(1);
});
