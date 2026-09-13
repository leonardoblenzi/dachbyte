"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toUserFacingDatabaseErrorMessage = exports.isDatabaseAuthError = exports.isDatabaseUnavailableError = void 0;
const DATABASE_UNAVAILABLE_CODES = new Set(['P1001', 'P1002', 'P1017']);
const DATABASE_AUTH_CODES = new Set(['P1000']);
const collectErrorChain = (error) => {
    const queue = [error];
    const seen = new Set();
    const collected = [];
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current || seen.has(current)) {
            continue;
        }
        seen.add(current);
        if (current instanceof Error) {
            collected.push({
                code: current.code,
                message: current.message,
            });
            const cause = current.cause;
            if (cause) {
                queue.push(cause);
            }
            continue;
        }
        if (typeof current === 'object') {
            const candidate = current;
            collected.push({
                code: candidate.code,
                message: candidate.message,
            });
            if (candidate.cause) {
                queue.push(candidate.cause);
            }
        }
    }
    return collected;
};
const isDatabaseUnavailableError = (error) => {
    const candidates = collectErrorChain(error);
    return candidates.some(({ code, message }) => {
        const normalizedMessage = String(message || '').toLowerCase();
        return (DATABASE_UNAVAILABLE_CODES.has(String(code || '')) ||
            normalizedMessage.includes("can't reach database server") ||
            (normalizedMessage.includes('database server') &&
                normalizedMessage.includes('timed out')) ||
            normalizedMessage.includes('connect econnrefused') ||
            normalizedMessage.includes('getaddrinfo enotfound') ||
            normalizedMessage.includes('connection terminated unexpectedly'));
    });
};
exports.isDatabaseUnavailableError = isDatabaseUnavailableError;
const isDatabaseAuthError = (error) => {
    const candidates = collectErrorChain(error);
    return candidates.some(({ code, message }) => {
        const normalizedMessage = String(message || '').toLowerCase();
        return (DATABASE_AUTH_CODES.has(String(code || '')) ||
            normalizedMessage.includes('authentication failed') ||
            normalizedMessage.includes('password authentication failed'));
    });
};
exports.isDatabaseAuthError = isDatabaseAuthError;
const toUserFacingDatabaseErrorMessage = (error, fallback = 'Erro interno ao processar a operacao.') => {
    if ((0, exports.isDatabaseUnavailableError)(error)) {
        return 'Banco de dados indisponivel no momento. Nao foi possivel conectar ao servidor do banco. Tente novamente em alguns instantes.';
    }
    if ((0, exports.isDatabaseAuthError)(error)) {
        return 'Falha de autenticacao no banco de dados. Verifique a configuracao da conexao antes de tentar novamente.';
    }
    if (error instanceof Error && error.message.trim()) {
        return error.message;
    }
    return fallback;
};
exports.toUserFacingDatabaseErrorMessage = toUserFacingDatabaseErrorMessage;
