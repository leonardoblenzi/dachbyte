const DATABASE_UNAVAILABLE_CODES = new Set(['P1001', 'P1002', 'P1017']);
const DATABASE_AUTH_CODES = new Set(['P1000']);

const collectErrorChain = (error: unknown) => {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  const collected: Array<{ code?: string; message?: string }> = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }

    seen.add(current);

    if (current instanceof Error) {
      collected.push({
        code: (current as Error & { code?: string }).code,
        message: current.message,
      });

      const cause = (current as Error & { cause?: unknown }).cause;
      if (cause) {
        queue.push(cause);
      }
      continue;
    }

    if (typeof current === 'object') {
      const candidate = current as { code?: string; message?: string; cause?: unknown };
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

export const isDatabaseUnavailableError = (error: unknown) => {
  const candidates = collectErrorChain(error);

  return candidates.some(({ code, message }) => {
    const normalizedMessage = String(message || '').toLowerCase();

    return (
      DATABASE_UNAVAILABLE_CODES.has(String(code || '')) ||
      normalizedMessage.includes("can't reach database server") ||
      (normalizedMessage.includes('database server') &&
        normalizedMessage.includes('timed out')) ||
      normalizedMessage.includes('connect econnrefused') ||
      normalizedMessage.includes('getaddrinfo enotfound') ||
      normalizedMessage.includes('connection terminated unexpectedly')
    );
  });
};

export const isDatabaseAuthError = (error: unknown) => {
  const candidates = collectErrorChain(error);

  return candidates.some(({ code, message }) => {
    const normalizedMessage = String(message || '').toLowerCase();

    return (
      DATABASE_AUTH_CODES.has(String(code || '')) ||
      normalizedMessage.includes('authentication failed') ||
      normalizedMessage.includes('password authentication failed')
    );
  });
};

export const toUserFacingDatabaseErrorMessage = (
  error: unknown,
  fallback = 'Erro interno ao processar a operacao.',
) => {
  if (isDatabaseUnavailableError(error)) {
    return 'Banco de dados indisponivel no momento. Nao foi possivel conectar ao servidor do banco. Tente novamente em alguns instantes.';
  }

  if (isDatabaseAuthError(error)) {
    return 'Falha de autenticacao no banco de dados. Verifique a configuracao da conexao antes de tentar novamente.';
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return fallback;
};
