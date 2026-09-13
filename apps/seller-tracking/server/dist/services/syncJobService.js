"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncJobService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const trackingService_1 = require("./trackingService");
const syncReportService_1 = require("./syncReportService");
const notificationService_1 = require("./notificationService");
const prismaError_1 = require("../utils/prismaError");
const demoCompanyService_1 = require("./demoCompanyService");
const db_1 = require("../lib/db");
const syncCancellation_1 = require("../utils/syncCancellation");
const modSituation_1 = require("../utils/modSituation");
const trackingService = new trackingService_1.TrackingService();
const MAX_LOGS = 1000;
const AUTO_SYNC_INTERVAL_MS = 10 * 60 * 60 * 1000;
const AUTO_SYNC_SCHEDULE_TIMES = [
    { hour: 5, minute: 0 },
    { hour: 15, minute: 0 },
];
const SAO_PAULO_TIMEZONE = 'America/Sao_Paulo';
const SAO_PAULO_UTC_OFFSET_HOURS = 3;
const BUSINESS_WEEKDAYS = new Set(['MON', 'TUE', 'WED', 'THU', 'FRI']);
class SyncJobService {
    jobs = new Map();
    autoSyncUsersByCompany = new Map();
    autoSchedule = {
        nextScheduledAt: null,
        timeout: null,
    };
    autoRunInProgress = false;
    runningExecutions = new Map();
    requesters = new Map();
    cancelRequests = new Set();
    getJob(companyId) {
        return this.jobs.get(companyId) || null;
    }
    getRunningJobsCount() {
        let running = 0;
        for (const job of this.jobs.values()) {
            if (job.status === 'running') {
                running += 1;
            }
        }
        return running;
    }
    cancelJob(companyId) {
        const job = this.jobs.get(companyId);
        if (!job || job.status !== 'running') {
            return job || null;
        }
        this.cancelRequests.add(companyId);
        job.cancelRequested = true;
        this.pushLog(job, 'info', 'Cancelamento do sync de rastreio solicitado.');
        return job;
    }
    ensureSchedule(companyId, userId) {
        if (!(0, modSituation_1.shouldRunAutomaticProcesses)()) {
            this.autoSyncUsersByCompany.delete(companyId);
            if (this.autoSchedule.timeout) {
                clearTimeout(this.autoSchedule.timeout);
                this.autoSchedule.timeout = null;
            }
            this.autoSchedule.nextScheduledAt = null;
            return;
        }
        this.autoSyncUsersByCompany.set(companyId, userId);
        this.scheduleAutomaticRun();
    }
    async initializeSchedules() {
        if (!(0, modSituation_1.shouldRunAutomaticProcesses)()) {
            this.autoSyncUsersByCompany.clear();
            if (this.autoSchedule.timeout) {
                clearTimeout(this.autoSchedule.timeout);
                this.autoSchedule.timeout = null;
            }
            this.autoSchedule.nextScheduledAt = null;
            return;
        }
        this.autoSyncUsersByCompany.clear();
        const usersResult = await (0, db_1.dbQuery)(`
        SELECT
          u."id",
          u."companyId",
          c."name" AS "companyName",
          c."cnpj" AS "companyCnpj"
        FROM "User" u
        INNER JOIN "Company" c ON c."id" = u."companyId"
        WHERE u."companyId" IS NOT NULL
          AND c."intelipostIntegrationEnabled" = TRUE
        ORDER BY u."createdAt" ASC
      `);
        const users = usersResult.rows.map((row) => ({
            id: row.id,
            companyId: row.companyId,
            company: {
                name: row.companyName,
                cnpj: row.companyCnpj,
            },
        }));
        const seenCompanies = new Set();
        for (const user of users) {
            if (!user.companyId ||
                seenCompanies.has(user.companyId) ||
                (0, demoCompanyService_1.isDemoCompany)(user.company)) {
                continue;
            }
            seenCompanies.add(user.companyId);
            this.autoSyncUsersByCompany.set(user.companyId, user.id);
        }
        this.scheduleAutomaticRun();
    }
    getSchedule(companyId) {
        if (!(0, modSituation_1.shouldRunAutomaticProcesses)()) {
            return {
                enabled: false,
                intervalMs: AUTO_SYNC_INTERVAL_MS,
                nextScheduledAt: null,
            };
        }
        const enabled = this.autoSyncUsersByCompany.has(companyId);
        return {
            enabled,
            intervalMs: AUTO_SYNC_INTERVAL_MS,
            nextScheduledAt: enabled ? this.autoSchedule.nextScheduledAt : null,
        };
    }
    getDisabledSchedule() {
        return {
            enabled: false,
            intervalMs: AUTO_SYNC_INTERVAL_MS,
            nextScheduledAt: null,
        };
    }
    startJob(companyId, userId, trigger = 'manual', requester) {
        const existing = this.jobs.get(companyId);
        if (existing && existing.status === 'running') {
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
        this.requesters.set(companyId, requester || {});
        this.pushLog(job, 'info', 'Sincronização iniciada.');
        this.jobs.set(companyId, job);
        const execution = this.run(job, trigger).finally(() => {
            this.runningExecutions.delete(companyId);
        });
        this.runningExecutions.set(companyId, execution);
        void execution;
        return job;
    }
    async run(job, trigger) {
        try {
            if (await (0, demoCompanyService_1.isDemoCompanyById)(job.companyId)) {
                job.status = 'completed';
                job.currentOrderNumber = null;
                job.total = 0;
                job.processed = 0;
                job.success = 0;
                job.failed = 0;
                job.finishedAt = new Date().toISOString();
                this.pushLog(job, 'info', 'Sincronizacao desabilitada para empresa demonstrativa.');
                this.requesters.delete(job.companyId);
                this.autoSyncUsersByCompany.delete(job.companyId);
                return;
            }
            let generatedReport = null;
            const results = await trackingService.syncAllActive(job.companyId, undefined, {
                onStart: ({ total }) => {
                    job.total = total;
                    this.touch(job);
                    this.pushLog(job, 'info', `Total de pedidos na fila: ${total}.`);
                },
                onOrderStart: ({ orderNumber, index, total }) => {
                    job.currentOrderNumber = orderNumber;
                    this.touch(job);
                    this.pushLog(job, 'info', `Processando pedido ${orderNumber} (${index}/${total}).`);
                },
                onOrderFinish: ({ orderNumber, success, message, durationMs }) => {
                    job.processed += 1;
                    if (success) {
                        job.success += 1;
                        this.pushLog(job, 'success', `Pedido ${orderNumber} sincronizado em ${(durationMs / 1000).toFixed(1)}s. ${message}`);
                    }
                    else {
                        job.failed += 1;
                        this.pushLog(job, 'error', `Pedido ${orderNumber} falhou em ${(durationMs / 1000).toFixed(1)}s. ${message}`);
                    }
                    this.touch(job);
                },
                shouldCancel: () => this.cancelRequests.has(job.companyId),
            });
            job.status = 'completed';
            job.currentOrderNumber = null;
            job.finishedAt = new Date().toISOString();
            job.warnings = Array.isArray(results.warnings) ? results.warnings : [];
            this.touch(job);
            this.pushLog(job, 'success', `Sincronização finalizada. ${job.success} sucesso(s), ${job.failed} falha(s).`);
            for (const warning of job.warnings) {
                this.pushLog(job, 'info', `Aviso: ${warning}`);
            }
            try {
                const requester = this.requesters.get(job.companyId);
                const report = await syncReportService_1.syncReportService.sendTrackingSyncReport({
                    companyId: job.companyId,
                    userId: job.userId,
                    userEmail: requester?.email,
                    userName: requester?.name,
                    trigger,
                    payload: results.report,
                    startedAt: job.startedAt,
                    finishedAt: job.finishedAt || new Date().toISOString(),
                });
                generatedReport = report;
                this.pushLog(job, 'info', `Relatorio enviado para ${report.recipients} destinatario(s). CSV: ${report.csvUrl}`);
            }
            catch (reportError) {
                const reportMessage = reportError instanceof Error
                    ? reportError.message
                    : 'Erro desconhecido ao enviar relatorio';
                this.pushLog(job, 'error', `Falha ao enviar relatorio: ${reportMessage}`);
            }
            try {
                await notificationService_1.notificationService.registerTrackingSyncNotifications({
                    companyId: job.companyId,
                    payload: results.report,
                    reportId: generatedReport?.reportId || null,
                    reportUrl: generatedReport?.reportUrl || null,
                    csvUrl: generatedReport?.csvUrl || null,
                    startedAt: job.startedAt,
                    finishedAt: job.finishedAt || new Date().toISOString(),
                });
            }
            catch (notificationError) {
                const notificationMessage = notificationError instanceof Error
                    ? notificationError.message
                    : 'Erro desconhecido ao salvar notificacoes';
                this.pushLog(job, 'error', `Falha ao registrar notificacoes da sincronizacao: ${notificationMessage}`);
            }
        }
        catch (error) {
            if ((0, syncCancellation_1.isSyncCancellationError)(error)) {
                job.status = 'canceled';
                job.currentOrderNumber = null;
                job.finishedAt = new Date().toISOString();
                job.error = null;
                this.touch(job);
                this.pushLog(job, 'info', syncCancellation_1.SYNC_CANCELLATION_MESSAGE);
                return;
            }
            job.status = 'failed';
            job.currentOrderNumber = null;
            job.finishedAt = new Date().toISOString();
            job.error = (0, prismaError_1.toUserFacingDatabaseErrorMessage)(error, 'Erro desconhecido durante a sincronizacao');
            this.touch(job);
            this.pushLog(job, 'error', `Sincronização interrompida: ${job.error}`);
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
            weekday: 'short',
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
            weekday: String(parts.find((part) => part.type === 'weekday')?.value || '')
                .slice(0, 3)
                .toUpperCase(),
            year: read('year'),
            month: read('month'),
            day: read('day'),
        };
    }
    createSaoPauloDate(year, month, day, hour, minute) {
        return new Date(Date.UTC(year, month - 1, day, hour + SAO_PAULO_UTC_OFFSET_HOURS, minute, 0, 0));
    }
    resolveNextRunDate(now = new Date()) {
        for (let dayOffset = 0; dayOffset < 8; dayOffset += 1) {
            const candidateBase = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
            const base = this.getSaoPauloDateParts(candidateBase);
            if (!BUSINESS_WEEKDAYS.has(base.weekday)) {
                continue;
            }
            for (const slot of AUTO_SYNC_SCHEDULE_TIMES) {
                const candidate = this.createSaoPauloDate(base.year, base.month, base.day, slot.hour, slot.minute);
                if (candidate.getTime() > now.getTime()) {
                    return candidate;
                }
            }
        }
        const nextDayBase = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const nextDayParts = this.getSaoPauloDateParts(nextDayBase);
        const firstSlot = AUTO_SYNC_SCHEDULE_TIMES[0];
        return this.createSaoPauloDate(nextDayParts.year, nextDayParts.month, nextDayParts.day, firstSlot.hour, firstSlot.minute);
    }
    scheduleAutomaticRun() {
        if (!(0, modSituation_1.shouldRunAutomaticProcesses)()) {
            if (this.autoSchedule.timeout) {
                clearTimeout(this.autoSchedule.timeout);
                this.autoSchedule.timeout = null;
            }
            this.autoSchedule.nextScheduledAt = null;
            return;
        }
        if (this.autoSchedule.timeout) {
            clearTimeout(this.autoSchedule.timeout);
            this.autoSchedule.timeout = null;
        }
        const nextRun = this.resolveNextRunDate();
        const delayMs = Math.max(1000, nextRun.getTime() - Date.now());
        this.autoSchedule.nextScheduledAt = nextRun.toISOString();
        this.autoSchedule.timeout = setTimeout(() => {
            this.triggerAutomaticBatch();
        }, delayMs);
    }
    triggerAutomaticBatch() {
        if (!(0, modSituation_1.shouldRunAutomaticProcesses)()) {
            if (this.autoSchedule.timeout) {
                clearTimeout(this.autoSchedule.timeout);
                this.autoSchedule.timeout = null;
            }
            this.autoSchedule.nextScheduledAt = null;
            return;
        }
        this.autoSchedule.timeout = null;
        this.autoSchedule.nextScheduledAt = null;
        if (this.autoRunInProgress) {
            this.scheduleAutomaticRun();
            return;
        }
        void this.runAutomaticBatch()
            .catch((error) => {
            console.error('Erro ao executar lote automatico de sincronizacao de rastreio:', error);
        })
            .finally(() => {
            this.scheduleAutomaticRun();
        });
    }
    async runAutomaticBatch() {
        if (!(0, modSituation_1.shouldRunAutomaticProcesses)()) {
            return;
        }
        if (this.autoRunInProgress) {
            return;
        }
        this.autoRunInProgress = true;
        try {
            const entries = Array.from(this.autoSyncUsersByCompany.entries());
            for (const [companyId, userId] of entries) {
                if (await (0, demoCompanyService_1.isDemoCompanyById)(companyId)) {
                    this.autoSyncUsersByCompany.delete(companyId);
                    continue;
                }
                let execution = this.runningExecutions.get(companyId);
                if (!execution) {
                    const job = this.startJob(companyId, userId, 'automatic');
                    this.pushLog(job, 'info', 'Execução automática disparada.');
                    execution = this.runningExecutions.get(companyId) || null;
                }
                if (execution) {
                    await execution;
                }
            }
        }
        finally {
            this.autoRunInProgress = false;
        }
    }
}
exports.syncJobService = new SyncJobService();
