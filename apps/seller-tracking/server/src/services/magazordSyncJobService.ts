import crypto from 'crypto';
import type { SyncJobStatus, SyncLogEntry, SyncScheduleStatus } from '../types/syncJob';
import {
  magazordSyncService,
  type MagazordSyncFiltersInput,
} from './magazordSyncService';
import {
  isSyncCancellationError,
  SYNC_CANCELLATION_MESSAGE,
} from '../utils/syncCancellation';

type RequesterEntry = {
  email?: string | null;
  name?: string | null;
};

const MAX_LOGS = 1000;

class MagazordSyncJobService {
  private jobs: Map<string, SyncJobStatus> = new Map();
  private requesters: Map<string, RequesterEntry> = new Map();
  private cancelRequests: Set<string> = new Set();

  getJob(companyId: string) {
    return this.jobs.get(companyId) || null;
  }

  getSchedule(): SyncScheduleStatus {
    return {
      enabled: false,
      intervalMs: 0,
      nextScheduledAt: null,
    };
  }

  startJob(
    companyId: string,
    userId: string,
    filters: MagazordSyncFiltersInput,
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

    this.requesters.set(companyId, requester || {});
    this.pushLog(job, 'info', 'Sincronizacao Magazord iniciada em segundo plano.');
    this.jobs.set(companyId, job);
    void this.run(job, filters);

    return job;
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

  private async run(job: SyncJobStatus, filters: MagazordSyncFiltersInput) {
    try {
      const result = await magazordSyncService.executeSync(job.companyId, filters, {
        onStart: ({ total }) => {
          job.total = total;
          this.touch(job);
          this.pushLog(job, 'info', `${total} etapa(s) de status na fila da Magazord.`);
        },
        onStatusStart: ({ status, index, total }) => {
          job.currentOrderNumber = status;
          this.touch(job);
          this.pushLog(
            job,
            'info',
            `Processando situacao "${status}" (${index}/${total}).`,
          );
        },
        onStatusFinish: ({ status, index, imported, total }) => {
          job.processed = index;
          job.currentOrderNumber = null;
          this.touch(job);
          this.pushLog(
            job,
            'success',
            `Situacao "${status}" concluida com ${imported} pedido(s) consultado(s) (${index}/${total}).`,
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
    } catch (error) {
      if (isSyncCancellationError(error)) {
        job.status = 'canceled';
        job.currentOrderNumber = null;
        job.finishedAt = new Date().toISOString();
        job.error = null;
        this.touch(job);
        this.pushLog(job, 'info', SYNC_CANCELLATION_MESSAGE);
        return;
      }

      job.status = 'failed';
      job.currentOrderNumber = null;
      job.finishedAt = new Date().toISOString();
      job.error =
        error instanceof Error
          ? error.message
          : 'Erro desconhecido na sincronizacao da Magazord.';
      this.touch(job);
      this.pushLog(job, 'error', job.error);
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
}

export const magazordSyncJobService = new MagazordSyncJobService();
