"use strict";

const {
  buildNoticeEventKey,
  toDateFromTimestamp,
  upsertShopeePushNotice,
} = require("../repositories/shopeePushNoticeSqlRepository");
const {
  SHOPEE_PUSH_CATEGORY_BY_CODE,
  getShopeeWebhookCategoryFromCode,
} = require("../webhooks/shopeePushCategories");

const SUPPORTED_NOTICE_CODES = new Set(
  Object.keys(SHOPEE_PUSH_CATEGORY_BY_CODE).map((code) => Number(code)),
);

const PENALTY_ACTION_LABEL = {
  1: "ponto de penalidade emitido",
  2: "ponto de penalidade removido",
  3: "nível de punição atualizado",
};

const PROMOTION_ACTION_LABEL = {
  added_in_promo: "Produto adicionado em promoção",
  removed_from_promo: "Produto removido de promoção",
  promo_time_updated: "Tempo da promoção atualizado",
};

const CATEGORY_NOTICE_LABEL = {
  shop_authorization: "Autorizacao de loja Shopee",
  shop_deauthorization: "Desautorizacao de loja Shopee",
  order_status_update: "Atualizacao de pedido Shopee",
  tracking_no_update: "Atualizacao de rastreamento Shopee",
  shopee_updates: "Aviso oficial Shopee",
  banned_item: "Item banido Shopee",
  item_promotion: "Promocao de item Shopee",
  reserved_stock_change: "Alteracao de estoque reservado Shopee",
  promotion_update: "Atualizacao de promocao Shopee",
  webchat: "Mensagem Webchat Shopee",
  video_upload: "Upload de video Shopee",
  authorization_expiry: "Expiracao de autorizacao Shopee",
  brand_register_result: "Resultado de cadastro de marca Shopee",
  violation_item: "Violacao de produto Shopee",
  purchase_order: "Pedido de compra Shopee",
  item_price_update: "Atualizacao de preco Shopee",
  shop_penalty_update: "Penalidade da loja Shopee",
  return_updates: "Atualizacao de devolucao/reembolso Shopee",
};

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function getPayloadData(payload = {}) {
  return payload?.data && typeof payload.data === "object" ? payload.data : {};
}

function getShopeeShopIdFromPayload(payload = {}) {
  const data = getPayloadData(payload);
  return firstNonEmpty(payload.shop_id, data.shop_id, payload.supplier_id) || null;
}

