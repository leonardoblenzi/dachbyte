"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.anymarketSyncJobService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const anymarketSyncService_1 = require("./anymarketSyncService");
const syncCancellation_1 = require("../utils/syncCancellation");
const db_1 = require("../lib/db");
const demoCompanyService_1 = require("./demoCompanyService");
const modSituation_1 = require("../utils/modSituation");
const integrationOrderStatusService_1 = require("./integrationOrderStatusService");
const MAX_LOGS = 1000;
const AUTO_ANYMARKET_SYNC_INTERVAL_MS = 0;
const AUTO_ANYMARKET_SYNC_SCHEDULE_TIMES = [{ hour: 12, minute: 0 }];
const SAO_PAULO_TIMEZONE = 'America/Sao_Paulo';
const SAO_PAULO_UTC_OFFSET_HOURS = 3;
const ANYMARKET_AUTO_SYNC_STATUSES = [
    'PENDING',
    'DELIVERY_ISSUE',
    'PAID_WAITING_SHIP',
    'INVOICED',
    'PAID_WAITING_DELIVERY',
    'CONCLUDED',
];
const ANYMARKET_AUTO_SYNC_STATUS_SET = new Set(ANYMARKET_AUTO_SYNC_STATUSES);
const normalizeConfiguredStatuses = (value) => {
    if (!Array.isArray(value))
        return [];
    return Array.from(new Set(value
        .map((item) => (0, integrationOrderStatusService_1.normalizeAnymarketStatusValue)(item))
        .filter((status) => ANYMARKET_AUTO_SYNC_STATUS_SET.has(status))));
};
class AnymarketSyncJobService {
    jobs = new Map();
    schedules = new Map();
    requesters = new Map();
    cancelRequests = new Set();
    getJob(companyId) {
        return this.jobs.get(companyId) || null;
    }
    getSchedule(companyId) {
        if (!(0, modSituation_1.shouldRunAutomaticProcesses)()) {
            return {
                enabled: false,
                intervalMs: AUTO_ANYMARKET_SYNC_INTERVAL_MS,
                nextScheduledAt: null,
            };
        }
        const schedule = companyId ? this.schedules.get(companyId) : null;
        return {
            enabled: true,
            intervalMs: AUTO_ANYMARKET_SYNC_INTERVAL_MS,
            nextScheduledAt: schedule?.nextScheduledAt ?? null,
        };
    }
    ensureSchedule(companyId, userId) {
        if (!(0, modSituation_1.shouldRunAutomaticProcesses)()) {
            this.clearScheduledTimeout(companyId);
            this.schedules.delete(companyId);
            return;
        }
        const existing = this.schedules.get(companyId);
        if (existing) {
            existing.userId = userId;
            if (!existing.nextScheduledAt)
                this.scheduleNext(companyId, userId);
            return;
        }
        this.scheduleNext(companyId, userId);
    }
    async initializeSchedules() {
        if (!(0, modSituation_1.shouldRunAutomaticProcesses)()) {
            for (const companyId of this.schedules.keys()) {
                this.clearScheduledTimeout(companyId);
            }
            this.schedules.clear();
            return;
        }
        const companiesResult = await (0, db_1.dbQuery)(`
        SELECT
          c."id",
          c."name",
          c."cnpj",
          c."documentNumber",
          u."id" AS "userId"
        FROM "Company" c
        JOIN LATERAL (
          SELECT usr."id"
          FROM "User" usr
          WHERE usr."companyId" = c."id"
          ORDER BY usr."createdAt" ASC
          LIMIT 1
        ) u ON TRUE
        WHERE c."anymarketIntegrationEnabled" = TRUE
          AND NULLIF(TRIM(COALESCE(c."anymarketToken", '')), '') IS NOT NULL
      `);
        for (const company of companiesResult.rows) {
            if ((0, demoCompanyService_1.isDemoCompany)(company))
                continue;
            this.ensureSchedule(company.id, company.userId);
            if (this.shouldRunStartupCatchUp()) {
                this.triggerAutomaticSync(company.id);
            }
        }
    }
    startJob(companyId, userId, filters, requester, mode = 'manual') {
        const existing = this.jobs.get(companyId);
        if (existing?.status === 'running') {
            return existing;
        }
        const now = new Date().toISOString();
        const job = {
            jobId: crypto_1.default.randomUUID(),
            companyId,
            userId,
            status: 'running',
            total: 0,
            processed: 0,
            success: 0,
            failed: 0,
            currentOrderNumber: null,
            startedAt: now,
            finishedAt: null,
            lastUpdatedAt: now,
            error: null,
            cancelRequested: false,
            warnings: [],
            logs: [],
        };
        this.clearScheduledTimeout(companyId);
        this.requesters.set(companyId, requester || {});
        this.pushLog(job, 'info', mode === 'automatic'
            ? 'Sincronizacao automatica ANYMARKET iniciada.'
            : 'Sincronizacao ANYMARKET iniciada em segundo plano.');
        this.jobs.set(companyId, job);
        void this.run(job, filters);
        return job;
    }
    cancelJob(companyId) {
        const job = this.jobs.get(companyId);
        if (!job || job.status !== 'running') {
            return job || null;
        }
        this.cancelRequests.add(companyId);
        job.cancelRequested = true;
        this.pushLog(job, 'info', 'Cancelamento do sync de pedidos solicitado.');
        return job;
    }
    async run(job, filters) {
        try {
            const result = await anymarketSyncService_1.anymarketSyncService.executeSync(job.companyId, filters, {
                onStart: ({ total }) => {
                    job.total = total;
                    this.touch(job);
                    this.pushLog(job, 'info', `${total} etapa(s) de status na fila do ANYMARKET.`);
                },
                onStatusStart: ({ status, index, total }) => {
                    job.currentOrderNumber = status;
                    this.touch(job);
                    this.pushLog(job, 'info', `Processando status "${status}" (${index}/${total}).`);
                },
                onStatusFinish: ({ status, index, imported, total }) => {
                    job.processed = index;
                    job.currentOrderNumber = null;
                    this.touch(job);
                    this.pushLog(job, 'success', `Status "${status}" concluido com ${imported} pedido(s) consultado(s) (${index}/${total}).`);
                },
                onLog: (message) => {
                    this.pushLog(job, 'info', message);
                },
                shouldCancel: () => this.cancelRequests.has(job.companyId),
            });
            job.status = 'completed';
            job.currentOrderNumber = null;
            job.finishedAt = new Date().toISOString();
            job.success =
                Number(result?.results?.created || 0) + Number(result?.results?.updated || 0);
            job.failed = Number(result?.results?.skipped || 0);
            this.touch(job);
            this.pushLog(job, 'success', result.message);
            this.scheduleNext(job.companyId, job.userId);
        }
        catch (error) {
            if ((0, syncCancellation_1.isSyncCancellationError)(error)) {
                job.status = 'canceled';
                job.currentOrderNumber = null;
                job.finishedAt = new Date().toISOString();
                job.error = null;
                this.touch(job);
                this.pushLog(job, 'info', syncCancellation_1.SYNC_CANCELLATION_MESSAGE);
                this.scheduleNext(job.companyId, job.userId);
                return;
            }
            job.status = 'failed';
            job.currentOrderNumber = null;
            job.finishedAt = new Date().toISOString();
            job.error =
                error instanceof Error
                    ? error.message
                    : 'Erro desconhecido na sincronizacao do ANYMARKET.';
            this.touch(job);
            this.pushLog(job, 'error', job.error);
            this.scheduleNext(job.companyId, job.userId);
        }
        finally {
            this.cancelRequests.delete(job.companyId);
            job.cancelRequested = false;
        }
    }
    touch(job) {
        job.lastUpdatedAt = new Date().toISOString();
    }
    pushLog(job, level, message) {
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            message,
        };
        job.logs = [...job.logs, entry].slice(-MAX_LOGS);
        this.touch(job);
    }
    getSaoPauloDateParts(date) {
        const formatter = new Intl.DateTimeFormat('en-CA', {
            timeZone: SAO_PAULO_TIMEZONE,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });
        const parts = formatter.formatToParts(date);
        const read = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
        return {
            year: read('year'),
            month: read('month'),
            day: read('day'),
        };
    }
    createSaoPauloDate(year, month, day, hour, minute) {
        return new Date(Date.UTC(year, month - 1, day, hour + SAO_PAULO_UTC_OFFSET_HOURS, minute, 0, 0));
    }
    resolveNextRunDate(now = new Date()) {
        const base = this.getSaoPauloDateParts(now);
        for (const slot of AUTO_ANYMARKET_SYNC_SCHEDULE_TIMES) {
            const candidate = this.createSaoPauloDate(base.year, base.month, base.day, slot.hour, slot.minute);
            if (candidate.getTime() > now.getTime())
                return candidate;
        }
        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const tomorrowParts = this.getSaoPauloDateParts(tomorrow);
        const firstSlot = AUTO_ANYMARKET_SYNC_SCHEDULE_TIMES[0];
        return this.createSaoPauloDate(tomorrowParts.year, tomorrowParts.month, tomorrowParts.day, firstSlot.hour, firstSlot.minute);
    }
    shouldRunStartupCatchUp(now = new Date()) {
        const current = this.getSaoPauloDateParts(now);
        const lastSlot = AUTO_ANYMARKET_SYNC_SCHEDULE_TIMES.at(-1);
        if (!lastSlot)
            return false;
        const lastRunToday = this.createSaoPauloDate(current.year, current.month, current.day, lastSlot.hour, lastSlot.minute);
        return now.getTime() >= lastRunToday.getTime();
    }
    scheduleNext(companyId, userId) {
        if (!(0, modSituation_1.shouldRunAutomaticProcesses)()) {
            this.clearScheduledTimeout(companyId);
            this.schedules.delete(companyId);
            return;
        }
        this.clearScheduledTimeout(companyId);
        const nextRun = this.resolveNextRunDate();
        const timeout = setTimeout(() => this.triggerAutomaticSync(companyId), Math.max(1000, nextRun.getTime() - Date.now()));
        this.schedules.set(companyId, {
            userId,
            nextScheduledAt: nextRun.toISOString(),
            timeout,
        });
    }
    triggerAutomaticSync(companyId) {
        if (!(0, modSituation_1.shouldRunAutomaticProcesses)()) {
            this.clearScheduledTimeout(companyId);
            this.schedules.delete(companyId);
            return;
        }
        const schedule = this.schedules.get(companyId);
        if (!schedule)
            return;
        schedule.timeout = null;
        schedule.nextScheduledAt = null;
        void (async () => {
            try {
                const companyResult = await (0, db_1.dbQuery)(`
            SELECT
              c."name",
              c."cnpj",
              c."documentNumber",
              c."anymarketIntegrationEnabled",
              c."anymarketToken",
              c."integrationAutoSyncStatuses"
            FROM "Company" c
            WHERE c."id" = $1
            LIMIT 1
          `, [companyId]);
                const company = companyResult.rows[0] || null;
                const tokenConfigured = Boolean(String(company?.anymarketToken || '').trim());
                if (company?.anymarketIntegrationEnabled !== true ||
                    !tokenConfigured ||
                    (0, demoCompanyService_1.isDemoCompany)(company)) {
                    this.schedules.delete(companyId);
                    return;
                }
                const configuredStatuses = normalizeConfiguredStatuses(company.integrationAutoSyncStatuses);
                const statuses = configuredStatuses.length > 0
                    ? configuredStatuses
                    : [...ANYMARKET_AUTO_SYNC_STATUSES];
                const existing = this.jobs.get(companyId);
                if (existing?.status === 'running') {
                    this.scheduleNext(companyId, schedule.userId);
                    return;
                }
                const job = this.startJob(companyId, schedule.userId, {
                    days: 2,
                    statusMode: 'selected',
                    statuses,
                    includeCreatedAndUpdated: true,
                }, undefined, 'automatic');
                this.pushLog(job, 'info', `Execucao automatica ANYMARKET disparada com pedidos novos e alterados dos ultimos 2 dias em ${statuses.length} status valido(s).`);
            }
            catch (error) {
                console.error('Erro ao disparar sincronizacao automatica ANYMARKET:', error);
                this.scheduleNext(companyId, schedule.userId);
            }
        })();
    }
    clearScheduledTimeout(companyId) {
        const schedule = this.schedules.get(companyId);
        if (!schedule?.timeout)
            return;
        clearTimeout(schedule.timeout);
        schedule.timeout = null;
    }
}
exports.anymarketSyncJobService = new AnymarketSyncJobService();
