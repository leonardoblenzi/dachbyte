// @ts-check
"use strict";

const express = require("express");
const jwt = require("jsonwebtoken");
const {
  readSession, readSuiteSession, decideAccess, signHubSession, identityFromPayload, safeReturnPath, cookieOptions, parseCookies,
  HUB_COOKIE, SIGNED_OUT_COOKIE, SESSION_TTL_SECONDS,
} = require("../platform/auth");
const { ASSET_VERSION } = require("./pages");

const TICKET_AUDIENCE = "dach-hub-ticket";
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_EMAIL = 8;
const MAX_FAILS_PER_IP = 30;

const ERRORS = /** @type {Record<string, string>} */ ({
  sem_acesso: "O DACH Hub não está liberado para esta empresa ou usuário. Fale com o administrador da empresa ou com a DACHBYTE.",
  indisponivel: "Não conseguimos confirmar seu acesso agora. Tente de novo em instantes.",
  sessao: "Sua sessão terminou. Entre de novo.",
});

/** @param {unknown} value */
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));

/** Tentativas erradas por e-mail e por IP, em memória (por processo). */
function createFailureLimiter(now = () => Date.now()) {
  /** @type {Map<string, number[]>} */
  const hits = new Map();
  /** @param {string} key */
  const recent = (key) => (hits.get(key) || []).filter((t) => now() - t < WINDOW_MS);
  return {
    /** @param {string} ip @param {string} email */
    blocked: (ip, email) => recent(`e:${email}`).length >= MAX_FAILS_PER_EMAIL || recent(`i:${ip}`).length >= MAX_FAILS_PER_IP,
    /** @param {string} ip @param {string} email */
    fail(ip, email) {
      for (const key of [`e:${email}`, `i:${ip}`]) hits.set(key, [...recent(key), now()]);
      if (hits.size > 10_000) hits.clear();
    },
    /** @param {string} email */
    clear: (email) => { hits.delete(`e:${email}`); },
  };
}

/**
 * Página de entrada do DACH Hub (sem o menu do shell).
 * @param {{ error?: string | null, notice?: string | null, suiteUser?: { name: string, email: string } | null, returnTo: string }} input
 */
function renderLoginPage({ error, notice, suiteUser, returnTo }) {
  return `<!doctype html>
<html lang="pt-BR" data-seller-theme="violet">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Entrar · DACH Hub</title>
  <link rel="icon" href="/brand/dachbyte/hub/mark-transparent.png?v=1" type="image/png">
  <script>try{var t=JSON.parse(localStorage.getItem("dachbyte:hub:shell:theme")||"null");document.documentElement.setAttribute("data-theme",t||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"));}catch(e){}</script>
  <link rel="stylesheet" href="/hub/ui/seller-shell.css?v=${ASSET_VERSION}">
  <link rel="stylesheet" href="/hub/assets/hub-login.css?v=${ASSET_VERSION}">
</head>
<body class="hub-login">
  <main class="hub-login__wrap">
    <section class="hub-login__brand" aria-hidden="true">
      <img src="/brand/dachbyte/hub/mark-transparent.png?v=1" alt="" width="56" height="56">
      <strong>DACH Hub</strong>
      <p>Catálogo, estoque, pedidos e preços de todos os canais em um só fluxo.</p>
      <ul><li>Mercado Livre, Magalu e Shopee num lugar só</li><li>Estoque central com conferência em cada envio</li><li>Pedidos, expedição e etiquetas</li></ul>
    </section>
    <section class="hub-login__card" data-login data-return="${esc(returnTo)}">
      <div class="hub-login__head">
        <img src="/brand/dachbyte/hub/mark-transparent.png?v=1" alt="" width="36" height="36">
        <div><span class="seller-kicker">DACH Hub</span><h1>Entrar</h1></div>
      </div>
      <div class="hub-login__flash" data-tone="danger" data-login-error ${error ? "" : "hidden"} role="alert">${esc(error || "")}</div>
      ${notice ? `<div class="hub-login__flash" data-tone="success">${esc(notice)}</div>` : ""}
      ${suiteUser ? `<button class="seller-btn hub-login__suite" type="button" data-login-suite>Continuar como <strong>${esc(suiteUser.name)}</strong><small>${esc(suiteUser.email)}</small></button>
      <div class="hub-login__or"><span>ou entre com outro usuário</span></div>` : ""}
      <form class="hub-login__form" data-login-form novalidate>
        <label><span>E-mail</span><input name="email" type="email" autocomplete="username" required autofocus></label>
        <label><span>Senha</span><input name="password" type="password" autocomplete="current-password" required></label>
        <button class="seller-btn seller-btn--primary" type="submit">Entrar</button>
        <a class="hub-login__link" href="/esqueci-senha">Esqueci minha senha</a>
      </form>
      <div class="hub-login__companies" data-login-companies hidden>
        <p>Seu usuário está em mais de uma empresa. Escolha com qual entrar:</p>
        <div data-login-company-list></div>
        <button class="hub-login__link" type="button" data-login-back>Voltar</button>
      </div>
      <p class="hub-login__foot">Acesso pelo mesmo usuário da DACHBYTE.</p>
    </section>
  </main>
  <script src="/hub/assets/hub-login.js?v=${ASSET_VERSION}"></script>
</body>
</html>`;
}

