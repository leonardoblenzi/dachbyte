export const SYNC_CANCELLATION_MESSAGE = 'Sincronizacao cancelada pelo usuario.';

export class SyncCancellationError extends Error {
  constructor(message = SYNC_CANCELLATION_MESSAGE) {
    super(message);
    this.name = 'SyncCancellationError';
  }
}

export const isSyncCancellationError = (error: unknown): error is SyncCancellationError =>
  error instanceof SyncCancellationError ||
  (error instanceof Error && error.name === 'SyncCancellationError');
