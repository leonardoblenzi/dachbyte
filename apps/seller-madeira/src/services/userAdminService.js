"use strict";

const { createHash, randomBytes, randomUUID } = require("crypto");
const bcrypt = require("bcryptjs");
const {
  getWorkspaceById,
  queryOne,
  queryRows,
  withClient,
} = require("./databaseService");

const MASTER_ADMIN_EMAIL = "araphael.fialho@gmail.com";
const INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const ALLOWED_ROLES = new Set(["admin", "operator", "viewer"]);
const ALLOWED_STATUSES = new Set(["active", "invited", "disabled"]);

function sanitizeText(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeRole(value) {
  const normalized = String(value || "viewer").trim().toLowerCase();
  return ALLOWED_ROLES.has(normalized) ? normalized : "viewer";
}

function normalizeStatus(value) {
  const normalized = String(value || "active").trim().toLowerCase();
  return ALLOWED_STATUSES.has(normalized) ? normalized : "active";
}

function hashToken(token) {
  return createHash("sha256").update(String(token || "")).digest("hex");
}

function createInviteToken() {
  return randomBytes(32).toString("hex");
}

function createTemporaryPassword() {
  return `${randomBytes(8).toString("hex")}Aa1!`;
}

function inviteExpiryDate() {
  return new Date(Date.now() + INVITE_TTL_MS);
}

function parseMetadata(rawMetadata) {
  return rawMetadata && typeof rawMetadata === "object" ? rawMetadata : {};
}

function serializeUser(row) {
  const metadata = parseMetadata(row?.metadata);

  return {
    id: row.id,
    workspaceId: row.workspaceId || null,
    name: row.name,
    email: row.email,
    role: row.role,
    status: row.status,
    isMaster: Boolean(row.isMaster),
    lastLoginAt: row.lastLoginAt || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    invite: {
      sentAt: metadata.inviteSentAt || null,
      expiresAt: metadata.inviteExpiresAt || null,
      acceptedAt: metadata.inviteAcceptedAt || null,
      invitedBy: metadata.invitedBy || null,
      workspaceId: metadata.invitedWorkspaceId || row.workspaceId || null,
      workspaceName: metadata.invitedWorkspaceName || null,
    },
  };
}

async function findUserByEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  return queryOne(
    `
      select
        "id",
        "workspaceId",
        "name",
        "email",
        "passwordHash",
        "role"::text as "role",
        "status"::text as "status",
        "isMaster",
        "lastLoginAt",
        "metadata",
        "createdAt",
        "updatedAt"
      from "MadUser"
      where lower("email") = $1
      limit 1
    `,
    [normalizedEmail],
  );
}

async function assertAdminAccess({ actingUserEmail, workspaceId, masterOnly = false }) {
  const normalizedEmail = normalizeEmail(actingUserEmail);
  if (!normalizedEmail) {
    const error = new Error("Usuario administrador nao identificado.");
    error.status = 401;
    throw error;
  }

  const user = await findUserByEmail(normalizedEmail);
  if (!user || user.status !== "active") {
    const error = new Error("Acesso administrativo indisponivel.");
    error.status = 403;
    throw error;
  }

  const isMaster = Boolean(user.isMaster) || user.role === "admin_master" || normalizedEmail === MASTER_ADMIN_EMAIL;
  const isAdmin = isMaster || user.role === "admin";

  if (masterOnly && !isMaster) {
    const error = new Error("Acesso restrito ao admin master.");
    error.status = 403;
    throw error;
  }

  if (!masterOnly && !isAdmin) {
    const error = new Error("Acesso restrito aos administradores.");
    error.status = 403;
    throw error;
  }

  const workspace = await getWorkspaceById(workspaceId || user.workspaceId);
  if (!workspace?.id) {
    const error = new Error("Workspace nao encontrado.");
    error.status = 404;
    throw error;
  }

  if (!isMaster && user.workspaceId && workspace.id !== user.workspaceId) {
    const error = new Error("Administrador sem permissao neste workspace.");
    error.status = 403;
    throw error;
  }

  return {
    admin: serializeUser(user),
    workspace,
  };
}

