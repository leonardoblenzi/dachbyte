const asyncHandler = require("../utils/asyncHandler");
const XLSX = require("xlsx");
const { requestShopeeAuthed } = require("../services/ShopeeAuthedHttp");
const {
  countProductsForCosts,
  exportProductsCosts,
  getShopTaxRate,
  listProductsForCosts,
  listProductsForIntelligentPricing,
  updateProductCostById,
  updateProductCostByItemId,
  updateShopTaxRate,
} = require("../repositories/costsSqlRepository");
const { resolveShop } = require("../utils/resolveShop");

async function getActiveShopOrFail(req) {
  return resolveShop(req, "active");
}

function normalizeSpreadsheetHeader(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();
}

function findSpreadsheetValue(row, headers) {
  const expected = new Set(headers.map(normalizeSpreadsheetHeader));
  const entry = Object.entries(row || {}).find(([key]) => expected.has(normalizeSpreadsheetHeader(key)));
  return entry ? entry[1] : undefined;
}

function parseImportedCostValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const raw = String(value ?? "").replace(/[R$\s]/g, "");
  const normalized = raw.includes(",")
    ? raw.replace(/\./g, "").replace(",", ".")
    : raw;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseImportedCostRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const itemId = findSpreadsheetValue(row, ["ID", "ITEM ID", "ITEMID"]);
      const cost = findSpreadsheetValue(row, ["PREÇO", "PRECO", "CUSTO", "COST", "PRICE"]);
      if (!itemId || cost === undefined) return null;
      const cleanId = String(itemId).replace(/[^0-9]/g, "").trim();
      return cleanId ? { itemId: cleanId, cost: parseImportedCostValue(cost) } : null;
    })
    .filter(Boolean);
}
async function listCosts(req, res) {
  const shop = await getActiveShopOrFail(req);
  const shopId = shop.id;

  const page = Number(req.query.page) || 1;
  const pageSize = Number(req.query.pageSize) || 50;
  const search = String(req.query.q || "").trim();
  const withoutCost = ["1", "true", "yes"].includes(
    String(req.query.withoutCost || "").trim().toLowerCase(),
  );

  const [total, items] = await Promise.all([
    countProductsForCosts({ shopId, search, withoutCost }),
    listProductsForCosts({ shopId, search, withoutCost, page, pageSize }),
  ]);

  const taxRate = await getShopTaxRate(shopId);

  res.json({
    items: items.map((item) => ({
      ...item,
      itemId: String(item.itemId),
      imageUrl: item.imageUrl || null,
      cost: (item.costCents || 0) / 100,
    })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
    withoutCost,
    taxRate,
  });
}

async function updateCost(req, res) {
  const shop = await getActiveShopOrFail(req);
  const shopId = shop.id;
  const { id } = req.params;
  const { cost } = req.body;

  const costCents = Math.round(Number(cost) * 100);

  await updateProductCostById({
    productId: Number(id),
    shopId,
    costCents,
  });

  res.json({ success: true });
}

async function updateTaxRate(req, res) {
  const shop = await getActiveShopOrFail(req);
  const shopId = shop.id;
  const { taxRate } = req.body;

  await updateShopTaxRate({
    shopId,
    taxRate: Number(taxRate) || 0,
  });

  res.json({ success: true });
}

function parseItemIdsInput(value) {
  const normalized = String(value || "")
    .split(/[\s,;\n\r\t]+/)
    .map((token) => token.replace(/[^0-9]/g, "").trim())
    .filter(Boolean);
  return Array.from(new Set(normalized));
}

async function getPricingItems(req, res) {
  const shop = await getActiveShopOrFail(req);
  const shopId = shop.id;
  const itemIds = parseItemIdsInput(
    req.query.itemIds || req.query.itemId || req.query.ids || "",
  ).slice(0, 500);

  const taxRate = await getShopTaxRate(shopId);
  if (!itemIds.length) {
    return res.json({ taxRate, items: [], notFoundItemIds: [] });
  }

  const products = await listProductsForIntelligentPricing({ shopId, itemIds });
  const foundIds = new Set(
    products
      .map((item) => String(item?.itemId || "").trim())
      .filter(Boolean),
  );
  const notFoundItemIds = itemIds.filter((itemId) => !foundIds.has(String(itemId)));

  return res.json({
    taxRate,
    items: products.map((item) => ({
      id: item.id,
      itemId: String(item.itemId || ""),
      status: item.status || null,
      title: item.title || null,
      itemSku: item.itemSku || null,
      imageUrl: item.imageUrl || null,
      cost: Number((Number(item.costCents || 0) / 100).toFixed(2)),
      priceMin: item.priceMin == null ? null : Number(item.priceMin),
      priceMax: item.priceMax == null ? null : Number(item.priceMax),
    })),
    notFoundItemIds,
  });
}

function normalizeVoucherStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (["upcoming", "ongoing", "expired", "all"].includes(status)) return status;
  return "ongoing";
}

