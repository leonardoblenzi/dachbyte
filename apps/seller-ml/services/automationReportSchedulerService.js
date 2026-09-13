"use strict";

const db = require("../db/db");
const AutomationReportService = require("./automationReportService");
const AutomationReportRunner = require("./automationReportRunnerService");

const CHECK_INTERVAL_MS = Math.max(60 * 1000, Number(process.env.REPORT_AUTOMATION_CHECK_INTERVAL_MS || 5 * 60 * 1000));
const BATCH_LIMIT = Math.max(1, Math.min(50, Number(process.env.REPORT_AUTOMATION_BATCH_LIMIT || 10)));

let started = false;
let running = false;
let timer = null;

async function withSchedulerLock(fn) {
  const lockKey = "ml_report_automations_scheduler";
  const lockedResult = await db.query(`select pg_try_advisory_lock(hashtext($1)) as locked`, [lockKey]);
  if (!lockedResult.rows?.[0]?.locked) {
    return { skipped: true, reason: "lock_not_acquired" };
  }
  try {
    return await fn();
  } finally {
    await db.query(`select pg_advisory_unlock(hashtext($1))`, [lockKey]).catch(() => null);
  }
}

async function runDueAutomations({ now = new Date() } = {}) {
  return withSchedulerLock(async () => {
    const output = [];
    await db.withClient(async (client) => {
      await client.query("begin");
      try {
        const { rows } = await client.query(
          `select *
             from report_automations
            where active = true
              and next_run_at is not null
              and next_run_at <= $1
            order by next_run_at asc, id asc
            limit $2
            for update skip locked`,
          [now, BATCH_LIMIT],
        );

        for (const row of rows || []) {
          const automation = AutomationReportService.getAutomation
            ? {
                id: Number(row.id),
                empresa_id: Number(row.empresa_id),
                meli_conta_id: Number(row.meli_conta_id),
                name: row.name,
                base_status: row.base_status,
                mlb_ids: Array.isArray(row.mlb_ids) ? row.mlb_ids : [],
                enrichment: row.enrichment,
                period_type: row.period_type,
                recipients: Array.isArray(row.recipients_json) ? row.recipients_json : [],
                frequency: row.frequency,
                weekday: row.weekday == null ? null : Number(row.weekday),
                time_of_day: String(row.time_of_day || "").slice(0, 5),
                timezone: row.timezone,
              }
            : null;

          const run = await AutomationReportService.createRunForAutomation({
            automation,
            scheduledFor: row.next_run_at || now,
            client,
          });
          const nextRunAt = AutomationReportService.calculateNextRunAt({
            frequency: automation.frequency,
            weekday: automation.weekday,
            timeOfDay: automation.time_of_day,
            timezone: automation.timezone,
            from: new Date(Date.now() + 60 * 1000),
          });
          await client.query(
            `update report_automations
                set next_run_at = $2,
                    updated_at = now()
              where id = $1`,
            [automation.id, nextRunAt],
          );
          output.push({ automation, run });
        }

        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    });

    for (const item of output) {
      await AutomationReportRunner.enqueueRun(item.run.id);
    }

    return {
      skipped: false,
      enqueued: output.length,
      automations: output.map((item) => ({
        automation_id: item.automation.id,
        run_id: item.run.id,
      })),
    };
  });
}

async function checkDueAutomations() {
  if (running) return;
  running = true;
  try {
    const result = await runDueAutomations();
    if (result?.enqueued) {
      console.log("[ReportAutomation] automacoes enfileiradas:", result.enqueued);
    }
  } catch (error) {
    console.error("[ReportAutomation] Falha no scheduler:", error?.message || error);
  } finally {
    running = false;
  }
}

function startAutomationReportScheduler() {
  if (started) return;
  if (String(process.env.REPORT_AUTOMATION_SCHEDULER || "1") === "0") {
    console.log("[ReportAutomation] scheduler desativado por env.");
    return;
  }
  started = true;
  AutomationReportRunner.initWorker();
  timer = setInterval(checkDueAutomations, CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();
  setTimeout(checkDueAutomations, 150 * 1000).unref?.();
  console.log("[ReportAutomation] scheduler ativo.");
}

module.exports = {
  checkDueAutomations,
  runDueAutomations,
  startAutomationReportScheduler,
};
