"use strict";

const env = require("../config/env");
const accountRepository = require("../repositories/accountRepository");
const catalogRepository = require("../repositories/catalogRepository");
const syncRunRepository = require("../repositories/syncRunRepository");
const portfolioReadService = require("./portfolioReadService");
const MAX_SKU_LIST_OFFSET = 20_000;
const CATALOG_SYNC_STATUSES = ["PUBLISHED", "UNPUBLISHED", "BLOCKED"];

function text(value) {
  return String(value == null ? "" : value).trim();
}

function apiErrorText(error) {
  return String(error?.payload?.message || error?.payload?.error_description || error?.message || error || "Erro desconhecido").slice(0, 1800);
}

function remoteErrorMeta(error, endpoint, stage) {
  return {
    failed_stage: stage || null,
    failed_endpoint: endpoint || null,
    http_status: Number(error?.status || 0) || null,
    request_id: error?.requestId || null,
    error_code: error?.code || null,
  };
}

async function mapWithConcurrency(items, concurrency, task) {
  const queue = Array.from(items || []);
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), Math.max(1, queue.length)) },
    async () => {
      while (queue.length) {
        const item = queue.shift();
        if (item === undefined) break;
        await task(item);
      }
    },
  );
  await Promise.all(workers);
}

function nextOffsetFromLink(nextLink, fallbackOffset) {
  const raw = text(nextLink);
  if (!raw) return null;
  try {
    const url = new URL(raw, "https://api.magalu.com");
    const next = Number.parseInt(url.searchParams.get("_offset") || "", 10);
    return Number.isFinite(next) && next >= 0 ? next : fallbackOffset;
  } catch (_error) {
    return fallbackOffset;
  }
}

async function syncPrice(account, sku) {
  try {
    const response = await portfolioReadService.getPrice(account.id, account.dach_tenant_id, sku);
    await catalogRepository.upsertPrice(account.id, sku, response.data, { httpStatus: response.status });
    return { ok: true };
  } catch (error) {
    if (Number(error?.status) === 404) {
      await catalogRepository.markPriceMissing(account.id, sku, {
        httpStatus: 404,
        error: "Preço não encontrado no Portfólio Magalu.",
      });
      return { ok: true, missing: true };
    }
    await catalogRepository.recordPriceError(account.id, sku, {
      httpStatus: error?.status || null,
      error: apiErrorText(error),
    });
    return { ok: false, error };
  }
}

async function syncStock(account, sku) {
  try {
    const response = await portfolioReadService.getStock(account.id, account.dach_tenant_id, sku);
    await catalogRepository.upsertStock(account.id, sku, response.data, { httpStatus: response.status });
    return { ok: true };
  } catch (error) {
    if (Number(error?.status) === 404) {
      await catalogRepository.markStockMissing(account.id, sku, {
        httpStatus: 404,
        error: "Estoque não encontrado no Portfólio Magalu.",
      });
      return { ok: true, missing: true };
    }
    await catalogRepository.recordStockError(account.id, sku, {
      httpStatus: error?.status || null,
      error: apiErrorText(error),
    });
    return { ok: false, error };
  }
}

