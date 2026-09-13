"use strict";

const { pickActiveRecipients } = require("./accountRecipients");
const {
  sendAddressAlertEmergencyEmail,
} = require("./inviteEmailService");
const {
  findShopNotificationContextById,
  listPendingAddressAlertsForNotification,
  markAddressAlertsNotification,
} = require("../repositories/orderAlertsSqlRepository");

const REPORT_TIMEZONE = process.env.SALES_SUMMARY_TZ || "America/Sao_Paulo";

function formatDateTime(value) {
  if (!value) return "-";

  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: REPORT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function compactLine(parts = []) {
  return parts
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(", ");
}

function formatAddress(snapshot) {
  if (!snapshot) return "Nao havia snapshot anterior disponivel.";

  const firstLine = compactLine([
    snapshot.fullAddress,
    snapshot.district,
    snapshot.town,
  ]);
  const secondLine = compactLine([
    snapshot.city,
    snapshot.state,
    snapshot.zipcode ? `CEP ${snapshot.zipcode}` : "",
  ]);
  const thirdLine = compactLine([snapshot.region]);

  return [firstLine, secondLine, thirdLine].filter(Boolean).join("\n") || "-";
}

function buildNotificationError(skippedReasons, errors) {
  const parts = [];

  if (skippedReasons.size) {
    parts.push(`skipped: ${[...skippedReasons].join(" | ")}`);
  }

  if (errors.length) {
    parts.push(
      `errors: ${errors
        .map((item) => `${item.email}: ${item.error}`)
        .join(" | ")}`,
    );
  }

  return parts.join(" || ").slice(0, 1800) || null;
}

async function notifyPendingAddressAlertsForShop({ shopId, now = new Date() }) {
  const shop = await findShopNotificationContextById(shopId);

  if (!shop?.account) {
    return {
      ok: false,
      skipped: true,
      reason: "Loja sem empresa vinculada para notificar.",
      shopId,
    };
  }

  const recipients = pickActiveRecipients(shop.account.users);
  if (!recipients.length) {
    return {
      ok: false,
      skipped: true,
      reason: "Nenhum usuario ativo com email encontrado para a empresa.",
      accountId: shop.account.id,
      shopShopeeId: String(shop.shopId),
    };
  }

  const alerts = await listPendingAddressAlertsForNotification(shop.id);

  if (!alerts.length) {
    return {
      ok: true,
      skipped: true,
      reason: "Nenhum alerta pendente sem notificacao para enviar.",
      accountId: shop.account.id,
      shopShopeeId: String(shop.shopId),
      alerts: 0,
    };
  }

  const report = {
    generatedAt: now.toISOString(),
    shopShopeeId: String(shop.shopId),
    alerts: alerts.map((alert) => {
      const customerName =
        alert.newSnapshot?.name || alert.oldSnapshot?.name || null;
      const customerPhone =
        alert.newSnapshot?.phone || alert.oldSnapshot?.phone || null;

      return {
        orderSn: alert.order?.orderSn || "-",
        detectedAt: formatDateTime(alert.createdAt),
        customerName,
        customerPhone,
        oldAddress: formatAddress(alert.oldSnapshot),
        newAddress: formatAddress(alert.newSnapshot),
      };
    }),
  };

  let sent = 0;
  let skipped = 0;
  const skippedReasons = new Set();
  const errors = [];

  for (const recipient of recipients) {
    try {
      const delivery = await sendAddressAlertEmergencyEmail({
        toEmail: recipient.email,
        toName: recipient.name,
        companyName: shop.account.name,
        report,
        subject: `EMERGENCIA Shopee - Troca de endereco detectada - ${shop.account.name || "DAVANTTI"} - Loja ${String(shop.shopId)}`,
      });

      if (delivery?.sent) {
        sent += 1;
      } else {
        skipped += 1;
        if (delivery?.reason) {
          skippedReasons.add(String(delivery.reason));
        }
      }
    } catch (error) {
      errors.push({
        email: recipient.email,
        error: String(error?.message || error),
      });
    }
  }

  const alertIds = alerts.map((alert) => alert.id);
  const notificationAttemptedAt = new Date();
  const notificationError = buildNotificationError(skippedReasons, errors);

  await markAddressAlertsNotification(alertIds, {
    notificationAttemptedAt,
    notificationError,
    ...(sent > 0 ? { notificationSentAt: notificationAttemptedAt } : {}),
  });

  return {
    ok: sent > 0,
    accountId: shop.account.id,
    accountName: shop.account.name,
    shopShopeeId: String(shop.shopId),
    alerts: alerts.length,
    recipients: recipients.length,
    sent,
    skipped,
    errors,
    notificationError,
  };
}

module.exports = {
  notifyPendingAddressAlertsForShop,
};
