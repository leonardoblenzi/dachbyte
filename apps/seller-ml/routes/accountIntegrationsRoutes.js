"use strict";

const express = require("express");
const db = require("../db/db");
const companyAccess = require("../services/companyAccessService");
const integrations = require("../services/companyIntegrationsService");

const router = express.Router();

function parsePositiveInt(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

async function resolveEmpresaId(req, res) {
  const localEmpresaId = parsePositiveInt(res.locals?.empresaId);
  if (localEmpresaId) return localEmpresaId;

  const userId = companyAccess.getUserId(req);
  if (!userId) return null;

  const selectedContaId = parsePositiveInt(req.cookies?.meli_conta_id);
  if (selectedContaId) {
    const { rows } = await db.query(
      `select mc.empresa_id
         from meli_contas mc
         join empresa_usuarios eu
           on eu.empresa_id = mc.empresa_id
          and eu.usuario_id = $2
        where mc.id = $1
        limit 1`,
      [selectedContaId, userId],
    );
    if (rows[0]?.empresa_id) return Number(rows[0].empresa_id);
  }

  const ctx = await companyAccess.userCompanyContext(userId);
  return parsePositiveInt(ctx?.empresa_id);
}

function requireEmpresaAdmin() {
  const requireNivelAdmin = companyAccess.requireNivelAdmin();
  return async (req, res, next) => {
    res.locals.empresaId = await resolveEmpresaId(req, res);
    if (!res.locals.empresaId) {
      return res.status(400).json({
        ok: false,
        error: "Selecione uma conta para gerenciar as integracoes da empresa.",
      });
    }
    return requireNivelAdmin(req, res, next);
  };
}

router.use(express.json({ limit: "1mb" }));
router.use(requireEmpresaAdmin());

router.get("/", async (_req, res) => {
  try {
    const sectors = await companyAccess.listCompanySectors(Number(res.locals.empresaId));
    const rows = await integrations.listCompanyIntegrations({
      empresaId: Number(res.locals.empresaId),
    });
    res.json({ ok: true, integrations: rows, sectors });
  } catch (error) {
    res.status(Number(error?.status) || 500).json({
      ok: false,
      error: error?.message || "Falha ao carregar integracoes.",
    });
  }
});

router.put("/:provider", async (req, res) => {
  try {
    const integration = await integrations.upsertCompanyIntegration({
      empresaId: Number(res.locals.empresaId),
      provider: req.params.provider,
      apiBaseUrl: req.body?.api_base_url || req.body?.apiBaseUrl || "",
      accessToken: req.body?.access_token || req.body?.accessToken || "",
      apiKey: req.body?.api_key || req.body?.apiKey || "",
      status: req.body?.status || "disabled",
      config: req.body?.config || {},
    });
    res.json({ ok: true, integration });
  } catch (error) {
    res.status(Number(error?.status) || 500).json({
      ok: false,
      error: error?.message || "Falha ao salvar integracao.",
    });
  }
});

router.post("/:provider/test", async (req, res) => {
  try {
    const result = await integrations.testCompanyIntegration({
      empresaId: Number(res.locals.empresaId),
      provider: req.params.provider,
      apiBaseUrl: req.body?.api_base_url || req.body?.apiBaseUrl || "",
      accessToken: req.body?.access_token || req.body?.accessToken || "",
      apiKey: req.body?.api_key || req.body?.apiKey || "",
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(Number(error?.status) || 400).json({
      ok: false,
      error: error?.message || "Falha ao testar integracao.",
    });
  }
});

router.post("/:provider/rotate-secret", async (req, res) => {
  try {
    const result = await integrations.rotateWebhookSecret({
      empresaId: Number(res.locals.empresaId),
      provider: req.params.provider,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(Number(error?.status) || 400).json({
      ok: false,
      error: error?.message || "Falha ao gerar webhook secret.",
    });
  }
});

module.exports = router;
