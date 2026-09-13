import crypto from 'crypto';
import type {
  SyncLogEntry,
  SyncJobStatus,
  SyncScheduleStatus,
} from '../types/syncJob';
import {
  traySyncService,
  type TraySyncFiltersInput,
} from './traySyncService';
import { trayAuthService } from './trayAuthService';
import { syncReportService } from './syncReportService';
import type { SyncTrigger } from '../types/syncReport';
import { isDemoCompany, isDemoCompanyById } from './demoCompanyService';
import { dbQuery } from '../lib/db';
import {
  isSyncCancellationError,
  SYNC_CANCELLATION_MESSAGE,
} from '../utils/syncCancellation';
import { shouldRunAutomaticProcesses } from '../utils/modSituation';

const MAX_LOGS = 1000;
const AUTO_TRAY_SYNC_INTERVAL_MS = 0;
const AUTO_TRAY_SYNC_SCHEDULE_TIMES = [
  { hour: 12, minute: 0 },
];
const SAO_PAULO_TIMEZONE = 'America/Sao_Paulo';
const SAO_PAULO_UTC_OFFSET_HOURS = 3;
const AUTO_TRAY_SYNC_FILTERS: TraySyncFiltersInput = {
  days: 2,
  statusMode: 'selected',
  revisitShippingOverdue: true,
  statuses: [
    'a enviar',
    '5- aguardando faturamento',
    'enviado',
    'aguardando envio',
    'pedido cadastrado',
  ],
};

const normalizeConfiguredStatuses = (value: unknown) => {
  if (!Array.isArray(value)) return [];

  return Array.from(
    new Set(
      value
        .map((item) => String(item || '').trim().toLowerCase())
        .filter(Boolean),
    ),
  );
};

type ScheduleEntry = {
  userId: string;
  nextScheduledAt: string | null;
  timeout: NodeJS.Timeout | null;
};
type RequesterEntry = {
  email?: string | null;
  name?: string | null;
};

class TraySyncJobService {
  private jobs: Map<string, SyncJobStatus> = new Map();
  private schedules: Map<string, ScheduleEntry> = new Map();
  private requesters: Map<string, RequesterEntry> = new Map();
  private cancelRequests: Set<string> = new Set();

  getJob(companyId: string) {
    return this.jobs.get(companyId) || null;
  }

  cancelJob(companyId: string) {
    const job = this.jobs.get(companyId);

    if (!job || job.status !== 'running') {
      return job || null;
    }

    this.cancelRequests.add(companyId);
    job.cancelRequested = true;
    this.pushLog(job, 'info', 'Cancelamento do sync de pedidos solicitado.');

    return job;
  }

  ensureSchedule(companyId: string, userId: string) {
    if (!shouldRunAutomaticProcesses()) {
      this.clearScheduledTimeout(companyId);
      this.schedules.delete(companyId);
      return;
    }

    const existing = this.schedules.get(companyId);

    if (existing) {
      existing.userId = userId;
      if (!existing.nextScheduledAt) {
        this.scheduleNext(companyId, userId);
      }
      return;
    }

    this.scheduleNext(companyId, userId);
  }

  getSchedule(companyId: string): SyncScheduleStatus {
    if (!shouldRunAutomaticProcesses()) {
      return {
        enabled: false,
        intervalMs: AUTO_TRAY_SYNC_INTERVAL_MS,
        nextScheduledAt: null,
      };
    }

    const schedule = this.schedules.get(companyId);

    return {
      enabled: true,
      intervalMs: AUTO_TRAY_SYNC_INTERVAL_MS,
      nextScheduledAt: schedule?.nextScheduledAt ?? null,
    };
  }

  getDisabledSchedule(): SyncScheduleStatus {
    return {
      enabled: false,
      intervalMs: AUTO_TRAY_SYNC_INTERVAL_MS,
      nextScheduledAt: null,
    };
  }

