"use strict";

const jwt = require("jsonwebtoken");
const { queryMl } = require("./db");

function parseCookies(headerValue) {
  const out = {};
  const raw = String(headerValue || "");
  if (!raw) return out;

  raw.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx <= 0) return;
    const key = part.slice(0, idx).trim();
    const value = decodeURIComponent(part.slice(idx + 1).trim());
    if (key) out[key] = value;
  });

  return out;
}

async function resolveSkuLeaderIdentity(cookies) {
  const token = String(cookies.skuleader_auth_token || "").trim();
  if (!token) return null;

  const secret =
    String(process.env.SKULEADER_JWT_SECRET || "").trim() ||
    String(process.env.JWT_SECRET || "").trim() ||
    String(process.env.ML_JWT_SECRET || "").trim();

  if (!secret) return null;

  let payload;
  try {
    payload = jwt.verify(token, secret);
  } catch {
    return null;
  }

  const tenantGlobalId = String(payload?.tenant_global_id || "").trim();
  const userGlobalId = String(payload?.user_global_id || "").trim();
  if (tenantGlobalId && userGlobalId) {
    return {
      source: "hub",
      userId: null,
      userGlobalId,
      userName: payload?.nome || null,
      userEmail: payload?.email || null,
      tenantGlobalId,
      empresaId: payload?.empresa_id == null ? null : Number(payload.empresa_id),
      empresaNome: payload?.empresa_nome || null,
    };
  }

  const userId = Number(payload?.uid || payload?.id || payload?.user_id);
  if (!Number.isFinite(userId)) return null;

  const result = await queryMl(
    `select
       u.id as user_id,
       coalesce(nullif(u.nome, ''), u.email) as user_name,
       u.email as user_email,
       u.user_global_id,
       e.id as empresa_id,
       e.nome as empresa_nome,
       e.tenant_global_id
     from ml.usuarios u
     join ml.empresa_usuarios eu on eu.usuario_id = u.id
     join ml.empresas e on e.id = eu.empresa_id
     where u.id = $1
     order by case eu.papel when 'owner' then 1 when 'admin' then 2 else 3 end
     limit 1`,
    [userId],
  );

  const row = result.rows[0] || null;
  if (!row?.tenant_global_id) return null;

  return {
    source: "skuleader",
    userId: Number(row.user_id),
    userGlobalId: String(row.user_global_id || row.user_id),
    userName: row.user_name || null,
    userEmail: row.user_email || null,
    tenantGlobalId: String(row.tenant_global_id),
    empresaId: row.empresa_id == null ? null : Number(row.empresa_id),
    empresaNome: row.empresa_nome || null,
  };
}

async function resolveIdentity(req) {
  const cookies = parseCookies(req.headers?.cookie || "");

  try {
    const identity = await resolveSkuLeaderIdentity(cookies);
    if (identity) return identity;
  } catch {
    // noop
  }

  return null;
}

module.exports = {
  parseCookies,
  resolveIdentity,
};
