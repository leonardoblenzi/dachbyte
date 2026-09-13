export interface SyncLogEntry {
  timestamp: string;
  level: 'info' | 'success' | 'error';
  message: string;
}

export interface SyncJobStatus {
  jobId: string;
  companyId: string;
  userId: string;
  status: 'running' | 'completed' | 'failed' | 'canceled';
  total: number;
  processed: number;
  success: number;
  failed: number;
  currentOrderNumber: string | null;
  startedAt: string;
  finishedAt: string | null;
  lastUpdatedAt: string;
  error: string | null;
  cancelRequested?: boolean;
  warnings: string[];
  logs: SyncLogEntry[];
}

export interface SyncScheduleStatus {
  enabled: boolean;
  intervalMs: number;
  nextScheduledAt: string | null;
}
