"use strict";

const db = require("../config/postgres");

const SNAPSHOT_LIMITS = [30, 50, 100];
const DEFAULT_SNAPSHOT_LIMIT = 30;

// O deploy da Magalu nao roda migrations; as tabelas da 020 tambem sao
// garantidas aqui (mesmo padrao da 019).
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = db.query(`
      create schema if not exists magalu;
      create table if not exists magalu.ranking_settings (
        account_id bigint primary key references magalu.accounts(id) on delete cascade,
        persist_enabled boolean not null default false,
        snapshot_limit integer not null default 30 check (snapshot_limit in (30, 50, 100)),
        updated_by_user_id text,
        updated_at timestamptz not null default now()
      );
      create table if not exists magalu.ranking_snapshots (
        id bigserial primary key,
        account_id bigint not null references magalu.accounts(id) on delete cascade,
        period_start date not null,
        period_end date not null,
        ranking_type text not null check (ranking_type in ('faturamento', 'quantidade')),
        snapshot_limit integer not null,
        total_revenue numeric(18,2) not null default 0,
        total_units numeric(18,4) not null default 0,
        products_sold integer not null default 0,
        generated_at timestamptz not null default now(),
        constraint uq_magalu_ranking_snapshot unique (account_id, period_start, period_end, ranking_type)
      );
      create table if not exists magalu.ranking_snapshot_items (
        snapshot_id bigint not null references magalu.ranking_snapshots(id) on delete cascade,
        position integer not null,
        sku text not null,
        title text,
        brand text,
        image_url text,
        marketplace_url text,
        fulfillment boolean not null default false,
        units numeric(18,4) not null default 0,
        revenue numeric(18,2) not null default 0,
        orders integer not null default 0,
        primary key (snapshot_id, position)
      );
      create index if not exists idx_magalu_ranking_snapshots_account
        on magalu.ranking_snapshots (account_id, period_start desc);
    `).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

function normalizeLimit(value) {
  const n = Number(value);
  return SNAPSHOT_LIMITS.includes(n) ? n : DEFAULT_SNAPSHOT_LIMIT;
}

async function getSettings(accountId) {
  await ensureSchema();
  const row = await db.queryOne(`select account_id, persist_enabled, snapshot_limit, updated_by_user_id, updated_at
    from magalu.ranking_settings where account_id = $1`, [Number(accountId)]);
  return {
    persist_enabled: row?.persist_enabled === true,
    snapshot_limit: normalizeLimit(row?.snapshot_limit),
    updated_at: row?.updated_at || null,
  };
}

async function saveSettings(accountId, { persistEnabled, snapshotLimit, userId = null }) {
  await ensureSchema();
  const row = await db.queryOne(`insert into magalu.ranking_settings (account_id, persist_enabled, snapshot_limit, updated_by_user_id, updated_at)
      values ($1, $2, $3, $4, now())
    on conflict (account_id) do update set persist_enabled = excluded.persist_enabled, snapshot_limit = excluded.snapshot_limit,
      updated_by_user_id = excluded.updated_by_user_id, updated_at = now()
    returning persist_enabled, snapshot_limit, updated_at`, [Number(accountId), persistEnabled === true, normalizeLimit(snapshotLimit), userId]);
  return { persist_enabled: row.persist_enabled === true, snapshot_limit: normalizeLimit(row.snapshot_limit), updated_at: row.updated_at };
}

async function listPersistAccounts() {
  await ensureSchema();
  const { rows } = await db.query(`select s.account_id, s.snapshot_limit from magalu.ranking_settings s
      join magalu.accounts a on a.id = s.account_id
     where s.persist_enabled = true and a.status = 'active' order by s.account_id`);
  return rows.map((row) => ({ accountId: Number(row.account_id), snapshotLimit: normalizeLimit(row.snapshot_limit) }));
}

