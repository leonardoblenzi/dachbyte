// ml/db/bootstrapMaster.js
"use strict";

/**
 * Bootstrap idempotente do usuário MASTER.
 *
 * ENV esperadas:
 * - ML_BOOTSTRAP_MASTER_ENABLED=1
 * - ML_BOOTSTRAP_MASTER_EMAIL=admin@...
 * - ML_BOOTSTRAP_MASTER_NOME=Admin Master (opcional)
 * - ML_BOOTSTRAP_MASTER_PASSWORD=... (ou)
 * - ML_BOOTSTRAP_MASTER_PASSWORD_HASH=... (preferível em produção)
 *
 * Observação:
 * - Este bootstrap assume que a tabela "usuarios" já existe (via migrations).
 * - Usa schema "ml" explicitamente (ml.usuarios).
 */

const { pool } = require("./db");

// tenta usar bcryptjs se existir (pra gerar hash quando não vier hash no ENV)
let bcrypt = null;
try {
  bcrypt = require("bcryptjs");
} catch (_) {
  // ok: se você passar ML_BOOTSTRAP_MASTER_PASSWORD_HASH, não precisa bcrypt no runtime do bootstrap
}

function envBool(v) {
  return (
    String(v || "").trim() === "1" || String(v || "").toLowerCase() === "true"
  );
}

async function tableExists(schema, table) {
  const r = await pool.query(
    `
    select 1
    from information_schema.tables
    where table_schema = $1
      and table_name = $2
    limit 1
  `,
    [schema, table],
  );
  return r.rowCount > 0;
}

async function ensureMasterUser() {
  const enabled = envBool(process.env.ML_BOOTSTRAP_MASTER_ENABLED);
  if (!enabled) {
    console.log(
      "ℹ️ [ML] Bootstrap MASTER desativado (ML_BOOTSTRAP_MASTER_ENABLED!=1).",
    );
    return { ok: true, skipped: true };
  }

  const email = String(process.env.ML_BOOTSTRAP_MASTER_EMAIL || "")
    .trim()
    .toLowerCase();
  const nome = String(
    process.env.ML_BOOTSTRAP_MASTER_NOME || "Admin Master",
  ).trim();

  const password = process.env.ML_BOOTSTRAP_MASTER_PASSWORD;
  const passwordHashFromEnv = process.env.ML_BOOTSTRAP_MASTER_PASSWORD_HASH;

  if (!email) {
    throw new Error("[ML] ML_BOOTSTRAP_MASTER_EMAIL não definido.");
  }

  // garante que a tabela existe (no schema ml)
  const hasUsuarios = await tableExists("ml", "usuarios");
  if (!hasUsuarios) {
    console.log(
      "⚠️ [ML] Tabela ml.usuarios ainda não existe. Rode as migrations antes do bootstrap.",
    );
    return { ok: false, reason: "missing_table" };
  }

  let senha_hash = passwordHashFromEnv;

  if (!senha_hash) {
    if (!password) {
      throw new Error(
        "[ML] Defina ML_BOOTSTRAP_MASTER_PASSWORD ou (preferível) ML_BOOTSTRAP_MASTER_PASSWORD_HASH.",
      );
    }
    if (!bcrypt) {
      throw new Error(
        "[ML] bcryptjs não está disponível. Instale bcryptjs OU use ML_BOOTSTRAP_MASTER_PASSWORD_HASH.",
      );
    }
    // custo 12 é um bom equilíbrio
    senha_hash = await bcrypt.hash(password, 12);
  }

  // Se já existe algum admin_master? (opcional: se quiser só criar quando não existe nenhum master)
  // Aqui a gente garante o email do master SEMPRE.
  const upsert = await pool.query(
    `
    insert into ml.usuarios (nome, email, senha_hash, nivel)
    values ($1, $2, $3, 'admin_master')
    on conflict (email) do update
    set
      nome = excluded.nome,
      senha_hash = excluded.senha_hash,
      nivel = 'admin_master'
    returning id, email, nivel
  `,
    [nome, email, senha_hash],
  );

  const u = upsert.rows[0];
  console.log(
    `✅ [ML] MASTER garantido: ${u.email} (nivel=${u.nivel}, id=${u.id})`,
  );

  return { ok: true, user: u };
}

module.exports = { ensureMasterUser };
