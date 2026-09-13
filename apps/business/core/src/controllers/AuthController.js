"use strict";

const authService = require("../modules/auth/authService");

function appRedirect(path = "") {
  const base = String(process.env.VOLT_CORE_APP_BASE_PATH || "/core/app")
    .trim()
    .replace(/\/+$/, "");
  const suffix = String(path || "").startsWith("/") ? path : `/${path}`;
  return `${base || ""}${suffix}`;
}

async function login(req, res) {
  const session = await authService.login(req.body || {});
  res.cookie("auth_token", session.token, authService.cookieOptions());
  res.json({
    ok: true,
    user: session.user,
    companies: session.companies,
    selectedCompanyId: session.selectedCompanyId,
    redirect: appRedirect("/dashboard"),
  });
}

async function me(req, res) {
  res.json({
    ok: true,
    user: req.user,
    companies: req.user?.companies || [],
    selectedCompanyId: req.user?.selectedCompanyId || null,
  });
}

async function logout(_req, res) {
  res.clearCookie("auth_token", authService.clearCookieOptions());
  res.json({ ok: true });
}

async function masterOverview(_req, res) {
  res.json({
    ok: true,
    overview: await authService.getMasterOverview(),
  });
}

module.exports = {
  login,
  logout,
  masterOverview,
  me,
};
