"use strict";

// Public backend contract for trusted Volt extensions. Extension code imports
// this boundary instead of reaching into Core implementation modules directly.
const db = require("../../../db/db");
const { createId } = require("../../modules/core/id");
const { validateCustomFields } = require("../../modules/core/configuration/customFields");
const { assertTransition, resolveWorkflow } = require("../../modules/core/workflows/workflowEngine");
const { normalizePageQuery, pageMeta } = require("../../modules/core/runtime/services/paging");
const {
  assertCompanyCapability,
  getCompanyConfiguration,
  getCompanyConfigurationWithClient,
} = require("../../modules/core/runtime/services/configurationService");
const {
  deleteEntityExtensionDataWithClient,
  listEntityExtensionData,
  upsertEntityExtensionDataWithClient,
} = require("./entityExtensionStore");
const {
  insertAuditWithClient,
  insertEventWithClient,
  insertWorkflowEventWithClient,
  nextOperationalNumber,
  recordEvent,
} = require("../../modules/core/runtime/services/persistenceHelpers");

async function rowsAndCount(dataSql, countSql, params, query, client = db) {
  const [rowsResult, countResult] = await Promise.all([
    client.query(dataSql, [...params, query.pageSize, query.offset]),
    client.query(countSql, params),
  ]);
  return {
    rows: rowsResult.rows,
    pagination: pageMeta(countResult.rows[0]?.total || 0, query),
  };
}

function normalizedFilter(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

module.exports = Object.freeze({
  assertCompanyCapability,
  assertTransition,
  createId,
  db,
  deleteEntityExtensionDataWithClient,
  getCompanyConfiguration,
  getCompanyConfigurationWithClient,
  insertAuditWithClient,
  insertEventWithClient,
  insertWorkflowEventWithClient,
  listEntityExtensionData,
  nextOperationalNumber,
  normalizePageQuery,
  normalizedFilter,
  recordEvent,
  resolveWorkflow,
  rowsAndCount,
  upsertEntityExtensionDataWithClient,
  validateCustomFields,
});
