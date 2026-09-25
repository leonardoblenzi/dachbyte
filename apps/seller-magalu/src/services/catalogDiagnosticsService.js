"use strict";

const portfolioReadService = require("./portfolioReadService");

function text(value) {
  return String(value == null ? "" : value).trim();
}

function safeMessage(error) {
  return text(error?.payload?.message || error?.payload?.error_description || error?.message || error || "Falha desconhecida").slice(0, 500);
}

function probeFromResponse(endpoint, response, extra = {}) {
  return {
    endpoint,
    ok: true,
    reachable: true,
    status: Number(response?.status || 200),
    request_id: response?.requestId || null,
    message: null,
    ...extra,
  };
}

function probeFromError(endpoint, error, { allowNotFound = false } = {}) {
  const status = Number(error?.status || 0) || null;
  const reachable = allowNotFound && status === 404;
  return {
    endpoint,
    ok: reachable,
    reachable,
    status,
    request_id: error?.requestId || null,
    code: error?.code || null,
    message: safeMessage(error),
  };
}

async function runPortfolioDiagnostics(account) {
  const result = {
    checked_at: new Date().toISOString(),
    account_id: Number(account.id),
    magalu_tenant_id: account.magalu_tenant_id,
    scopes: Array.isArray(account.scopes) ? account.scopes : [],
    sample_sku: null,
    probes: {
      sku: null,
      price: null,
      stock: null,
      seller: null,
    },
  };

  let firstSku = null;
  try {
    const response = await portfolioReadService.listSkus(account.id, account.dach_tenant_id, { offset: 0, limit: 1 });
    const rows = Array.isArray(response?.data?.results) ? response.data.results : [];
    firstSku = text(rows[0]?.sku) || null;
    result.sample_sku = firstSku;
    result.probes.sku = probeFromResponse("/seller/v1/portfolios/skus?_limit=1", response, {
      count: rows.length,
    });
  } catch (error) {
    result.probes.sku = probeFromError("/seller/v1/portfolios/skus?_limit=1", error);
  }

  // /me is useful to enrich the account name, but it is deliberately auxiliary.
  // A failure here must never be interpreted as catalog access failure.
  try {
    const response = await portfolioReadService.getSeller(account.id, account.dach_tenant_id);
    result.probes.seller = probeFromResponse("/seller/v1/portfolios/me", response);
  } catch (error) {
    result.probes.seller = probeFromError("/seller/v1/portfolios/me", error);
  }

  if (firstSku) {
    const [price, stock] = await Promise.all([
      portfolioReadService.getPrice(account.id, account.dach_tenant_id, firstSku)
        .then((response) => probeFromResponse(`/seller/v1/portfolios/prices/${encodeURIComponent(firstSku)}`, response))
        .catch((error) => probeFromError(`/seller/v1/portfolios/prices/${encodeURIComponent(firstSku)}`, error, { allowNotFound: true })),
      portfolioReadService.getStock(account.id, account.dach_tenant_id, firstSku)
        .then((response) => probeFromResponse(`/seller/v1/portfolios/stocks/${encodeURIComponent(firstSku)}`, response))
        .catch((error) => probeFromError(`/seller/v1/portfolios/stocks/${encodeURIComponent(firstSku)}`, error, { allowNotFound: true })),
    ]);
    result.probes.price = price;
    result.probes.stock = stock;
  } else {
    const reason = result.probes.sku?.ok ? "Nenhum SKU disponível para testar este endpoint." : "Teste não executado porque o acesso a SKUs falhou.";
    result.probes.price = { endpoint: "/seller/v1/portfolios/prices/:sku", ok: null, reachable: null, status: null, request_id: null, message: reason };
    result.probes.stock = { endpoint: "/seller/v1/portfolios/stocks/:sku", ok: null, reachable: null, status: null, request_id: null, message: reason };
  }

  result.catalog_access_ok = result.probes.sku?.ok === true;
  result.profile_warning = result.probes.seller?.ok === false ? result.probes.seller : null;
  return result;
}

module.exports = {
  runPortfolioDiagnostics,
  _test: { safeMessage, probeFromError, probeFromResponse },
};
