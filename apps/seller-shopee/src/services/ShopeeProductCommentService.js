const { requestShopeeAuthed } = require("./ShopeeAuthedHttp");

function onlyDigits(v) {
  return /^\d+$/.test(String(v ?? "").trim());
}

function toIntSafe(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function getItemRatingSummary({
  shopId,
  itemId,
  max = 500,
  pageSize = 100,
}) {
  const sShopId = String(shopId ?? "").trim();
  const sItemId = String(itemId ?? "").trim();

  if (!onlyDigits(sShopId)) {
    const err = new Error("shopId inválido (get_comment).");
    err.statusCode = 400;
    throw err;
  }
  if (!onlyDigits(sItemId)) {
    const err = new Error("itemId inválido (get_comment).");
    err.statusCode = 400;
    throw err;
  }

  const limit = Math.max(1, Math.min(500, Number(max) || 500));
  const ps = Math.max(1, Math.min(100, Number(pageSize) || 100));

  let cursor = "";
  let processed = 0;

  let sumStars = 0;
  let ratingCount = 0;
  let over500 = false;

  while (processed < limit) {
    const payload = await requestShopeeAuthed({
      method: "GET",
      path: "/api/v2/product/get_comment",
      shopId: sShopId,
      query: {
        item_id: sItemId,
        cursor,
        page_size: Math.min(ps, limit - processed),
      },
    });

    if (payload?.error) {
      const msg = payload?.message || payload?.error || "Erro Shopee";
      const err = new Error(String(msg));
      err.statusCode = 502;
      err.shopee = payload;
      throw err;
    }

    const items = Array.isArray(payload?.response?.item_comment_list)
      ? payload.response.item_comment_list
      : [];

    const more = Boolean(payload?.more);
    const nextCursor = String(payload?.response?.next_cursor ?? "");

    for (const c of items) {
      if (processed >= limit) break;
      processed += 1;

      const star = toIntSafe(c?.rating_star);
      if (star !== null && star >= 1 && star <= 5) {
        sumStars += star;
        ratingCount += 1;
      }
    }

    if (more && processed >= limit) {
      over500 = true; // ✅ avisa que é parcial
      break;
    }

    if (!more) break;

    // defesa contra loop infinito
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }

  const avgStar = ratingCount > 0 ? sumStars / ratingCount : 0;

  return { avgStar, ratingCount, over500, processed };
}

module.exports = { getItemRatingSummary };
