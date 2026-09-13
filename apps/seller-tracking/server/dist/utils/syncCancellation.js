"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSyncCancellationError = exports.SyncCancellationError = exports.SYNC_CANCELLATION_MESSAGE = void 0;
exports.SYNC_CANCELLATION_MESSAGE = 'Sincronizacao cancelada pelo usuario.';
class SyncCancellationError extends Error {
    constructor(message = exports.SYNC_CANCELLATION_MESSAGE) {
        super(message);
        this.name = 'SyncCancellationError';
    }
}
exports.SyncCancellationError = SyncCancellationError;
const isSyncCancellationError = (error) => error instanceof SyncCancellationError ||
    (error instanceof Error && error.name === 'SyncCancellationError');
exports.isSyncCancellationError = isSyncCancellationError;