async function getPricingVouchers(req, res) {
  const shop = await getActiveShopOrFail(req);
  const status = normalizeVoucherStatus(req.query.status || "ongoing");
  const pageSize = Math.max(
    1,
    Math.min(100, Math.floor(Number(req.query.pageSize || 100) || 100)),
  );
  const maxPages = Math.max(
    1,
    Math.min(50, Math.floor(Number(req.query.maxPages || 20) || 20)),
  );

  const vouchers = [];
  let pageNo = 1;
  let more = true;

  while (more && pageNo <= maxPages) {
    const payload = await requestShopeeAuthed({
      method: "GET",
      path: "/api/v2/voucher/get_voucher_list",
      query: {
        status,
        page_no: pageNo,
        page_size: pageSize,
      },
      shopId: String(shop.shopId),
    });
    const response = payload?.response || {};
    const pageRows = Array.isArray(response.voucher_list)
      ? response.voucher_list
      : [];
    vouchers.push(...pageRows);
    more = Boolean(response.more);
    pageNo += 1;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const normalized = vouchers.map((row) => {
    const usageQuantity = Number(row?.usage_quantity || 0);
    const currentUsage = Number(row?.current_usage || 0);
    const startTime = Number(row?.start_time || 0);
    const endTime = Number(row?.end_time || 0);
    const isTimeActive =
      startTime > 0 && endTime > 0 ? startTime <= nowSec && nowSec <= endTime : true;
    const hasRemainingUsage = usageQuantity > 0 ? currentUsage < usageQuantity : true;
    return {
      voucherId: String(row?.voucher_id || ""),
      voucherCode: String(row?.voucher_code || "").trim(),
      voucherName: String(row?.voucher_name || "").trim(),
      voucherType: Number(row?.voucher_type || 0),
      rewardType: Number(row?.reward_type || 0),
      usageQuantity,
      currentUsage,
      startTime: startTime > 0 ? new Date(startTime * 1000).toISOString() : null,
      endTime: endTime > 0 ? new Date(endTime * 1000).toISOString() : null,
      status,
      isAdmin: Boolean(row?.is_admin),
      discountAmount: row?.discount_amount == null ? null : Number(row.discount_amount),
      percentage: row?.percentage == null ? null : Number(row.percentage),
      minSpendAmount:
        row?.min_spend == null
          ? row?.min_spend_amount == null
            ? null
            : Number(row.min_spend_amount)
          : Number(row.min_spend),
      maxDiscountAmount:
        row?.max_discount_amount == null
          ? row?.max_discount == null
            ? null
            : Number(row.max_discount)
          : Number(row.max_discount_amount),
      isTimeActive,
      hasRemainingUsage,
      isActiveNow: isTimeActive && hasRemainingUsage,
    };
  });

  return res.json({
    status,
    vouchers: normalized,
    fetchedAt: new Date().toISOString(),
  });
}

async function importCosts(req, res) {
  const shop = await getActiveShopOrFail(req);
  const shopId = shop.id;

  let items = [];

  if (req.body.items && Array.isArray(req.body.items)) {
    items = req.body.items;
    console.log("[importCosts] Recebido JSON com", items.length, "itens");
  } else if (req.body.fileData) {
    try {
      const buffer = Buffer.from(req.body.fileData, "base64");
      const workbook = XLSX.read(buffer, { type: "buffer" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(sheet);

      console.log(
        "[importCosts] Primeiro registro do XLSX:",
        JSON.stringify(data[0]),
      );
      items = parseImportedCostRows(data);

      console.log(
        "[importCosts] XLSX parseado:",
        items.length,
        "itens validos",
      );
    } catch (err) {
      console.error("[importCosts] Erro ao ler XLSX:", err);
      throw new Error("Erro ao ler XLSX: " + err.message);
    }
  } else {
    throw new Error("Formato invalido.");
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Nenhum item valido encontrado.");
  }

  let updated = 0;
  const errors = [];

  console.log("[importCosts] Iniciando atualizacao de", items.length, "itens");

  for (const item of items) {
    try {
      if (!item.itemId || !/^\d+$/.test(String(item.itemId))) {
        console.warn(
          "[importCosts] ItemId invalido (nao e numero):",
          item.itemId,
        );
        errors.push({
          itemId: item.itemId,
          erro: "ID invalido (nao e numero)",
        });
        continue;
      }

      const itemId = BigInt(item.itemId);
      const costCents = Math.round(Number(item.cost) * 100);

      const changed = await updateProductCostByItemId({
        shopId,
        itemId,
        costCents,
      });
      updated += changed ? 1 : 0;

      if (!changed) {
        console.warn("[importCosts] Produto nao encontrado:", item.itemId);
        errors.push({
          itemId: item.itemId,
          erro: "Produto nao encontrado na loja",
        });
      }
    } catch (err) {
      console.error(
        "[importCosts] Erro ao atualizar item",
        item.itemId,
        ":",
        err.message,
      );
      errors.push({
        itemId: item.itemId,
        erro: err.message,
      });
    }
  }

  console.log(
    "[importCosts] Completado -",
    updated,
    "atualizados,",
    errors.length,
    "erros",
  );

  res.json({ success: true, updated, errors, total: items.length });
}

async function exportCosts(req, res) {
  const shop = await getActiveShopOrFail(req);
  const shopId = shop.id;

  const format = (req.query.format || "xlsx").toLowerCase();

  const items = await exportProductsCosts(shopId);

  if (format === "csv") {
    let csv = "ID,NOME,SKU,PREÇO\n";
    for (const item of items) {
      const cost = ((item.costCents || 0) / 100).toFixed(2).replace(".", ",");
      const title = (item.title || "").replace(/"/g, '""');
      csv += `${item.itemId},"${title}",${item.itemSku || ""},"${cost}"\n`;
    }

    res.header("Content-Type", "text/csv; charset=utf-8");
    res.attachment("custos_produtos.csv");
    res.send(csv);
    return;
  }

  const data = items.map((item) => ({
    ID: item.itemId.toString(),
    NOME: item.title || "",
    SKU: item.itemSku || "",
    "PREÇO": ((item.costCents || 0) / 100).toFixed(2),
  }));

  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Custos");

  worksheet["!cols"] = [
    { wch: 15 },
    { wch: 30 },
    { wch: 15 },
    { wch: 12 },
  ];

  const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
  res.header(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.attachment("custos_produtos.xlsx");
  res.send(buffer);
}

module.exports = {
  getPricingItems,
  getPricingVouchers,
  listCosts,
  updateCost,
  updateTaxRate,
  importCosts,
  exportCosts,
  _test: { parseImportedCostRows },
};
