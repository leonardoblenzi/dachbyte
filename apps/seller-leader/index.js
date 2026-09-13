"use strict";

const express = require("express");
const path = require("path");
const jwt = require("jsonwebtoken");
const { resolveIdentity, parseCookies } = require("./lib/auth");
const { querySku, queryMl, queryShopee, getDbDiagnostics } = require("./lib/db");
const { checkSkuLeaderAccess, verifySkuLeaderGlobalLogin } = require("./lib/hubAccess");
const { startHubUsageReporter } = require("./lib/hubUsageReporter");
const {
  buildOverview,
  exportCsv,
  saveAction,
  updateAction,
  saveConfig,
  saveRoutine,
  updateRoutine,
  deleteRoutine,
  saveCompanySettings,
  saveAdminUser,
  updateAdminUser,
  deleteAdminUser,
  searchSkuCandidates,
  listMlAccounts,
  saveMeliAccountPreference,
  resolveMeliAccountSelection,
  saveSkuLink,
  deleteSkuLink,
  syncLiveMetrics,
} = require("./lib/service");

module.exports = async function createSkuLeaderApp() {
  const app = express();
  const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";


  function authCookieOptions() {
    return {
      httpOnly: true,
      sameSite: "lax",
      secure: isProd,
      maxAge: 1000 * 60 * 60 * 12,
      path: "/",
    };
  }

  function wantsHtml(req) {
    const accept = String(req.headers?.accept || "").toLowerCase();
    return accept.includes("text/html") || accept.includes("application/xhtml+xml");
  }

  function denyBillingAccess(req, res, access = {}) {
    if (req.method === "GET" && wantsHtml(req)) {
      return res.redirect("/selecao-plataforma?subscription=expired");
    }

    return res.status(402).json({
      ok: false,
      error: "Assinatura inativa para este modulo.",
      code: "PAYMENT_REQUIRED",
      reason: access.reason || null,
      status: access.status || null,
      redirect: "/selecao-plataforma?subscription=expired",
    });
  }

  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));

  startHubUsageReporter();

  app.use("/assets", express.static(path.join(__dirname, "public", "assets")));
  app.use("/styles.css", express.static(path.join(__dirname, "public", "styles.css")));
  app.use("/login.css", express.static(path.join(__dirname, "public", "login.css")));
  app.use("/app.js", express.static(path.join(__dirname, "public", "app.js")));

  app.get("/healthz", (_req, res) => {
    return res.json({ ok: true, module: "skuleader" });
  });

  app.get("/healthz/db", async (_req, res) => {
    const diagnostics = getDbDiagnostics();
    const out = {
      ok: true,
      module: "skuleader",
      databases: {
        sku: {
          ...diagnostics.sku,
          reachable: false,
          error: null,
        },
        ml: {
          ...diagnostics.ml,
          reachable: false,
          error: null,
        },
        shopee: {
          ...diagnostics.shopee,
          reachable: false,
          error: null,
        },
      },
    };

    try {
      await querySku("select 1 as ok");
      out.databases.sku.reachable = true;
    } catch (error) {
      out.databases.sku.error = error?.message || "Falha ao conectar no SKU Tracker.";
    }

    try {
      await queryMl("select 1 as ok");
      out.databases.ml.reachable = true;
    } catch (error) {
      out.databases.ml.error = error?.message || "Falha ao conectar no ML.";
    }

    try {
      await queryShopee("select 1 as ok");
      out.databases.shopee.reachable = true;
    } catch (error) {
      out.databases.shopee.error = error?.message || "Falha ao conectar na Shopee.";
    }

    out.ok = out.databases.sku.reachable && (out.databases.ml.reachable || out.databases.shopee.reachable);
    return res.json(out);
  });

  app.get("/login", (_req, res) => {
    return res.sendFile(path.join(__dirname, "public", "login.html"));
  });
  app.get("/longin", (_req, res) => {
    return res.redirect("/skuleader/login");
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const email = String(req.body?.email || "")
        .trim()
        .toLowerCase();
      const senha = String(req.body?.senha || "");

      if (!email || !senha) {
        return res.status(400).json({ ok: false, error: "Informe email e senha." });
      }

      const secret =
        String(process.env.SKULEADER_JWT_SECRET || "").trim() ||
        String(process.env.JWT_SECRET || "").trim() ||
        String(process.env.ML_JWT_SECRET || "").trim();
      if (!secret) {
        return res.status(500).json({
          ok: false,
          error: "JWT nao configurado no ambiente.",
        });
      }

      const hubLogin = await verifySkuLeaderGlobalLogin({ email, password: senha });
      if (!hubLogin.allow) {
        const reason = hubLogin.reason || "hub_denied";
        const status = reason === "hub_not_configured" ? 503 : 401;
        return res.status(status).json({
          ok: false,
          error: status === 503 ? "Login global nao configurado." : "Credenciais invalidas.",
          reason,
        });
      }

      const payload = hubLogin.payload || {};
      const tenantGlobalId = String(payload.tenant_id || "").trim();
      const userGlobalId = String(payload.user_id || "").trim();
      if (!tenantGlobalId || !userGlobalId) {
        return res.status(403).json({
          ok: false,
          error: "Identidade global incompleta no hub.",
        });
      }

      const identity = {
        source: "hub",
        userId: null,
        userGlobalId,
        userName: String(payload.name || payload.full_name || email).trim() || email,
        userEmail: email,
        tenantGlobalId,
        empresaId: null,
        empresaNome: String(payload.company_name || "Empresa Davantti").trim() || "Empresa Davantti",
      };

      const access = await checkSkuLeaderAccess(identity, "login");
      if (!access.allow) {
        return res.status(403).json({
          ok: false,
          error: "Acesso ao SKU Tracker nao liberado para esta conta.",
          reason: access.reason || "hub_denied",
        });
      }

      const token = jwt.sign(
        {
          user_global_id: identity.userGlobalId,
          tenant_global_id: identity.tenantGlobalId,
          empresa_id: identity.empresaId,
          empresa_nome: identity.empresaNome,
          email: identity.userEmail,
          nivel: "global",
          nome: identity.userName || null,
        },
        secret,
        { expiresIn: "12h" },
      );

      res.cookie("skuleader_auth_token", token, authCookieOptions());
      return res.json({
        ok: true,
        user: {
          id: null,
          user_global_id: identity.userGlobalId,
          nome: identity.userName || null,
          email: identity.userEmail || null,
        },
        tenant: {
          tenant_global_id: identity.tenantGlobalId,
          empresa_id: identity.empresaId,
          empresa_nome: identity.empresaNome || null,
        },
        redirect: "/skuleader",
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error?.message || "Falha ao autenticar no SKU Leader.",
      });
    }
  });

  app.post("/api/auth/logout", (_req, res) => {
    res.clearCookie("skuleader_auth_token", {
      httpOnly: true,
      sameSite: "lax",
      secure: isProd,
      path: "/",
    });
    res.clearCookie("skuleader_meli_account_id", {
      sameSite: "lax",
      secure: isProd,
      path: "/",
    });
    return res.json({ ok: true, redirect: "/selecao-plataforma" });
  });

  app.get("/api/auth/logout", (_req, res) => {
    res.clearCookie("skuleader_auth_token", {
      httpOnly: true,
      sameSite: "lax",
      secure: isProd,
      path: "/",
    });
    res.clearCookie("skuleader_meli_account_id", {
      sameSite: "lax",
      secure: isProd,
      path: "/",
    });
    return res.redirect("/selecao-plataforma");
  });

  app.use(async (req, res, next) => {
    if (
      req.path === "/healthz" ||
      req.path === "/healthz/db" ||
      req.path === "/login" ||
      req.path === "/longin" ||
      req.path === "/api/auth/login" ||
      req.path === "/api/auth/logout"
    ) {
      return next();
    }

    const identity = await resolveIdentity(req).catch(() => null);
    if (!identity) {
      const accept = String(req.headers?.accept || "").toLowerCase();
      if (accept.includes("text/html")) {
        return res.redirect("/skuleader/login");
      }

      return res.status(401).json({
        ok: false,
        error: "Nao autenticado.",
        redirect: "/skuleader/login",
      });
    }

    const access = await checkSkuLeaderAccess(identity, "api");
    if (!access.allow) {
      return denyBillingAccess(req, res, access);
    }

    const cookies = parseCookies(req.headers?.cookie || "");
    const cookieMeliAccountId = Number(cookies.skuleader_meli_account_id || 0);
    const resolvedSelection = await resolveMeliAccountSelection(
      identity,
      Number.isFinite(cookieMeliAccountId) && cookieMeliAccountId > 0
        ? cookieMeliAccountId
        : null,
    ).catch(() => ({ accounts: [], selectedId: null }));
    req.identity = {
      ...identity,
      meliAccountId:
        Number.isFinite(resolvedSelection.selectedId) && resolvedSelection.selectedId > 0
          ? resolvedSelection.selectedId
          : null,
      selectedMeliAccountId:
        Number.isFinite(resolvedSelection.selectedId) && resolvedSelection.selectedId > 0
          ? resolvedSelection.selectedId
          : null,
    };
    req.meliAccountSelection = resolvedSelection;
    return next();
  });

  app.get("/", (_req, res) => {
    return res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  app.get("/api/me", (req, res) => {
    return res.json({ ok: true, identity: req.identity });
  });

  app.get("/api/overview", async (req, res) => {
    try {
      const payload = await buildOverview(req.identity, req.query || {});
      return res.json(payload);
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error?.message || "Falha ao carregar overview do SKU Leader.",
      });
    }
  });

  app.get("/api/export.csv", async (req, res) => {
    try {
      const csv = await exportCsv(req.identity, req.query || {});
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader("content-type", "text/csv; charset=utf-8");
      res.setHeader(
        "content-disposition",
        `attachment; filename="sku-leader-${stamp}.csv"`,
      );
      return res.status(200).send(csv);
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error?.message || "Falha ao exportar CSV.",
      });
    }
  });

  app.post("/api/actions", async (req, res) => {
    try {
      const row = await saveAction(req.identity, req.body || {});
      return res.status(201).json({ ok: true, action: row });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error?.message || "Falha ao salvar acao.",
      });
    }
  });

  app.patch("/api/actions/:id", async (req, res) => {
    try {
      const row = await updateAction(req.identity, req.params.id, req.body || {});
      return res.json({ ok: true, action: row });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error?.message || "Falha ao atualizar acao.",
      });
    }
  });

  app.post("/api/config", async (req, res) => {
    try {
      const row = await saveConfig(req.identity, req.body || {});
      return res.json({ ok: true, config: row });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error?.message || "Falha ao salvar configuracao.",
      });
    }
  });

  app.get("/api/sku-candidates", async (req, res) => {
    try {
      const data = await searchSkuCandidates(req.identity, req.query || {});
      return res.json({ ok: true, ...data });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error?.message || "Falha ao buscar candidatos de SKU.",
      });
    }
  });

  app.get("/api/meli-accounts", async (req, res) => {
    try {
      const resolvedSelection =
        req.meliAccountSelection || (await resolveMeliAccountSelection(req.identity));
      const accounts = Array.isArray(resolvedSelection.accounts)
        ? resolvedSelection.accounts
        : await listMlAccounts(req.identity);
      return res.json({
        ok: true,
        accounts,
        selected_id: resolvedSelection.selectedId || req.identity?.meliAccountId || null,
      });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error?.message || "Falha ao listar contas do MeLi.",
      });
    }
  });

  app.post("/api/meli-account/select", async (req, res) => {
    try {
      const requestedId = Number(req.body?.meli_account_id || 0);
      if (!Number.isFinite(requestedId) || requestedId <= 0) {
        return res.status(400).json({ ok: false, error: "Conta MeLi invalida." });
      }

      const accounts = await listMlAccounts(req.identity);
      const match = accounts.find((row) => Number(row.id) === requestedId);
      if (!match) {
        return res.status(403).json({
          ok: false,
          error: "Conta MeLi nao vinculada ao acesso atual.",
        });
      }

      res.cookie("skuleader_meli_account_id", String(requestedId), {
        httpOnly: true,
        sameSite: "lax",
        secure: isProd,
        maxAge: 1000 * 60 * 60 * 24 * 30,
        path: "/",
      });
      await saveMeliAccountPreference(req.identity, requestedId).catch(() => {});
      return res.json({ ok: true, selected_id: requestedId });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error?.message || "Falha ao selecionar conta MeLi.",
      });
    }
  });

  app.post("/api/sku-links", async (req, res) => {
    try {
      const row = await saveSkuLink(req.identity, req.body || {});
      return res.status(201).json({ ok: true, sku_link: row });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error?.message || "Falha ao salvar vinculo de SKU.",
      });
    }
  });

  app.delete("/api/sku-links/:id", async (req, res) => {
    try {
      const removed = await deleteSkuLink(req.identity, req.params.id);
      return res.json({ ok: true, removed });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error?.message || "Falha ao excluir vinculo de SKU.",
      });
    }
  });

  app.post("/api/metrics/sync", async (req, res) => {
    try {
      const result = await syncLiveMetrics(req.identity, {
        force: true,
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error?.message || "Falha ao sincronizar métricas em tempo real.",
      });
    }
  });

  app.post("/api/routines", async (req, res) => {
    try {
      const row = await saveRoutine(req.identity, req.body || {});
      return res.status(201).json({ ok: true, routine: row });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error?.message || "Falha ao salvar rotina.",
      });
    }
  });

  app.patch("/api/routines/:id", async (req, res) => {
    try {
      const row = await updateRoutine(req.identity, req.params.id, req.body || {});
      return res.json({ ok: true, routine: row });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error?.message || "Falha ao atualizar rotina.",
      });
    }
  });

  app.delete("/api/routines/:id", async (req, res) => {
    try {
      const removed = await deleteRoutine(req.identity, req.params.id);
      return res.json({ ok: true, removed });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error?.message || "Falha ao excluir rotina.",
      });
    }
  });

  app.post("/api/admin/users", async (req, res) => {
    try {
      const row = await saveAdminUser(req.identity, req.body || {});
      return res.status(201).json({ ok: true, user: row });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error?.message || "Falha ao salvar usuario do modulo.",
      });
    }
  });

  app.patch("/api/admin/users/:id", async (req, res) => {
    try {
      const row = await updateAdminUser(req.identity, req.params.id, req.body || {});
      return res.json({ ok: true, user: row });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error?.message || "Falha ao atualizar usuario do modulo.",
      });
    }
  });

  app.delete("/api/admin/users/:id", async (req, res) => {
    try {
      const removed = await deleteAdminUser(req.identity, req.params.id);
      return res.json({ ok: true, removed });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error?.message || "Falha ao excluir usuario do modulo.",
      });
    }
  });

  app.put("/api/admin/settings", async (req, res) => {
    try {
      const row = await saveCompanySettings(req.identity, req.body || {});
      return res.json({ ok: true, settings: row });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error?.message || "Falha ao salvar configuracoes da empresa.",
      });
    }
  });

  return app;
};
