const {
  findShopForAccountById,
} = require("../repositories/runtimeSqlRepository");
const ListingCloneService = require("../services/ListingCloneService");

async function getActiveShopOrFail(req, res) {
  if (!req.auth) {
    res.status(401).json({ error: "unauthorized" });
    return null;
  }

  const shopDbId = req.auth.activeShopId || null;
  if (!shopDbId) {
    res.status(409).json({
      error: "select_shop_required",
      message: "Selecione uma loja para continuar.",
    });
    return null;
  }

  const shop = await findShopForAccountById(shopDbId, req.auth.accountId);
  if (!shop) {
    res.status(404).json({ error: "shop_not_found" });
    return null;
  }

  return shop;
}

async function preview(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop) return;

  const sourceUrl = String(req.body?.sourceUrl || "").trim();
  if (!sourceUrl) {
    return res.status(400).json({
      error: "source_url_required",
      message: "Cole um link público de produto.",
    });
  }

  const draft = await ListingCloneService.buildCloneDraft({ shop, sourceUrl });
  return res.json({ draft });
}

async function categoryAttributes(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop) return;

  const categoryId = String(req.body?.categoryId || "").trim();
  if (!categoryId) {
    return res.status(400).json({
      error: "category_id_required",
      message: "Informe a categoria Shopee para carregar os atributos.",
    });
  }

  const result = await ListingCloneService.previewCategoryAttributes({
    shop,
    categoryId,
    sourceAttributes: Array.isArray(req.body?.sourceAttributes)
      ? req.body.sourceAttributes
      : [],
    sourceSpecifications: Array.isArray(req.body?.sourceSpecifications)
      ? req.body.sourceSpecifications
      : [],
  });

  return res.json(result);
}

async function categories(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop) return;

  const result = await ListingCloneService.listCategoryTree({ shop });
  return res.json(result);
}

async function listDrafts(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop) return;

  const result = await ListingCloneService.listDrafts({ shop });
  return res.json(result);
}

async function getDraft(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop) return;

  const draftId = Number(req.params?.draftId);
  if (!Number.isFinite(draftId) || draftId <= 0) {
    return res.status(400).json({
      error: "draft_id_invalid",
      message: "Informe um rascunho vÃ¡lido.",
    });
  }

  const result = await ListingCloneService.getDraft({ shop, draftId });
  return res.json(result);
}

async function saveDraft(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop) return;

  const draft = req.body?.draft;
  if (!draft || typeof draft !== "object") {
    return res.status(400).json({
      error: "draft_required",
      message: "O rascunho do anúncio é obrigatório para salvar.",
    });
  }

  const result = await ListingCloneService.saveDraft({
    shop,
    userId: req.auth?.userId || null,
    draft,
  });
  return res.json(result);
}

async function deleteDraft(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop) return;

  const draftId = Number(req.params?.draftId);
  if (!Number.isFinite(draftId) || draftId <= 0) {
    return res.status(400).json({
      error: "draft_id_invalid",
      message: "Informe um rascunho vÃ¡lido.",
    });
  }

  const result = await ListingCloneService.removeDraft({ shop, draftId });
  return res.json(result);
}

async function validateLogistics(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop) return;

  const draft = req.body?.draft;
  if (!draft || typeof draft !== "object") {
    return res.status(400).json({
      error: "draft_required",
      message: "O rascunho do anúncio é obrigatório para validar a logística.",
    });
  }

  const result = await ListingCloneService.validateDraftLogistics({ draft });
  return res.json(result);
}

async function uploadImages(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop) return;

  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) {
    return res.status(400).json({
      error: "no_images_uploaded",
      message: "Selecione ao menos uma imagem para enviar.",
    });
  }

  const business = Number(req.body?.business || 1);
  const scene = Number(req.body?.scene || 1);

  const result = await ListingCloneService.uploadCloneImages({
    files,
    business,
    scene,
  });

  return res.json(result);
}

async function uploadVideo(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop) return;

  const file = req.file || null;
  if (!file) {
    return res.status(400).json({
      error: "no_video_uploaded",
      message: "Selecione um arquivo MP4 para enviar.",
    });
  }

  const business = Number(req.body?.business || 1);
  const scene = Number(req.body?.scene || 1);

  const result = await ListingCloneService.uploadCloneVideo({
    shop,
    file,
    business,
    scene,
  });

  return res.json(result);
}

async function publish(req, res) {
  const shop = await getActiveShopOrFail(req, res);
  if (!shop) return;

  const draft = req.body?.draft;
  if (!draft || typeof draft !== "object") {
    return res.status(400).json({
      error: "draft_required",
      message: "O rascunho do anúncio é obrigatório para publicar.",
    });
  }

  const result = await ListingCloneService.publishDraft({ shop, draft });
  return res.json(result);
}

module.exports = {
  preview,
  categoryAttributes,
  categories,
  listDrafts,
  getDraft,
  saveDraft,
  deleteDraft,
  validateLogistics,
  uploadImages,
  uploadVideo,
  publish,
};
