"use strict";

const logger = require("../observability/logger");

function errorHandler(err, req, res, _next) {
  const status = Number.isInteger(err.statusCode) ? err.statusCode : Number.isInteger(err.status) ? err.status : 500;
  const requestId = req?.id || null;

  if (status >= 500) {
    logger.error("http.error", {
      requestId,
      companyId: req?.params?.companyId,
      userId: req?.user?.uid || req?.user?.id,
      method: req?.method,
      path: String(req?.originalUrl || req?.url || "").split("?")[0],
      statusCode: status,
      errorCode: err?.code,
      error: err,
    });
  } else if (status >= 400) {
    logger.warn("http.client_error", {
      requestId,
      companyId: req?.params?.companyId,
      userId: req?.user?.uid || req?.user?.id,
      method: req?.method,
      path: String(req?.originalUrl || req?.url || "").split("?")[0],
      statusCode: status,
      errorCode: err?.code,
    });
  }

  const payload = {
    error: {
      message: status === 500 ? "Erro interno do servidor" : err.message,
      code: err.code,
      requestId,
    },
  };

  if (process.env.NODE_ENV !== "production") payload.error.details = err.message;
  return res.status(status).json(payload);
}

module.exports = errorHandler;
