"use strict";

/**
 * Public DACHBYTE URLs are intentionally an adapter layer for now. Products
 * still own their legacy mounts, cookies and callback URLs; this module only
 * translates a customer-facing path to that stable mount.
 */
const CANONICAL_ROUTE_GROUPS = Object.freeze({
  seller: Object.freeze([
    Object.freeze({ canonical: "/dach/seller", legacy: "/landing" }),
    Object.freeze({ canonical: "/dach/seller/mercado-livre", legacy: "/ml" }),
    Object.freeze({ canonical: "/dach/seller/shopee", legacy: "/shopee" }),
    Object.freeze({ canonical: "/dach/seller/madeira", legacy: "/madeiramadeira" }),
    Object.freeze({ canonical: "/dach/seller/tracking", legacy: "/avantracking" }),
    Object.freeze({ canonical: "/dach/seller/log", legacy: "/davanttilog" }),
    Object.freeze({ canonical: "/dach/seller/leader", legacy: "/skuleader" }),
    Object.freeze({ canonical: "/seller", legacy: "/landing" }),
    Object.freeze({ canonical: "/seller/mercado-livre", legacy: "/ml" }),
    Object.freeze({ canonical: "/seller/shopee", legacy: "/shopee" }),
    Object.freeze({ canonical: "/seller/madeira", legacy: "/madeiramadeira" }),
    Object.freeze({ canonical: "/seller/tracking", legacy: "/avantracking" }),
    Object.freeze({ canonical: "/seller/log", legacy: "/davanttilog" }),
    Object.freeze({ canonical: "/seller/leader", legacy: "/skuleader" }),
    Object.freeze({ canonical: "/seller/cloner", legacy: "/ml/clonar-anuncio" }),
  ]),
  business: Object.freeze([
    Object.freeze({ canonical: "/dach/business", legacy: "/" }),
    Object.freeze({ canonical: "/dach/business/core", legacy: "/core" }),
    Object.freeze({ canonical: "/dach/business/stock", legacy: "/voltstock" }),
    Object.freeze({ canonical: "/dach/business/chat", legacy: "/chat" }),
    Object.freeze({ canonical: "/dach/business/price", legacy: "/volt-price" }),
    Object.freeze({ canonical: "/business", legacy: "/" }),
    Object.freeze({ canonical: "/business/core", legacy: "/core" }),
    Object.freeze({ canonical: "/business/stock", legacy: "/voltstock" }),
    Object.freeze({ canonical: "/business/chat", legacy: "/chat" }),
  ]),
});

function normalizePathname(value) {
  const path = String(value || "/").split("?")[0].replace(/\/+$/, "");
  return path || "/";
}

function getCanonicalRedirect(pathname, search = "", group) {
  const normalizedPath = normalizePathname(pathname);
  const rules = CANONICAL_ROUTE_GROUPS[group] || [];
  const groupRoots = group === "seller" ? ["/seller", "/dach/seller"] : ["/business", "/dach/business"];
  const match = rules
    .slice()
    .sort((left, right) => right.canonical.length - left.canonical.length)
    .find(({ canonical }) =>
      normalizedPath === canonical ||
      (!groupRoots.includes(canonical) && normalizedPath.startsWith(`${canonical}/`)),
    );
  if (!match) return null;

  const suffix = normalizedPath.slice(match.canonical.length);
  const targetPath = `${match.legacy}${suffix}`.replace(/^\/\//, "/");
  const normalizedSearch = String(search || "");
  return `${targetPath}${normalizedSearch.startsWith("?") ? normalizedSearch : normalizedSearch ? `?${normalizedSearch}` : ""}`;
}

function createCanonicalRedirectHandler(group) {
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const target = getCanonicalRedirect(req.path, req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "", group);
    if (!target) return next();
    return res.redirect(302, target);
  };
}

function registerCanonicalRoutes(app, group) {
  // Do not register a string wildcard here. Express 5 (used by Business)
  // rejects the Express 4-style `/business/*` syntax, while a middleware
  // handler works in both versions and already ignores unrelated requests.
  app.use(createCanonicalRedirectHandler(group));
}

module.exports = {
  CANONICAL_ROUTE_GROUPS,
  createCanonicalRedirectHandler,
  getCanonicalRedirect,
  registerCanonicalRoutes,
};
