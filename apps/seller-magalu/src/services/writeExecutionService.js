"use strict";

const env = require("../config/env");
const db = require("../config/postgres");
const accountRepository = require("../repositories/accountRepository");
const catalogRepository = require("../repositories/catalogRepository");
const writeRepository = require("../repositories/writeRepository");
const portfolioReadService = require("./portfolioReadService");
const portfolioWriteService = require("./portfolioWriteService");
const catalogPayload = require("./catalogPayload");
const { checkAccountAccess } = require("./hubResourceAccessService");
const { currentFromRemote, equals, scopeFor, hasScope } = require("./writePayload");

const RECONCILIATION_STATES = new Set(["dispatching", "accepted", "divergent", "uncertain"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isReconciliationOnly(operation) {
  return RECONCILIATION_STATES.has(String(operation?.status || "")) || Boolean(operation?.remote_accepted_at);
}

async function remoteResource(account, operation) {
  const reader = operation.resource_type === "price"
    ? portfolioReadService.getPrice
    : portfolioReadService.getStock;
  try {
    const response = await reader(account.id, account.dach_tenant_id, operation.sku);
    return {
      exists: true,
      payload: response.data || {},
      status: response.status || 200,
      requestId: response.requestId || null,
    };
  } catch (error) {
    if (Number(error?.status) === 404) {
      return {
        exists: false,
        payload: {},
        status: 404,
        requestId: error?.requestId || null,
      };
    }
    throw error;
  }
}

async function assertSkuStillExists(account, sku) {
  try {
    return await portfolioReadService.getSku(account.id, account.dach_tenant_id, sku);
  } catch (error) {
    if (Number(error?.status) === 404) {
      const missing = new Error("O SKU não existe mais no portfólio Magalu.");
      missing.code = "MAGALU_WRITE_SKU_NOT_FOUND";
      missing.status = 409;
      throw missing;
    }
    throw error;
  }
}

async function mirrorVerified(accountId, operation, payload) {
  if (operation.resource_type === "price") {
    return catalogRepository.upsertPrice(accountId, operation.sku, payload, {
      httpStatus: 200,
      error: null,
      present: true,
    });
  }
  return catalogRepository.upsertStock(accountId, operation.sku, payload, {
    httpStatus: 200,
    error: null,
    present: true,
  });
}

async function verifyAcceptedWrite(account, operation) {
  for (let attempt = 1; attempt <= env.MAGALU_WRITE_VERIFY_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      await sleep(env.MAGALU_WRITE_VERIFY_DELAY_MS * Math.min(attempt, 4));
    }
    const remote = await remoteResource(account, operation);
    if (remote.exists) {
      const current = currentFromRemote(operation.resource_type, remote.payload, catalogPayload);
      if (equals(operation.resource_type, current, operation.requested_payload)) {
        await mirrorVerified(account.id, operation, remote.payload);
        return {
          verified: true,
          payload: remote.payload,
          current,
          requestId: remote.requestId || null,
        };
      }
    }
  }
  return { verified: false };
}

async function fail(operation, code, message, details = {}) {
  const saved = await writeRepository.finishOperation(operation.id, {
    status: details.status || "failed",
    afterPayload: details.afterPayload || null,
    errorCode: code,
    errorMessage: message,
    responseStatus: details.responseStatus || null,
    responsePayload: details.responsePayload || null,
    requestId: details.requestId || null,
    actualMethod: details.actualMethod || null,
  });
  await writeRepository.appendAudit({
    accountId: operation.account_id,
    operationId: operation.id,
    dachTenantId: operation.dach_tenant_id,
    dachUserId: operation.dach_user_id,
    action: details.status === "stale"
      ? "WRITE_STALE"
      : details.status === "divergent"
        ? "WRITE_DIVERGENT"
        : details.status === "uncertain"
          ? "WRITE_UNCERTAIN"
          : "WRITE_FAILED",
    resourceType: operation.resource_type,
    sku: operation.sku,
    details: {
      code,
      message,
      response_status: details.responseStatus || null,
      request_id: details.requestId || null,
      hub_reason: details.hubReason || null,
    },
  });
  return saved;
}

async function reconcileWithoutWrite(account, operation) {
  const verification = await verifyAcceptedWrite(account, operation);
  if (verification.verified) {
    const saved = await writeRepository.finishOperation(operation.id, {
      status: "succeeded",
      afterPayload: verification.payload,
      requestId: verification.requestId,
      actualMethod: operation.actual_method || null,
    });
    await writeRepository.appendAudit({
      accountId: operation.account_id,
      operationId: operation.id,
      dachTenantId: operation.dach_tenant_id,
      dachUserId: operation.dach_user_id,
      action: "WRITE_VERIFIED",
      resourceType: operation.resource_type,
      sku: operation.sku,
      details: {
        resumed: true,
        previous_status: operation.status,
        write_enabled: env.MAGALU_WRITE_ENABLED,
      },
    });
    return saved;
  }

  const confirmedAccepted = operation.status === "accepted"
    || operation.status === "divergent"
    || Boolean(operation.remote_accepted_at);
  return fail(
    operation,
    confirmedAccepted ? "MAGALU_WRITE_NOT_CONVERGED" : "MAGALU_WRITE_RESULT_UNCERTAIN",
    confirmedAccepted
      ? "A API aceitou a alteração, mas a leitura não convergiu dentro da janela de verificação."
      : "A operação entrou em envio, mas não é seguro afirmar se o Magalu recebeu a alteração. Nenhum reenvio automático será feito.",
    {
      status: confirmedAccepted ? "divergent" : "uncertain",
      actualMethod: operation.actual_method,
    },
  );
}

async function assertFreshHubWriteAccess(operation, account) {
  const hub = await checkAccountAccess(
    {
      dachTenantId: operation.dach_tenant_id,
      dachUserId: operation.dach_user_id,
    },
    account,
    { force: true, action: "WRITE magalu" },
  );
  if (hub.allow) return hub;

  const error = new Error("O Hub não confirmou acesso para executar a alteração no Magalu.");
  error.code = "MAGALU_WRITE_HUB_ACCESS_DENIED";
  error.status = 403;
  error.hubReason = hub.reason || "hub_denied";
  throw error;
}

async function executeOperation(operationId) {
  const original = await writeRepository.getOperation(operationId);
  if (!original) throw new Error(`Operação Magalu inexistente: ${operationId}`);
  if (!["queued", "running", "dispatching", "accepted", "divergent", "uncertain"].includes(String(original.status))) {
    return original;
  }

  return db.withClient(async (client) => {
    const unlock = await writeRepository.acquireOperationLock(client, original);
    try {
      let operation = await writeRepository.getOperation(operationId);
      if (!operation) throw new Error(`Operação Magalu inexistente: ${operationId}`);
      if (operation.status === "queued") {
        operation = await writeRepository.claimOperation(operationId) || operation;
      }
      if (!["running", "dispatching", "accepted", "divergent", "uncertain"].includes(operation.status)) {
        return operation;
      }

      const account = await accountRepository.findAccountById(operation.account_id);
      if (!account || String(account.dach_tenant_id) !== String(operation.dach_tenant_id)) {
        return fail(
          operation,
          "MAGALU_WRITE_ACCOUNT_MISMATCH",
          "Conta/tenant não correspondem à operação gravada.",
        );
      }

      // Estados pós-dispatch são sempre reconciliados por GET primeiro. A flag
      // de escrita ou a perda de write scope não podem transformar uma
      // incerteza remota em 'failed' nem liberar o SKU sem verificação.
      if (isReconciliationOnly(operation)) {
        return reconcileWithoutWrite(account, operation);
      }

      // A partir daqui ainda NÃO houve dispatch remoto nesta execução.
      if (!env.MAGALU_WRITE_ENABLED) {
        return fail(
          operation,
          "MAGALU_WRITE_DISABLED",
          "Escritas Magalu foram desativadas antes da execução.",
        );
      }
      const requiredScope = scopeFor(operation.resource_type);
      if (!hasScope(account.scopes, requiredScope)) {
        return fail(
          operation,
          "MAGALU_WRITE_SCOPE_MISSING",
          `Scope ausente: ${requiredScope}.`,
        );
      }

      await assertSkuStillExists(account, operation.sku);
      const beforeRemote = await remoteResource(account, operation);
      const current = beforeRemote.exists
        ? currentFromRemote(operation.resource_type, beforeRemote.payload, catalogPayload)
        : {};

      if (beforeRemote.exists && equals(operation.resource_type, current, operation.requested_payload)) {
        await mirrorVerified(account.id, operation, beforeRemote.payload);
        const saved = await writeRepository.finishOperation(operation.id, {
          status: "succeeded",
          afterPayload: beforeRemote.payload,
          requestId: beforeRemote.requestId,
        });
        await writeRepository.appendAudit({
          accountId: operation.account_id,
          operationId: operation.id,
          dachTenantId: operation.dach_tenant_id,
          dachUserId: operation.dach_user_id,
          action: "WRITE_ALREADY_APPLIED",
          resourceType: operation.resource_type,
          sku: operation.sku,
          details: {},
        });
        return saved;
      }

      const previewExpectedExists = Object.keys(operation.before_payload || {}).length > 0;
      const stateChanged = previewExpectedExists !== beforeRemote.exists
        || (previewExpectedExists && !equals(operation.resource_type, current, operation.before_payload));
      if (stateChanged) {
        return fail(
          operation,
          "MAGALU_REMOTE_STATE_CHANGED",
          "O estado remoto mudou após o preview. Gere um novo preview antes de sobrescrever.",
          { status: "stale", afterPayload: beforeRemote.payload },
        );
      }

      // Última autorização antes de qualquer POST/PATCH. Não usa o cache do
      // Hub: uma revogação ocorrida enquanto o job aguardava na fila bloqueia
      // a escrita sem tocar o recurso remoto.
      try {
        await assertFreshHubWriteAccess(operation, account);
      } catch (error) {
        if (error?.code !== "MAGALU_WRITE_HUB_ACCESS_DENIED") throw error;
        return fail(operation, error.code, error.message, { hubReason: error.hubReason });
      }

      const method = beforeRemote.exists ? "PATCH" : "POST";
      operation = await writeRepository.setOperationDispatching(operation.id, {
        method,
        requestId: operation.idempotency_key,
      }) || {
        ...operation,
        status: "dispatching",
        actual_method: method,
        request_id: operation.idempotency_key,
      };
      await writeRepository.appendAudit({
        accountId: operation.account_id,
        operationId: operation.id,
        dachTenantId: operation.dach_tenant_id,
        dachUserId: operation.dach_user_id,
        action: "WRITE_DISPATCHING",
        resourceType: operation.resource_type,
        sku: operation.sku,
        details: { method, request_id: operation.idempotency_key },
      });

      let response;
      try {
        response = await portfolioWriteService.writeResource(
          account.id,
          account.dach_tenant_id,
          operation.resource_type,
          operation.sku,
          operation.requested_payload,
          {
            exists: beforeRemote.exists,
            requestId: operation.idempotency_key,
          },
        );
      } catch (error) {
        // Depois de entrar em dispatching, timeout/network/5xx são tratados
        // como INCERTOS. O retry BullMQ reencontra dispatching e executa GET,
        // sem repetir POST/PATCH.
        const status = Number(error?.status) || null;
        const uncertain = !status || status === 408 || status >= 500;
        const code = uncertain
          ? "MAGALU_WRITE_RESULT_UNCERTAIN"
          : status === 429
            ? "MAGALU_WRITE_RATE_LIMITED"
            : error?.code || `MAGALU_WRITE_HTTP_${status || "ERROR"}`;
        return fail(operation, code, error?.message || String(error), {
          status: uncertain ? "uncertain" : "failed",
          responseStatus: status,
          responsePayload: error?.payload || null,
          requestId: error?.requestId || operation.idempotency_key,
          actualMethod: method,
        });
      }

      operation = await writeRepository.setOperationAccepted(operation.id, {
        method,
        responseStatus: response.status,
        responsePayload: response.data,
        requestId: response.requestId || operation.idempotency_key,
      });
      await writeRepository.appendAudit({
        accountId: operation.account_id,
        operationId: operation.id,
        dachTenantId: operation.dach_tenant_id,
        dachUserId: operation.dach_user_id,
        action: "WRITE_ACCEPTED",
        resourceType: operation.resource_type,
        sku: operation.sku,
        details: {
          method,
          response_status: response.status,
          request_id: response.requestId || null,
        },
      });

      const verification = await verifyAcceptedWrite(account, operation);
      if (!verification.verified) {
        return fail(
          operation,
          "MAGALU_WRITE_NOT_CONVERGED",
          "A API aceitou a alteração, mas a leitura não convergiu dentro da janela de verificação.",
          { status: "divergent", actualMethod: method },
        );
      }

      const saved = await writeRepository.finishOperation(operation.id, {
        status: "succeeded",
        afterPayload: verification.payload,
        requestId: verification.requestId || response.requestId,
        actualMethod: method,
      });
      await writeRepository.appendAudit({
        accountId: operation.account_id,
        operationId: operation.id,
        dachTenantId: operation.dach_tenant_id,
        dachUserId: operation.dach_user_id,
        action: "WRITE_VERIFIED",
        resourceType: operation.resource_type,
        sku: operation.sku,
        details: { method },
      });
      return saved;
    } finally {
      await unlock();
    }
  });
}

module.exports = {
  executeOperation,
  _test: {
    remoteResource,
    verifyAcceptedWrite,
    assertSkuStillExists,
    assertFreshHubWriteAccess,
    isReconciliationOnly,
  },
};