/**
 * Rotas públicas de entrada e saída (antes do controle de acesso).
 * @param {{ config: ReturnType<typeof import("../platform/config").loadConfig>, accessHub: ReturnType<typeof import("../platform/accessHub").createAccessHub> | any, limiter?: ReturnType<typeof createFailureLimiter> }} deps
 */
function createLoginRouter({ config, accessHub, limiter = createFailureLimiter() }) {
  const router = express.Router();
  const options = cookieOptions(config.secureCookies);

  /** @param {any} res */
  const markSignedIn = (res) => res.clearCookie(SIGNED_OUT_COOKIE, options);

  /**
   * Fecha o login na empresa escolhida: confere a liberação e grava a sessão do Hub.
   * @param {any} res @param {{ tenantId: string, userId: string, email: string, name: string, companyRole: string | null, companyName: string | null }} who @param {string} returnTo
   */
  async function finish(res, who, returnTo) {
    if (!config.sessionSecret) return res.status(503).json({ ok: false, error: "session_not_configured", message: "Login do Hub sem configuração (HUB_SESSION_SECRET)." });
    const identity = identityFromPayload({ tenant_id: who.tenantId, user_id: who.userId, email: who.email, name: who.name, company_role: who.companyRole, company_name: who.companyName }, config, "hub");
    const decision = await decideAccess(identity, config, accessHub);
    if (!decision.allow) {
      const down = decision.reason === "hub_unavailable" || decision.reason === "hub_unreachable";
      return res.status(down ? 503 : 403).json({ ok: false, error: down ? "indisponivel" : "sem_acesso", message: ERRORS[down ? "indisponivel" : "sem_acesso"] });
    }
    res.cookie(HUB_COOKIE, signHubSession(identity, config.sessionSecret), { ...options, maxAge: SESSION_TTL_SECONDS * 1000 });
    markSignedIn(res);
    return res.json({ ok: true, redirect: safeReturnPath(returnTo) });
  }

  router.get("/login", (req, res) => {
    const query = /** @type {Record<string, any>} */ (req.query);
    const returnTo = safeReturnPath(query.volta);
    const errorKey = String(query.erro || "");
    // Já tem sessão e não veio de uma recusa: segue direto.
    if (!errorKey && !query.saiu && readSession(req, config).ok) return res.redirect(302, returnTo);
    const cookies = parseCookies(req.headers.cookie);
    const suite = readSuiteSession(cookies, config);
    const suiteUser = suite.ok && suite.identity && errorKey !== "sem_acesso" ? { name: suite.identity.name, email: suite.identity.email } : null;
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(renderLoginPage({
      error: ERRORS[errorKey] || null, notice: query.saiu ? "Você saiu do DACH Hub." : null, suiteUser, returnTo,
    }));
  });

  router.post("/api/session", async (req, res, next) => {
    try {
      const email = String(req.body?.email || "").trim().toLowerCase();
      const password = String(req.body?.password || "");
      const ip = String(req.ip || "");
      if (!email || !password) return res.status(400).json({ ok: false, error: "missing_fields", message: "Informe e-mail e senha." });
      if (limiter.blocked(ip, email)) return res.status(429).json({ ok: false, error: "too_many_attempts", message: "Muitas tentativas. Espere 15 minutos e tente de novo." });
      const result = await accessHub.verifyLogin(email, password);
      if (!result.ok) {
        if (result.reason === "invalid_credentials") {
          limiter.fail(ip, email);
          return res.status(401).json({ ok: false, error: "invalid_credentials", message: "E-mail ou senha incorretos." });
        }
        if (result.reason === "no_company") return res.status(403).json({ ok: false, error: "no_company", message: "Seu usuário não tem empresa ativa na DACHBYTE." });
        return res.status(503).json({ ok: false, error: "indisponivel", message: ERRORS.indisponivel });
      }
      limiter.clear(email);
      const { user } = result;
      if (user.tenants.length > 1) {
        const ticket = jwt.sign({ user_id: user.userId, email: user.email, name: user.name, tenants: user.tenants }, config.sessionSecret, { audience: TICKET_AUDIENCE, expiresIn: 300 });
        return res.json({ ok: true, choose: user.tenants.map((t) => ({ tenantId: t.tenantId, companyName: t.companyName || t.tenantId })), ticket });
      }
      const only = user.tenants[0];
      return await finish(res, { tenantId: only?.tenantId || user.tenantId, userId: user.userId, email: user.email, name: user.name,
        companyRole: only?.role ?? user.companyRole, companyName: only?.companyName ?? user.companyName }, req.body?.volta);
    } catch (error) { next(error); }
  });

  // Segunda etapa: empresa escolhida (o ticket só vale 5 minutos e só para as empresas do usuário).
  router.post("/api/session/tenant", async (req, res, next) => {
    try {
      let ticket;
      try { ticket = /** @type {any} */ (jwt.verify(String(req.body?.ticket || ""), config.sessionSecret, { audience: TICKET_AUDIENCE })); }
      catch (_error) { return res.status(401).json({ ok: false, error: "ticket_expired", message: "O tempo para escolher a empresa acabou. Entre de novo." }); }
      const tenant = (ticket.tenants || []).find((/** @type {any} */ t) => t.tenantId === String(req.body?.tenantId || ""));
      if (!tenant) return res.status(400).json({ ok: false, error: "invalid_tenant", message: "Empresa inválida." });
      return await finish(res, { tenantId: tenant.tenantId, userId: ticket.user_id, email: ticket.email, name: ticket.name, companyRole: tenant.role, companyName: tenant.companyName }, req.body?.volta);
    } catch (error) { next(error); }
  });

  // Atalho para quem já está na suíte: vira sessão do Hub (depois de conferir a liberação).
  router.post("/api/session/suite", async (req, res, next) => {
    try {
      const suite = readSuiteSession(parseCookies(req.headers.cookie), config);
      if (!suite.ok || !suite.identity) return res.status(401).json({ ok: false, error: "no_suite_session", message: "Sessão da DACHBYTE não encontrada. Entre com e-mail e senha." });
      const s = suite.identity;
      return await finish(res, { tenantId: s.tenantId, userId: s.userId, email: s.email, name: s.name, companyRole: s.companyRole, companyName: s.companyName }, req.body?.volta);
    } catch (error) { next(error); }
  });

  /** @param {any} req @param {any} res */
  function signOut(req, res) {
    const session = readSession(req, config);
    if (session.ok && session.identity && typeof accessHub?.forget === "function") accessHub.forget(session.identity);
    res.clearCookie(HUB_COOKIE, options);
    res.cookie(SIGNED_OUT_COOKIE, "1", options);
  }
  router.get("/sair", (req, res) => { signOut(req, res); res.redirect(302, "/hub/login?saiu=1"); });
  router.post("/api/session/logout", (req, res) => { signOut(req, res); res.json({ ok: true, redirect: "/hub/login?saiu=1" }); });

  return router;
}

module.exports = { createLoginRouter, createFailureLimiter, renderLoginPage };
