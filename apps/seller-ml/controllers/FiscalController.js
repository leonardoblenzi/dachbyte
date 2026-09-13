"use strict";

const FiscalService = require("../services/fiscalService");

function serviceContext(res) {
  return {
    mlCreds: res.locals?.mlCreds || {},
    accountKey: res.locals?.accountKey || null,
  };
}

function parseJsonMaybe(value) {
  if (value == null || value === "") return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function normalizeBodyPayload(body) {
  if (!body || typeof body !== "object") return {};
  if (body.payload && typeof body.payload === "object") return body.payload;

  const parsed = parseJsonMaybe(body.payload_json || body.payloadJson);
  if (parsed && typeof parsed === "object") return parsed;

  const clone = { ...body };
  delete clone.payload_json;
  delete clone.payloadJson;
  return clone;
}

function sendBinaryResponse(res, result, fallbackFileName) {
  if (!result) {
    return res.status(404).json({
      success: false,
      error: "Arquivo nao encontrado.",
    });
  }

  if (result.isJson) {
    return res.json({
      success: true,
      payload: result.data,
    });
  }

  const filename = result.filename || fallbackFileName || "arquivo.bin";
  const contentType = result.contentType || "application/octet-stream";

  res.setHeader("Content-Type", contentType);
  if (!String(result.contentDisposition || "").trim()) {
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  } else {
    res.setHeader("Content-Disposition", result.contentDisposition);
  }

  return res.send(result.buffer);
}

function handleError(res, error, fallbackMessage) {
  const status = Number(error?.status);
  const httpStatus = status >= 400 && status < 600 ? status : 500;
  return res.status(httpStatus).json({
    success: false,
    error: error?.message || fallbackMessage || "Falha ao executar operacao fiscal.",
    details: error?.payload || null,
  });
}

module.exports = {
  async dashboard(req, res) {
    try {
      const payload = await FiscalService.dashboard(req.query || {}, serviceContext(res));
      return res.json(payload);
    } catch (error) {
      return handleError(res, error, "Falha ao carregar dashboard fiscal.");
    }
  },

  async reconcilePeriod(req, res) {
    try {
      const payload = await FiscalService.reconcilePeriod(req.query || {}, serviceContext(res));
      return res.json(payload);
    } catch (error) {
      return handleError(res, error, "Falha na conciliacao fiscal por periodo.");
    }
  },

  async listDocuments(req, res) {
    try {
      const payload = await FiscalService.listDocuments(req.query || {}, serviceContext(res));
      return res.json(payload);
    } catch (error) {
      return handleError(res, error, "Falha ao listar documentos fiscais.");
    }
  },

  async perceptionsDetails(req, res) {
    try {
      const payload = await FiscalService.perceptionsDetails(
        req.query || {},
        serviceContext(res),
      );
      return res.json(payload);
    } catch (error) {
      return handleError(res, error, "Falha ao consultar percepcoes fiscais.");
    }
  },

  async downloadLegalDocument(req, res) {
    try {
      const result = await FiscalService.downloadLegalDocument(
        req.params.fileId,
        serviceContext(res),
      );
      return sendBinaryResponse(
        res,
        result,
        `documento-legal-${String(req.params.fileId || "").trim() || "fiscal"}.pdf`,
      );
    } catch (error) {
      return handleError(res, error, "Falha ao baixar documento legal.");
    }
  },

  async downloadOrderPdf(req, res) {
    try {
      const result = await FiscalService.downloadOrderPdf(
        req.params.orderId,
        serviceContext(res),
      );
      return sendBinaryResponse(
        res,
        result,
        `pedido-${String(req.params.orderId || "").trim() || "fiscal"}.pdf`,
      );
    } catch (error) {
      return handleError(res, error, "Falha ao baixar PDF do pedido.");
    }
  },

  async orderBillingInfo(req, res) {
    try {
      const payload = await FiscalService.orderBillingInfo(
        req.params.orderId,
        serviceContext(res),
      );
      return res.json(payload);
    } catch (error) {
      return handleError(res, error, "Falha ao consultar billing_info do pedido.");
    }
  },

  async issueManualInvoice(req, res) {
    try {
      const payload = await FiscalService.issueManualInvoice(
        {
          user_id: req.body?.user_id || req.query?.user_id,
          body: normalizeBodyPayload(req.body),
        },
        serviceContext(res),
      );
      return res.json(payload);
    } catch (error) {
      return handleError(res, error, "Falha ao emitir nota manual.");
    }
  },

  async getInvoiceById(req, res) {
    try {
      const payload = await FiscalService.getInvoiceById(
        {
          user_id: req.query?.user_id,
          invoice_id: req.params.invoiceId,
        },
        serviceContext(res),
      );
      return res.json(payload);
    } catch (error) {
      return handleError(res, error, "Falha ao consultar invoice.");
    }
  },

  async getInvoiceByOrder(req, res) {
    try {
      const payload = await FiscalService.getInvoiceByOrder(
        {
          user_id: req.query?.user_id,
          order_id: req.params.orderId,
        },
        serviceContext(res),
      );
      return res.json(payload);
    } catch (error) {
      return handleError(res, error, "Falha ao consultar invoice por pedido.");
    }
  },

  async getInvoiceByShipment(req, res) {
    try {
      const payload = await FiscalService.getInvoiceByShipment(
        {
          user_id: req.query?.user_id,
          shipment_id: req.params.shipmentId,
        },
        serviceContext(res),
      );
      return res.json(payload);
    } catch (error) {
      return handleError(res, error, "Falha ao consultar invoice por shipment.");
    }
  },

  async createReconciliationReport(req, res) {
    try {
      const payload = await FiscalService.createReconciliationReport(
        {
          key: req.body?.key || req.query?.key,
          group: req.body?.group || req.query?.group,
          body: normalizeBodyPayload(req.body),
        },
        serviceContext(res),
      );
      return res.json(payload);
    } catch (error) {
      return handleError(res, error, "Falha ao solicitar relatorio de conciliacao.");
    }
  },

  async reportStatus(req, res) {
    try {
      const payload = await FiscalService.reportStatus(
        req.params.fileId,
        serviceContext(res),
      );
      return res.json(payload);
    } catch (error) {
      return handleError(res, error, "Falha ao consultar status do relatorio.");
    }
  },

  async downloadReport(req, res) {
    try {
      const result = await FiscalService.downloadReport(
        req.params.fileId,
        serviceContext(res),
      );
      return sendBinaryResponse(
        res,
        result,
        `relatorio-conciliacao-${String(req.params.fileId || "").trim() || "fiscal"}.csv`,
      );
    } catch (error) {
      return handleError(res, error, "Falha ao baixar relatorio.");
    }
  },

  async monitor(req, res) {
    try {
      const payload = await FiscalService.monitor(req.query || {}, serviceContext(res));
      return res.json(payload);
    } catch (error) {
      return handleError(res, error, "Falha no monitor de eventos fiscais.");
    }
  },

  async sales(req, res) {
    try {
      const payload = await FiscalService.sales(req.query || {}, serviceContext(res));
      return res.json(payload);
    } catch (error) {
      return handleError(res, error, "Falha ao consultar painel de vendas.");
    }
  },

};