async function listWorkspaceUsers(workspaceId) {
  const workspace = await getWorkspaceById(workspaceId);
  const rows = await queryRows(
    `
      select
        "id",
        "workspaceId",
        "name",
        "email",
        "role"::text as "role",
        "status"::text as "status",
        "isMaster",
        "lastLoginAt",
        "metadata",
        "createdAt",
        "updatedAt"
      from "MadUser"
      where "workspaceId" = $1
         or ("isMaster" = true and lower("email") = $2)
      order by "isMaster" desc, "createdAt" asc
    `,
    [workspace.id, MASTER_ADMIN_EMAIL],
  );

  return {
    workspace,
    items: rows.map(serializeUser),
  };
}

async function createInvitedUser({ workspaceId, name, email, role, invitedBy }) {
  const workspace = await getWorkspaceById(workspaceId);
  const normalizedEmail = normalizeEmail(email);
  const normalizedName = sanitizeText(name);
  const normalizedRole = normalizeRole(role);

  if (!normalizedName || !normalizedEmail) {
    const error = new Error("Informe nome e email para o convite.");
    error.status = 400;
    throw error;
  }

  const existing = await findUserByEmail(normalizedEmail);
  if (existing) {
    const error = new Error("Ja existe usuario com este email.");
    error.status = 409;
    throw error;
  }

  const inviteToken = createInviteToken();
  const inviteExpiresAt = inviteExpiryDate();
  const passwordHash = await bcrypt.hash(createTemporaryPassword(), 10);
  const metadata = {
    inviteTokenHash: hashToken(inviteToken),
    inviteSentAt: new Date().toISOString(),
    inviteExpiresAt: inviteExpiresAt.toISOString(),
    inviteAcceptedAt: null,
    invitedBy: sanitizeText(invitedBy),
    invitedWorkspaceId: workspace.id,
    invitedWorkspaceSlug: sanitizeText(workspace.slug),
    invitedWorkspaceName: sanitizeText(workspace.sellerName || workspace.slug || workspace.id),
  };

  const created = await queryOne(
    `
      insert into "MadUser" (
        "id",
        "workspaceId",
        "name",
        "email",
        "passwordHash",
        "userGlobalId",
        "role",
        "status",
        "isMaster",
        "metadata",
        "createdAt",
        "updatedAt"
      )
      values (
        $1, $2, $3, $4, $5, $6, $7::"MadUserRole", 'invited', false, $8::jsonb, now(), now()
      )
      returning
        "id",
        "workspaceId",
        "name",
        "email",
        "role"::text as "role",
        "status"::text as "status",
        "isMaster",
        "lastLoginAt",
        "metadata",
        "createdAt",
        "updatedAt"
      `,
      [
        `madusr_${randomUUID()}`,
        workspace.id,
        normalizedName,
        normalizedEmail,
        passwordHash,
        randomUUID(),
        normalizedRole,
        JSON.stringify(metadata),
      ],
  );

  return {
    workspace,
    user: serializeUser(created),
    inviteToken,
    inviteExpiresAt,
  };
}

async function resendUserInvite({ workspaceId, userId, invitedBy }) {
  const workspace = await getWorkspaceById(workspaceId);
  const existing = await queryOne(
    `
      select
        "id",
        "workspaceId",
        "name",
        "email",
        "role"::text as "role",
        "status"::text as "status",
        "isMaster",
        "lastLoginAt",
        "metadata",
        "createdAt",
        "updatedAt"
      from "MadUser"
      where "id" = $1
        and "workspaceId" = $2
      limit 1
    `,
    [userId, workspace.id],
  );

  if (!existing) {
    const error = new Error("Usuario nao encontrado.");
    error.status = 404;
    throw error;
  }

  if (existing.status === "active") {
    const error = new Error("O usuario ja esta ativo. Nao e necessario reenviar convite.");
    error.status = 409;
    throw error;
  }

  const metadata = parseMetadata(existing.metadata);
  const inviteToken = createInviteToken();
  const inviteExpiresAt = inviteExpiryDate();
  const nextMetadata = {
    ...metadata,
    inviteTokenHash: hashToken(inviteToken),
    inviteSentAt: new Date().toISOString(),
    inviteExpiresAt: inviteExpiresAt.toISOString(),
    inviteAcceptedAt: null,
    invitedBy: sanitizeText(invitedBy) || metadata.invitedBy || null,
  };

  const updated = await queryOne(
    `
      update "MadUser"
      set
        "status" = 'invited',
        "metadata" = $3::jsonb,
        "updatedAt" = now()
      where "id" = $1
        and "workspaceId" = $2
      returning
        "id",
        "workspaceId",
        "name",
        "email",
        "role"::text as "role",
        "status"::text as "status",
        "isMaster",
        "lastLoginAt",
        "metadata",
        "createdAt",
        "updatedAt"
    `,
    [userId, workspace.id, JSON.stringify(nextMetadata)],
  );

  return {
    workspace,
    user: serializeUser(updated),
    inviteToken,
    inviteExpiresAt,
  };
}

