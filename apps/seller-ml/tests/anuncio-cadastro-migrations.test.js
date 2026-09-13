"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const dbDir = path.join(__dirname, "..", "db");

test("histórico de migrations do Cadastro usa 067 a 070 sem reintroduzir 058/059", () => {
  const files = new Set(fs.readdirSync(dbDir));
  assert.ok(files.has("067_create_anuncio_drafts.sql"));
  assert.ok(files.has("068_anuncio_drafts_publication_target.sql"));
  assert.ok(files.has("069_create_anuncio_draft_groups.sql"));
  assert.ok(files.has("070_harden_anuncio_draft_groups_scope.sql"));
  assert.equal(files.has("058_create_anuncio_drafts.sql"), false);
  assert.equal(files.has("059_anuncio_drafts_publication_target.sql"), false);
});

test("migration 070 vincula grupo, empresa e conta ML na mesma FK", () => {
  const sql = fs.readFileSync(path.join(dbDir, "070_harden_anuncio_draft_groups_scope.sql"), "utf8");
  assert.match(sql, /unique \(id, empresa_id, meli_conta_id\)/i);
  assert.match(sql, /foreign key \(draft_group_id, empresa_id, meli_conta_id\)/i);
  assert.match(sql, /references ml\.anuncio_draft_groups \(id, empresa_id, meli_conta_id\)/i);
});

test("migration 069 cria grupos e FK opcional em anuncio_drafts", () => {
  const sql = fs.readFileSync(path.join(dbDir, "069_create_anuncio_draft_groups.sql"), "utf8");
  assert.match(sql, /create table if not exists ml\.anuncio_draft_groups/i);
  assert.match(sql, /type in \('batch_copy', 'family_clone'\)/i);
  assert.match(sql, /add column if not exists draft_group_id bigint/i);
  assert.match(sql, /references ml\.anuncio_draft_groups\(id\)/i);
});
