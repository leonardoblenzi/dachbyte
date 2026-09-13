"use strict";

const { query, queryOne } = require("../config/postgres");

const TABLE_NAME = '"AdminInformativeNotice"';

function toSafeInt(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.trunc(parsed);
}

function normalizeHexColor(value) {
  const raw = String(value || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toUpperCase();
  return "#FF5A00";
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    title: row.title || "",
    message: row.message || "",
    noticeType: String(row.notice_type || "TAG").toUpperCase(),
    color: row.color || "#FF5A00",
    linkUrl: row.link_url || "",
    imageUrl: row.image_url || "",
    startsAt: row.starts_at || null,
    endsAt: row.ends_at || null,
    enabled: Boolean(row.enabled),
    priority: Number(row.priority || 0),
    createdBy: row.created_by || null,
    updatedBy: row.updated_by || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function ensureAdminInformativeTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL,
      notice_type TEXT NOT NULL DEFAULT 'TAG',
      color TEXT NOT NULL DEFAULT '#FF5A00',
      link_url TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      priority INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      updated_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(
    `ALTER TABLE ${TABLE_NAME} ADD COLUMN IF NOT EXISTS notice_type TEXT NOT NULL DEFAULT 'TAG'`,
  );
  await query(
    `ALTER TABLE ${TABLE_NAME} ADD COLUMN IF NOT EXISTS image_url TEXT NOT NULL DEFAULT ''`,
  );
}

async function listAdminInformativeNotices({ includeExpired = true, limit = 200 } = {}) {
  await ensureAdminInformativeTable();
  const safeLimit = Math.max(1, Math.min(500, toSafeInt(limit, 200)));
  const rows = await query(
    `
      SELECT
        id,
        title,
        message,
        notice_type,
        color,
        link_url,
        image_url,
        starts_at,
        ends_at,
        enabled,
        priority,
        created_by,
        updated_by,
        created_at,
        updated_at
      FROM ${TABLE_NAME}
      WHERE ($1::boolean = TRUE OR ends_at >= NOW() - INTERVAL '30 days')
      ORDER BY enabled DESC, priority DESC, starts_at DESC, id DESC
      LIMIT $2
    `,
    [Boolean(includeExpired), safeLimit],
  );
  return rows.rows.map(mapRow);
}

async function listActiveAdminInformativeNotices(at = new Date()) {
  await ensureAdminInformativeTable();
  const rows = await query(
    `
      SELECT
        id,
        title,
        message,
        notice_type,
        color,
        link_url,
        image_url,
        starts_at,
        ends_at,
        enabled,
        priority,
        created_by,
        updated_by,
        created_at,
        updated_at
      FROM ${TABLE_NAME}
      WHERE enabled = TRUE
        AND starts_at <= $1::timestamptz
        AND ends_at >= $1::timestamptz
      ORDER BY priority DESC, starts_at ASC, id ASC
    `,
    [at instanceof Date ? at.toISOString() : new Date().toISOString()],
  );
  return rows.rows.map(mapRow);
}

async function createAdminInformativeNotice({
  title = "",
  message = "",
  noticeType = "TAG",
  color = "#FF5A00",
  linkUrl = "",
  imageUrl = "",
  startsAt,
  endsAt,
  enabled = true,
  priority = 0,
  createdBy = null,
}) {
  await ensureAdminInformativeTable();
  const row = await queryOne(
    `
      INSERT INTO ${TABLE_NAME} (
        title,
        message,
        notice_type,
        color,
        link_url,
        image_url,
        starts_at,
        ends_at,
        enabled,
        priority,
        created_by,
        updated_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::boolean, $10::integer, $11, $11)
      RETURNING
        id,
        title,
        message,
        notice_type,
        color,
        link_url,
        image_url,
        starts_at,
        ends_at,
        enabled,
        priority,
        created_by,
        updated_by,
        created_at,
        updated_at
    `,
    [
      String(title || "").trim(),
      String(message || "").trim(),
      String(noticeType || "TAG").trim().toUpperCase(),
      normalizeHexColor(color),
      String(linkUrl || "").trim(),
      String(imageUrl || "").trim(),
      startsAt,
      endsAt,
      Boolean(enabled),
      toSafeInt(priority, 0),
      createdBy ? String(createdBy) : null,
    ],
  );
  return mapRow(row);
}

async function updateAdminInformativeNoticeById(
  id,
  {
    title = "",
    message = "",
    noticeType = "TAG",
    color = "#FF5A00",
    linkUrl = "",
    imageUrl = "",
    startsAt,
    endsAt,
    enabled = true,
    priority = 0,
    updatedBy = null,
  } = {},
) {
  await ensureAdminInformativeTable();
  const row = await queryOne(
    `
      UPDATE ${TABLE_NAME}
      SET
        title = $2,
        message = $3,
        notice_type = $4,
        color = $5,
        link_url = $6,
        image_url = $7,
        starts_at = $8::timestamptz,
        ends_at = $9::timestamptz,
        enabled = $10::boolean,
        priority = $11::integer,
        updated_by = $12,
        updated_at = NOW()
      WHERE id = $1
      RETURNING
        id,
        title,
        message,
        notice_type,
        color,
        link_url,
        image_url,
        starts_at,
        ends_at,
        enabled,
        priority,
        created_by,
        updated_by,
        created_at,
        updated_at
    `,
    [
      Number(id),
      String(title || "").trim(),
      String(message || "").trim(),
      String(noticeType || "TAG").trim().toUpperCase(),
      normalizeHexColor(color),
      String(linkUrl || "").trim(),
      String(imageUrl || "").trim(),
      startsAt,
      endsAt,
      Boolean(enabled),
      toSafeInt(priority, 0),
      updatedBy ? String(updatedBy) : null,
    ],
  );
  return mapRow(row);
}

async function deleteAdminInformativeNoticeById(id) {
  await ensureAdminInformativeTable();
  const row = await queryOne(
    `
      DELETE FROM ${TABLE_NAME}
      WHERE id = $1
      RETURNING id
    `,
    [Number(id)],
  );
  return Boolean(row?.id);
}

module.exports = {
  ensureAdminInformativeTable,
  listAdminInformativeNotices,
  listActiveAdminInformativeNotices,
  createAdminInformativeNotice,
  updateAdminInformativeNoticeById,
  deleteAdminInformativeNoticeById,
};