// Meses ja guardados (com o menor limite entre os dois tipos de ranking).
async function listSnapshotMonths(accountId) {
  await ensureSchema();
  const { rows } = await db.query(`select to_char(period_start, 'YYYY-MM-DD') as period_start, to_char(period_end, 'YYYY-MM-DD') as period_end,
      min(snapshot_limit)::int as snapshot_limit, count(*)::int as types, max(generated_at) as generated_at
    from magalu.ranking_snapshots where account_id = $1
    group by period_start, period_end order by period_start desc limit 24`, [Number(accountId)]);
  return rows;
}

async function findSnapshot(accountId, range, rankingType, minLimit) {
  await ensureSchema();
  const header = await db.queryOne(`select id, snapshot_limit, total_revenue, total_units, products_sold, generated_at
      from magalu.ranking_snapshots
     where account_id = $1 and period_start = $2::date and period_end = $3::date and ranking_type = $4 and snapshot_limit >= $5
     order by snapshot_limit asc limit 1`, [Number(accountId), range.from, range.to, rankingType, Number(minLimit) || 0]);
  if (!header) return null;
  const { rows } = await db.query(`select position, sku, title, brand, image_url, marketplace_url, fulfillment, units, revenue, orders
      from magalu.ranking_snapshot_items where snapshot_id = $1 order by position asc`, [header.id]);
  return { snapshot: header, rows };
}

// Substitui a foto do mes (mesma conta, periodo e tipo) de forma atomica.
async function saveSnapshot(accountId, range, rankingType, { snapshotLimit, totals, rows }) {
  await ensureSchema();
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      await client.query(`delete from magalu.ranking_snapshots where account_id = $1 and period_start = $2::date and period_end = $3::date and ranking_type = $4`,
        [Number(accountId), range.from, range.to, rankingType]);
      const { rows: inserted } = await client.query(`insert into magalu.ranking_snapshots
          (account_id, period_start, period_end, ranking_type, snapshot_limit, total_revenue, total_units, products_sold)
          values ($1, $2::date, $3::date, $4, $5, $6, $7, $8) returning id`,
        [Number(accountId), range.from, range.to, rankingType, normalizeLimit(snapshotLimit), Number(totals.revenue) || 0, Number(totals.units) || 0, Number(totals.products) || 0]);
      const snapshotId = inserted[0].id;
      if (rows.length) {
        const values = [];
        const params = [];
        rows.forEach((row, index) => {
          const base = params.length;
          params.push(snapshotId, row.position, row.sku, row.title || null, row.brand || null, row.image_url || null, row.marketplace_url || null, row.fulfillment === true, Number(row.units) || 0, Number(row.revenue) || 0, Number(row.orders) || 0);
          values.push(`(${Array.from({ length: 11 }, (_, i) => `$${base + i + 1}`).join(",")})`);
          if (index > 200) throw new Error("ranking_snapshot_too_many_rows");
        });
        await client.query(`insert into magalu.ranking_snapshot_items
            (snapshot_id, position, sku, title, brand, image_url, marketplace_url, fulfillment, units, revenue, orders)
            values ${values.join(",")}`, params);
      }
      await client.query("commit");
      return { snapshot_id: Number(snapshotId), rows: rows.length };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

// Evita duas execucoes simultaneas (web + worker) para a mesma conta.
async function withAccountLock(accountId, fn) {
  return db.withClient(async (client) => {
    const { rows } = await client.query("select pg_try_advisory_lock($1, $2) as locked", [41017, Number(accountId)]);
    if (!rows[0]?.locked) return { skipped: true, reason: "locked" };
    try {
      return await fn();
    } finally {
      await client.query("select pg_advisory_unlock($1, $2)", [41017, Number(accountId)]).catch(() => {});
    }
  });
}

module.exports = { SNAPSHOT_LIMITS, DEFAULT_SNAPSHOT_LIMIT, ensureSchema, normalizeLimit, getSettings, saveSettings, listPersistAccounts, listSnapshotMonths, findSnapshot, saveSnapshot, withAccountLock };
