"use strict";

const db = require("../config/postgres");

function n(value) {
  const parsed = Number.parseInt(String(value == null ? "" : value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function probeDatabase() {
  const started = Date.now();
  const row = await db.queryOne("select now() as server_time, current_database() as database_name");
  return {
    ok: true,
    latency_ms: Date.now() - started,
    server_time: row?.server_time || null,
    database_name: row?.database_name || null,
  };
}

async function summary() {
  const [accounts, tokens, webhooks, events, syncs] = await Promise.all([
    db.queryOne(`
      select count(*)::int total,
             count(*) filter (where status='active')::int active,
             count(*) filter (where status in ('error','disabled','revoked'))::int problem,
             count(*) filter (where hub_sync_status='failed')::int hub_failed,
             count(*) filter (where hub_sync_status in ('pending','queued','syncing'))::int hub_pending
        from magalu.accounts`),
    db.queryOne(`
      select count(*)::int total,
             count(*) filter (where access_expires_at is null)::int access_missing,
             count(*) filter (where access_expires_at is not null and access_expires_at <= now())::int access_expired,
             count(*) filter (where access_expires_at > now() and access_expires_at <= now()+interval '30 minutes')::int access_expiring,
             count(*) filter (where refresh_expires_at is not null and refresh_expires_at <= now())::int refresh_expired,
             count(*) filter (where last_refresh_error is not null and btrim(last_refresh_error)<>'')::int refresh_errors
        from magalu.tokens`),
    db.queryOne(`
      select count(*)::int total,
             count(*) filter (where status='active')::int active,
             count(*) filter (where status='error')::int error,
             count(*) filter (where status='pending')::int pending,
             count(*) filter (where status='disabled')::int disabled
        from magalu.webhook_subscriptions`),
    db.queryOne(`
      select count(*) filter (where received_at >= now()-interval '24 hours')::int events_24h,
             count(*) filter (where received_at >= now()-interval '24 hours' and processing_status='failed')::int failed_24h,
             max(received_at) as last_received_at,
             max(processed_at) as last_processed_at
        from magalu.webhook_events`),
    db.queryOne(`
      select count(*) filter (where started_at >= now()-interval '24 hours')::int runs_24h,
             count(*) filter (where started_at >= now()-interval '24 hours' and status='failed')::int failed_24h,
             max(started_at) as last_started_at,
             max(finished_at) as last_finished_at
        from magalu.sync_runs`),
  ]);
  return {
    accounts: accounts || {},
    tokens: tokens || {},
    webhooks: webhooks || {},
    webhook_events: events || {},
    syncs: syncs || {},
  };
}

async function listAccounts() {
  const { rows } = await db.query(`
    select a.id,a.dach_tenant_id,a.magalu_tenant_id,a.magalu_tenant_name,a.status,a.scopes,
           a.connected_at,a.last_oauth_at,a.catalog_sync_status,a.catalog_last_synced_at,a.catalog_last_error,
           a.hub_resource_key,a.hub_sync_status,a.hub_synced_at,a.hub_sync_error,a.updated_at,
           t.access_expires_at,t.refresh_expires_at,t.last_refresh_at,t.last_refresh_attempt_at,t.last_refresh_error,
           coalesce(wh.total,0)::int webhook_total,coalesce(wh.active,0)::int webhook_active,
           coalesce(wh.errors,0)::int webhook_errors,
           wh.last_synced_at as webhook_last_synced_at,
           ev.last_event_at,coalesce(ev.failed_24h,0)::int webhook_failed_24h,
           sr.last_sync_at,sr.last_sync_status
      from magalu.accounts a
      left join magalu.tokens t on t.account_id=a.id
      left join lateral (
        select count(*)::int total,
               count(*) filter(where status='active')::int active,
               count(*) filter(where status='error')::int errors,
               max(last_synced_at) last_synced_at
          from magalu.webhook_subscriptions w where w.account_id=a.id
      ) wh on true
      left join lateral (
        select max(received_at) last_event_at,
               count(*) filter(where received_at>=now()-interval '24 hours' and processing_status='failed')::int failed_24h
          from magalu.webhook_events e where e.account_id=a.id
      ) ev on true
      left join lateral (
        select started_at last_sync_at,status last_sync_status
          from magalu.sync_runs s where s.account_id=a.id order by started_at desc limit 1
      ) sr on true
     order by case when a.status='active' then 0 else 1 end,
              coalesce(a.magalu_tenant_name,a.magalu_tenant_id),a.id`);
  return rows;
}

async function accountSnapshot(accountId) {
  const id = n(accountId);
  if (!id) return null;
  const account = await db.queryOne(`
    select a.id,a.dach_tenant_id,a.dach_created_by_user_id,a.magalu_tenant_id,a.magalu_tenant_name,
           a.status,a.scopes,a.connected_at,a.last_oauth_at,a.catalog_sync_status,a.catalog_last_synced_at,
           a.catalog_last_error,a.hub_resource_key,a.hub_sync_status,a.hub_synced_at,a.hub_sync_error,
           a.created_at,a.updated_at,
           t.access_expires_at,t.refresh_expires_at,t.token_type,t.token_version,t.last_refresh_at,
           t.last_refresh_attempt_at,t.last_refresh_error
      from magalu.accounts a left join magalu.tokens t on t.account_id=a.id
     where a.id=$1 limit 1`, [id]);
  if (!account) return null;

  const [subscriptions, eventStats, eventRows, syncRows] = await Promise.all([
    db.query(`
      select id,topic,webhook_url,status,subscription_external_id,last_synced_at,created_at,updated_at,
             metadata->'master_reconcile' as master_reconcile
        from magalu.webhook_subscriptions where account_id=$1 order by topic,webhook_url`, [id]),
    db.queryOne(`
      select count(*)::int total,
             count(*) filter(where received_at>=now()-interval '24 hours')::int events_24h,
             count(*) filter(where processing_status='failed' and received_at>=now()-interval '24 hours')::int failed_24h,
             count(*) filter(where processing_status in('validated','queued','processing'))::int pending,
             max(received_at) last_received_at,max(processed_at) last_processed_at
        from magalu.webhook_events where account_id=$1`, [id]),
    db.query(`
      select id,topic,processing_status,attempts,last_error,received_at,processed_at
        from magalu.webhook_events where account_id=$1 order by received_at desc limit 25`, [id]),
    db.query(`
      select id,sync_type,status,scanned_count,created_count,updated_count,failed_count,error_message,started_at,finished_at
        from magalu.sync_runs where account_id=$1 order by started_at desc limit 20`, [id]),
  ]);

  return {
    account,
    subscriptions: subscriptions.rows,
    webhook_events: eventStats || {},
    recent_webhook_events: eventRows.rows,
    recent_syncs: syncRows.rows,
  };
}

async function recordWebhookReconcile(accountId, comparison) {
  const id = n(accountId);
  if (!id) return 0;
  const payload = JSON.stringify({
    checked_at: new Date().toISOString(),
    matched: Number(comparison?.matched?.length || 0),
    local_only: Number(comparison?.local_only?.length || 0),
    remote_only: Number(comparison?.remote_only?.length || 0),
  });
  const result = await db.query(`
    update magalu.webhook_subscriptions
       set last_synced_at=now(),
           metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object('master_reconcile',$2::jsonb),
           updated_at=now()
     where account_id=$1`, [id, payload]);
  return Number(result.rowCount || 0);
}

module.exports = {
  probeDatabase,
  summary,
  listAccounts,
  accountSnapshot,
  recordWebhookReconcile,
  _test: { n },
};
