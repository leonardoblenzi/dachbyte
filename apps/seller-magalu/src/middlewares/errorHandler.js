"use strict";

function errorHandler(error, req, res, _next) {
  const status = Number(error?.status || error?.statusCode || 500);
  const safeStatus = status >= 400 && status <= 599 ? status : 500;
  const requestId = req.headers?.["x-request-id"] || null;
  console.error("[seller-magalu] request failed", {
    method: req.method,
    path: req.originalUrl,
    status: safeStatus,
    requestId,
    code: error?.code || null,
    message: error?.message || String(error),
  });
  if (res.headersSent) return;
  res.status(safeStatus).json({
    ok: false,
    error: error?.code || "internal_error",
    message: safeStatus >= 500 ? "Falha interna no módulo Magalu." : error?.message || "Falha na requisição.",
    request_id: requestId,
  });
}

module.exports = { errorHandler };
