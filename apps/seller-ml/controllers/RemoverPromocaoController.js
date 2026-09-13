const PromocaoService = require("../services/removerPromocaoService");
const {
  getRequestIp,
  getRequestUserAgent,
  recordAuthEvent,
} = require("../services/authAuditService");

function safeText(value, max = 500) {
  const text = value == null ? "" : String(value);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

async function auditPromotionEvent(req, res, evento, status, metadata = {}) {
  return recordAuthEvent({
    userId: Number(req.user?.uid || req.user?.id) || null,
    email: req.user?.email || null,
    evento,
    status,
    ip: getRequestIp(req),
    userAgent: getRequestUserAgent(req),
    metadata: {
      accountKey: res.locals?.accountKey || null,
      accountLabel: res.locals?.accountLabel || res.locals?.accountKey || null,
      meli_conta_id: res.locals?.mlCreds?.meli_conta_id || null,
      route: req.originalUrl || req.url || null,
      method: req.method,
      action: "remove",
      ...metadata,
    },
  }).catch((err) => {
    console.error("audit remover promocao erro:", err?.message || err);
  });
}

class PromocaoController {
  static async removerPromocaoUnica(req, res) {
    try {
      const { mlb_id } = req.body;
      const accountKey = String(res.locals?.accountKey || "").trim();

      if (!mlb_id) {
        return res.status(400).json({
          success: false,
          error: "MLB ID e obrigatorio",
        });
      }
      if (!accountKey) {
        return res.status(400).json({
          success: false,
          error: "Conta selecionada e obrigatoria",
        });
      }

      console.log(`Iniciando remocao de promocao para: ${mlb_id}`);
      const resultado = await PromocaoService.removerPromocaoUnico(mlb_id, {
        mlCreds: res.locals?.mlCreds || {},
        accountKey,
        logger: console,
      });

      await auditPromotionEvent(
        req,
        res,
        "promotion_item_processed",
        resultado?.success ? "success" : "warn",
        {
          mlb_id: String(mlb_id || "").trim().toUpperCase(),
          total_items: 1,
          item_index: 1,
          success: !!resultado?.success,
          message: safeText(resultado?.message || resultado?.error || ""),
        },
      );

      return res.json(resultado);
    } catch (error) {
      console.error("Erro no endpoint de remocao:", error);
      await auditPromotionEvent(req, res, "promotion_item_processed", "error", {
        mlb_id: String(req.body?.mlb_id || "").trim().toUpperCase() || null,
        total_items: 1,
        item_index: 1,
        success: false,
        message: safeText(error?.message || String(error)),
      });
      return res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
}

module.exports = PromocaoController;
