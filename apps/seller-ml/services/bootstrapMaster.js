"use strict";

const bcrypt = require("bcryptjs");
const db = require("../db/db");

function normEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normName(value) {
  const clean = String(value || "").trim();
  return clean || "Master";
}

function normNivel(value) {
  return String(value || "").trim().toLowerCase();
}

function envEnabled(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "").trim().toLowerCase(),
  );
}

async function ensureMasterUser(options = {}) {
  const enabled =
    options.enabled === true ||
    (options.enabled !== false && envEnabled(process.env.ML_BOOTSTRAP_MASTER));

  if (!enabled) {
    console.log("[ML] Bootstrap MASTER desativado por padrao.");
    return { ok: true, skipped: true, reason: "disabled" };
  }

  const allowPromote =
    options.allowPromote === true ||
    envEnabled(process.env.ML_BOOTSTRAP_MASTER_ALLOW_PROMOTE);
  const email = normEmail(process.env.ML_BOOTSTRAP_MASTER_EMAIL);
  const senha = String(process.env.ML_BOOTSTRAP_MASTER_PASSWORD || "");
  const nome = normName(process.env.ML_BOOTSTRAP_MASTER_NAME);

  if (!email || !senha) {
    const error = new Error(
      "ML_BOOTSTRAP_MASTER_EMAIL e ML_BOOTSTRAP_MASTER_PASSWORD sao obrigatorios para o bootstrap explicito.",
    );
    error.code = "MASTER_BOOTSTRAP_CONFIG_MISSING";
    throw error;
  }

  if (senha.length < 10) {
    const error = new Error("Senha do MASTER deve ter no minimo 10 caracteres.");
    error.code = "MASTER_PASSWORD_TOO_SHORT";
    throw error;
  }

  const { rows } = await db.query(
    `select id, email, nivel
       from usuarios
      where email = $1
      limit 1`,
    [email],
  );

  if (rows[0]) {
    const nivel = normNivel(rows[0].nivel);
    if (nivel === "admin_master") {
      console.log(`[ML] Bootstrap MASTER: ja existe (${email}).`);
      return { ok: true, existed: true };
    }

    if (!allowPromote) {
      const error = new Error(
        `O email ${email} ja pertence a um usuario ${nivel || "sem nivel"}. Promocao automatica bloqueada.`,
      );
      error.code = "MASTER_PROMOTION_REQUIRES_EXPLICIT_OPT_IN";
      throw error;
    }

    await db.query(`update usuarios set nivel = 'admin_master' where id = $1`, [
      rows[0].id,
    ]);
    console.warn(`[ML] Bootstrap MASTER: promocao explicita aplicada (${email}).`);
    return { ok: true, existed: true, promoted: true };
  }

  const senha_hash = await bcrypt.hash(senha, 12);
  const created = await db.query(
    `insert into usuarios (nome, email, senha_hash, nivel)
     values ($1, $2, $3, 'admin_master')
     returning id, email, nivel`,
    [nome, email, senha_hash],
  );

  console.log(`[ML] Bootstrap MASTER: criado (${created.rows[0].email}).`);
  return { ok: true, created: true };
}

module.exports = { ensureMasterUser };
