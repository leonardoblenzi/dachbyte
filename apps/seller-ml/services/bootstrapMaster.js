"use strict";

const bcrypt = require("bcryptjs");
const db = require("../db/db");

function normEmail(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

function normName(s) {
  const v = String(s || "").trim();
  return v || "Master";
}

function normNivel(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

// ✅ usa SEMPRE o schema ML se você ativar search_path (explico na parte B)
// e não depende de quotes estranhos.
async function ensureMasterUser() {
  const enabled =
    String(process.env.ML_BOOTSTRAP_MASTER ?? "true").toLowerCase() === "true";

  if (!enabled) {
    console.log(
      "⚠️ [ML] Bootstrap MASTER desativado (ML_BOOTSTRAP_MASTER=false).",
    );
    return { ok: false, skipped: true };
  }

  const email = normEmail(process.env.ML_BOOTSTRAP_MASTER_EMAIL);
  const senha = String(process.env.ML_BOOTSTRAP_MASTER_PASSWORD || "");
  const nome = normName(process.env.ML_BOOTSTRAP_MASTER_NAME);

  if (!email || !senha) {
    console.log(
      "⚠️ [ML] Bootstrap MASTER: faltou ML_BOOTSTRAP_MASTER_EMAIL ou ML_BOOTSTRAP_MASTER_PASSWORD.",
    );
    return { ok: false, skipped: true };
  }

  // Se quiser forçar senha mínima
  if (senha.length < 8) {
    console.log("⚠️ [ML] Bootstrap MASTER: senha muito curta (min 8).");
    return { ok: false, skipped: true };
  }

  // ✅ Idempotente: se já existir, não recria
  const { rows } = await db.query(
    `select id, email, nivel
       from usuarios
      where email = $1
      limit 1`,
    [email],
  );

  if (rows[0]) {
    const nivel = normNivel(rows[0].nivel);
    if (nivel !== "admin_master") {
      await db.query(
        `update usuarios set nivel = 'admin_master' where id = $1`,
        [rows[0].id],
      );
      console.log(
        `✅ [ML] Bootstrap MASTER: usuário promovido pra admin_master (${email}).`,
      );
    } else {
      console.log(`✅ [ML] Bootstrap MASTER: já existe (${email}).`);
    }
    return { ok: true, existed: true };
  }

  // ✅ cria do zero
  const senha_hash = await bcrypt.hash(senha, 10);

  const created = await db.query(
    `insert into usuarios (nome, email, senha_hash, nivel)
     values ($1, $2, $3, 'admin_master')
     returning id, email, nivel`,
    [nome, email, senha_hash],
  );

  console.log(
    `✅ [ML] Bootstrap MASTER: criado (${created.rows[0].email}) nivel=${created.rows[0].nivel}`,
  );

  return { ok: true, created: true };
}

module.exports = { ensureMasterUser };
