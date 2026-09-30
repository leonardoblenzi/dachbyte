"use strict";

const accountRepository = require("../repositories/accountRepository");
const { checkAccountAccess } = require("../services/hubResourceAccessService");
const promotionCapabilityService = require("../services/promotionCapabilityService");
const promotionReadService = require("../services/promotionReadService");

function accountNotFoundError() {
  const error = new Error("Conta Magalu não encontrada para este tenant DACH.");
  error.code = "MAGALU_ACCOUNT_NOT_FOUND";
  error.status = 404;
  return error;
}

async function resolveAccount(req) {
  const accountId = Number.parseInt(String(req.query?.account_id || req.params?.accountId || ""), 10);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    const error = new Error("Selecione uma conta Magalu.");
    error.code = "MAGALU_ACCOUNT_REQUIRED";
    error.status = 400;
    throw error;
  }

  const account = await accountRepository.findAccountByIdForTenant(
    accountId,
    req.magaluIdentity.dachTenantId,
  );
  if (!account) throw accountNotFoundError();
  return account;
}

async function requirePromotionRead(req, account) {
  const hub = await checkAccountAccess(req.magaluIdentity, account, { action: "READ magalu" });
  if (!hub.allow) throw accountNotFoundError();

  if (!promotionCapabilityService.forAccount(account).list) {
    const error = new Error("Reconecte a conta Magalu para liberar a leitura de promoções.");
    error.code = "MAGALU_PROMOTIONS_SCOPE_REQUIRED";
    error.status = 409;
    throw error;
  }
}

async function list(req, res, next) {
  try {
    const account = await resolveAccount(req);
    await requirePromotionRead(req, account);
    const result = await promotionReadService.list(account, {
      force: String(req.query?.refresh || "") === "1",
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return next(error);
  }
}

async function detail(req, res, next) {
  try {
    const promotionId = String(req.params?.promotionId || "").trim();
    if (!promotionId) {
      const error = new Error("Informe a promoção para consultar seus detalhes.");
      error.code = "MAGALU_PROMOTION_ID_REQUIRED";
      error.status = 400;
      throw error;
    }
    const account = await resolveAccount(req);
    await requirePromotionRead(req, account);
    const result = await promotionReadService.detail(account, promotionId, {
      force: String(req.query?.refresh || "") === "1",
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return next(error);
  }
}

module.exports = { list, detail, _test: { resolveAccount, requirePromotionRead } };
