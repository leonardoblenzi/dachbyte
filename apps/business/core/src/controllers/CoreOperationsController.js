"use strict";

// Transitional controller kept only for registry reads and import-template downloads.
// The former in-memory operational API is no longer mounted in production routes.
const operations = require("../modules/core/coreOperationsService");
const persistent = require("../modules/core/runtime");
const {
  buildCustomerImportTemplateBuffer,
  buildProductImportTemplateBuffer,
} = require("../modules/core/importTemplates");

async function listRoles(req, res) {
  res.json({
    roles: persistent.isEnabled() ? await persistent.listRoles(req.params.companyId || null) : operations.listRoles(),
  });
}

async function listPermissions(_req, res) {
  res.json({
    permissions: persistent.isEnabled() ? persistent.listPermissions() : operations.listPermissions(),
  });
}

async function downloadImportTemplate(req, res) {
  const entity = String(req.params.entity || "").toLowerCase();
  const categories = Array.isArray(req.query.category)
    ? req.query.category
    : String(req.query.category || "")
      .split("|")
      .map((item) => item.trim())
      .filter(Boolean);
  const isProducts = entity === "products" || entity === "produtos";
  const buffer = isProducts
    ? await buildProductImportTemplateBuffer(categories)
    : await buildCustomerImportTemplateBuffer();
  const filename = isProducts ? "modelo-produtos-volt-core.xlsx" : "modelo-clientes-volt-core.xlsx";

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(Buffer.from(buffer));
}

module.exports = {
  downloadImportTemplate,
  listPermissions,
  listRoles,
};
