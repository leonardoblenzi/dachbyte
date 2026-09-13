"use strict";

const { config } = require("./config");

function secureHeaders(_req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  if (config.isProduction) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://auth.mercadolivre.com.br https://partner.shopeemobile.com",
  );
  next();
}


function assertSafeHttpsUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw Object.assign(new Error("URL externa invalida."), { statusCode: 400 }); }
  if (url.protocol !== "https:") throw Object.assign(new Error("Integracoes externas exigem HTTPS."), { statusCode: 400 });
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "169.254.169.254") {
    throw Object.assign(new Error("Host externo bloqueado."), { statusCode: 400 });
  }
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    throw Object.assign(new Error("Rede privada nao permitida para callback externo."), { statusCode: 400 });
  }
  return url;
}


function assertAllowedHost(url, allowedHosts, label = "Host") {
  const parsed = typeof url === "string" ? assertSafeHttpsUrl(url) : url;
  const host = parsed.hostname.toLowerCase();
  const ok = (allowedHosts || []).some((rule) => {
    const value = String(rule || "").trim().toLowerCase();
    if (!value) return false;
    if (value.startsWith(".")) return host.endsWith(value);
    return host === value;
  });
  if (!ok) throw Object.assign(new Error(`${label} nao esta na allowlist configurada.`), { statusCode: 400, code: "external_host_not_allowed" });
  return parsed;
}

module.exports = { secureHeaders, assertSafeHttpsUrl, assertAllowedHost };
