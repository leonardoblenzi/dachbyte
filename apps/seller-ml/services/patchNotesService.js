"use strict";

const db = require("../db/db");

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function normalizeText(value) {
  const text = String(value ?? "").replace(/\r\n/g, "\n").trim();
  return text || null;
}

function normalizeVersion(version) {
  const cleaned = String(version || "")
    .trim()
    .replace(/^v/i, "");

  if (!SEMVER_RE.test(cleaned)) {
    throw new Error("Versao invalida. Use o formato x.y.z, por exemplo 1.4.0.");
  }

  return cleaned;
}

function parseLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeAudience(value) {
  const normalized = String(value || "manual").trim().toLowerCase();
  if (["manual", "all_active", "admins"].includes(normalized)) return normalized;
  return "manual";
}

function sanitizePatchNoteInput(input = {}) {
  return {
    version: normalizeVersion(input.version),
    title: String(input.title || "").trim() || "Atualizacao DAVANTTI",
    summary: normalizeText(input.summary),
    novidades_text: normalizeText(input.novidades_text),
    melhorias_text: normalizeText(input.melhorias_text),
    correcoes_text: normalizeText(input.correcoes_text),
    cta_label: normalizeText(input.cta_label) || "Abrir plataforma",
    cta_url: normalizeText(input.cta_url) || null,
    audience: normalizeAudience(input.audience),
  };
}

async function listPatchNotes({ limit = 20 } = {}) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const { rows } = await db.query(
    `select
       id,
       version,
       title,
       summary,
       status,
       audience,
       sent_at,
       created_at,
       updated_at
     from patch_notes
     order by created_at desc
     limit $1`,
    [safeLimit],
  );
  return rows;
}

async function getPatchNoteById(id) {
  const noteId = Number(id);
  if (!Number.isFinite(noteId)) return null;

  const { rows } = await db.query(
    `select
       id,
       version,
       title,
       summary,
       novidades_text,
       melhorias_text,
       correcoes_text,
       cta_label,
       cta_url,
       status,
       audience,
       sent_at,
       created_at,
       updated_at,
       created_by,
       updated_by
     from patch_notes
     where id = $1
     limit 1`,
    [noteId],
  );

  return rows[0] || null;
}

async function getPatchNoteByVersion(version) {
  const safeVersion = normalizeVersion(version);
  const { rows } = await db.query(
    `select
       id,
       version,
       title,
       summary,
       novidades_text,
       melhorias_text,
       correcoes_text,
       cta_label,
       cta_url,
       status,
       audience,
       sent_at,
       created_at,
       updated_at,
       created_by,
       updated_by
     from patch_notes
     where version = $1
     limit 1`,
    [safeVersion],
  );

  return rows[0] || null;
}

async function upsertPatchNote(input, actorUserId = null) {
  const payload = sanitizePatchNoteInput(input);
  const rawPatchNoteId = input?.id;
  const hasPatchNoteId =
    rawPatchNoteId !== null &&
    rawPatchNoteId !== undefined &&
    String(rawPatchNoteId).trim() !== "";
  const patchNoteId = hasPatchNoteId ? Number(rawPatchNoteId) : null;
  const safeActorId = Number.isFinite(Number(actorUserId))
    ? Number(actorUserId)
    : null;

  if (Number.isFinite(patchNoteId) && patchNoteId > 0) {
    const { rows } = await db.query(
      `update patch_notes
          set version = $2,
              title = $3,
              summary = $4,
              novidades_text = $5,
              melhorias_text = $6,
              correcoes_text = $7,
              cta_label = $8,
              cta_url = $9,
              audience = $10,
              updated_by = $11,
              updated_at = now()
        where id = $1
      returning *`,
      [
        patchNoteId,
        payload.version,
        payload.title,
        payload.summary,
        payload.novidades_text,
        payload.melhorias_text,
        payload.correcoes_text,
        payload.cta_label,
        payload.cta_url,
        payload.audience,
        safeActorId,
      ],
    );

    if (!rows[0]) throw new Error("Patch note nao encontrado.");
    return rows[0];
  }

  const { rows } = await db.query(
    `insert into patch_notes (
       version,
       title,
       summary,
       novidades_text,
       melhorias_text,
       correcoes_text,
       cta_label,
       cta_url,
       audience,
       created_by,
       updated_by
     )
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     returning *`,
    [
      payload.version,
      payload.title,
      payload.summary,
      payload.novidades_text,
      payload.melhorias_text,
      payload.correcoes_text,
      payload.cta_label,
      payload.cta_url,
      payload.audience,
      safeActorId,
      safeActorId,
    ],
  );

  return rows[0];
}

