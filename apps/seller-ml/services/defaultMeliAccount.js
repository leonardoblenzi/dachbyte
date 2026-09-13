"use strict";

const db = require("../db/db");

const COOKIE_MELI_CONTA = "meli_conta_id";

function normalizeNivel(n) {
  return String(n || "")
    .trim()
    .toLowerCase();
}

function isMasterUser(user) {
  return (
    normalizeNivel(user?.nivel) === "admin_master" ||
    normalizeNivel(user?.role) === "admin_master" ||
    user?.is_master === true ||
    user?.flags?.is_master === true
  );
}

function cookieOptions() {
  const isProd =
    String(process.env.NODE_ENV || "").toLowerCase() === "production";
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,
    maxAge: 30 * 24 * 3600 * 1000,
    path: "/",
  };
}

async function withClient(fn) {
  if (typeof db.withClient === "function") return db.withClient(fn);
  if (typeof db.connect === "function") {
    const client = await db.connect();
    try {
      return await fn(client);
    } finally {
      client.release?.();
    }
  }
  throw new Error("db.withClient/db.connect nao disponiveis");
}

async function ensureDefaultColumn(client) {
  await client.query(`
    alter table empresa_usuarios
      add column if not exists default_meli_conta_id bigint references meli_contas (id) on delete set null
  `);
}

async function getPrimaryEmpresaForUser(client, userId) {
  const { rows } = await client.query(
    `select eu.empresa_id, eu.default_meli_conta_id, eu.papel, e.nome as empresa_nome
       from empresa_usuarios eu
       join empresas e on e.id = eu.empresa_id
      where eu.usuario_id = $1
      order by case eu.papel when 'owner' then 1 when 'admin' then 2 else 3 end,
               eu.criado_em asc,
               eu.empresa_id asc
      limit 1`,
    [userId],
  );
  return rows[0] || null;
}

async function findAccountByIdForUser(client, userId, contaId) {
  const { rows } = await client.query(
    `select c.id, c.empresa_id, c.meli_user_id, c.apelido, c.site_id, c.status
       from empresa_usuarios eu
       join meli_contas c on c.empresa_id = eu.empresa_id
      where eu.usuario_id = $1
        and c.id = $2
        and lower(coalesce(c.status, '')) not in ('desvinculada','revogada','unlinked','revoked')
      limit 1`,
    [userId, contaId],
  );
  return rows[0] || null;
}

async function findFirstAccountForEmpresa(client, empresaId) {
  const { rows } = await client.query(
    `select id, empresa_id, meli_user_id, apelido, site_id, status
      from meli_contas
     where empresa_id = $1
       and lower(coalesce(status, '')) not in ('desvinculada','revogada','unlinked','revoked')
     order by criado_em asc, id asc
      limit 1`,
    [empresaId],
  );
  return rows[0] || null;
}

async function getDefaultAccountForUser(userId) {
  const uid = Number(userId);
  if (!Number.isFinite(uid)) return null;

  return withClient(async (client) => {
    await ensureDefaultColumn(client);

    const empresa = await getPrimaryEmpresaForUser(client, uid);
    if (!empresa) return null;

    const preferredId = Number(empresa.default_meli_conta_id);
    if (Number.isFinite(preferredId) && preferredId > 0) {
      const preferred = await findAccountByIdForUser(client, uid, preferredId);
      if (preferred) return preferred;

      await client.query(
        `update empresa_usuarios
            set default_meli_conta_id = null
          where usuario_id = $1 and empresa_id = $2`,
        [uid, empresa.empresa_id],
      );
    }

    const first = await findFirstAccountForEmpresa(client, empresa.empresa_id);
    if (!first) return null;

    await client.query(
      `update empresa_usuarios
          set default_meli_conta_id = $3
        where usuario_id = $1 and empresa_id = $2`,
      [uid, empresa.empresa_id, first.id],
    );

    return first;
  });
}

async function setDefaultAccountForUser(userId, contaId) {
  const uid = Number(userId);
  const id = Number(contaId);
  if (!Number.isFinite(uid) || !Number.isFinite(id) || id <= 0) return null;

  return withClient(async (client) => {
    await ensureDefaultColumn(client);

    const account = await findAccountByIdForUser(client, uid, id);
    if (!account) return null;

    await client.query(
      `update empresa_usuarios
          set default_meli_conta_id = $3
        where usuario_id = $1 and empresa_id = $2`,
      [uid, account.empresa_id, account.id],
    );

    return account;
  });
}

async function setDefaultIfMissingForMembership(userId, empresaId, contaId) {
  const uid = Number(userId);
  const emp = Number(empresaId);
  const id = Number(contaId);
  if (!Number.isFinite(uid) || !Number.isFinite(emp) || !Number.isFinite(id)) {
    return null;
  }

  return withClient(async (client) => {
    await ensureDefaultColumn(client);
    const { rows } = await client.query(
      `update empresa_usuarios
          set default_meli_conta_id = $3
        where usuario_id = $1
          and empresa_id = $2
          and default_meli_conta_id is null
      returning default_meli_conta_id`,
      [uid, emp, id],
    );
    return rows[0] || null;
  });
}

function applySelectedAccountCookie(res, contaId) {
  if (!res || !contaId) return;
  res.clearCookie(COOKIE_MELI_CONTA, { path: "/ml" });
  res.clearCookie(COOKIE_MELI_CONTA, { path: "/" });
  res.cookie(COOKIE_MELI_CONTA, String(contaId), cookieOptions());
}

module.exports = {
  COOKIE_MELI_CONTA,
  applySelectedAccountCookie,
  cookieOptions,
  getDefaultAccountForUser,
  isMasterUser,
  setDefaultAccountForUser,
  setDefaultIfMissingForMembership,
};
