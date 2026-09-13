"use strict";

const {
  ClonarAnuncioService,
  CloneDraftError,
} = require("../services/clonarAnuncioService");

function getContext(req, res) {
  return {
    mlCreds: res.locals?.mlCreds || {},
    accountKey: res.locals?.accountKey || null,
    userId: req.user?.uid || req.user?.id || null,
  };
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
    });
  }

  console.error("[clonar-anuncio] erro:", error?.message || error);
  return res.status(500).json({
    ok: false,
    error: "Erro interno ao processar clonagem de anuncio.",
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

  static async publishDraft(req, res) {
    try {
      const ctx = getContext(req, res);
      const result = await ClonarAnuncioService.publishDraft({
        draftId: req.params.id,
        mlCreds: ctx.mlCreds,
        accountKey: ctx.accountKey,
        userId: ctx.userId,
        skipValidation: req.body?.skip_validation === true,
      });

      return res.json({
        ok: true,
        message: result.already_published
          ? "Este rascunho ja estava publicado."
          : "Anuncio publicado com sucesso.",
        already_published: !!result.already_published,
        publication: result.publication || null,
        draft: result.draft || null,
      });
    } catch (error) {
      return handleError(res, error);
    }
  }
}

module.exports = ClonarAnuncioController;
