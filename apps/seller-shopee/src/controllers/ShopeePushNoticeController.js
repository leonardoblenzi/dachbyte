"use strict";

const {
  findShopByDbIdAndAccountId,
} = require("../repositories/operationsSqlRepository");
const {
  deleteShopeePushNotices,
  listShopeePushNoticeReport,
  listShopeePushNotices,
  markShopeePushNoticeRead,
} = require("../repositories/shopeePushNoticeSqlRepository");

async function getActiveShopOrFail(req, res) {
  if (!req.auth) {
    res.status(401).json({ error: "unauthorized" });
    return null;
  }

  const shopDbId = req.auth.activeShopId || null;
  if (!shopDbId) {
    res.status(409).json({
      error: "select_shop_required",
      message: "Selecione uma loja para continuar.",
    });
    return null;
  }

  const shop = await findShopByDbIdAndAccountId(shopDbId, req.auth.accountId);
  if (!shop) {
    res.status(404).json({ error: "shop_not_found" });
    return null;
  }

  return shop;
}

function parseBool(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parseIds(value) {
  const source = Array.isArray(value) ? value : [value];
  return source
    .flatMap((item) => String(item || "").split(","))
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0)
    .map((item) => Math.trunc(item));
}

function csvCell(value) {
  const text = String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `"${text.replace(/"/g, '""')}"`;
}

function formatCsvDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "");
  return date.toISOString();
}

function buildNoticesCsv(notices = []) {
  const headers = [
    "id",
    "categoria",
    "codigo",
    "severidade",
    "titulo",
    "mensagem",
    "entidade_tipo",
    "entidade_id",
    "ocorrido_em",
    "push_em",
    "expira_em",
    "lido_em",
    "criado_em",
  ];
  const lines = [headers.map(csvCell).join(",")];
  for (const notice of notices) {
    lines.push([
      notice.id,
      notice.category,
      notice.code,
      notice.severity,
      notice.title,
      notice.message,
      notice.entityType,
      notice.entityId,
      formatCsvDate(notice.occurredAt),
      formatCsvDate(notice.pushTimestamp),
      formatCsvDate(notice.expiresAt),
      formatCsvDate(notice.readAt),
      formatCsvDate(notice.createdAt),
    ].map(csvCell).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

async function list(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop) return;

  const page = Math.max(1, Number(req.query?.page || 1) || 1);
  const pageSize = Math.max(1, Math.min(200, Number(req.query?.pageSize || 50) || 50));
  const data = await listShopeePushNotices({
    shopId: shop.id,
    page,
    pageSize,
    category: String(req.query?.category || "").trim(),
    unreadOnly: parseBool(req.query?.unreadOnly),
    search: String(req.query?.q || req.query?.search || "").trim(),
  });

  return res.json({
    ok: true,
    ...data,
  });
}

async function markRead(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop) return;

  const all = parseBool(req.body?.all);
  const noticeId = req.params?.id || req.body?.id || null;
  const noticeIds = parseIds(req.body?.ids || req.body?.noticeIds);
  const affected = await markShopeePushNoticeRead({
    shopId: shop.id,
    noticeId,
    noticeIds,
    all,
  });

  return res.json({
    ok: true,
    affected,
  });
}

async function remove(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop) return;

  const all = parseBool(req.body?.all);
  const noticeId = req.params?.id || req.body?.id || null;
  const noticeIds = parseIds(req.body?.ids || req.body?.noticeIds);
  const affected = await deleteShopeePushNotices({
    shopId: shop.id,
    noticeId,
    noticeIds,
    all,
  });

  return res.json({
    ok: true,
    affected,
  });
}

async function exportCsv(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop) return;

  const notices = await listShopeePushNoticeReport({
    shopId: shop.id,
    category: String(req.query?.category || "").trim(),
    unreadOnly: parseBool(req.query?.unreadOnly),
    search: String(req.query?.q || req.query?.search || "").trim(),
    limit: Number(req.query?.limit || 10000) || 10000,
  });
  const csv = buildNoticesCsv(notices);
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="avisos-shopee-${date}.csv"`);
  return res.send(csv);
}

module.exports = {
  exportCsv,
  list,
  markRead,
  remove,
};
