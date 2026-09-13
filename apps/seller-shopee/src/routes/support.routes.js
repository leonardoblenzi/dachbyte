const express = require("express");
const { requireAuth } = require("../middlewares/sessionAuth");
const {
  findAccountSummaryById,
  findShopById,
  findUserSummaryById,
} = require("../repositories/runtimeSqlRepository");
const { sendSupportRequestEmail } = require("../services/inviteEmailService");

const router = express.Router();

router.use(requireAuth);

const SUPPORT_EMAIL = "contato@davanttisuite.com.br";

function normalize(value) {
  return String(value || "").trim();
}

function formatSupportShopLabel(shop) {
  if (!shop) return "Nenhuma loja ativa";

  const parts = [];
  if (shop.shopId != null) parts.push(`Shop ${shop.shopId}`);
  if (shop.region) parts.push(String(shop.region));
  if (shop.id != null) parts.push(`Loja ${shop.id}`);
  return parts.join(" • ");
}

router.post("/support/request", async (req, res, next) => {
  try {
    const rawSubject = normalize(req.body?.subject) || "Duvidas";
    const replyMode = normalize(req.body?.replyMode).toLowerCase() || "email";
    const phone = normalize(req.body?.phone);
    const message = normalize(req.body?.message);

    if (!message) {
      return res.status(400).json({
        error: "bad_request",
        message: "Descreva sua mensagem antes de enviar ao suporte.",
      });
    }

    if (replyMode === "phone" && !phone) {
      return res.status(400).json({
        error: "bad_request",
        message:
          "Preencha um celular para retorno quando escolher resposta por celular.",
      });
    }

    const [account, user, activeShop] = await Promise.all([
      findAccountSummaryById(req.auth.accountId),
      findUserSummaryById(req.auth.userId),
      req.auth.activeShopId
        ? findShopById(Number(req.auth.activeShopId))
        : Promise.resolve(null),
    ]);

    const accountName = normalize(account?.name) || "Conta sem nome";
    const loginEmail = normalize(user?.email) || "Email nao identificado";
    const userName =
      normalize(user?.name) || accountName || "Usuario";
    const shopLabel = formatSupportShopLabel(activeShop);
    const supportSubject = `[Shopee] ${rawSubject} - ${accountName}`;

    const delivery = await sendSupportRequestEmail({
      toEmail: SUPPORT_EMAIL,
      requesterEmail: loginEmail,
      requesterName: userName,
      subject: supportSubject,
      replyMode,
      phone,
      accountName,
      userName,
      loginEmail,
      shopLabel,
      activeShopId: activeShop?.shopId ? String(activeShop.shopId) : "",
      message,
    });

    if (delivery?.skipped) {
      return res.status(503).json({
        error: "support_email_unavailable",
        message: delivery.reason || "Brevo nao configurado.",
      });
    }

    return res.json({
      ok: true,
      delivery,
      message: "Solicitacao enviada ao suporte com sucesso.",
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