  async initializeSchedules() {
    if (!shouldRunAutomaticProcesses()) {
      for (const companyId of this.schedules.keys()) {
        this.clearScheduledTimeout(companyId);
      }
      this.schedules.clear();
      return;
    }

    const companyIdsWithAuth = new Set(await trayAuthService.getCompaniesWithAuth());
    if (companyIdsWithAuth.size === 0) return;

    const usersResult = await dbQuery<any>(
      `
        SELECT
          u."id",
          u."companyId"
        FROM "User" u
        WHERE u."companyId" IS NOT NULL
        ORDER BY u."createdAt" ASC
      `,
    );
    const users = usersResult.rows;

    const seenCompanies = new Set<string>();
    const enabledCompanies = new Set(
      (
        (
          await dbQuery<any>(
            `
              SELECT
                c."id",
                c."name",
                c."cnpj",
                c."documentNumber"
              FROM "Company" c
              WHERE c."trayIntegrationEnabled" = TRUE
            `,
          )
        ).rows
      )
        .filter((company: { name?: string | null; cnpj?: string | null; documentNumber?: string | null }) =>
          !isDemoCompany(company),
        )
        .map((company: { id: string }) => company.id),
    );

    for (const user of users) {
      if (
        !user.companyId ||
        seenCompanies.has(user.companyId) ||
        !companyIdsWithAuth.has(user.companyId) ||
        !enabledCompanies.has(user.companyId)
      ) {
        continue;
      }

      seenCompanies.add(user.companyId);
      this.ensureSchedule(user.companyId, user.id);

      if (this.shouldRunStartupCatchUp()) {
        this.triggerAutomaticSync(user.companyId);
      }
    }
  }