async function updateWorkspaceUser({ workspaceId, userId, role, status }) {
  const workspace = await getWorkspaceById(workspaceId);
  const existing = await queryOne(
    `
      select
        "id",
        "workspaceId",
        "name",
        "email",
        "role"::text as "role",
        "status"::text as "status",
        "isMaster",
        "lastLoginAt",
        "metadata",
        "createdAt",
        "updatedAt"
      from "MadUser"
      where "id" = $1
        and "workspaceId" = $2
      limit 1
    `,
    [userId, workspace.id],
  );

  if (!existing) {
    const error = new Error("Usuario nao encontrado.");
    error.status = 404;
    throw error;
  }

  if (existing.isMaster || existing.role === "admin_master") {
    const error = new Error("O admin master nao pode ser alterado por esta tela.");
    error.status = 409;
    throw error;
  }

  const updated = await queryOne(
    `
      update "MadUser"
      set
        "role" = $3::"MadUserRole",
        "status" = $4::"MadUserStatus",
        "updatedAt" = now()
      where "id" = $1
        and "workspaceId" = $2
      returning
        "id",
        "workspaceId",
        "name",
        "email",
        "role"::text as "role",
        "status"::text as "status",
        "isMaster",
        "lastLoginAt",
        "metadata",
        "createdAt",
        "updatedAt"
    `,
    [userId, workspace.id, normalizeRole(role || existing.role), normalizeStatus(status || existing.status)],
  );

  return {
    workspace,
    user: serializeUser(updated),
  };
}

async function findInviteUserByToken(token) {
  const tokenHash = hashToken(token);
  const row = await queryOne(
    `
      select
        "id",
        "workspaceId",
        "name",
        "email",
        "passwordHash",
        "role"::text as "role",
        "status"::text as "status",
        "isMaster",
        "lastLoginAt",
        "metadata",
        "createdAt",
        "updatedAt"
      from "MadUser"
      where "status" = 'invited'
        and "metadata"->>'inviteTokenHash' = $1
      limit 1
    `,
    [tokenHash],
  );

  if (!row) return null;

  return {
    ...serializeUser(row),
    metadata: parseMetadata(row.metadata),
  };
}

async function activateInvitedUser({ token, password, name }) {
  const inviteUser = await findInviteUserByToken(token);
  if (!inviteUser) {
    const error = new Error("Convite invalido.");
    error.status = 404;
    throw error;
  }

  const inviteExpiresAt = inviteUser.metadata?.inviteExpiresAt;
  if (!inviteExpiresAt || new Date(inviteExpiresAt).getTime() < Date.now()) {
    const error = new Error("Convite expirado.");
    error.status = 410;
    throw error;
  }

  const passwordHash = await bcrypt.hash(String(password || ""), 10);
  const nextMetadata = {
    ...inviteUser.metadata,
    inviteTokenHash: null,
    inviteAcceptedAt: new Date().toISOString(),
  };

  const updated = await queryOne(
    `
      update "MadUser"
      set
        "name" = $2,
        "passwordHash" = $3,
        "status" = 'active',
        "metadata" = $4::jsonb,
        "updatedAt" = now()
      where "id" = $1
      returning
        "id",
        "workspaceId",
        "name",
        "email",
        "role"::text as "role",
        "status"::text as "status",
        "isMaster",
        "lastLoginAt",
        "metadata",
        "createdAt",
        "updatedAt"
    `,
    [
      inviteUser.id,
      sanitizeText(name) || inviteUser.name,
      passwordHash,
      JSON.stringify(nextMetadata),
    ],
  );

  return serializeUser(updated);
}

module.exports = {
  MASTER_ADMIN_EMAIL,
  assertAdminAccess,
  activateInvitedUser,
  createInvitedUser,
  findInviteUserByToken,
  findUserByEmail,
  inviteExpiryDate,
  listWorkspaceUsers,
  resendUserInvite,
  updateWorkspaceUser,
};