async function listRecipientOptions() {
  const { rows } = await db.query(
    `select id, nome, email, nivel, status
       from usuarios
      where lower(coalesce(status, 'ativo')) = 'ativo'
        and coalesce(email, '') <> ''
      order by lower(coalesce(nome, email)), id`,
  );

  return rows;
}

function filterRecipients(users = [], { audience = "manual", recipientIds = [], manualEmails = [] } = {}) {
  const wantedAudience = normalizeAudience(audience);
  const ids = new Set(
    (Array.isArray(recipientIds) ? recipientIds : [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value)),
  );

  let recipients = [];
  if (wantedAudience === "all_active") {
    recipients = users;
  } else if (wantedAudience === "admins") {
    recipients = users.filter((user) =>
      ["administrador", "admin_master"].includes(String(user.nivel || "").toLowerCase()),
    );
  } else {
    recipients = users.filter((user) => ids.has(Number(user.id)));

    const manualList = (Array.isArray(manualEmails) ? manualEmails : [])
      .map((entry) => {
        if (!entry) return null;
        if (typeof entry === "string") {
          const email = entry.trim().toLowerCase();
          return email ? { email, nome: null, id: null, nivel: "manual" } : null;
        }
        const email = String(entry.email || "").trim().toLowerCase();
        const nome = String(entry.nome || "").trim() || null;
        return email ? { email, nome, id: null, nivel: "manual" } : null;
      })
      .filter(Boolean);

    recipients = [...recipients, ...manualList];
  }

  const dedup = new Map();
  recipients.forEach((recipient) => {
    const email = String(recipient.email || "").trim().toLowerCase();
    if (!email) return;
    if (!dedup.has(email)) dedup.set(email, { ...recipient, email });
  });

  return [...dedup.values()];
}

async function markPatchNoteAsSent(id, audience) {
  const noteId = Number(id);
  if (!Number.isFinite(noteId)) return null;

  const { rows } = await db.query(
    `update patch_notes
        set status = 'sent',
            audience = $2,
            sent_at = now(),
            updated_at = now()
      where id = $1
      returning *`,
    [noteId, normalizeAudience(audience)],
  );

  return rows[0] || null;
}

async function saveDeliveryLog({
  patchNoteId,
  recipientEmail,
  recipientName,
  deliveryStatus,
  providerMessageId,
  errorMessage,
}) {
  await db.query(
    `insert into patch_note_deliveries (
       patch_note_id,
       recipient_email,
       recipient_name,
       delivery_status,
       provider_message_id,
       error_message
     )
     values ($1,$2,$3,$4,$5,$6)`,
    [
      Number(patchNoteId),
      String(recipientEmail || "").trim().toLowerCase(),
      normalizeText(recipientName),
      String(deliveryStatus || "pending").trim().toLowerCase(),
      normalizeText(providerMessageId),
      normalizeText(errorMessage),
    ],
  );
}

async function deletePatchNotes(ids = []) {
  const safeIds = [...new Set(
    (Array.isArray(ids) ? ids : [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value)),
  )];

  if (!safeIds.length) {
    return { deletedCount: 0, deletedIds: [] };
  }

  const { rows } = await db.query(
    `delete from patch_notes
      where id = any($1::bigint[])
      returning id`,
    [safeIds],
  );

  return {
    deletedCount: rows.length,
    deletedIds: rows.map((row) => Number(row.id)),
  };
}

module.exports = {
  deletePatchNotes,
  filterRecipients,
  getPatchNoteById,
  getPatchNoteByVersion,
  listPatchNotes,
  listRecipientOptions,
  markPatchNoteAsSent,
  normalizeVersion,
  parseLines,
  sanitizePatchNoteInput,
  saveDeliveryLog,
  upsertPatchNote,
};
