import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: 'validation_error',
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message
        }))
      });
    }

    const maybePgError = error as { code?: string };

    if (maybePgError.code === '23505') {
      return reply.code(409).send({
        error: 'conflict',
        message: 'Registro duplicado dentro do tenant.'
      });
    }

    app.log.error(error);
    return reply.code(500).send({
      error: 'internal_error',
      message: 'Erro interno ao processar a requisicao.'
    });
  });
}
