"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const db = require("../db/db");
const { createAuditAction } = require("../middleware/auditAction");

const router = express.Router();

/**
 * MASTER ONLY
 * Fonte da verdade: req.user.nivel === 'admin_master'
 * Observação: no seu index.js você já está aplicando ensureMasterOnly no /api/admin,
 * mas deixo esse gate aqui também (defesa em profundidade).
 */
function ensureMasterOnly(req, res, next) {
  const u = req.user || res.locals.user;
  const nivel = String(u?.nivel || "").trim().toLowerCase();
  if (nivel === "admin_master") return next();
  return res.status(403).json({ ok: false, error: "Acesso não autorizado." });
}

router.use(ensureMasterOnly);

// Helpers
function isSqlMigrationFile(name) {
  return /^\d+_.*\.sql$/i.test(name);
}

function getDbDir() {
  // routes/ -> ../db
  return path.join(__dirname, "..", "db");
}

function safeReadFileSql(fullPath, maxBytes = 250_000) {
  const st = fs.statSync(fullPath);
  if (st.size > maxBytes) {
    return { ok: false, error: `Arquivo muito grande (${st.size} bytes).` };
  }
  const content = fs.readFileSync(fullPath, "utf8");
  return { ok: true, content };
}

function getLegacyMigrationMeta(fileName) {
  const legacyRules = [
    {
      pattern: /anuncios_estrategicos/i,
      reason: "Historico de feature removida: Produtos Estrategicos.",
    },
  ];

  return legacyRules.find((rule) => rule.pattern.test(String(fileName || ""))) || null;
}

// GET /api/admin/migracoes/status
// Retorna:
// - files[]: arquivos .sql do diretório /db
// - applied[]: linhas da tabela migracoes
// - pending[]: arquivos ainda não aplicados
router.get("/migracoes/status", async (_req, res) => {
  try {
    const dir = getDbDir();

    let files = [];
    try {
      files = fs
        .readdirSync(dir)
        .filter(isSqlMigrationFile)
        .sort((a, b) => a.localeCompare(b, "en"));
    } catch (e) {
      console.error("Erro lendo dir db:", e);
      return res.status(500).json({
        ok: false,
        error: "Não foi possível ler o diretório de migrações (/db).",
      });
    }

    const { rows } = await db.query(
      `select id, arquivo, aplicado_em
         from migracoes
        order by id desc`
    );

    const appliedSet = new Set(rows.map((r) => String(r.arquivo)));

    const filesMapped = files.map((f) => {
      const legacy = getLegacyMigrationMeta(f);
      return {
        arquivo: f,
        applied: appliedSet.has(f),
        legacy: !!legacy,
        legacy_reason: legacy?.reason || null,
      };
    });

    const pending = filesMapped.filter((x) => !x.applied).map((x) => x.arquivo);

    const appliedMapped = rows.map((row) => {
      const legacy = getLegacyMigrationMeta(row.arquivo);
      return {
        ...row,
        legacy: !!legacy,
        legacy_reason: legacy?.reason || null,
      };
    });

    return res.json({
      ok: true,
      files: filesMapped,
      applied: appliedMapped,
      pending,
      totals: {
        files: files.length,
        applied: rows.length,
        pending: pending.length,
      },
    });
  } catch (err) {
    console.error("GET /api/admin/migracoes/status erro:", err);
    return res.status(500).json({ ok: false, error: "Erro ao ler migrações." });
  }
});

// GET /api/admin/migracoes/file?name=001_xxx.sql
// Retorna preview do SQL (para inspeção)
router.get("/migracoes/file", async (req, res) => {
  try {
    const name = String(req.query?.name || "").trim();
    if (!name || !isSqlMigrationFile(name)) {
      return res.status(400).json({ ok: false, error: "Arquivo inválido." });
    }

    const dir = getDbDir();
    const full = path.join(dir, name);

    if (!fs.existsSync(full)) {
      return res.status(404).json({ ok: false, error: "Arquivo não encontrado." });
    }

    const r = safeReadFileSql(full);
    if (!r.ok) return res.status(400).json({ ok: false, error: r.error });

    // Só preview — não executa
    return res.json({ ok: true, arquivo: name, sql: r.content });
  } catch (err) {
    console.error("GET /api/admin/migracoes/file erro:", err);
    return res.status(500).json({ ok: false, error: "Erro ao ler arquivo." });
  }
});

// POST /api/admin/migracoes/run
// Executa migrações pendentes (mesma lógica do migrate.js) usando db.withClient
router.post(
  "/migracoes/run",
  createAuditAction({
    evento: "admin_migrations_run",
    metadata: (req) => ({
      confirm: String(req.body?.confirm || "").trim().toLowerCase() || null,
    }),
  }),
  express.json({ limit: "50kb" }),
  async (req, res) => {
  try {
    // Segurança: exige confirmação simples
    const confirm = String(req.body?.confirm || "").trim().toLowerCase();
    if (confirm !== "rodar") {
      return res.status(400).json({
        ok: false,
        error: "Confirmação inválida. Envie { confirm: 'rodar' }.",
      });
    }

    const dir = getDbDir();
    const files = fs
      .readdirSync(dir)
      .filter(isSqlMigrationFile)
      .sort((a, b) => a.localeCompare(b, "en"));

    if (!files.length) {
      return res.json({ ok: true, applied_now: [], message: "Nenhuma migração encontrada." });
    }

    const appliedNow = [];

    await db.withClient(async (client) => {
      // garante tabela
      await client.query(`
        create table if not exists migracoes (
          id bigserial primary key,
          arquivo text not null unique,
          aplicado_em timestamptz not null default now()
        );
      `);

      // pega aplicadas
      const ap = await client.query(`select arquivo from migracoes`);
      const appliedSet = new Set(ap.rows.map((r) => String(r.arquivo)));

      for (const file of files) {
        if (appliedSet.has(file)) continue;

        const full = path.join(dir, file);
        const r = safeReadFileSql(full);
        if (!r.ok) {
          throw new Error(`Falha ao ler ${file}: ${r.error}`);
        }

        await client.query("begin");
        try {
          await client.query(r.content);
          await client.query(
            `insert into migracoes (arquivo) values ($1) on conflict do nothing`,
            [file]
          );
          await client.query("commit");
          appliedNow.push(file);
          appliedSet.add(file);
        } catch (e) {
          await client.query("rollback");
          throw new Error(`Falha ao aplicar ${file}: ${e.message}`);
        }
      }
    });

    return res.json({
      ok: true,
      applied_now: appliedNow,
      message: appliedNow.length
        ? `Aplicadas ${appliedNow.length} migração(ões).`
        : "Nenhuma migração pendente.",
    });
  } catch (err) {
    console.error("POST /api/admin/migracoes/run erro:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message || "Erro ao rodar migrações.",
    });
  }
  },
);

module.exports = router;
