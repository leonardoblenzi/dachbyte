"use strict";

const express = require("express");
const db = require("../db/db");
const { createAuditAction } = require("../middleware/auditAction");

const router = express.Router();

function ensureMasterOnly(req, res, next) {
  const u = req.user || res.locals.user;
  const nivel = String(u?.nivel || "").trim().toLowerCase();
  if (nivel === "admin_master" || u?.is_master === true) return next();
  return res.status(403).json({ ok: false, error: "Acesso nao autorizado." });
}

router.use(ensureMasterOnly);

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(
    d.getHours(),
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// =====================================================
// ✅ Schema alvo do app (default: ml)
// - Você pode sobrescrever via ENV: DB_SCHEMA=ml
// =====================================================
function getSchema() {
  const s = String(process.env.DB_SCHEMA || "ml").trim();
  // valida identificador SQL simples
  if (!/^[a-z_][a-z0-9_]*$/i.test(s)) {
    throw new Error(
      `DB_SCHEMA inválido: "${s}". Use algo tipo "ml" ou "public".`,
    );
  }
  return s;
}

function qIdent(x) {
  // quote simples para schema/table (apenas identificador)
  return `"${String(x).replace(/"/g, '""')}"`;
}

const ALLOWED_TABLES = [
  "empresas",
  "usuarios",
  "empresa_usuarios",
  "meli_contas",
  "meli_tokens",
  "oauth_states",
  "migracoes",
  // se você quiser incluir outras tabelas no backup:
  // "anuncios_full",
];

// ordem boa pra inserir respeitando FK
const INSERT_ORDER = [
  "empresas",
  "usuarios",
  "empresa_usuarios",
  "meli_contas",
  "meli_tokens",
  "oauth_states",
  "migracoes",
];

// ======================================================================
// Helpers
// ======================================================================
async function getTableColumns(client, schemaName, tableName) {
  const r = await client.query(
    `
    select column_name
      from information_schema.columns
     where table_schema = $1
       and table_name = $2
     order by ordinal_position
    `,
    [schemaName, tableName],
  );
  return new Set((r.rows || []).map((x) => x.column_name));
}

function pickColumns(availableColsSet, rowObj) {
  // pega só colunas que existem na tabela atual (evita quebrar por coluna antiga)
  const cols = Object.keys(rowObj || {}).filter((c) => availableColsSet.has(c));
  return cols;
}

async function bumpSerial(client, schemaName, table, idCol = "id") {
  const fullTable = `${schemaName}.${table}`;

  const seq = (
    await client.query(`select pg_get_serial_sequence($1, $2) as seq`, [
      fullTable,
      idCol,
    ])
  ).rows?.[0]?.seq;

  if (!seq) return; // tabela pode não ter serial

  // setval(seq, max(id), true) -> próximo nextval = max+1
  await client.query(
    `
    select setval($1,
      coalesce((select max(${qIdent(idCol)}) from ${qIdent(schemaName)}.${qIdent(
        table,
      )}), 0),
      true
    )
    `,
    [seq],
  );
}

function qualify(schemaName, tableName) {
  return `${qIdent(schemaName)}.${qIdent(tableName)}`;
}

// ======================================================================
// GET /api/admin/backup/export.json
// Exporta backup JSON por tabelas (com order by id asc quando existir)
// ======================================================================
router.get(
  "/backup/export.json",
  createAuditAction({
    evento: "admin_backup_exported",
  }),
  async (_req, res) => {
  try {
    const schemaName = getSchema();
    const tables = [...ALLOWED_TABLES];

    const payload = await db.withClient(async (client) => {
      // garante que consultas "sem schema" caiam no schema do app
      await client.query(
        `set local search_path = ${qIdent(schemaName)}, public`,
      );

      const tableCols = {};
      for (const t of tables) {
        tableCols[t] = await getTableColumns(client, schemaName, t);
      }

      const pack = {};
      for (const t of tables) {
        const hasId = tableCols[t].has("id");
        const sql = hasId
          ? `select * from ${qualify(schemaName, t)} order by id asc`
          : `select * from ${qualify(schemaName, t)}`;
        const r = await client.query(sql);
        pack[t] = r.rows || [];
      }

      return {
        ok: true,
        format: "davantti_backup_json_v1",
        created_at: new Date().toISOString(),
        tables,
        schema: schemaName,
        data: pack,
      };
    });

    const filename = `davantti_db_backup_${nowStamp()}.json`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error("GET /api/admin/backup/export.json erro:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Erro ao exportar backup." });
  }
  },
);

