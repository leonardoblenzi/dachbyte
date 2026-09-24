"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const { loadRuntimeEnv } = require("../../../lib/runtimeEnv");

loadRuntimeEnv({
  defaultCandidates: [
    path.resolve(__dirname, "..", ".env"),
    path.resolve(__dirname, "..", "..", ".env"),
  ],
});

function databaseUrl() {
  return String(process.env.MAGALU_DATABASE_URL || process.env.DATABASE_URL || "").trim();
}

function sslConfig(url) {
  if (/sslmode=(require|prefer|verify-ca|verify-full)/i.test(url) || /\.neon\.(tech|build)/i.test(url)) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

function checksum(content) {
  return crypto.createHash("sha256").update(String(content).replace(/\r\n/g, "\n")).digest("hex");
}

async function main() {
  const command = String(process.argv[2] || "deploy").trim().toLowerCase();
  if (!["deploy", "status"].includes(command)) throw new Error(`Comando inválido: ${command}`);
  const url = databaseUrl();
  if (!url) throw new Error("MAGALU_DATABASE_URL/DATABASE_URL não configurada.");

  const client = new Client({ connectionString: url, ssl: sslConfig(url) });
  await client.connect();
  try {
    await client.query("create schema if not exists magalu");
    await client.query(`
      create table if not exists magalu.migrations (
        filename text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);

    const dir = path.join(__dirname, "migrations");
    const files = fs.readdirSync(dir).filter((file) => /^\d+_.+\.sql$/i.test(file)).sort();
    const applied = new Map((await client.query("select filename, checksum from magalu.migrations")).rows.map((row) => [row.filename, row.checksum]));

    if (command === "status") {
      console.log(JSON.stringify({
        applied: files.filter((file) => applied.has(file)),
        pending: files.filter((file) => !applied.has(file)),
      }, null, 2));
      return;
    }

    for (const file of files) {
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      const hash = checksum(sql);
      if (applied.has(file)) {
        if (applied.get(file) !== hash) throw new Error(`Checksum divergente em migration aplicada: ${file}`);
        continue;
      }
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into magalu.migrations(filename, checksum) values ($1, $2)", [file, hash]);
        await client.query("commit");
        console.log(`[seller-magalu:migrate] applied ${file}`);
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("[seller-magalu:migrate] failed", error);
  process.exit(1);
});
