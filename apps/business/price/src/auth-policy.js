"use strict";

function policyError(message, code, statusCode) {
  return Object.assign(new Error(message), { code, statusCode });
}

function resolveLoginScope({ platformRole, memberships }) {
  if (platformRole) {
    return { isPlatformAdmin: true, role: platformRole, tenantId: null, tenant: null };
  }

  const activeMemberships = Array.isArray(memberships) ? memberships : [];
  if (activeMemberships.length === 0) {
    throw policyError("Usuario sem acesso a uma empresa ativa.", "no_workspace", 403);
  }
  if (activeMemberships.length > 1) {
    throw policyError("A configuracao de workspaces desta conta nao permite o login.", "multiple_workspaces_not_allowed", 409);
  }

  const tenant = activeMemberships[0];
  return { isPlatformAdmin: false, role: tenant.role, tenantId: tenant.tenant_id, tenant };
}

function assertPasswordChangeComplete({ mustChangePassword }) {
  if (mustChangePassword) {
    throw policyError("A troca de senha deve ser concluida antes de acessar este recurso.", "password_change_required", 403);
  }
}

module.exports = { resolveLoginScope, assertPasswordChangeComplete };
