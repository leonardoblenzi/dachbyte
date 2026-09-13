function redactShopeePayload(shopee) {
  if (!shopee || typeof shopee !== "object") return shopee;
  const safe = { ...shopee };
  if (safe.access_token) safe.access_token = "[REDACTED]";
  if (safe.refresh_token) safe.refresh_token = "[REDACTED]";
  return safe;
}

function extractIpFromMessage(message) {
  const match = String(message || "").match(/(\d+\.\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

function errorHandler(err, req, res, next) {
  const status =
    err.statusCode && Number.isInteger(err.statusCode) ? err.statusCode : 500;

  const payload = {
    error: {
      message: status === 500 ? "Erro interno do servidor" : err.message,
      code: err.code || undefined,
    },
  };

  if (err.shopee) {
    payload.error.type = "shopee_error";

    // Tratamento especial para erro de IP undeclared
    if (
      err.shopee?.error === "source_ip_undeclared" ||
      err.shopee?.message?.includes("source_ip_undeclared")
    ) {
      const ip = extractIpFromMessage(err.shopee.message);
      payload.error.message = ip
        ? `Contate o time de desenvolvimento para adicionar o IP "${ip}" à WhiteList`
        : "Contate o time de desenvolvimento para adicionar o IP à WhiteList";
      payload.error.type = "ip_whitelist_error";
    } else {
      payload.error.shopee = redactShopeePayload(err.shopee);
    }
  }

  // Diagnóstico SEM stack: ajuda muito no Render
  if (status === 500) {
    payload.error.details = err.message;
  } else if (process.env.NODE_ENV !== "production") {
    payload.error.details = err.message;
    payload.error.stack = err.stack;
  }

  return res.status(status).json(payload);
}

module.exports = errorHandler;