async function reconcileSku(accountId, sku, { topic = "manual", dachTenantId = null } = {}) {
  const account = dachTenantId
    ? await accountRepository.findAccountByIdForTenant(accountId, dachTenantId)
    : await accountRepository.findAccountById(accountId);

  if (!account || account.status !== "active") {
    const error = new Error("Conta Magalu ativa não encontrada para reconciliação.");
    error.code = "MAGALU_ACCOUNT_NOT_ACTIVE";
    error.status = 404;
    throw error;
  }

  const normalizedSku = text(sku);
  if (!normalizedSku) {
    const error = new Error("SKU ausente para reconciliação Magalu.");
    error.code = "MAGALU_SKU_REQUIRED";
    error.status = 400;
    throw error;
  }

  const seenAt = new Date();
  const result = { sku: normalizedSku, topic, sku_ok: null, price_ok: null, stock_ok: null };

  if (topic === "portfolios_price" || topic === "portfolios_stock") {
    const local = await catalogRepository.getCatalogItem(account.id, normalizedSku);
    if (!local) {
      try {
        const response = await portfolioReadService.getSku(account.id, account.dach_tenant_id, normalizedSku);
        await catalogRepository.upsertSku(account.id, response.data, { seenAt, httpStatus: response.status });
        result.sku_ok = true;
      } catch (error) {
        if (Number(error?.status) === 404) {
          result.sku_ok = true;
          result.missing = true;
          return result;
        }
        throw error;
      }
    }
  }

  if (topic === "portfolios_sku" || topic === "manual" || topic === "full") {
    try {
      const response = await portfolioReadService.getSku(account.id, account.dach_tenant_id, normalizedSku);
      await catalogRepository.upsertSku(account.id, response.data, { seenAt, httpStatus: response.status });
      result.sku_ok = true;
    } catch (error) {
      if (Number(error?.status) === 404) {
        await catalogRepository.markSkuMissing(account.id, normalizedSku, {
          httpStatus: 404,
          error: "SKU não encontrado no Portfólio Magalu.",
        });
        result.sku_ok = true;
        result.missing = true;
      } else {
        throw error;
      }
    }
  }

  if (!result.missing && (topic === "portfolios_price" || topic === "manual" || topic === "full")) {
    const price = await syncPrice(account, normalizedSku);
    result.price_ok = price.ok;
    if (!price.ok) result.price_error = apiErrorText(price.error);
  }

  if (!result.missing && (topic === "portfolios_stock" || topic === "manual" || topic === "full")) {
    const stock = await syncStock(account, normalizedSku);
    result.stock_ok = stock.ok;
    if (!stock.ok) result.stock_error = apiErrorText(stock.error);
  }

  return result;
}

async function refreshKnownSku(account, sku) {
  try {
    const response = await portfolioReadService.getSku(account.id, account.dach_tenant_id, sku);
    await catalogRepository.upsertSku(account.id, response.data, { seenAt: new Date(), httpStatus: response.status });
  } catch (error) {
    if (Number(error?.status) !== 404) throw error;
    await catalogRepository.markSkuMissing(account.id, sku, {
      httpStatus: 404, error: "SKU não encontrado no Portfólio Magalu.",
    });
    return { missing: true };
  }
  const [price, stock] = await Promise.all([syncPrice(account, sku), syncStock(account, sku)]);
  return { missing: false, price_ok: price.ok, stock_ok: stock.ok };
}

