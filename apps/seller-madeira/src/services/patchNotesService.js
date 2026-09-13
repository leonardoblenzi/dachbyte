"use strict";

const { randomUUID } = require("crypto");
const {
  getOrCreateDefaultWorkspace,
  getWorkspaceById,
  queryOne,
  queryRows,
  withClient,
} = require("./databaseService");

function sanitizeText(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.map((item) => sanitizeText(item)).filter(Boolean)
    : [];
}

function normalizePatchNotesPayload(input = {}) {
  const recipientEmails = normalizeStringArray(input.recipientEmails).map((email) =>
    normalizeEmail(email),
  );

  return {
    version: sanitizeText(input.version),
    title: sanitizeText(input.title),
    summary: sanitizeText(input.summary),
    newFeatures: normalizeStringArray(input.newFeatures),
    adjustments: normalizeStringArray(input.adjustments),
    recipientEmails: Array.from(new Set(recipientEmails)),
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function buildPatchNotesHtml({ nome, patchNotes }) {
  const newFeatures = Array.isArray(patchNotes?.newFeatures) ? patchNotes.newFeatures : [];
  const adjustments = Array.isArray(patchNotes?.adjustments) ? patchNotes.adjustments : [];
  const releaseDate = new Intl.DateTimeFormat("pt-BR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());

  const renderList = (title, items, accent) => {
    if (!items.length) return "";

    return `
      <div style="margin-top:22px;">
        <div style="font-size:15px;font-weight:800;color:${accent};margin-bottom:10px;">${escapeHtml(title)}</div>
        <ul style="padding-left:18px;margin:0;color:#334155;line-height:1.7;">
          ${items.map((item) => `<li style="margin-bottom:8px;">${escapeHtml(item)}</li>`).join("")}
        </ul>
      </div>
    `;
  };

  return `
    <div style="font-family:Arial,Helvetica,sans-serif;background:#f6fbff;padding:32px;color:#0f172a;">
      <div style="max-width:720px;margin:0 auto;background:#ffffff;border-radius:24px;padding:32px;border:1px solid #dbeafe;">
        <p style="margin:0 0 14px;font-size:13px;color:#0f766e;font-weight:800;letter-spacing:.08em;text-transform:uppercase;">
          DAVANTTI • Release Notes MadeiraMadeira
        </p>
        <h1 style="margin:0;font-size:32px;line-height:1.05;color:#0f172a;">
          ${escapeHtml(patchNotes?.title || `Atualizacao ${patchNotes?.version || ""}`)}
        </h1>
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:16px;">
          <div style="padding:10px 14px;border-radius:14px;background:#eff6ff;border:1px solid #bfdbfe;">
            <div style="font-size:12px;color:#64748b;">Versao</div>
            <div style="margin-top:4px;font-size:18px;font-weight:800;color:#1d4ed8;">${escapeHtml(patchNotes?.version || "-")}</div>
          </div>
          <div style="padding:10px 14px;border-radius:14px;background:#ecfeff;border:1px solid #a5f3fc;">
            <div style="font-size:12px;color:#64748b;">Publicado em</div>
            <div style="margin-top:4px;font-size:18px;font-weight:800;color:#0f766e;">${escapeHtml(releaseDate)}</div>
          </div>
        </div>
        <p style="margin:22px 0 0;font-size:16px;line-height:1.75;color:#334155;">
          Ola, ${escapeHtml(nome || "time")}. ${escapeHtml(patchNotes?.summary || "")}
        </p>
        ${renderList("Novidades", newFeatures, "#0369a1")}
        ${renderList("Ajustes e refinamentos", adjustments, "#b45309")}
      </div>
    </div>
  `;
}

async function listPatchNotesRecipients(workspaceId) {
  const workspace =
    workspaceId && String(workspaceId).trim()
      ? await getWorkspaceById(String(workspaceId).trim())
      : await getOrCreateDefaultWorkspace();

  const users = await queryRows(
    `
      select
        "id",
        "name",
        "email",
        "role"::text as "role",
        "status"::text as "status",
        "isMaster"
      from "MadUser"
      where "workspaceId" = $1
        and "status" = 'active'
      order by "isMaster" desc, "name" asc
    `,
    [workspace.id],
  );

  return {
    workspace,
    totalRecipients: users.length,
    users,
  };
}

async function listUsersByEmailsActive(workspaceId, emails) {
  const workspace =
    workspaceId && String(workspaceId).trim()
      ? await getWorkspaceById(String(workspaceId).trim())
      : await getOrCreateDefaultWorkspace();
  const normalized = Array.from(new Set((emails || []).map((email) => normalizeEmail(email)).filter(Boolean)));
  if (!normalized.length) return [];

  return queryRows(
    `
      select
        "id",
        "name",
        "email",
        "role"::text as "role",
        "status"::text as "status"
      from "MadUser"
      where "workspaceId" = $1
        and "status" = 'active'
        and lower("email") = any($2::text[])
      order by "name" asc
    `,
    [workspace.id, normalized],
  );
}

async function createPatchNoteHistory({
  workspaceId,
  version,
  title,
  summary,
  subject,
  html,
  newFeatures,
  adjustments,
  recipientCount,
  sentCount,
  skippedCount,
  failedCount,
  createdByName,
  createdByEmail,
}) {
  const workspace =
    workspaceId && String(workspaceId).trim()
      ? await getWorkspaceById(String(workspaceId).trim())
      : await getOrCreateDefaultWorkspace();

  const created = await queryOne(
    `
      insert into "MadWebhookEvent" (
        "id",
        "workspaceId",
        "topic",
        "externalEventId",
        "status",
        "sourceIp",
        "headers",
        "payload",
        "attempts",
        "errorMessage",
        "receivedAt",
        "processedAt",
        "createdAt",
        "updatedAt"
      )
      values (
        $1,
        $2,
        'patch_notes',
        $3,
        $4::"MadWebhookStatus",
        null,
        $5::jsonb,
        $6::jsonb,
        $7,
        $8,
        now(),
        now(),
        now(),
        now()
      )
      returning
        "id",
        "workspaceId",
        "topic",
        "externalEventId",
        "status"::text as "status",
        "payload",
        "attempts",
        "errorMessage",
        "receivedAt",
        "processedAt",
        "createdAt",
        "updatedAt"
    `,
    [
      `madpatch_${randomUUID()}`,
      workspace.id,
      `patch_${version || randomUUID()}`,
      failedCount > 0 ? "processed" : "processed",
      JSON.stringify({
        createdByName: sanitizeText(createdByName),
        createdByEmail: normalizeEmail(createdByEmail),
        subject: sanitizeText(subject),
      }),
      JSON.stringify({
        version,
        title,
        summary,
        subject,
        html,
        newFeatures: normalizeStringArray(newFeatures),
        adjustments: normalizeStringArray(adjustments),
        totals: {
          recipientCount,
          sentCount,
          skippedCount,
          failedCount,
        },
      }),
      recipientCount || 0,
      failedCount > 0 ? `${failedCount} falhas no envio de release notes.` : null,
    ],
  );

  return created;
}

async function listPatchNotesHistory(params = {}) {
  const workspace =
    params.workspaceId && String(params.workspaceId).trim()
      ? await getWorkspaceById(String(params.workspaceId).trim())
      : await getOrCreateDefaultWorkspace();
  const limit = Math.max(1, Number.parseInt(String(params.limit || 12), 10) || 12);

  const rows = await queryRows(
    `
      select
        "id",
        "workspaceId",
        "topic",
        "externalEventId",
        "status"::text as "status",
        "payload",
        "headers",
        "attempts",
        "errorMessage",
        "receivedAt",
        "processedAt",
        "createdAt",
        "updatedAt"
      from "MadWebhookEvent"
      where "workspaceId" = $1
        and "topic" = 'patch_notes'
      order by "receivedAt" desc
      limit $2
    `,
    [workspace.id, limit],
  );

  return {
    workspace,
    items: rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      status: row.status,
      version: row.payload?.version || null,
      title: row.payload?.title || null,
      summary: row.payload?.summary || null,
      subject: row.payload?.subject || null,
      html: row.payload?.html || null,
      newFeatures: Array.isArray(row.payload?.newFeatures) ? row.payload.newFeatures : [],
      adjustments: Array.isArray(row.payload?.adjustments) ? row.payload.adjustments : [],
      totals: row.payload?.totals || {},
      receivedAt: row.receivedAt,
      processedAt: row.processedAt,
      createdAt: row.createdAt,
    })),
  };
}

module.exports = {
  buildPatchNotesHtml,
  createPatchNoteHistory,
  listPatchNotesHistory,
  listPatchNotesRecipients,
  listUsersByEmailsActive,
  normalizePatchNotesPayload,
};
