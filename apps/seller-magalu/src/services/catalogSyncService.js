"use strict";

const env = require("../config/env");
const accountRepository = require("../repositories/accountRepository");
const catalogRepository = require("../repositories/catalogRepository");
const syncRunRepository = require("../repositories/syncRunRepository");
const portfolioReadService = require("./portfolioReadService");

function text(value) {
  return String(value == null ? "" : value).trim();
}

function apiErrorText(error) {
  return String(error?.message || error?.payload?.message || error || "Erro desconhecido").slice(0, 1800);
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
    const response = await portfolioReadService.getPrice(
      account.id,
      account.dach_tenant_id,
      sku,
    );
    await catalogRepository.upsertPrice(account.id, sku, response.data, {
      httpStatus: response.status,
    });
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
    const response = await portfolioReadService.getStock(
      account.id,
      account.dach_tenant_id,
      sku,
    );
    await catalogRepository.upsertStock(account.id, sku, response.data, {
      httpStatus: response.status,
    });
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
  const result = {
    sku: normalizedSku,
    topic,
    sku_ok: null,
    price_ok: null,
    stock_ok: null,
  };

  // Price/stock webhooks can arrive before the initial full mirror. The FK-bound
  // mirror therefore materializes the base SKU first when it is still absent.
  if (topic === "portfolios_price" || topic === "portfolios_stock") {
    const local = await catalogRepository.getCatalogItem(account.id, normalizedSku);
    if (!local) {
      try {
        const response = await portfolioReadService.getSku(
          account.id,
          account.dach_tenant_id,
          normalizedSku,
        );
        await catalogRepository.upsertSku(account.id, response.data, {
          seenAt,
          httpStatus: response.status,
        });
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
      const response = await portfolioReadService.getSku(
        account.id,
        account.dach_tenant_id,
        normalizedSku,
      );
      await catalogRepository.upsertSku(account.id, response.data, {
        seenAt,
        httpStatus: response.status,
      });
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
    result: { reason, job_id: jobId || null, stage: 3 },
  });
  await accountRepository.setCatalogSyncState(account.id, { status: "running", error: null });

  let scanned = 0;
  let created = 0;
  let updated = 0;
  let failed = 0;
  let offset = 0;
  let pages = 0;
  let lastCursor = "0";

  try {
    // This real API call validates the connected tenant against the portfolio
    // surface before a catalog mirror is accepted as healthy.
    const seller = await portfolioReadService.getSeller(account.id, account.dach_tenant_id);
    if (seller?.data && typeof seller.data === "object") {
      await accountRepository.updateSellerProfile(account.id, seller.data);
    }

    while (true) {
      const page = await portfolioReadService.listSkus(account.id, account.dach_tenant_id, {
        offset,
        limit: env.MAGALU_SYNC_PAGE_SIZE,
      });
      const payload = page.data && typeof page.data === "object" ? page.data : {};
      const rows = Array.isArray(payload.results) ? payload.results : [];
      pages += 1;

      for (const skuPayload of rows) {
        const saved = await catalogRepository.upsertSku(account.id, skuPayload, {
          seenAt: startedAt,
          httpStatus: page.status,
        });
        scanned += 1;
        if (saved?.inserted === true) created += 1;
        else updated += 1;
      }

      await mapWithConcurrency(rows, env.MAGALU_SYNC_DETAIL_CONCURRENCY, async (skuPayload) => {
        const sku = text(skuPayload?.sku);
        if (!sku) {
          failed += 1;
          return;
        }
        const [price, stock] = await Promise.all([
          syncPrice(account, sku),
          syncStock(account, sku),
        ]);
        if (!price.ok) failed += 1;
        if (!stock.ok) failed += 1;
      });

      const fallbackNext = offset + rows.length;
      const nextOffset = nextOffsetFromLink(payload?.meta?.links?.next, fallbackNext);
      lastCursor = String(fallbackNext);
      if (nextOffset === null || rows.length === 0) break;
      offset = nextOffset;
    }

    const missing = await catalogRepository.markUnseenSkusMissing(account.id, startedAt);
    const status = failed > 0 ? "partial" : "success";
    const finishedAt = new Date();

    await syncRunRepository.finishRun(run.id, {
      status,
      cursorOut: lastCursor,
      scannedCount: scanned,
      createdCount: created,
      updatedCount: updated,
      failedCount: failed,
      result: { pages, missing_marked: missing, reason, job_id: jobId || null },
    });
    await accountRepository.setCatalogSyncState(account.id, {
      status,
      error: failed ? `${failed} leitura(s) de preço/estoque falharam; consulte o histórico.` : null,
      syncedAt: finishedAt.toISOString(),
    });

    return { status, scanned, created, updated, failed, pages, missingMarked: missing };
  } catch (error) {
    await syncRunRepository.finishRun(run.id, {
      status: "failed",
      cursorOut: lastCursor,
      scannedCount: scanned,
      createdCount: created,
      updatedCount: updated,
      failedCount: failed + 1,
      result: { pages, reason, job_id: jobId || null },
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
  _test: { mapWithConcurrency, apiErrorText, nextOffsetFromLink },
};