async function fullCatalogSync(accountId, { reason = "manual", jobId = null } = {}) {
  const account = await accountRepository.findAccountById(accountId);
  if (!account || account.status !== "active") {
    const error = new Error("Conta Magalu ativa não encontrada para sincronização.");
    error.code = "MAGALU_ACCOUNT_NOT_ACTIVE";
    error.status = 404;
    throw error;
  }

  const startedAt = new Date();
  const run = await syncRunRepository.createRun({
    dachTenantId: account.dach_tenant_id,
    accountId: account.id,
    syncType: "catalog_full",
    result: { reason, job_id: jobId || null },
  });
  await accountRepository.setCatalogSyncState(account.id, { status: "running", error: null });

  let scanned = 0;
  let created = 0;
  let updated = 0;
  let failed = 0;
  let pages = 0;
  let lastCursor = "0";
  let currentStage = "sku_list";
  let currentEndpoint = "/seller/v1/portfolios/skus";
  let sellerProfile = { status: "not_checked" };
  let knownRefreshed = 0;
  let knownProcessed = 0;
  let knownMissing = 0;
  const discoveryPartialStatuses = [];
  const fullyScannedStatuses = [];
  const progress = async (stage) => {
    if (typeof syncRunRepository.updateRunProgress !== "function") return;
    await syncRunRepository.updateRunProgress(run.id, {
      scannedCount: scanned + knownProcessed, createdCount: created,
      updatedCount: updated + knownRefreshed, failedCount: failed,
      result: { stage, pages, known_processed: knownProcessed, known_refreshed: knownRefreshed, known_missing: knownMissing,
        discovery_partial_statuses: discoveryPartialStatuses },
    });
  };

  try {
    // Seller profile is enrichment only. Some tenants can access portfolio SKUs while
    // /portfolios/me returns 403. Never block the catalog mirror on this auxiliary call.
    try {
      const seller = await portfolioReadService.getSeller(account.id, account.dach_tenant_id);
      if (seller?.data && typeof seller.data === "object") {
        await accountRepository.updateSellerProfile(account.id, seller.data);
      }
      sellerProfile = {
        status: "ok",
        http_status: Number(seller?.status || 200),
        request_id: seller?.requestId || null,
      };
    } catch (profileError) {
      sellerProfile = {
        status: "warning",
        http_status: Number(profileError?.status || 0) || null,
        request_id: profileError?.requestId || null,
        message: apiErrorText(profileError),
      };
      console.warn("[seller-magalu:catalog] seller profile unavailable; continuing with catalog sync", {
        accountId: account.id,
        status: sellerProfile.http_status,
        requestId: sellerProfile.request_id,
      });
    }

    for (const statusFilter of CATALOG_SYNC_STATUSES) {
      let offset = 0;
      let partitionComplete = false;
      while (true) {
        currentStage = "sku_list";
        currentEndpoint = `/seller/v1/portfolios/skus?_offset=${offset}&_limit=${env.MAGALU_SYNC_PAGE_SIZE}&status=${statusFilter}`;
        let page;
        try {
          page = await portfolioReadService.listSkus(account.id, account.dach_tenant_id, {
            offset,
            limit: env.MAGALU_SYNC_PAGE_SIZE,
            status: statusFilter,
            sort: "updated_at:desc",
          });
        } catch (error) {
          if (Number(error?.status) === 422 && offset >= MAX_SKU_LIST_OFFSET) {
            discoveryPartialStatuses.push(statusFilter);
            break;
          }
          throw error;
        }
        const payload = page.data && typeof page.data === "object" ? page.data : {};
        const rows = Array.isArray(payload.results) ? payload.results : [];
        pages += 1;

        currentStage = "sku_persist";
        for (const skuPayload of rows) {
          const saved = await catalogRepository.upsertSku(account.id, skuPayload, {
            seenAt: startedAt,
            httpStatus: page.status,
          });
          scanned += 1;
          if (saved?.inserted === true) created += 1;
          else updated += 1;
        }

        currentStage = "price_stock_details";
        currentEndpoint = "/seller/v1/portfolios/prices/:sku + /seller/v1/portfolios/stocks/:sku";
        await mapWithConcurrency(rows, env.MAGALU_SYNC_DETAIL_CONCURRENCY, async (skuPayload) => {
          const sku = text(skuPayload?.sku);
          if (!sku) {
            failed += 1;
            return;
          }
          const [price, stock] = await Promise.all([syncPrice(account, sku), syncStock(account, sku)]);
          if (!price.ok) failed += 1;
          if (!stock.ok) failed += 1;
        });
        await progress(`list:${statusFilter}`);

        const fallbackNext = offset + rows.length;
        const nextOffset = nextOffsetFromLink(payload?.meta?.links?.next, fallbackNext);
        lastCursor = `${statusFilter}:${fallbackNext}`;
        if (nextOffset === null || rows.length === 0) {
          partitionComplete = true;
          break;
        }
        if (nextOffset > MAX_SKU_LIST_OFFSET) {
          discoveryPartialStatuses.push(statusFilter);
          break;
        }
        offset = nextOffset;
      }
      if (partitionComplete) fullyScannedStatuses.push(statusFilter);
    }

    // SKUs outside the accessible list window remain in the local mirror. Refresh
    // each known item by its direct endpoint; a confirmed 404 can safely mark it missing.
    let afterId = 0;
    while (true) {
      const batch = typeof catalogRepository.listSkusNotSeenSince === "function"
        ? await catalogRepository.listSkusNotSeenSince(account.id, startedAt, afterId, 100)
        : [];
      if (!batch.length) break;
      afterId = Number(batch[batch.length - 1].id);
      currentStage = "known_sku_refresh";
      currentEndpoint = "/seller/v1/portfolios/skus/:sku + price + stock";
      await mapWithConcurrency(batch, env.MAGALU_SYNC_DETAIL_CONCURRENCY, async ({ sku }) => {
        try {
          const result = await refreshKnownSku(account, sku);
          if (result.missing) knownMissing += 1;
          else if (result.price_ok === false || result.stock_ok === false) {
            if (result.price_ok === false) failed += 1;
            if (result.stock_ok === false) failed += 1;
          } else knownRefreshed += 1;
        } catch (error) {
          failed += 1;
          console.warn("[seller-magalu:catalog] known SKU refresh failed", { accountId: account.id, sku, error: apiErrorText(error) });
        } finally {
          knownProcessed += 1;
        }
      });
      await progress("known_sku_refresh");
    }

    currentStage = "finalize";
    currentEndpoint = null;
    // Offset pages can shift while the remote catalog changes. Only a direct 404
    // marks a saved SKU missing; never infer deletion from an incomplete list.
    const missing = knownMissing;
    const status = failed > 0 || discoveryPartialStatuses.length ? "partial" : "success";
    const finishedAt = new Date();

    await syncRunRepository.finishRun(run.id, {
      status,
      cursorOut: lastCursor,
      scannedCount: scanned + knownProcessed,
      createdCount: created,
      updatedCount: updated + knownRefreshed,
      failedCount: failed,
      result: {
        pages,
        known_processed: knownProcessed,
        known_refreshed: knownRefreshed,
        known_missing: knownMissing,
        discovery_partial_statuses: discoveryPartialStatuses,
        fully_scanned_statuses: fullyScannedStatuses,
        missing_marked: missing,
        reason,
        job_id: jobId || null,
        seller_profile: sellerProfile,
      },
    });
    await accountRepository.setCatalogSyncState(account.id, {
      status,
      error: [discoveryPartialStatuses.length ? `Descoberta parcial em ${discoveryPartialStatuses.join(", ")}: a API limita a paginação a 20.000. SKUs salvos: ${knownRefreshed} atualizados, ${knownMissing} ausentes confirmados.` : null,
        failed ? `${failed} leitura(s) falharam; consulte o histórico.` : null].filter(Boolean).join(" ") || null,
      syncedAt: finishedAt.toISOString(),
    });

    return { status, scanned: scanned + knownProcessed, created, updated: updated + knownRefreshed,
      knownProcessed, knownRefreshed, knownMissing, discoveryPartialStatuses, failed, pages, missingMarked: missing, sellerProfile };
  } catch (error) {
    const remote = remoteErrorMeta(error, currentEndpoint, currentStage);
    await syncRunRepository.finishRun(run.id, {
      status: "failed",
      cursorOut: lastCursor,
      scannedCount: scanned + knownProcessed,
      createdCount: created,
      updatedCount: updated + knownRefreshed,
      failedCount: failed + 1,
      result: {
        pages,
        known_processed: knownProcessed,
        known_refreshed: knownRefreshed,
        known_missing: knownMissing,
        discovery_partial_statuses: discoveryPartialStatuses,
        reason,
        job_id: jobId || null,
        seller_profile: sellerProfile,
        ...remote,
      },
      errorMessage: apiErrorText(error),
    }).catch(() => {});
    await accountRepository.setCatalogSyncState(account.id, {
      status: "failed",
      error: apiErrorText(error),
    }).catch(() => {});
    throw error;
  }
}

module.exports = {
  fullCatalogSync,
  reconcileSku,
  _test: { mapWithConcurrency, apiErrorText, nextOffsetFromLink, remoteErrorMeta },
};
