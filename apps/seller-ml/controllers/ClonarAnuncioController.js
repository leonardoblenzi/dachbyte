"use strict";

const {
  ClonarAnuncioService,
  CloneDraftError,
} = require("../services/clonarAnuncioService");
const CloneBilling = require("../services/clonarAnuncioBillingService");
const {
  getRequestIp,
  getRequestUserAgent,
  recordAuthEvent,
} = require("../services/authAuditService");

function getContext(req, res) {
  return {
    mlCreds: res.locals?.mlCreds || {},
    accountKey: res.locals?.accountKey || null,
    accountLabel: res.locals?.accountLabel || res.locals?.accountKey || null,
    account: res.locals?.account || null,
    userId: req.user?.uid || req.user?.id || null,
    email: req.user?.email || null,
  };
}

async function auditClone(req, res, evento, status, metadata = {}) {
  const ctx = getContext(req, res);
  return recordAuthEvent({
    userId: Number(ctx.userId) || null,
    email: ctx.email,
    evento,
    status,
    ip: getRequestIp(req),
    userAgent: getRequestUserAgent(req),
    metadata: {
      accountKey: ctx.accountKey,
      accountLabel: ctx.accountLabel,
      meli_conta_id: ctx.mlCreds?.meli_conta_id || null,
      route: req.originalUrl || req.url || null,
      method: req.method,
      ...metadata,
    },
  }).catch((auditError) => {
    console.error("[clonar-anuncio] audit erro:", auditError?.message || auditError);
  });
}

function handleError(res, error) {
  if (error instanceof CloneDraftError) {
    const upstreamStatus = Number(error.status || 0);
    const isMlApiError = error.code === "ml_api_error";
    const status = isMlApiError && upstreamStatus !== 404
      ? 502
      : error.status || 400;
    const blockedByMl = isMlApiError && upstreamStatus === 403;
    const message = blockedByMl
      ? "O Mercado Livre bloqueou o acesso aos dados desse MLB. Verifique se o anuncio esta ativo/publico ou se pertence a conta selecionada."
      : error.message;

    return res.status(status).json({
      ok: false,
      error: message,
      code: error.code || "clone_draft_error",
      upstream_status: isMlApiError ? upstreamStatus || null : undefined,
      ...(error.details ? { details: error.details } : {}),
      ...(error.billingTelemetry
        ? { billing_telemetry: error.billingTelemetry }
        : {}),
    });
  }

  console.error("[clonar-anuncio] erro:", error?.message || error);
  return res.status(500).json({
    ok: false,
    error: "Erro interno ao processar clonagem de anuncio.",
    ...(error?.billingTelemetry
      ? { billing_telemetry: error.billingTelemetry }
      : {}),
  });
}

class ClonarAnuncioController {
  static async preview(req, res) {
    try {
      const source = req.body?.url || req.body?.source || req.body?.item || "";
      const ctx = getContext(req, res);
      const preview = await ClonarAnuncioService.fetchPreviewFromSource({
        source,
        mlCreds: ctx.mlCreds,
        accountKey: ctx.accountKey,
      });
      return res.json({ ok: true, preview });
    } catch (error) {
      return handleError(res, error);
    }
  }

  static async createDraft(req, res) {
    try {
      const source = req.body?.url || req.body?.source || req.body?.item || "";
      const ctx = getContext(req, res);
      const draft = await ClonarAnuncioService.createDraftFromSource({
        source,
        mlCreds: ctx.mlCreds,
        accountKey: ctx.accountKey,
        userId: ctx.userId,
      });
      return res.status(201).json({
        ok: true,
        message: "Rascunho criado em revisao. Ajuste conteudo e atributos antes de publicar.",
        draft,
      });
    } catch (error) {
      return handleError(res, error);
    }
  }

  static async createDraftFromBrowserCapture(req, res) {
    try {
      const source = req.body?.url || req.body?.source || "";
      const html = req.body?.html || "";
      const ctx = getContext(req, res);
      const draft = await ClonarAnuncioService.createDraftFromBrowserCapture({
        source,
        html,
        mlCreds: ctx.mlCreds,
        accountKey: ctx.accountKey,
        userId: ctx.userId,
      });
      return res.status(201).json({
        ok: true,
        message: "Captura do navegador importada. Revise o rascunho antes de publicar.",
        draft,
      });
    } catch (error) {
      return handleError(res, error);
    }
  }

  static async listDrafts(req, res) {
    try {
      const ctx = getContext(req, res);
      const drafts = await ClonarAnuncioService.listDrafts({
        mlCreds: ctx.mlCreds,
        accountKey: ctx.accountKey,
        limit: req.query?.limit,
      });
      return res.json({ ok: true, drafts });
    } catch (error) {
      return handleError(res, error);
    }
  }

  static async getDraft(req, res) {
    try {
      const ctx = getContext(req, res);
      const draft = await ClonarAnuncioService.getDraftById({
        draftId: req.params.id,
        mlCreds: ctx.mlCreds,
        accountKey: ctx.accountKey,
      });
      return res.json({ ok: true, draft });
    } catch (error) {
      return handleError(res, error);
    }
  }

