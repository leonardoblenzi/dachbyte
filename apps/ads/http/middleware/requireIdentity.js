"use strict";

function wantsHtml(req) {
  return req.method === "GET" && String(req.originalUrl || req.url || "").startsWith("/ads/app");
}

function requireIdentity(provider) {
  return async (req, res, next) => {
    try {
      const resolution = await provider.resolve(req);
      if (resolution.status === "unavailable") {
        return res.status(503).json({
          success: false,
          error: "auth_unavailable",
          reason: resolution.reason,
        });
      }
      if (resolution.status === "anonymous") {
        if (wantsHtml(req)) return res.redirect(302, "/login");
        return res.status(401).json({
          success: false,
          error: "authentication_required",
        });
      }
      if (resolution.status === "forbidden") {
        if (wantsHtml(req)) return res.redirect(302, "/selecao-plataforma?module=denied&product=dach_ads");
        return res.status(403).json({
          success: false,
          error: "dach_ads_access_denied",
          reason: resolution.reason,
          status: resolution.accessStatus || "blocked",
        });
      }

      req.adsIdentity = resolution.identity;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = { requireIdentity };
