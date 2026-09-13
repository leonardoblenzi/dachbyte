"use strict";

const draftService = require("../services/anuncioCadastro/anuncioDraftService");
const sourceService = require("../services/anuncioCadastro/anuncioSourceService");
const categoryService = require("../services/anuncioCadastro/anuncioCategoryService");
const capabilitiesService = require("../services/anuncioCadastro/anuncioCapabilitiesService");
const validationService = require("../services/anuncioCadastro/anuncioValidationService");
const publicationService = require("../services/anuncioCadastro/anuncioPublicationService");
const pictureService = require("../services/anuncioCadastro/anuncioPictureService");
const groupService = require("../services/anuncioCadastro/anuncioDraftGroupService");
const familyCloneService = require("../services/anuncioCadastro/anuncioFamilyCloneService");
const { requestContext } = require("../services/anuncioCadastro/helpers");

function ctx(req, res) {
  return requestContext(req, res);
}

function handleError(res, error, fallback = "Falha no Cadastro de anúncios.") {
  const status = Number(error?.status);
  return res.status(status >= 400 && status < 600 ? status : 500).json({
    ok: false,
    error: error?.message || fallback,
    code: error?.code || null,
    details: error?.details || error?.mlPayload || null,
  });
}

module.exports = {
  async capabilities(req, res) {
    try { return res.json({ ok: true, capabilities: await capabilitiesService.getCapabilities(ctx(req, res)) }); }
    catch (error) { return handleError(res, error); }
  },

  async resolveSource(req, res) {
    try { return res.json({ ok: true, source: await sourceService.resolveSource(req.body || {}, ctx(req, res)) }); }
    catch (error) { return handleError(res, error, "Não foi possível consultar a origem informada."); }
  },

  async searchOwn(req, res) {
    try { return res.json({ ok: true, ...(await sourceService.searchOwnItems(req.query || {}, ctx(req, res))) }); }
    catch (error) { return handleError(res, error, "Não foi possível buscar os anúncios da conta."); }
  },

  async suggestCategories(req, res) {
    try { return res.json({ ok: true, items: await categoryService.suggestCategories(req.query?.q, ctx(req, res)) }); }
    catch (error) { return handleError(res, error); }
  },

  async categoryAttributes(req, res) {
    try { return res.json({ ok: true, ...(await categoryService.getAttributes(req.params.categoryId, ctx(req, res))) }); }
    catch (error) { return handleError(res, error); }
  },

  async listingTypes(req, res) {
    try { return res.json({ ok: true, items: await categoryService.listingTypes(ctx(req, res)) }); }
    catch (error) { return handleError(res, error); }
  },

  async uploadPicture(req, res) {
    try { return res.status(201).json({ ok: true, picture: await pictureService.uploadPicture(req.file, ctx(req, res)) }); }
    catch (error) { return handleError(res, error, "Não foi possível enviar a imagem."); }
  },

  async createBlank(req, res) {
    try { return res.status(201).json({ ok: true, draft: await draftService.createBlank(req.body?.draft_data || {}, ctx(req, res)) }); }
    catch (error) { return handleError(res, error); }
  },
  async listGroups(req, res) {
    try { return res.json({ ok: true, items: await groupService.listGroups(req.query || {}, ctx(req, res)) }); }
    catch (error) { return handleError(res, error, "Não foi possível listar os grupos de rascunhos."); }
  },

  async getGroup(req, res) {
    try { return res.json({ ok: true, group: await groupService.getGroup(req.params.id, ctx(req, res)) }); }
    catch (error) { return handleError(res, error, "Não foi possível consultar o grupo."); }
  },

  async createBatchCopies(req, res) {
    try { return res.status(201).json({ ok: true, ...(await groupService.createBatchCopies(req.body || {}, ctx(req, res))) }); }
    catch (error) { return handleError(res, error, "Não foi possível criar as cópias em lote."); }
  },

  async previewFamilyClone(req, res) {
    try { return res.json({ ok: true, family: await familyCloneService.discoverFamilyFromItem(req.body?.input || req.body?.source_item_id, ctx(req, res)) }); }
    catch (error) { return handleError(res, error, "Não foi possível descobrir a família do anúncio."); }
  },

  async createFamilyClone(req, res) {
    try { return res.status(201).json({ ok: true, ...(await familyCloneService.createFamilyClone(req.body || {}, ctx(req, res))) }); }
    catch (error) { return handleError(res, error, "Não foi possível clonar as variações selecionadas."); }
  },


  async createFromSource(req, res) {
    try {
      const type = String(req.body?.type || "item");
      if (type === "family") {
        const result = await draftService.createFromFamily(req.body?.input, ctx(req, res));
        return res.status(201).json({ ok: true, ...result });
      }
      const draft = await draftService.createFromItem(req.body?.input, ctx(req, res), {
        expected: req.body?.expected,
        publicationTarget: req.body?.publication_target,
      });
      return res.status(201).json({ ok: true, draft });
    } catch (error) { return handleError(res, error, "Não foi possível criar o rascunho a partir da origem."); }
  },

  async listDrafts(req, res) {
    try { return res.json({ ok: true, ...(await draftService.listDrafts(req.query || {}, ctx(req, res))) }); }
    catch (error) { return handleError(res, error); }
  },

  async getDraft(req, res) {
    try { return res.json({ ok: true, draft: await draftService.getDraft(req.params.id, ctx(req, res), { includeDeleted: String(req.query?.include_deleted || "0") === "1" }) }); }
    catch (error) { return handleError(res, error); }
  },

  async updateDraft(req, res) {
    try { return res.json({ ok: true, draft: await draftService.updateDraft(req.params.id, req.body || {}, ctx(req, res)) }); }
    catch (error) { return handleError(res, error); }
  },

  async duplicateDraft(req, res) {
    try { return res.status(201).json({ ok: true, draft: await draftService.duplicateDraft(req.params.id, ctx(req, res)) }); }
    catch (error) { return handleError(res, error); }
  },

  async deleteDraft(req, res) {
    try { return res.json(await draftService.softDelete(req.params.id, ctx(req, res))); }
    catch (error) { return handleError(res, error); }
  },

  async restoreDraft(req, res) {
    try { return res.json({ ok: true, draft: await draftService.restore(req.params.id, ctx(req, res)) }); }
    catch (error) { return handleError(res, error); }
  },

  async validateDraft(req, res) {
    try {
      const result = await validationService.validateDraft(req.params.id, ctx(req, res));
      return res.status(result.valid ? 200 : 422).json(result);
    } catch (error) { return handleError(res, error, "Não foi possível validar o rascunho."); }
  },

  async publishDraft(req, res) {
    try { return res.json(await publicationService.publishDraft(req.params.id, ctx(req, res))); }
    catch (error) { return handleError(res, error, "Não foi possível publicar o rascunho."); }
  },
};