function formatDateFromTimestamp(value) {
  const date = toDateFromTimestamp(value);
  if (!date) return "";
  return date.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

function firstTimestampDate(...values) {
  for (const value of values) {
    const date = toDateFromTimestamp(value);
    if (date) return date;
  }
  return null;
}

function summarizePenalty(data = {}) {
  const actionType = Number(data.action_type || 0);
  const actionLabel = PENALTY_ACTION_LABEL[actionType] || "penalidade atualizada";
  if (actionType === 1) {
    const issued = data.points_issued_data || {};
    return {
      severity: "danger",
      title: "Nova penalidade Shopee",
      message: `${actionLabel}: ${issued.issued_points ?? "-"} ponto(s). Tipo de violação: ${issued.violation_type ?? "-"}.`,
      entityType: "shop_penalty",
      entityId: String(issued.violation_type || actionType || "penalty"),
      occurredAt: toDateFromTimestamp(data.update_time),
      expiresAt: firstTimestampDate(issued.expire_time, issued.end_time, data.end_time),
    };
  }
  if (actionType === 2) {
    const removed = data.points_removed_data || {};
    return {
      severity: "success",
      title: "Penalidade removida na Shopee",
      message: `${actionLabel}: ${removed.removed_points ?? "-"} ponto(s). Motivo: ${removed.removed_reason ?? "-"}.`,
      entityType: "shop_penalty",
      entityId: String(removed.violation_type || actionType || "penalty"),
      occurredAt: toDateFromTimestamp(data.update_time),
      expiresAt: firstTimestampDate(data.update_time),
    };
  }
  const tier = data.tier_update_data || {};
  return {
    severity: "warning",
    title: "Nível de punição atualizado",
    message: `Tier Shopee alterado de ${tier.old_tier ?? "-"} para ${tier.new_tier ?? "-"}.`,
    entityType: "shop_penalty",
    entityId: String(actionType || "tier"),
    occurredAt: toDateFromTimestamp(data.update_time),
    expiresAt: firstTimestampDate(tier.expire_time, tier.end_time, data.end_time),
  };
}

function summarizePurchaseOrder(data = {}, payload = {}) {
  const order = Array.isArray(data) ? data[0] || {} : data;
  const purchaseOrderId = firstNonEmpty(order.purchase_order_id, payload.purchase_order_id);
  const status = firstNonEmpty(order.purchase_order_status, payload.purchase_order_status);
  const reason = firstNonEmpty(order.purchase_reason, payload.purchase_reason);
  const tags = Array.isArray(order.purchase_function_tag_list)
    ? order.purchase_function_tag_list.join(", ")
    : "";
  return {
    severity: "info",
    title: "Novo pedido de compra Shopee",
    message: `Pedido ${purchaseOrderId || "-"} recebido. Status: ${status || "-"}. Motivo: ${reason || "-"}${tags ? ` • Tags: ${tags}` : ""}.`,
    entityType: "purchase_order",
    entityId: purchaseOrderId || null,
    occurredAt: toDateFromTimestamp(order.create_time || payload.timestamp),
  };
}

function summarizePromotion(data = {}) {
  const action = String(data.action || "").trim();
  const actionLabel = PROMOTION_ACTION_LABEL[action] || "Promoção atualizada";
  const promotionType = firstNonEmpty(data.promotion_type, "promoção");
  const itemId = firstNonEmpty(data.item_id, data.variation_id);
  const end = data.end_time ? ` Encerramento: ${formatDateFromTimestamp(data.end_time)}.` : "";
  const severity = action === "removed_from_promo" ? "warning" : "info";
  return {
    severity,
    title: action === "removed_from_promo" ? "Produto saiu de promoção" : actionLabel,
    message: `${actionLabel} (${promotionType}). Item: ${itemId || "-"}. Promoção: ${data.promotion_id || "-"}.${end}`,
    entityType: "promotion",
    entityId: firstNonEmpty(data.promotion_id, data.item_id) || null,
    occurredAt: firstTimestampDate(data.update_time, data.create_time),
    expiresAt: firstTimestampDate(data.end_time),
  };
}

function summarizeViolation(data = {}) {
  const itemId = firstNonEmpty(data.item_id);
  const itemName = firstNonEmpty(data.item_name, `Item ${itemId || "-"}`);
  const status = firstNonEmpty(data.item_status, "status atualizado");
  const details = Array.isArray(data.item_status_details)
    ? data.item_status_details
    : Array.isArray(data.deboost_details)
      ? data.deboost_details
      : Array.isArray(data.deboosted_details)
        ? data.deboosted_details
        : [];
  const firstDetail = details[0] || {};
  const expiresAt = firstTimestampDate(
    firstDetail.fix_deadline_time,
    firstDetail.end_time,
    data.fix_deadline_time,
    data.end_time,
  );
  const deadline = firstDetail.fix_deadline_time
    ? ` Prazo de correção: ${formatDateFromTimestamp(firstDetail.fix_deadline_time)}.`
    : "";
  const deboost = data.deboost ? " Produto com deboost/ranking reduzido." : "";
  return {
    severity: status === "NORMAL" && data.deboost ? "warning" : "danger",
    title: data.deboost ? "Produto com deboost Shopee" : "Violação de produto Shopee",
    message: `${itemName} (${itemId || "-"}): ${status}. ${firstDetail.violation_type || ""} ${firstDetail.violation_reason || ""}. ${firstDetail.suggestion || ""}.${deadline}${deboost}`.replace(/\s+/g, " ").trim(),
    entityType: "item_violation",
    entityId: itemId || null,
    occurredAt: toDateFromTimestamp(firstDetail.update_time || data.update_time),
    expiresAt,
  };
}

function summarizeReturn(data = {}) {
  const updates = Array.isArray(data.updated_values) ? data.updated_values : [];
  const updateText = updates
    .slice(0, 3)
    .map((entry) => `${entry.update_field || "campo"}: ${entry.old_value || "-"} > ${entry.new_value || "-"}`)
    .join("; ");
  return {
    severity: "warning",
    title: "Atualização de devolução/reembolso",
    message: `Pedido ${data.order_sn || "-"} • Devolução ${data.return_sn || "-"}. ${updateText || "Status atualizado."}`,
    entityType: "return_refund",
    entityId: firstNonEmpty(data.return_sn, data.order_sn) || null,
    occurredAt: toDateFromTimestamp(updates[0]?.update_time || data.update_time),
    expiresAt: firstTimestampDate(data.end_time, data.close_time, data.complete_time),
  };
}

function summarizePriceUpdate(data = {}) {
  const oldValue = data.old_value ?? data.oldValue ?? "-";
  const newValue = data.new_value ?? data.newValue ?? "-";
  const increased = Number(data.new_value) > Number(data.old_value);
  return {
    severity: increased ? "warning" : "info",
    title: increased ? "Aumento de preço recebido" : "Preço atualizado",
    message: `Item ${data.item_id || "-"}${data.model_id ? ` / modelo ${data.model_id}` : ""}: ${oldValue} > ${newValue}. Campo: ${data.update_field || "-"}.`,
    entityType: "item_price",
    entityId: firstNonEmpty(data.item_id, data.model_id) || null,
    occurredAt: toDateFromTimestamp(data.update_time),
    expiresAt: firstTimestampDate(data.end_time),
  };
}

function normalizeShopeeUpdateActions(data = {}) {
  const actions = Array.isArray(data?.actions) ? data.actions : [];
  return actions.filter((action) => action && typeof action === "object");
}

function summarizeShopeeUpdate(action = {}, index = 0) {
  const title = firstNonEmpty(action.title, "Aviso oficial Shopee");
  const content = firstNonEmpty(action.content, "Atualizacao oficial recebida na Central da Shopee.");
  const url = firstNonEmpty(action.url);
  const message = `${content}${url ? ` Link: ${url}` : ""}`.replace(/\s+/g, " ").trim();
  return {
    severity: "info",
    title,
    message,
    entityType: "shopee_update",
    entityId: firstNonEmpty(action.url, action.title, action.update_time, index + 1) || null,
    occurredAt: toDateFromTimestamp(action.update_time),
    expiresAt: firstTimestampDate(action.end_time, action.expire_time),
  };
}

function summarizeGenericShopeePush(data = {}, payload = {}, category = "unknown") {
  const label = CATEGORY_NOTICE_LABEL[category] || `Evento Shopee ${payload?.code || ""}`.trim();
  const entityId = firstNonEmpty(
    data.item_id,
    data.model_id,
    data.order_sn,
    data.return_sn,
    data.promotion_id,
    data.purchase_order_id,
    data.video_id,
    data.message_id,
    data.shop_id,
    payload.shop_id,
  );
  const status = firstNonEmpty(
    data.status,
    data.order_status,
    data.item_status,
    data.action,
    data.action_type,
    data.update_field,
  );
  const messageParts = [
    label,
    entityId ? `Referencia: ${entityId}.` : "",
    status ? `Status/acao: ${status}.` : "",
  ].filter(Boolean);
  return {
    severity: category === "shop_deauthorization" || category === "banned_item" ? "danger" : "info",
    title: label,
    message: messageParts.join(" ").trim(),
    entityType: category,
    entityId: entityId || null,
    occurredAt: firstTimestampDate(data.update_time, data.create_time, data.event_time, payload.timestamp),
    expiresAt: firstTimestampDate(data.end_time, data.expire_time, data.close_time, data.complete_time),
  };
}

function buildShopeeUpdatePayload(payload = {}, data = {}, action = {}, index = 0) {
  return {
    ...payload,
    data: {
      ...data,
      action,
      action_index: index,
      action_title: action?.title || null,
      action_content: action?.content || null,
      action_url: action?.url || null,
      action_update_time: action?.update_time || null,
    },
  };
}

function buildShopeePushNoticeDescriptors(payload = {}) {
  const code = Number(payload?.code || 0) || null;
  if (!SUPPORTED_NOTICE_CODES.has(code)) return [];
  const data = getPayloadData(payload);
  const category = getShopeeWebhookCategoryFromCode(code);
  const pushTimestamp = toDateFromTimestamp(payload?.timestamp);
  const shopeeShopId = getShopeeShopIdFromPayload(payload);

  if (code === 5) {
    const actions = normalizeShopeeUpdateActions(data);
    const sourceActions = actions.length ? actions : [{}];
    return sourceActions.map((action, index) => ({
      code,
      category,
      shopeeShopId,
      pushTimestamp,
      payload: buildShopeeUpdatePayload(payload, data, action, index),
      ...summarizeShopeeUpdate(action, index),
    }));
  }

  let descriptor;
  if (code === 28) descriptor = summarizePenalty(data);
  else if (code === 20) descriptor = summarizePurchaseOrder(data, payload);
  else if (code === 9) descriptor = summarizePromotion(data);
  else if (code === 16) descriptor = summarizeViolation(data);
  else if (code === 29) descriptor = summarizeReturn(data);
  else if (code === 22) descriptor = summarizePriceUpdate(data);
  else descriptor = summarizeGenericShopeePush(data, payload, category);

  if (!descriptor) return [];
  return [{
    code,
    category,
    shopeeShopId,
    pushTimestamp,
    ...descriptor,
  }];
}

function buildShopeePushNoticeDescriptor(payload = {}) {
  return buildShopeePushNoticeDescriptors(payload)[0] || null;
}

async function storeShopeePushNotice({ payload, shop = null } = {}) {
  const descriptors = buildShopeePushNoticeDescriptors(payload).filter((descriptor) => {
    if (!descriptor.expiresAt) return true;
    return descriptor.expiresAt.getTime() > Date.now();
  });
  if (!descriptors.length) {
    return {
      stored: false,
      reason: SUPPORTED_NOTICE_CODES.has(Number(payload?.code || 0) || null)
        ? "notice_expired"
        : "unsupported_notice_code",
      code: Number(payload?.code || 0) || null,
    };
  }

  if (!shop?.id) {
    const descriptor = descriptors[0];
    return {
      stored: false,
      reason: "shop_not_found",
      code: descriptor.code,
      shopeeShopId: descriptor.shopeeShopId,
    };
  }

  const notices = [];
  for (const descriptor of descriptors) {
    const noticePayload = descriptor.payload || payload;
    const eventKey = buildNoticeEventKey({
      shopId: shop.id,
      shopeeShopId: descriptor.shopeeShopId,
      code: descriptor.code,
      category: descriptor.category,
      payload: noticePayload,
      title: descriptor.title,
      message: descriptor.message,
    });

    const notice = await upsertShopeePushNotice({
      eventKey,
      shopId: shop.id,
      shopeeShopId: descriptor.shopeeShopId,
      code: descriptor.code,
      category: descriptor.category,
      severity: descriptor.severity,
      title: descriptor.title,
      message: descriptor.message,
      entityType: descriptor.entityType,
      entityId: descriptor.entityId,
      occurredAt: descriptor.occurredAt || descriptor.pushTimestamp,
      pushTimestamp: descriptor.pushTimestamp,
      expiresAt: descriptor.expiresAt || null,
      payload: noticePayload,
    });
    notices.push(notice);
  }

  return {
    stored: notices.length > 0,
    notice: notices[0] || null,
    notices,
  };
}

module.exports = {
  SUPPORTED_NOTICE_CODES,
  buildShopeePushNoticeDescriptor,
  buildShopeePushNoticeDescriptors,
  storeShopeePushNotice,
};
