"use strict";

const db = require("../../db/db");

const RETENTION_DAYS = 30;
const DELETE_BATCH_SIZE = 500;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
let started = false;
let running = false;
let timer = null;

function cutoffDate(now = new Date()) {
  return new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

async function cleanupExpiredDrafts({ now = new Date() } = {}) {
  const cutoff = cutoffDate(now);
  return db.withClient(async (client) => {
    const lock = await client.query(`select pg_try_advisory_lock(hashtext($1)) as locked`, ["ml_anuncio_drafts_daily_cleanup"]);
    if (!lock.rows?.[0]?.locked) return { skipped: true, reason: "lock_not_acquired" };
    try {
      await client.query("BEGIN");
      try {
        const trash = await client.query(
          `with candidates as (
             select id from ml.anuncio_drafts
              where deleted_at is not null
                and deleted_at < $1
                and status <> 'publishing'
              order by deleted_at asc, id asc
              limit $2
              for update skip locked
           )
           delete from ml.anuncio_drafts d using candidates c
            where d.id=c.id`,
          [cutoff, DELETE_BATCH_SIZE],
        );
        const published = await client.query(
          `with candidates as (
             select id from ml.anuncio_drafts
              where published_at is not null
                and published_at < $1
                and status = 'published'
              order by published_at asc, id asc
              limit $2
              for update skip locked
           )
           delete from ml.anuncio_drafts d using candidates c
            where d.id=c.id`,
          [cutoff, DELETE_BATCH_SIZE],
        );
        const inactive = await client.query(
          `with candidates as (
             select id from ml.anuncio_drafts
              where published_item_id is null
                and deleted_at is null
                and updated_at < $1
                and status <> 'publishing'
              order by updated_at asc, id asc
              limit $2
              for update skip locked
           )
           delete from ml.anuncio_drafts d using candidates c
            where d.id=c.id`,
          [cutoff, DELETE_BATCH_SIZE],
        );
        const groups = await client.query(
          `with candidates as (
             select g.id from ml.anuncio_draft_groups g
              where not exists (
                select 1 from ml.anuncio_drafts d where d.draft_group_id=g.id
              )
              order by g.updated_at asc, g.id asc
              limit $1
              for update skip locked
           )
           delete from ml.anuncio_draft_groups g using candidates c
            where g.id=c.id`,
          [DELETE_BATCH_SIZE],
        );
        await client.query("COMMIT");
        return {
          skipped: false,
          cutoff: cutoff.toISOString(),
          inactive_drafts: inactive.rowCount || 0,
          trash: trash.rowCount || 0,
          published_history: published.rowCount || 0,
          empty_groups: groups.rowCount || 0,
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => null);
        throw error;
      }
    } finally {
      await client.query(`select pg_advisory_unlock(hashtext($1))`, ["ml_anuncio_drafts_daily_cleanup"]).catch(() => null);
    }
  });
}

async function checkDraftCleanup() {
  if (running) return;
  running = true;
  try {
    const result = await cleanupExpiredDrafts();
    if (!result?.skipped) {
      console.log("[Cadastro de anúncios] Limpeza diária:", {
        inactive_drafts: result.inactive_drafts,
        trash: result.trash,
        published_history: result.published_history,
        empty_groups: result.empty_groups,
      });
    }
  } catch (error) {
    console.error("[Cadastro de anúncios] Falha na limpeza diária:", error?.message || error);
  } finally {
    running = false;
  }
}

function startAnuncioDraftCleanupScheduler() {
  if (started) return;
  if (String(process.env.ML_ANUNCIO_DRAFT_CLEANUP_SCHEDULER || "1") === "0") {
    console.log("[Cadastro de anúncios] Scheduler de limpeza desativado por env.");
    return;
  }
  started = true;
  timer = setInterval(checkDraftCleanup, CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();
  const kickoff = setTimeout(checkDraftCleanup, 120 * 1000);
  if (kickoff.unref) kickoff.unref();
  console.log("[Cadastro de anúncios] Scheduler de limpeza diária ativo.");
}

module.exports = {
  RETENTION_DAYS,
  DELETE_BATCH_SIZE,
  cutoffDate,
  cleanupExpiredDrafts,
  checkDraftCleanup,
  startAnuncioDraftCleanupScheduler,
};