// ======================================================================
// POST /api/admin/backup/import.json
// body: { backup: {...} }
// Restaura (wipe & restore) - MASTER ONLY (via gate do index.js)
// Retorna resumo: { inserted: {tabela: n}, total_inserted, truncated: [...] }
// ======================================================================
router.post(
  "/backup/import.json",
  createAuditAction({
    evento: "admin_backup_imported",
    metadata: (req) => ({
      backup_format: req.body?.backup?.format || null,
      backup_tables: Array.isArray(req.body?.backup?.tables)
        ? req.body.backup.tables
        : [],
    }),
  }),
  express.json({ limit: "50mb" }),
  async (req, res) => {
    try {
      const schemaName = getSchema();
      const backup = req.body?.backup;

      if (!backup || backup.format !== "davantti_backup_json_v1") {
        return res
          .status(400)
          .json({ ok: false, error: "Backup inválido (formato)." });
      }

      const data = backup.data || {};
      const tables = Array.isArray(backup.tables) ? backup.tables : [];

      // travinha: só aceitamos as tabelas conhecidas
      const allowedSet = new Set(ALLOWED_TABLES);
      for (const t of tables) {
        if (!allowedSet.has(t)) {
          return res.status(400).json({
            ok: false,
            error: `Tabela não permitida no restore: ${t}`,
          });
        }
      }

      // Se o backup veio sem tables, assume allowed
      const usedTables = tables.length > 0 ? tables : [...ALLOWED_TABLES];

      const summary = await db.withClient(async (client) => {
        await client.query("begin");
        try {
          // ✅ Importante: garante que queries sem schema apontem para ml
          await client.query(
            `set local search_path = ${qIdent(schemaName)}, public`,
          );

          const inserted = {};
          for (const t of ALLOWED_TABLES) inserted[t] = 0;

          // 1) Limpa tudo (CASCADE + restart identity)
          // usa tabelas qualificadas no schema alvo
          const truncateList = ALLOWED_TABLES.map((t) =>
            qualify(schemaName, t),
          ).join(", ");

          await client.query(
            `truncate ${truncateList} restart identity cascade`,
          );

          // 2) Pré-carrega colunas (para ignorar colunas antigas do backup)
          const tableCols = {};
          for (const t of ALLOWED_TABLES) {
            tableCols[t] = await getTableColumns(client, schemaName, t);
          }

          // 3) Insere na ordem correta
          const chunkSize = 500;

          for (const t of INSERT_ORDER) {
            if (!usedTables.includes(t)) continue;

            const rows = Array.isArray(data[t]) ? data[t] : [];
            if (!rows.length) continue;

            const cols = pickColumns(tableCols[t], rows[0]);
            if (!cols.length) continue;

            const colSql = cols.map((c) => qIdent(c)).join(", ");
            const tableSql = qualify(schemaName, t);

            for (let i = 0; i < rows.length; i += chunkSize) {
              const chunk = rows.slice(i, i + chunkSize);

              const values = [];
              const params = [];
              let p = 1;

              for (const row of chunk) {
                const tuple = [];
                for (const c of cols) {
                  tuple.push(`$${p++}`);
                  params.push(row[c]);
                }
                values.push(`(${tuple.join(", ")})`);
              }

              await client.query(
                `insert into ${tableSql} (${colSql}) values ${values.join(", ")}`,
                params,
              );

              inserted[t] += chunk.length;
            }
          }

          // 4) Ajusta sequences (apenas onde faz sentido)
          await bumpSerial(client, schemaName, "empresas", "id");
          await bumpSerial(client, schemaName, "usuarios", "id");
          await bumpSerial(client, schemaName, "meli_contas", "id");
          await bumpSerial(client, schemaName, "migracoes", "id");

          await client.query("commit");

          const totalInserted = Object.values(inserted).reduce(
            (a, b) => a + b,
            0,
          );

          return {
            inserted,
            total_inserted: totalInserted,
            truncated: [...ALLOWED_TABLES],
            schema: schemaName,
          };
        } catch (e) {
          try {
            await client.query("rollback");
          } catch {}
          throw e;
        }
      });

      return res.json({ ok: true, ...summary });
    } catch (err) {
      console.error("POST /api/admin/backup/import.json erro:", err);
      return res.status(500).json({
        ok: false,
        error: `Erro ao importar backup. ${err?.message || ""}`.trim(),
      });
    }
  },
);

module.exports = router;

