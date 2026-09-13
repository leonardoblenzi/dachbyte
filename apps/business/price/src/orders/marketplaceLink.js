"use strict";

function validationError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function validateMarketplaceLink({ marketplace, externalOrderId, connectionId } = {}) {
  const normalizedMarketplace = String(marketplace || "").trim().toLowerCase();
  const normalizedExternalOrderId = String(externalOrderId || "").trim();
  const normalizedConnectionId = String(connectionId || "").trim();

  if (!["meli", "shopee"].includes(normalizedMarketplace)) {
    throw validationError("Marketplace invalido. Use meli ou shopee.");
  }
  if (!normalizedExternalOrderId) {
    throw validationError("ID externo do pedido e obrigatorio.");
  }
  if (!normalizedConnectionId) {
    throw validationError("Selecione a conta vinculada ao marketplace.");
  }

  return {
    marketplace: normalizedMarketplace,
    externalOrderId: normalizedExternalOrderId,
    connectionId: normalizedConnectionId,
  };
}

module.exports = { validateMarketplaceLink };