  static async updateDraft(req, res) {
    try {
      const ctx = getContext(req, res);
      const draft = await ClonarAnuncioService.updateDraftReview({
        draftId: req.params.id,
        patch: req.body || {},
        mlCreds: ctx.mlCreds,
        accountKey: ctx.accountKey,
        userId: ctx.userId,
      });
      return res.json({
        ok: true,
        message: "Rascunho atualizado.",
        draft,
      });
    } catch (error) {
      return handleError(res, error);
    }
  }

  static async validateDraft(req, res) {
    try {
      const ctx = getContext(req, res);
      const validation = await ClonarAnuncioService.validateDraftAgainstMl({
        draftId: req.params.id,
        mlCreds: ctx.mlCreds,
        accountKey: ctx.accountKey,
        userId: ctx.userId,
      });

      const blockingValidation = !validation.ok && validation.warnings_only !== true;

      return res.status(blockingValidation ? 422 : 200).json({
        ok: !blockingValidation,
        validation,
      });
    } catch (error) {
      return handleError(res, error);
    }
  }

  static async quotePublishCredits(req, res) {
    try {
      const ctx = getContext(req, res);
      const draft = await ClonarAnuncioService.getDraftById({
        draftId: req.params.id,
        mlCreds: ctx.mlCreds,
        accountKey: ctx.accountKey,
      });
      const alreadyPublished =
        draft?.status === "publicado" && !!draft?.published_item_id;
      const quote = await CloneBilling.previewCloneCredits({
        mlCreds: ctx.mlCreds,
        account: ctx.account,
        draftId: req.params.id,
        alreadyPublished,
      });
      return res.json({ ok: true, ...quote });
    } catch (error) {
      return handleError(res, error);
    }
  }

  static async publishDraft(req, res) {
    const startedAt = Date.now();
    const ctx = getContext(req, res);
    const draftId = Number(req.params.id);
    let operationId = null;
    let reservation = null;

    try {
      const currentDraft = await ClonarAnuncioService.getDraftById({
        draftId,
        mlCreds: ctx.mlCreds,
        accountKey: ctx.accountKey,
      });
      const alreadyPublished =
        currentDraft?.status === "publicado" && !!currentDraft?.published_item_id;

      if (!alreadyPublished) {
        operationId = CloneBilling.cloneOperationId(draftId);
        reservation = await CloneBilling.reserveCloneCredits({
          mlCreds: ctx.mlCreds,
          draftId,
          operationId,
        });
        await auditClone(req, res, "listing_clone_publish_started", "success", {
          operation_id: operationId,
          operation_key: CloneBilling.OPERATION_KEY,
          draft_id: draftId,
        });
      }

      const result = await ClonarAnuncioService.publishDraft({
        draftId,
        mlCreds: ctx.mlCreds,
        accountKey: ctx.accountKey,
        userId: ctx.userId,
        skipValidation: req.body?.skip_validation === true,
      });

      const publishedItemId = result?.publication?.item_id || null;
      await CloneBilling.settleCloneCredits(reservation, {
        publishedItemId,
        alreadyPublished: !!result.already_published,
      });

      const billingTelemetry = CloneBilling.cloneBillingTelemetry({
        reservation,
        operationId,
        draftId,
        publishedItemId,
        alreadyPublished: !!result.already_published,
        publishAttempts: result?.publication?.publish_attempts || 0,
        validationAttempts: result?.publication?.validation_attempts || 0,
        startedAt,
        finishedAt: Date.now(),
      });

      await auditClone(req, res, "listing_clone_publish_completed", "success", {
        operation_id: operationId,
        operation_key: CloneBilling.OPERATION_KEY,
        draft_id: draftId,
        published_item_id: publishedItemId,
        already_published: !!result.already_published,
        billing_telemetry: billingTelemetry,
      });

      return res.json({
        ok: true,
        message: result.already_published
          ? "Este rascunho ja estava publicado."
          : "Anuncio publicado com sucesso.",
        already_published: !!result.already_published,
        publication: result.publication || null,
        draft: result.draft || null,
        billing_telemetry: billingTelemetry,
      });
    } catch (error) {
      const publishedItemId =
        error?.publishedItemId ||
        error?.details?.published_item_id ||
        null;

      await CloneBilling.settleCloneCredits(reservation, {
        publishedItemId,
        alreadyPublished: false,
      }).catch(() => {});

      const billingTelemetry = CloneBilling.cloneBillingTelemetry({
        reservation,
        operationId,
        draftId,
        publishedItemId,
        alreadyPublished: false,
        publishAttempts:
          error?.publishAttempts ||
          error?.details?.publish_attempts ||
          0,
        validationAttempts:
          error?.validationAttempts ||
          error?.details?.validation_attempts ||
          0,
        startedAt,
        failedAt: Date.now(),
        error: error?.message || error,
      });

      error.billingTelemetry = billingTelemetry;
      await auditClone(
        req,
        res,
        "listing_clone_publish_failed",
        publishedItemId ? "warn" : "error",
        {
          operation_id: operationId,
          operation_key: CloneBilling.OPERATION_KEY,
          draft_id: draftId,
          published_item_id: publishedItemId,
          billing_telemetry: billingTelemetry,
          error: String(error?.message || error).slice(0, 500),
        },
      );

      return handleError(res, error);
    }
  }
}

module.exports = ClonarAnuncioController;
