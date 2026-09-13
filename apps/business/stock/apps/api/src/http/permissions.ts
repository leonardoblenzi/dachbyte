import type { FastifyReply, FastifyRequest } from 'fastify';
import { hasAnyPermission, type VoltPermission, type VoltRole } from '@voltstock/shared';

export function requireAnyPermission(permissions: readonly VoltPermission[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const role = request.auth.role as VoltRole;

    if (!hasAnyPermission(role, permissions)) {
      return reply.code(403).send({
        error: 'forbidden',
        message: 'Permissao insuficiente para esta operacao.'
      });
    }
  };
}
