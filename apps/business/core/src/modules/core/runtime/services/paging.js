"use strict";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePageQuery(query = {}, options = {}) {
  const maxPageSize = positiveInt(options.maxPageSize, MAX_PAGE_SIZE);
  const defaultPageSize = Math.min(positiveInt(options.defaultPageSize, DEFAULT_PAGE_SIZE), maxPageSize);
  const page = positiveInt(query.page, 1);
  const pageSize = Math.min(positiveInt(query.pageSize, defaultPageSize), maxPageSize);
  const search = String(query.search || "").trim().slice(0, 160);
  const filter = String(query.filter || query.status || "").trim().slice(0, 80);
  const dateFrom = normalizeDateKey(query.dateFrom);
  const dateTo = normalizeDateKey(query.dateTo);
  const scope = String(query.scope || "").trim().slice(0, 80);
  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    search,
    filter,
    dateFrom,
    dateTo,
    scope,
  };
}

function normalizeDateKey(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const [year, month, day] = text.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return "";
  return text;
}

function pageMeta(total, query) {
  const normalizedTotal = Math.max(0, Number(total || 0));
  const totalPages = Math.max(1, Math.ceil(normalizedTotal / query.pageSize));
  return {
    page: Math.min(query.page, totalPages),
    pageSize: query.pageSize,
    total: normalizedTotal,
    totalPages,
    hasPrevious: query.page > 1,
    hasNext: query.page < totalPages,
  };
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  normalizeDateKey,
  normalizePageQuery,
  pageMeta,
};