  startJob(
    companyId: string,
    userId: string,
    filters: TraySyncFiltersInput,
    mode: 'manual' | 'automatic' = 'manual',
    requester?: RequesterEntry,
  ) {
    const existing = this.jobs.get(companyId);

    if (existing?.status === 'running') {
      return existing;
    }

    const now = new Date().toISOString();
    const job: SyncJobStatus = {
      jobId: crypto.randomUUID(),
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
    this.pushLog(
      job,
      'info',
      mode === 'automatic'
        ? 'Sincronizacao automatica da Tray iniciada.'
        : 'Sincronizacao da Tray iniciada em segundo plano.',
    );
    this.jobs.set(companyId, job);
    void this.run(job, filters, mode);

    return job;
  }

  private async run(
    job: SyncJobStatus,
    filters: TraySyncFiltersInput,
    mode: 'manual' | 'automatic',
  ) {
    try {
      if (await isDemoCompanyById(job.companyId)) {
        job.status = 'completed';
        job.currentOrderNumber = null;
        job.total = 0;
        job.processed = 0;
        job.success = 0;
        job.failed = 0;
        job.finishedAt = new Date().toISOString();
        this.pushLog(
          job,
          'info',
          'Sincronizacao da Tray desabilitada para empresa demonstrativa.',
        );
        this.requesters.delete(job.companyId);
        this.schedules.delete(job.companyId);
        return;
      }

      const result = await traySyncService.executeSync(job.companyId, filters, {
        onStart: ({ total }) => {
          job.total = total;
          this.touch(job);
          this.pushLog(job, 'info', `${total} etapa(s) de status na fila da Tray.`);
        },
        onStatusStart: ({ status, index, total }) => {
          job.currentOrderNumber = status;
          this.touch(job);
          this.pushLog(
            job,
            'info',
            `Processando status "${status}" (${index}/${total}).`,
          );
        },
        onStatusFinish: ({ status, index, imported }) => {
          job.processed = index;
          job.success += imported;
          job.currentOrderNumber = null;
          this.touch(job);
          this.pushLog(
            job,
            'success',
            `Status "${status}" concluido com ${imported} pedido(s) novo(s).`,
          );
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

      try {
        const requester = this.requesters.get(job.companyId);
        const report = await syncReportService.sendTraySyncReport({
          companyId: job.companyId,
          userId: job.userId,
          userEmail: requester?.email,
          userName: requester?.name,
          trigger: mode as SyncTrigger,
          payload: {
            companyId: job.companyId,
            storeId: result.storeId,
            modified: result.modified,
            statuses: result.statuses,
            created: Number(result?.results?.created || 0),
            updated: Number(result?.results?.updated || 0),
            skipped: Number(result?.results?.skipped || 0),
            totalTrackingEvents: Number(result?.results?.totalTrackingEvents || 0),
            errors: Array.isArray(result?.results?.errors)
              ? result.results.errors
              : [],
            createdOrders: Array.isArray(result?.results?.createdOrders)
              ? result.results.createdOrders
              : [],
            updatedOrders: Array.isArray(result?.results?.updatedOrders)
              ? result.results.updatedOrders
              : [],
            skippedOrders: Array.isArray(result?.results?.skippedOrders)
              ? result.results.skippedOrders
              : [],
          },
          startedAt: job.startedAt,
          finishedAt: job.finishedAt || new Date().toISOString(),
        });
        this.pushLog(
          job,
          'info',
          `Relatorio da Tray enviado para ${report.recipients} destinatario(s). CSV: ${report.csvUrl}`,
        );
      } catch (reportError) {
        const reportMessage =
          reportError instanceof Error
            ? reportError.message
            : 'Erro desconhecido ao enviar relatorio da Tray';
        this.pushLog(
          job,
          'error',
          `Falha ao enviar relatorio da Tray: ${reportMessage}`,
        );
      }

      this.scheduleNext(job.companyId, job.userId);
    } catch (error) {
      if (isSyncCancellationError(error)) {
        job.status = 'canceled';
        job.currentOrderNumber = null;
        job.finishedAt = new Date().toISOString();
        job.error = null;
        this.touch(job);
        this.pushLog(job, 'info', SYNC_CANCELLATION_MESSAGE);
        this.scheduleNext(job.companyId, job.userId);
        return;
      }

      job.status = 'failed';
      job.currentOrderNumber = null;
      job.finishedAt = new Date().toISOString();
      job.error =
        error instanceof Error ? error.message : 'Erro desconhecido na sincronizacao da Tray.';
      this.touch(job);
      this.pushLog(job, 'error', job.error);
      this.scheduleNext(job.companyId, job.userId);
    } finally {
      this.cancelRequests.delete(job.companyId);
      job.cancelRequested = false;
    }
  }

  private touch(job: SyncJobStatus) {
    job.lastUpdatedAt = new Date().toISOString();
  }

  private pushLog(
    job: SyncJobStatus,
    level: SyncLogEntry['level'],
    message: string,
  ) {
    const entry: SyncLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
    };

    job.logs = [...job.logs, entry].slice(-MAX_LOGS);
    this.touch(job);
  }

  private getSaoPauloDateParts(date: Date) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: SAO_PAULO_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    const parts = formatter.formatToParts(date);
    const read = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value || 0);

    return {
      year: read('year'),
      month: read('month'),
      day: read('day'),
      weekday: ({
        Sun: 0,
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6,
      } as Record<string, number>)[
        parts.find((part) => part.type === 'weekday')?.value || ''
      ] ?? 0,
    };
  }

  private createSaoPauloDate(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
  ) {
    return new Date(
      Date.UTC(
        year,
        month - 1,
        day,
        hour + SAO_PAULO_UTC_OFFSET_HOURS,
        minute,
        0,
        0,
      ),
    );
  }

  private resolveNextRunDate(now = new Date()) {
    const base = this.getSaoPauloDateParts(now);
    const isBusinessDay = (weekday: number) => weekday >= 1 && weekday <= 5;

    if (isBusinessDay(base.weekday)) {
      for (const slot of AUTO_TRAY_SYNC_SCHEDULE_TIMES) {
        const candidate = this.createSaoPauloDate(
          base.year,
          base.month,
          base.day,
          slot.hour,
          slot.minute,
        );

        if (candidate.getTime() > now.getTime()) {
          return candidate;
        }
      }
    }

    const firstSlot = AUTO_TRAY_SYNC_SCHEDULE_TIMES[0];
    let nextDayBase = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    while (true) {
      const nextDayParts = this.getSaoPauloDateParts(nextDayBase);

      if (isBusinessDay(nextDayParts.weekday)) {
        return this.createSaoPauloDate(
          nextDayParts.year,
          nextDayParts.month,
          nextDayParts.day,
          firstSlot.hour,
          firstSlot.minute,
        );
      }

      nextDayBase = new Date(nextDayBase.getTime() + 24 * 60 * 60 * 1000);
    }
  }

  private shouldRunStartupCatchUp(now = new Date()) {
    const current = this.getSaoPauloDateParts(now);
    const isBusinessDay = current.weekday >= 1 && current.weekday <= 5;
    if (!isBusinessDay) return false;

    const lastSlot = AUTO_TRAY_SYNC_SCHEDULE_TIMES.at(-1);
    if (!lastSlot) return false;

    const lastRunToday = this.createSaoPauloDate(
      current.year,
      current.month,
      current.day,
      lastSlot.hour,
      lastSlot.minute,
    );

    return now.getTime() >= lastRunToday.getTime();
  }

  private scheduleNext(companyId: string, userId: string) {
    if (!shouldRunAutomaticProcesses()) {
      this.clearScheduledTimeout(companyId);
      this.schedules.delete(companyId);
      return;
    }

    this.clearScheduledTimeout(companyId);

    const nextRun = this.resolveNextRunDate();
    const delayMs = Math.max(1000, nextRun.getTime() - Date.now());
    const nextRunAt = nextRun.toISOString();
    const timeout = setTimeout(() => {
      this.triggerAutomaticSync(companyId);
    }, delayMs);

    this.schedules.set(companyId, {
      userId,
      nextScheduledAt: nextRunAt,
      timeout,
    });
  }

  private triggerAutomaticSync(companyId: string) {
    if (!shouldRunAutomaticProcesses()) {
      this.clearScheduledTimeout(companyId);
      this.schedules.delete(companyId);
      return;
    }

    const schedule = this.schedules.get(companyId);
    if (!schedule) return;

    schedule.timeout = null;
    schedule.nextScheduledAt = null;

    void (async () => {
      try {
        const companyResult = await dbQuery<any>(
        `
          SELECT
            c."name",
            c."cnpj",
            c."documentNumber",
            c."trayIntegrationEnabled",
            c."integrationAutoSyncStatuses"
          FROM "Company" c
          WHERE c."id" = $1
          LIMIT 1
        `,
        [companyId],
      );
      const company = companyResult.rows[0] || null;

      if (company?.trayIntegrationEnabled === false || isDemoCompany(company)) {
        this.schedules.delete(companyId);
        return;
      }

      const configuredAutomaticStatuses = normalizeConfiguredStatuses(
        company?.integrationAutoSyncStatuses,
      );
      const automaticFilters: TraySyncFiltersInput = {
        ...AUTO_TRAY_SYNC_FILTERS,
        statusMode: 'selected',
        statuses:
          configuredAutomaticStatuses.length > 0
            ? configuredAutomaticStatuses
            : AUTO_TRAY_SYNC_FILTERS.statuses || [],
      };

      const existing = this.jobs.get(companyId);
      if (existing?.status === 'running') {
        this.scheduleNext(companyId, schedule.userId);
        return;
      }

      const job = this.startJob(
        companyId,
        schedule.userId,
        automaticFilters,
        'automatic',
      );
        this.pushLog(
          job,
          'info',
          `Execucao automatica da Tray disparada com janela de 2 dias e ${automaticFilters.statuses?.length || 0} status configurado(s).`,
        );
      } catch (error) {
        console.error('Erro ao disparar sincronizacao automatica da Tray:', error);
        this.scheduleNext(companyId, schedule.userId);
      }
    })();
  }

  private clearScheduledTimeout(companyId: string) {
    const schedule = this.schedules.get(companyId);
    if (!schedule?.timeout) return;

    clearTimeout(schedule.timeout);
    schedule.timeout = null;
  }
}

export const traySyncJobService = new TraySyncJobService();
