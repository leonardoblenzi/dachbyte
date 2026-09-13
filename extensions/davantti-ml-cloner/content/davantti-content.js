(() => {
  "use strict";

  const ROOT_ID = "davantti-insight-root";
  const STORAGE_KEYS = {
    token: "davantti_extension_token",
    user: "davantti_extension_user",
    accountId: "davantti_extension_account_id",
    launcherPosition: "davantti_extension_launcher_position",
  };
  const DEFAULT_BASE_URL = "https://www.davanttisuite.com.br/ml";
  const BRAND_ICON_URL = chrome.runtime.getURL("icons/icone.png");
  const DAVANTTI_LANDING_URL = "https://www.davanttisuite.com.br/landing";
  const DAVANTTI_CONTACT_URL = "https://www.davanttisuite.com.br/landing#contato";
  const NETWORK_EVENT_CAPTURE = "DAVANTTI_NETWORK_CAPTURE";
  const NETWORK_EVENT_CACHE_REQUEST = "DAVANTTI_NETWORK_CACHE_REQUEST";
  const NETWORK_EVENT_CACHE_RESPONSE = "DAVANTTI_NETWORK_CACHE_RESPONSE";

  const state = {
    open: false,
    drawerOpen: false,
    modalOpen: false,
    current: null,
    cloning: false,
    loggingIn: false,
    baseUrl: DEFAULT_BASE_URL,
    token: "",
    user: null,
    accounts: [],
    accountId: "",
    realtimeCache: new Map(),
    realtimeInflight: new Set(),
    networkEntries: [],
    marketAnalysis: null,
    analyzingMarket: false,
    generatingKeywords: false,
    generatedKeywordsKey: "",
    keywordPage: 1,
    keywordPageByKey: new Map(),
    inlineReadyAt: 0,
    pendingInlineTimer: null,
    networkVersion: 0,
    pendingRealtimeRefreshTimer: null,
    lastRealtimeRefreshKey: "",
    lastRealtimeRefreshVersion: 0,
    launcherOpen: false,
    launcherPosition: null,
    launcherDrag: null,
    suppressLauncherClick: false,
    activeTool: "",
    toolOpen: false,
    eanValue: "",
    shopeeItemSnapshot: { url: "", item: null },
    mediaDownloading: false,
  };

  function text(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function firstText(selectors, root = document) {
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      const value = text(node?.textContent || node?.getAttribute?.("content") || "");
      if (value) return value;
    }
    return "";
  }

  function attr(selectors, name, root = document) {
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      const value = text(node?.getAttribute?.(name) || "");
      if (value) return value;
    }
    return "";
  }

  function parseMoney(raw) {
    const value = text(raw);
    if (!value) return null;
    const match = value.match(
      /(?:R\$\s*)?([0-9]{1,3}(?:\.[0-9]{3})*(?:,[0-9]{2})|[0-9]+(?:,[0-9]{2})?)/,
    );
    if (!match) return null;
    const normalized = match[1].replace(/\./g, "").replace(",", ".");
    const number = Number(normalized);
    return Number.isFinite(number) ? number : null;
  }

  function formatMoney(value) {
    if (!Number.isFinite(value)) return "-";
    return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function parseCountValue(raw) {
    if (typeof raw === "number" && Number.isFinite(raw)) return Math.round(raw);
    const value = text(raw).toLowerCase();
    if (!value) return null;
    const match = value.match(/([0-9]+(?:[.,][0-9]+)?)/);
    if (!match) return null;
    let base = Number(match[1].replace(/\./g, "").replace(",", "."));
    if (!Number.isFinite(base)) return null;
    if (/\bmilh(?:ao|oes)?\b|\bmi\b/.test(value)) base *= 1000000;
    else if (/\bmil\b|\bk\b/.test(value)) base *= 1000;
    return Math.round(base);
  }

  function extractAllMoney(raw) {
    const values = [];
    const regex = /R\$\s*([0-9]{1,3}(?:\.[0-9]{3})*(?:,[0-9]{2})|[0-9]+(?:,[0-9]{2})?)/gi;
    let match = null;
    const source = String(raw || "");
    while ((match = regex.exec(source)) !== null) {
      const parsed = Number(String(match[1] || "").replace(/\./g, "").replace(",", "."));
      if (Number.isFinite(parsed)) values.push(parsed);
    }
    return values;
  }

  function normalizeShopeePrice(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    if (Math.abs(parsed) >= 100000) return Number((parsed / 100000).toFixed(2));
    return parsed;
  }

  function epochToIso(value) {
    const raw = Number(value || 0);
    if (!Number.isFinite(raw) || raw <= 0) return "";
    if (raw > 1000000000000) {
      const msDate = new Date(raw);
      return Number.isNaN(msDate.getTime()) ? "" : msDate.toISOString();
    }
    if (raw > 1000000000) {
      const secDate = new Date(raw * 1000);
      return Number.isNaN(secDate.getTime()) ? "" : secDate.toISOString();
    }
    return "";
  }

  function extractShopeeIdsFromUrl(url = location.href) {
    const raw = String(url || "");
    const direct = raw.match(/-i\.(\d+)\.(\d+)/i);
    if (direct) {
      return {
        shopId: String(direct[1] || ""),
        itemId: String(direct[2] || ""),
      };
    }
    const product = raw.match(/\/product\/(\d+)\/(\d+)/i);
    if (product) {
      return {
        shopId: String(product[1] || ""),
        itemId: String(product[2] || ""),
      };
    }
    const queryItem = raw.match(/[?&]itemid=(\d+)/i);
    const queryShop = raw.match(/[?&]shopid=(\d+)/i);
    return {
      shopId: queryShop?.[1] ? String(queryShop[1]) : "",
      itemId: queryItem?.[1] ? String(queryItem[1]) : "",
    };
  }

  function parseJsonLoose(value, fallback = null) {
    if (value == null) return fallback;
    if (typeof value === "object") return value;
    try {
      return JSON.parse(String(value));
    } catch {
      return fallback;
    }
  }

  function findShopeeItemInInitialData(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 12) return null;
    if (
      value.item
      && typeof value.item === "object"
      && (
        value.item.title
        || value.item.name
        || Array.isArray(value.item.models)
        || Array.isArray(value.item.attributes)
      )
    ) {
      return value.item;
    }
    const entries = Array.isArray(value) ? value : Object.values(value);
    for (const entry of entries) {
      const found = findShopeeItemInInitialData(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function readShopeeItemFromInitialData() {
    if (state.shopeeItemSnapshot.url === location.href) {
      return state.shopeeItemSnapshot.item || null;
    }
    let foundItem = null;
    const scripts = Array.from(document.querySelectorAll('script[type="text/mfe-initial-data"]'));
    for (const script of scripts) {
      const parsed = parseJsonLoose(script.textContent || "", null);
      if (!parsed) continue;
      foundItem = findShopeeItemInInitialData(parsed);
      if (foundItem) break;
    }
    state.shopeeItemSnapshot = {
      url: location.href,
      item: foundItem || null,
    };
    return foundItem || null;
  }

  function collectShopeeAttributes() {
    const rows = [];
    const seen = new Set();
    const push = (label, value) => {
      const cleanLabel = text(label);
      const cleanValue = text(value);
      if (!cleanLabel || !cleanValue) return;
      const key = `${cleanLabel}|${cleanValue}`;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({ label: cleanLabel, value: cleanValue });
    };

    Array.from(document.querySelectorAll(".ybxj32")).forEach((block) => {
      const label = text(block.querySelector("h3")?.textContent || "");
      const value = text(Array.from(block.children)
        .filter((child) => child.tagName !== "H3")
        .map((child) => child.textContent || "")
        .join(" "));
      push(label, value);
    });

    if (!rows.length) {
      const section = Array.from(document.querySelectorAll("section")).find((node) => /detalhes do produto/i.test(text(node.textContent || "")));
      if (section) {
        Array.from(section.querySelectorAll("h3")).forEach((titleNode) => {
          const label = text(titleNode.textContent || "");
          const wrapper = titleNode.parentElement;
          const value = text(Array.from(wrapper?.children || [])
            .filter((child) => child !== titleNode)
            .map((child) => child.textContent || "")
            .join(" "));
          push(label, value);
        });
      }
    }

    return rows.slice(0, 18);
  }

  function shopeeCommissionRuleForPrice(price) {
    const value = Number(price || 0);
    if (!Number.isFinite(value) || value <= 0) return null;
    if (value <= 79.99) {
      return { rate: 0.2, fixedFee: 4, label: "20% + R$4" };
    }
    if (value <= 99.99) {
      return { rate: 0.14, fixedFee: 16, label: "14% + R$16" };
    }
    if (value <= 199.99) {
      return { rate: 0.14, fixedFee: 20, label: "14% + R$20" };
    }
    return { rate: 0.14, fixedFee: 26, label: "14% + R$26" };
  }

  function shopeeFreightSubsidyCap(price) {
    const value = Number(price || 0);
    if (!Number.isFinite(value) || value <= 0) return 0;
    if (value <= 79.99) return 20;
    if (value <= 199.99) return 30;
    return 40;
  }

  function shopeePixDiscountRate(price) {
    const value = Number(price || 0);
    if (!Number.isFinite(value) || value <= 0) return 0;
    if (value > 500) return 0.08;
    if (value >= 80 && value <= 499.99) return 0.05;
    return 0;
  }

  function computeShopeeSubsidyBenefits({ salePrice, regularPrice, pixPrice, shippingMin }) {
    const basePrice = Number.isFinite(Number(regularPrice)) && Number(regularPrice) > 0
      ? Number(regularPrice)
      : Number.isFinite(Number(salePrice)) && Number(salePrice) > 0
        ? Number(salePrice)
        : 0;
    const pixValue = Number.isFinite(Number(pixPrice)) && Number(pixPrice) > 0 ? Number(pixPrice) : 0;
    const hasPix = basePrice > 0 && pixValue > 0 && pixValue < basePrice;
    const expectedPixRate = shopeePixDiscountRate(basePrice);
    const expectedPixDiscount = hasPix && expectedPixRate > 0 ? basePrice * expectedPixRate : 0;
    const observedPixDiscount = hasPix ? Math.max(0, basePrice - pixValue) : 0;
    const pixDiscountAmount = observedPixDiscount > 0 ? observedPixDiscount : expectedPixDiscount;
    const pixDiscountRate = basePrice > 0 && pixDiscountAmount > 0 ? (pixDiscountAmount / basePrice) * 100 : 0;
    const freightCap = shopeeFreightSubsidyCap(basePrice);
    const shippingValue = Number.isFinite(Number(shippingMin)) && Number(shippingMin) > 0 ? Number(shippingMin) : 0;
    const freightSubsidyAmount = shippingValue > 0 ? Math.min(shippingValue, freightCap) : 0;
    return {
      basePrice,
      hasPix,
      pixDiscountAmount: Number(pixDiscountAmount.toFixed(2)),
      pixDiscountRate: Number(pixDiscountRate.toFixed(2)),
      freightCap: Number(freightCap.toFixed(2)),
      freightSubsidyAmount: Number(freightSubsidyAmount.toFixed(2)),
      totalSubsidyAmount: Number((pixDiscountAmount + freightSubsidyAmount).toFixed(2)),
    };
  }

  function computeShopeeEstimatedFees(price) {
    const unitPrice = Number(price || 0);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) return null;

    const rule = shopeeCommissionRuleForPrice(unitPrice);
    if (!rule) return null;
    const commissionRate = Number(rule.rate || 0);
    const fixedFee = Number(rule.fixedFee || 0);
    const variableCommission = unitPrice * commissionRate;
    const total = variableCommission + fixedFee;

    return {
      sale_fee: Number(total.toFixed(2)),
      commission_amount: Number(variableCommission.toFixed(2)),
      fixed_fee: fixedFee,
      effective_rate: Number(((total / unitPrice) * 100).toFixed(2)),
      rule: rule.label,
      source: "estimativa_publica_shopee",
    };
  }

  function normalizeShopeeMediaUrl(raw, keepQuery = false) {
    const value = String(raw || "").trim().replace(/&amp;/g, "&");
    if (!value || /^data:/i.test(value) || /^blob:/i.test(value)) return "";
    const cleaned = keepQuery ? value : value.split("?")[0];
    return cleaned
      .replace(/@[^/?#]+/g, "")
      .replace(/([a-z0-9-]{20,})_(?:tn|thumb|thumbnail)\b/i, "$1")
      .replace(/([a-z0-9-]{20,})_wxh\b/i, "$1")
      .trim();
  }

  function shopeeImageUrlsFromToken(token) {
    const value = String(token || "").trim();
    if (!value) return [];
    if (/^https?:\/\//i.test(value)) return [normalizeShopeeMediaUrl(value)];
    if (!/[a-z0-9]/i.test(value)) return [];
    const id = value.replace(/[^a-z0-9_-]/gi, "");
    if (!id) return [];
    return [normalizeShopeeMediaUrl(`https://down-br.img.susercontent.com/file/${id}`)].filter(Boolean);
  }

  function collectNestedUrls(source, keyPattern, out = [], depth = 0) {
    if (!source || depth > 7) return out;
    if (typeof source === "string") {
      if (/^https?:\/\//i.test(source)) out.push(source);
      return out;
    }
    if (Array.isArray(source)) {
      source.forEach((entry) => collectNestedUrls(entry, keyPattern, out, depth + 1));
      return out;
    }
    if (typeof source === "object") {
      Object.entries(source).forEach(([key, value]) => {
        if (typeof value === "string" && keyPattern.test(String(key || "")) && /^https?:\/\//i.test(value)) {
          out.push(value);
        } else if (typeof value === "object") {
          collectNestedUrls(value, keyPattern, out, depth + 1);
        }
      });
    }
    return out;
  }

  function normalizePtMonthToken(value) {
    const token = String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z]/g, "");
    const map = {
      jan: 0, janeiro: 0,
      fev: 1, fevereiro: 1,
      mar: 2, marco: 2,
      abr: 3, abril: 3,
      mai: 4, maio: 4,
      jun: 5, junho: 5,
      jul: 6, julho: 6,
      ago: 7, agosto: 7,
      set: 8, setembro: 8,
      out: 9, outubro: 9,
      nov: 10, novembro: 10,
      dez: 11, dezembro: 11,
    };
    return Number.isInteger(map[token]) ? map[token] : null;
  }

  function businessDaysBetween(startDate, endDate) {
    if (!(startDate instanceof Date) || !(endDate instanceof Date)) return null;
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return null;
    if (endDate < startDate) return null;
    const cursor = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
    cursor.setDate(cursor.getDate() + 1);
    const end = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
    let days = 0;
    while (cursor <= end) {
      const dow = cursor.getDay();
      if (dow !== 0 && dow !== 6) days += 1;
      cursor.setDate(cursor.getDate() + 1);
    }
    return days;
  }

  function buildFutureDate(day, monthIndex, baseDate) {
    const base = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
    let year = base.getFullYear();
    let month = Number.isInteger(monthIndex) ? monthIndex : base.getMonth();
    let date = new Date(year, month, day);
    if (date < base) {
      if (Number.isInteger(monthIndex)) {
        year += 1;
        date = new Date(year, month, day);
      } else {
        month += 1;
        date = new Date(year, month, day);
      }
    }
    return date;
  }

  function parseShopeeDeliveryWindow(textValue) {
    const content = text(textValue || "");
    if (!/(chega|receba|recebe)/i.test(content)) return null;
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monthTokenPattern = "jan(?:eiro)?|fev(?:ereiro)?|mar(?:[çc]o)?|abr(?:il)?|mai(?:o)?|jun(?:ho)?|jul(?:ho)?|ago(?:sto)?|set(?:embro)?|out(?:ubro)?|nov(?:embro)?|dez(?:embro)?";
    const deliveryVerbPattern = "(?:chega|receba|recebe)";

    let fromDay = null;
    let toDay = null;
    let fromMonth = null;
    let toMonth = null;

    const betweenMonthSlash = content.match(new RegExp(`${deliveryVerbPattern}\\s+entre\\s+(\\d{1,2})\\s*\\/\\s*(${monthTokenPattern})\\s+e\\s+(\\d{1,2})\\s*\\/\\s*(${monthTokenPattern})`, "i"));
    if (betweenMonthSlash) {
      fromDay = Number(betweenMonthSlash[1] || 0);
      fromMonth = normalizePtMonthToken(betweenMonthSlash[2]);
      toDay = Number(betweenMonthSlash[3] || 0);
      toMonth = normalizePtMonthToken(betweenMonthSlash[4]);
    }
    if (fromDay == null || toDay == null) {
      const betweenMonth = content.match(new RegExp(`${deliveryVerbPattern}\\s+entre\\s+(\\d{1,2})\\s+(${monthTokenPattern})\\s+e\\s+(\\d{1,2})\\s+(${monthTokenPattern})`, "i"));
      if (betweenMonth) {
        fromDay = Number(betweenMonth[1] || 0);
        fromMonth = normalizePtMonthToken(betweenMonth[2]);
        toDay = Number(betweenMonth[3] || 0);
        toMonth = normalizePtMonthToken(betweenMonth[4]);
      }
    }
    if (fromDay == null || toDay == null) {
      const betweenSlash = content.match(new RegExp(`${deliveryVerbPattern}\\s+entre\\s+(\\d{1,2})\\s+e\\s+(\\d{1,2})\\s*\\/\\s*(${monthTokenPattern})`, "i"));
      if (betweenSlash) {
        fromDay = Number(betweenSlash[1] || 0);
        toDay = Number(betweenSlash[2] || 0);
        const month = normalizePtMonthToken(betweenSlash[3]);
        fromMonth = month;
        toMonth = month;
      }
    }
    if (fromDay == null || toDay == null) {
      const betweenSimple = content.match(new RegExp(`${deliveryVerbPattern}\\s+entre\\s+(\\d{1,2})\\s+e\\s+(\\d{1,2})`, "i"));
      if (betweenSimple) {
        fromDay = Number(betweenSimple[1] || 0);
        toDay = Number(betweenSimple[2] || 0);
      }
    }
    if (!Number.isFinite(fromDay) || !Number.isFinite(toDay) || fromDay <= 0 || toDay <= 0) return null;

    const startDate = buildFutureDate(fromDay, fromMonth, startOfToday);
    let endDate = buildFutureDate(toDay, toMonth != null ? toMonth : fromMonth, startOfToday);
    if (endDate < startDate) {
      endDate = new Date(endDate.getFullYear() + 1, endDate.getMonth(), endDate.getDate());
    }
    const msPerDay = 86400000;
    const corridos = Math.max(1, Math.ceil((startDate.getTime() - startOfToday.getTime()) / msPerDay));
    const uteis = businessDaysBetween(startOfToday, endDate);
    return {
      startDateIso: startDate.toISOString(),
      endDateIso: endDate.toISOString(),
      corridos,
      uteis,
      label: `${startDate.toLocaleDateString("pt-BR")} - ${endDate.toLocaleDateString("pt-BR")}`,
    };
  }

  function extractShopeeFinalFreightValue(shippingSection, regularPrice) {
    const candidateSelectors = [
      ".BWGW5I .LUAQqJ > div:last-child",
      ".BWGW5I .LUAQqJ div:last-child",
      ".BWGW5I [class*='LUAQqJ'] > div:last-child",
      ".BWGW5I [class*='LUAQqJ'] div:last-child",
      ".BWGW5I .LUAQqJ",
    ];
    for (const selector of candidateSelectors) {
      const value = parseMoney(firstText([selector], shippingSection || document));
      if (Number.isFinite(value) && value > 0) return value;
    }
    const freightGroups = Array.from((shippingSection || document).querySelectorAll(".LUAQqJ, [class*='LUAQqJ']"));
    for (const group of freightGroups) {
      const values = extractAllMoney(group.textContent || "")
        .filter((value) => value > 0 && (!regularPrice || value <= regularPrice));
      if (!values.length) continue;
      return values[values.length - 1];
    }
    const values = extractAllMoney(shippingSection?.textContent || "")
      .filter((value) => value > 0 && (!regularPrice || value <= regularPrice));
    if (!values.length) return null;
    return values[values.length - 1];
  }

  function collectShopeeReviewVideoUrls() {
    const section = Array.from(document.querySelectorAll("section, div")).find((node) => {
      const heading = text(node.querySelector("h2,h3")?.textContent || "");
      return /avalia[cç][aã]o|reviews?/i.test(heading);
    });
    const root = section || document;
    const urls = new Set();
    const push = (value) => {
      const normalized = normalizeShopeeMediaUrl(value, true);
      if (!normalized || !/^https?:\/\//i.test(normalized)) return;
      if (!/mp4|m3u8|video/i.test(normalized)) return;
      urls.add(normalized);
    };
    root.querySelectorAll("video, video source, a[href]").forEach((node) => {
      push(node.currentSrc || node.src || node.getAttribute("src") || node.getAttribute("href") || "");
    });
    const rawMatches = String(root.innerHTML || "").match(/https?:\/\/[^"'\\s>]+(?:mp4|m3u8)[^"'\\s<]*/gi) || [];
    rawMatches.forEach(push);
    return Array.from(urls).slice(0, 20);
  }

  function findShopeeYouMayAlsoLikeSection() {
    const candidates = Array.from(document.querySelectorAll("section, div"));
    for (const node of candidates) {
      const heading = text(node.querySelector("h2,h3,h4")?.textContent || "");
      if (!/voc[eê]\s+tamb[eé]m\s+pode\s+gostar/i.test(heading)) continue;
      if (node.querySelectorAll("a[href]").length < 3) continue;
      return node;
    }
    return null;
  }

  function extractShopeeYouMayAlsoLikeItems(limit = 80) {
    const section = findShopeeYouMayAlsoLikeSection();
    if (!section) return [];
    const rows = [];
    const seen = new Set();
    const anchors = Array.from(section.querySelectorAll("a[href]"));
    anchors.forEach((anchor) => {
      const href = anchor.href || anchor.getAttribute("href") || "";
      if (!href || seen.has(href)) return;
      const card = anchor.closest("li, section, div, article") || anchor;
      const title = text(
        firstText(
          ["[data-sqe='name']", "[title]", "img[alt]", "h3", "h2", "span", "p"],
          card,
        ),
      );
      const price = parseMoney(firstText(["[class*='price']", ".IZPeQz", ".AcmPRb", "span", "div"], card));
      if (!title || !Number.isFinite(price)) return;
      rows.push({ title, price, url: href });
      seen.add(href);
    });
    return rows.slice(0, limit);
  }

  function collectShopeeMediaAssets(item = {}) {
    const galleryImageSet = new Set();
    const primaryImageSet = new Set();
    const imageSet = new Set();
    const videoSet = new Set();
    const clipSet = new Set();
    const previewSet = new Set();

    const addPrimaryImage = (value) => {
      shopeeImageUrlsFromToken(value).forEach((url) => primaryImageSet.add(url));
    };
    const addGalleryImage = (value) => {
      shopeeImageUrlsFromToken(value).forEach((url) => galleryImageSet.add(url));
    };
    const addImage = (value) => {
      shopeeImageUrlsFromToken(value).forEach((url) => imageSet.add(url));
    };
    const addVideo = (value, isClip = false) => {
      const normalized = normalizeShopeeMediaUrl(value, true);
      if (!normalized || !/^https?:\/\//i.test(normalized)) return;
      videoSet.add(normalized);
      if (isClip) clipSet.add(normalized);
    };
    const addPreview = (value) => {
      const normalized = normalizeShopeeMediaUrl(value);
      if (!normalized) return;
      previewSet.add(normalized);
    };

    const gallerySources = [
      ...(Array.isArray(item.images) ? item.images : []),
      ...(Array.isArray(item.image_list) ? item.image_list : []),
      ...(Array.isArray(item.long_images) ? item.long_images : []),
    ];
    gallerySources.forEach(addGalleryImage);
    const imageSources = [
      ...gallerySources,
      item.image,
      item.cover,
      item.thumb_image,
    ];
    imageSources.forEach((entry) => {
      addPrimaryImage(entry);
      addImage(entry);
    });

    if (Array.isArray(item.models)) {
      item.models.forEach((model) => {
        [
          model?.image,
          model?.extinfo?.tier_index?.[0]?.image,
          model?.extinfo?.image,
          model?.image_id,
        ].forEach(addImage);
      });
    }

    const videoGroups = [
      ...(Array.isArray(item.video_info_list) ? item.video_info_list : []),
      ...(Array.isArray(item.shopee_video_info_list) ? item.shopee_video_info_list : []),
      ...(Array.isArray(item.video_list) ? item.video_list : []),
      ...(Array.isArray(item.videos) ? item.videos : []),
    ];
    if (item.video_info && typeof item.video_info === "object") videoGroups.push(item.video_info);
    if (item.preview_info && typeof item.preview_info === "object") videoGroups.push(item.preview_info);

    videoGroups.forEach((entry) => {
      if (!entry || typeof entry !== "object") return;
      addVideo(entry.video_url || entry.play_url || entry.url || entry.mp4 || "", true);
      addPreview(entry.thumbnail || entry.thumb_url || entry.thumb || entry.preview || entry.cover || "");
      const nestedVideos = collectNestedUrls(entry, /video|play|mp4|m3u8/i, []);
      nestedVideos.forEach((url) => addVideo(url, true));
      const nestedThumbs = collectNestedUrls(entry, /thumb|thumbnail|cover|preview/i, []);
      nestedThumbs.forEach(addPreview);
    });

    Array.from(document.querySelectorAll("img"))
      .map((img) => img.currentSrc || img.src || img.getAttribute("data-src") || "")
      .filter((src) => /susercontent\.com|shopee/i.test(src))
      .slice(0, 80)
      .forEach(addImage);

    Array.from(document.querySelectorAll("video, video source"))
      .map((node) => node.currentSrc || node.src || node.getAttribute("src") || "")
      .filter(Boolean)
      .forEach((src) => addVideo(src, true));

    return {
      galleryImageUrls: Array.from(galleryImageSet).slice(0, 80),
      primaryImageUrls: Array.from(primaryImageSet).slice(0, 80),
      imageUrls: Array.from(imageSet).slice(0, 120),
      videoUrls: Array.from(videoSet).slice(0, 12),
      clipUrls: Array.from(clipSet).slice(0, 12),
      previewUrls: Array.from(previewSet).slice(0, 30),
    };
  }

  function extractShopeeProductSignals() {
    const ids = extractShopeeIdsFromUrl(location.href);
    const item = readShopeeItemFromInitialData() || {};
    const attributes = collectShopeeAttributes();
    const bodyText = text(document.body?.textContent || "");

    const soldFromText = parseCountValue((bodyText.match(/([0-9]+(?:[.,][0-9]+)?(?:\s*mil)?)\s+vendid[oa]s?/i) || [])[1] || "");
    const soldFromPayload = parseCountValue(item.historical_sold || item.sold || null);
    const sold = soldFromPayload != null ? soldFromPayload : soldFromText;

    const reviewCountFromPayload = Number(item?.item_rating?.total_rating_count || item?.cmt_count || 0);
    const reviewCountFromText = parseCountValue((bodyText.match(/([0-9]+(?:[.,][0-9]+)?(?:\s*mil)?)\s+avalia[cç][aã]o/i) || [])[1] || "");
    const reviewsCount = Number.isFinite(reviewCountFromPayload) && reviewCountFromPayload > 0
      ? reviewCountFromPayload
      : reviewCountFromText;

    const ratingPayload = Number(item?.item_rating?.rating_star || 0);
    const ratingText = Number(String((bodyText.match(/([0-5](?:[.,][0-9])?)\s*(?:de\s*5)?\s+avalia[cç][aã]o/i) || [])[1] || "").replace(",", "."));
    const rating = Number.isFinite(ratingPayload) && ratingPayload > 0
      ? ratingPayload
      : Number.isFinite(ratingText) && ratingText > 0 ? ratingText : null;

    const stockFromModels = (Array.isArray(item.models) ? item.models : []).reduce((sum, model) => {
      const current = Number(model?.stock || 0);
      return sum + (Number.isFinite(current) && current > 0 ? current : 0);
    }, 0);
    const stockFromText = parseCountValue((bodyText.match(/([0-9]+)\s*pe[çc]as dispon[ií]veis/i) || [])[1] || "");
    const stock = stockFromModels > 0 ? stockFromModels : stockFromText;

    const categoryPath = Array.isArray(item.categories)
      ? item.categories
          .map((entry) => text(entry?.display_name || entry?.name || ""))
          .filter(Boolean)
          .join(" > ")
      : "";

    const couponPercents = Array.from(new Set(Array.from(bodyText.matchAll(/([0-9]+(?:[.,][0-9]+)?)%\s*off/gi))
      .map((match) => Number(String(match[1] || "").replace(",", ".")))
      .filter((value) => Number.isFinite(value) && value > 0))).slice(0, 6);

    const installmentMatch = bodyText.match(/(\d{1,2})x\s*R\$\s*([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2})/i);
    const installment = installmentMatch
      ? {
          count: Number(installmentMatch[1] || 0),
          value: Number(String(installmentMatch[2] || "").replace(/\./g, "").replace(",", ".")),
        }
      : null;

    const pixPriceFromDom = parseMoney(firstText([".jRlVo0 .IZPeQz", ".IZPeQz.B67UQ0", ".IZPeQz"], document));
    const regularPriceFromDom = parseMoney(firstText([".AMabbr"], document));
    const pixMatch = bodyText.match(/R\$\s*([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2})\s*no pix/i);
    const pixPriceFromText = pixMatch ? Number(String(pixMatch[1] || "").replace(/\./g, "").replace(",", ".")) : null;
    const pixPrice = Number.isFinite(Number(pixPriceFromDom))
      ? Number(pixPriceFromDom)
      : pixPriceFromText;
    const allPrices = extractAllMoney(bodyText);
    const visibleMinPrice = allPrices.length ? Math.min(...allPrices) : null;
    const visibleMaxPrice = allPrices.length ? Math.max(...allPrices) : null;
    const regularPrice = Number.isFinite(Number(regularPriceFromDom))
      ? Number(regularPriceFromDom)
      : visibleMaxPrice && pixPrice && visibleMaxPrice > pixPrice ? visibleMaxPrice : null;

    const shippingSection = document.querySelector(".uVwYBh")
      || document.querySelector("section.uVwYBh")
      || Array.from(document.querySelectorAll("section")).find((node) => {
      const heading = text(node.querySelector("h2")?.textContent || "");
      const content = text(node.textContent || "");
      return (/^frete$/i.test(heading) || /frete\s*:/i.test(content)) && /R\$\s*[0-9]/i.test(content);
    }) || Array.from(document.querySelectorAll("section, div"))
      .find((node) => {
        const content = text(node.textContent || "");
        return /frete/i.test(content) && /R\$\s*[0-9]/i.test(content);
      });
    const shippingFinal = extractShopeeFinalFreightValue(shippingSection, regularPrice);
    const deliveryWindow = parseShopeeDeliveryWindow(shippingSection?.textContent || "");
    const shippingMin = shippingFinal;
    const shippingMax = shippingFinal;

    const saleBasePrice = regularPrice || pixPrice || visibleMinPrice || null;
    const estimatedFees = computeShopeeEstimatedFees(saleBasePrice);
    const subsidies = computeShopeeSubsidyBenefits({
      salePrice: saleBasePrice,
      regularPrice,
      pixPrice,
      shippingMin,
    });
    const media = collectShopeeMediaAssets(item);
    const reviewVideoUrls = collectShopeeReviewVideoUrls();
    const clipCount = Array.isArray(media?.clipUrls) ? media.clipUrls.length : 0;
    const reviewVideoCount = reviewVideoUrls.length;
    const createdAtTs = Number(item?.ctime || item?.create_time || item?.created_at || 0);
    const createdAtIso = epochToIso(createdAtTs);
    const descriptionSection = Array.from(document.querySelectorAll("section")).find((node) => {
      const heading = text(node.querySelector("h2")?.textContent || "");
      return /descri[cç][aã]o do produto/i.test(heading);
    });
    const descriptionTextFromDom = descriptionSection
      ? text((descriptionSection.querySelector(".e8lZp3")?.textContent || descriptionSection.textContent || "").replace(/descri[cç][aã]o do produto/i, ""))
      : "";
    const descriptionText = descriptionTextFromDom || text(item?.description || item?.item_desc || "");
    const hasBrandInAttributes = attributes.some((row) => /marca/i.test(text(row?.label)) && text(row?.value));
    const filledAttributesExcludingBrand = attributes.filter((row) => {
      const label = text(row?.label);
      const value = text(row?.value);
      if (!value) return false;
      if (/^n\/?a$/i.test(value) || /^nao informado$/i.test(value)) return false;
      return !/marca/i.test(label);
    });

    return {
      itemId: String(item.item_id || item.itemid || ids.itemId || ""),
      shopId: String(item.shop_id || item.shopid || ids.shopId || ""),
      stock,
      sold,
      rating,
      reviewsCount,
      likedCount: parseCountValue(item.liked_count || null),
      shopLocation: text(item.shop_location || ""),
      estimatedDays: Number(item.estimated_days || 0) || null,
      brand: text(item.brand || ""),
      catId: String(item.cat_id || ""),
      createdAtTs: Number.isFinite(createdAtTs) && createdAtTs > 0 ? createdAtTs : null,
      createdAtIso,
      categoryPath,
      modelCount: Array.isArray(item.models) ? item.models.length : 0,
      variationCount: Array.isArray(item.tier_variations) ? item.tier_variations.length : 0,
      couponPercents,
      installment,
      pixPrice,
      regularPrice,
      saleBasePrice,
      shippingMin,
      shippingMax,
      shippingFinal,
      deliveryWindow,
      subsidies,
      attributes,
      hasBrandInAttributes,
      filledAttributesExcludingBrandCount: filledAttributesExcludingBrand.length,
      descriptionLength: descriptionText.length,
      galleryImagesCount: Array.isArray(media?.galleryImageUrls) ? media.galleryImageUrls.length : 0,
      estimatedFees,
      media,
      reviewVideoUrls,
      hasVideo: clipCount > 0 || reviewVideoCount > 0,
      clipCount,
      reviewVideoCount,
      videoCount: reviewVideoCount,
    };
  }

  function readJsonLd() {
    const items = [];
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(script.textContent || "null");
        if (Array.isArray(parsed)) items.push(...parsed);
        else if (parsed) items.push(parsed);
      } catch (_) {}
    }
    const flat = [];
    const visit = (item) => {
      if (!item || typeof item !== "object") return;
      flat.push(item);
      if (Array.isArray(item["@graph"])) item["@graph"].forEach(visit);
    };
    items.forEach(visit);
    return flat;
  }

  function rememberNetworkEntries(entries) {
    const rows = Array.isArray(entries) ? entries : [entries].filter(Boolean);
    let added = false;
    rows.forEach((entry) => {
      if (!entry?.url) return;
      const compact = {
        url: String(entry.url || ""),
        method: String(entry.method || "GET").toUpperCase(),
        status: Number(entry.status || 0),
        body: String(entry.body || "").slice(0, 250000),
        captured_at: Number(entry.captured_at || Date.now()),
      };
      const exists = state.networkEntries.some(
        (item) => item.url === compact.url && item.status === compact.status && item.body.slice(0, 90) === compact.body.slice(0, 90),
      );
      if (!exists) {
        state.networkEntries.push(compact);
        added = true;
      }
    });
    state.networkEntries = state.networkEntries.slice(-80);
    if (added) state.networkVersion += 1;
    return added;
  }

  function requestNetworkCache() {
    window.postMessage({ source: "davantti-content", type: NETWORK_EVENT_CACHE_REQUEST }, "*");
  }

  function decodeLoose(value) {
    let current = String(value || "");
    for (let i = 0; i < 3; i += 1) {
      try {
        const decoded = decodeURIComponent(current);
        if (decoded === current) break;
        current = decoded;
      } catch {
        break;
      }
    }
    return current;
  }

  function normalizeMlItemId(value) {
    const match = String(value || "").toUpperCase().match(/\b(MLB)-?(\d{6,})\b/);
    return match ? `${match[1]}${match[2]}` : "";
  }

  function mlIdMatches(value) {
    return Array.from(String(value || "").toUpperCase().matchAll(/\b(MLB)-?(\d{6,})\b/g)).map((match) => `${match[1]}${match[2]}`);
  }

  function extractMlItemIdFromText(value) {
    const raw = decodeLoose(value);
    const priorityPatterns = [
      /(?:item_id|itemId)["'=:\s%]+["']?(MLB-?\d{6,})/i,
      /["'](?:item_id|itemId|itemIdRaw|item_id_raw)["']\s*:\s*["'](MLB-?\d{6,})["']/i,
      /item_id:?(MLB-?\d{6,})/i,
      /\/items\/(MLB-?\d{6,})/i,
      /\/reviews\/(MLB-?\d{6,})/i,
      /\/visits\/items\?ids=(MLB-?\d{6,})/i,
      /\/(MLB-\d{6,})[-_/]/i,
      /"item_info"\s*:\s*\{[^}]*"id"\s*:\s*"(MLB-?\d{6,})"/i,
      /"item"\s*:\s*\{[^}]*"id"\s*:\s*"(MLB-?\d{6,})"/i,
      /"itemId"\s*:\s*"(MLB-?\d{6,})"/i,
    ];
    for (const pattern of priorityPatterns) {
      const match = raw.match(pattern);
      if (match?.[1]) return normalizeMlItemId(match[1]);
    }
    return "";
  }

  function mlProductIdFromUrl(url = location.href) {
    try {
      const parsed = new URL(String(url || ""));
      const match = parsed.pathname.toUpperCase().match(/\/P\/(MLB-?\d{6,})/);
      return match?.[1] ? normalizeMlItemId(match[1]) : "";
    } catch {
      return "";
    }
  }

  function resolveMlItemId(data = null) {
    const direct = data?.item_id || data?.itemId || "";
    const normalizedDirect = normalizeMlItemId(direct);
    if (normalizedDirect) return normalizedDirect;

    const productId = mlProductIdFromUrl(location.href);
    const fromUrl = extractMlItemIdFromText(location.href);
    if (fromUrl && fromUrl !== productId) return fromUrl;

    const networkText = state.networkEntries
      .slice()
      .reverse()
      .map((entry) => `${entry.url}\n${entry.body}`)
      .join("\n");
    const fromNetwork = extractMlItemIdFromText(networkText);
    if (fromNetwork && fromNetwork !== productId) return fromNetwork;

    const htmlCandidates = [
      document.documentElement?.innerHTML || "",
      ...Array.from(document.querySelectorAll("a[href*='MLB']")).slice(0, 60).map((node) => node.href || node.getAttribute("href") || ""),
    ].join("\n");
    const fromHtml = extractMlItemIdFromText(htmlCandidates);
    if (fromHtml && fromHtml !== productId) return fromHtml;

    const matches = mlIdMatches(location.href);
    return matches.find((id) => id !== productId) || (!productId ? matches[0] || "" : "");
  }

  function extractMlPageSignals(data = null) {
    if (detectMarketplace() !== "ml") return {};
    const itemId = resolveMlItemId(data);
    const html = String(document.documentElement?.innerHTML || "")
      .replace(/&quot;/g, '"')
      .replace(/\\"/g, '"')
      .replace(/\\u002F/gi, "/");
    if (!html) return itemId ? { item_id: itemId } : {};

    const pickDateNearItemState = (key) => {
      const pattern = new RegExp(`"${key}"\\s*:\\s*"(\\d{4}-\\d{2}-\\d{2}T[^"]+)"`, "gi");
      const matches = Array.from(html.matchAll(pattern));
      for (const match of matches) {
        const index = match.index || 0;
        const context = html.slice(Math.max(0, index - 900), Math.min(html.length, index + 900));
        if (
          (itemId && context.includes(itemId)) ||
          /"listingType"\s*:|"listing_type_id"\s*:|"condition"\s*:|"status"\s*:\s*"active"|"siteId"\s*:\s*"MLB"/i.test(context)
        ) {
          return text(match[1]);
        }
      }
      return "";
    };

    const contexts = [];
    if (itemId) {
      let index = -1;
      while ((index = html.indexOf(itemId, index + 1)) !== -1 && contexts.length < 18) {
        contexts.push(html.slice(Math.max(0, index - 1800), Math.min(html.length, index + 1800)));
      }
    }
    ["startTime", "localItemPrice", "listingType", "original_price"].forEach((term) => {
      let index = -1;
      let count = 0;
      while ((index = html.indexOf(term, index + 1)) !== -1 && count < 4) {
        contexts.push(html.slice(Math.max(0, index - 1800), Math.min(html.length, index + 1800)));
        count += 1;
      }
    });
    contexts.push(html.slice(0, Math.min(html.length, 9000)));
    const scopedHtml = contexts.join("\n");
    const pickString = (patterns) => {
      for (const pattern of patterns) {
        const match = scopedHtml.match(pattern);
        if (match?.[1]) return text(match[1]);
      }
      return "";
    };
    const pickNumber = (patterns) => {
      for (const pattern of patterns) {
        const match = scopedHtml.match(pattern);
        const parsed = match?.[1] ? Number(String(match[1]).replace(",", ".")) : NaN;
        if (Number.isFinite(parsed)) return parsed;
      }
      return null;
    };

    const startTime = pickDateNearItemState("startTime")
      || pickDateNearItemState("start_time")
      || pickString([/"startTime"\s*:\s*"(\d{4}-\d{2}-\d{2}T[^"]+)"/i, /"start_time"\s*:\s*"(\d{4}-\d{2}-\d{2}T[^"]+)"/i, /"dateCreated"\s*:\s*"(\d{4}-\d{2}-\d{2}T[^"]+)"/i, /"date_created"\s*:\s*"(\d{4}-\d{2}-\d{2}T[^"]+)"/i]);
    const stopTime = pickDateNearItemState("stopTime")
      || pickDateNearItemState("stop_time")
      || pickString([/"stopTime"\s*:\s*"(\d{4}-\d{2}-\d{2}T[^"]+)"/i, /"stop_time"\s*:\s*"(\d{4}-\d{2}-\d{2}T[^"]+)"/i, /"lastUpdated"\s*:\s*"(\d{4}-\d{2}-\d{2}T[^"]+)"/i, /"last_updated"\s*:\s*"(\d{4}-\d{2}-\d{2}T[^"]+)"/i]);
    const signals = {};
    if (itemId) signals.item_id = itemId;
    if (startTime) signals.start_time = startTime;
    if (stopTime) signals.stop_time = stopTime;
    const price = pickNumber([/"localItemPrice"\s*:\s*([0-9.]+)/i, /"price"\s*:\s*([0-9.]+)/i]);
    const originalPrice = pickNumber([/"original_price"\s*:\s*([0-9.]+)/i, /"originalPrice"\s*:\s*([0-9.]+)/i]);
    const sellerId = pickNumber([/"seller_id"\s*:\s*([0-9]+)/i, /"sellerId"\s*:\s*([0-9]+)/i]);
    const picturesCount = pickNumber([/"pictures_quantity"\s*:\s*([0-9]+)/i]);
    const reviewsCount = pickNumber([/"reviews"\s*:\s*\{[^}]*"count"\s*:\s*([0-9]+)/i, /"rating_average_formatted"[^}]*"count"\s*:\s*([0-9]+)/i]);
    const reviewsRate = pickNumber([/"review_rate"\s*:\s*([0-9.]+)/i, /"rate"\s*:\s*([0-9.]+)[^}]*"count"\s*:/i]);
    const categoryId = pickString([/"categoryId"\s*:\s*"(MLB\d+)"/i, /"category_id"\s*:\s*"(MLB\d+)"/i]);
    const domainId = pickString([/"domain_id"\s*:\s*"(MLB-[^"]+)"/i, /"domainId"\s*:\s*"(MLB-[^"]+)"/i]);
    const listingTypeId = pickString([/"listingType"\s*:\s*"([^"]+)"/i, /"listing_type_id"\s*:\s*"([^"]+)"/i]);
    const condition = pickString([/"condition"\s*:\s*"([^"]+)"/i, /"item_condition"\s*:\s*"([^"]+)"/i]);
    const siteId = pickString([/"siteId"\s*:\s*"([^"]+)"/i, /"site_id"\s*:\s*"([^"]+)"/i]);
    if (price != null) signals.price = price;
    if (originalPrice != null) signals.original_price = originalPrice;
    if (sellerId != null) signals.seller_id = String(Math.trunc(sellerId));
    if (picturesCount != null) signals.pictures_count = picturesCount;
    if (reviewsCount != null || reviewsRate != null) {
      signals.reviews = {};
      if (reviewsCount != null) signals.reviews.count = reviewsCount;
      if (reviewsRate != null) signals.reviews.rate = reviewsRate;
    }
    if (categoryId) signals.category_id = categoryId;
    if (domainId) signals.domain_id = domainId;
    if (listingTypeId) signals.listing_type_id = listingTypeId;
    if (condition) signals.condition = condition;
    if (siteId) signals.site_id = siteId;
    return signals;
  }

  function detectMarketplace() {
    const host = location.hostname.toLowerCase();
    if (host.includes("mercadolivre") || host.includes("mercadolibre")) return "ml";
    if (host.includes("shopee")) return "shopee";
    return "unknown";
  }

  function marketplaceNameByKey(key) {
    if (key === "ml") return "Mercado Livre";
    if (key === "shopee") return "Shopee";
    return "Marketplace";
  }

  function defaultRealtimeLoadingText(marketplaceKey) {
    return marketplaceKey === "shopee"
      ? "Coletando dados completos da Shopee..."
      : "Coletando dados completos do Mercado Livre...";
  }

  function detectPageType(marketplace) {
    const path = location.pathname.toLowerCase();
    const href = location.href.toLowerCase();
    if (marketplace === "ml") {
      if (/(\/publicar\/|\/anuncios\/|\/modificar\/|\/catalogo\/|\/publisher\/|\/sell\/)/i.test(path)) return "unknown";
      if (/\/mlb-?\d+|\/p\/mlb|mlb\d{6,}/i.test(href)) return "product";
      if (path.includes("/lista") || path.includes("/search") || location.search.includes("as_word")) return "search";
    }
    if (marketplace === "shopee") {
      if (/-i\.\d+\.\d+/.test(path) || path.includes("/product/")) return "product";
      if (path.includes("/search") || location.search.includes("keyword=")) return "search";
    }
    return "unknown";
  }

  function extractMetaProduct() {
    const json = readJsonLd().find((item) => {
      const type = item["@type"];
      return type === "Product" || (Array.isArray(type) && type.includes("Product"));
    }) || {};
    const offers = Array.isArray(json.offers) ? json.offers[0] : (json.offers || {});
    return {
      title: text(json.name || attr(['meta[property="og:title"]', 'meta[name="twitter:title"]'], "content")),
      price: Number(offers.price || attr(['meta[itemprop="price"]', 'meta[property="product:price:amount"]'], "content")) || null,
      image: Array.isArray(json.image) ? json.image[0] : text(json.image || attr(['meta[property="og:image"]'], "content")),
      brand: text(json.brand?.name || json.brand || ""),
      availability: text(offers.availability || ""),
    };
  }

  function extractMlProduct() {
    const meta = extractMetaProduct();
    const title = meta.title || firstText(["h1.ui-pdp-title", "h1"]);
    const seller = firstText([
      ".ui-pdp-seller__header__title",
      ".ui-pdp-seller__link-trigger",
      ".ui-pdp-color--BLUE",
    ]);
    const priceText = firstText([
      ".ui-pdp-price .andes-money-amount__fraction",
      ".andes-money-amount__fraction",
      '[itemprop="price"]',
    ]);
    const pictures = new Set([
      ...Array.from(document.querySelectorAll(".ui-pdp-gallery img, .ui-pdp-image, img.ui-pdp-image"))
        .map((img) => img.currentSrc || img.src)
        .filter(Boolean),
    ]);
    const shippingText = firstText([
      ".ui-pdp-media__title",
      ".ui-pdp-shipping-summary__text",
      ".ui-pdp-color--GREEN",
    ]);
    const soldText = firstText([".ui-pdp-subtitle", ".ui-pdp-header__subtitle"]);
    const attributes = Array.from(document.querySelectorAll(".ui-pdp-specs__table tr, .andes-table__row"))
      .map((row) => text(row.textContent))
      .filter(Boolean)
      .slice(0, 8);

    return {
      marketplace: "Mercado Livre",
      type: "product",
      item_id: resolveMlItemId(),
      title,
      price: meta.price || parseMoney(priceText),
      seller,
      brand: meta.brand,
      pictures: pictures.size,
      shipping: shippingText,
      sold: soldText,
      attributes,
      url: location.href,
    };
  }

  function extractShopeeProduct() {
    const meta = extractMetaProduct();
    const shopee = extractShopeeProductSignals();
    const title = meta.title || firstText(['meta[property="og:title"]', "h1", "main h1"], document);
    const priceText = firstText([
      ".jRlVo0 .IZPeQz",
      ".IZPeQz.B67UQ0",
      ".IZPeQz",
      ".AMabbr",
      ".YRa9CH",
      ".AcmPRb",
      '[data-testid*="price"]',
      '[class*="price"]',
    ]);
    const seller = firstText([
      ".fV3TIn",
      '[class*="shop-name"]',
      '[class*="ShopName"]',
      'a[href*="/shop/"]',
      ".navbar__username",
    ]);
    const pictures = new Set(Array.from(document.querySelectorAll("img"))
      .map((img) => img.currentSrc || img.src)
      .filter((src) => /shopee|cf\.shopee/i.test(src))
      .slice(0, 30));
    const shippingText = firstText([
      ".uVwYBh .YRa9CH",
      ".uVwYBh .LUAQqJ",
      ".uVwYBh .BWGW5I",
      '[class*="shipping"]',
      '[class*="Shipping"]',
    ]);
    const visiblePrice = meta.price || parseMoney(priceText);
    const finalPrice = Number.isFinite(visiblePrice)
      ? visiblePrice
      : Number.isFinite(shopee.pixPrice) ? shopee.pixPrice
        : Number.isFinite(shopee.regularPrice) ? shopee.regularPrice
          : null;
    const saleBasePrice = Number.isFinite(Number(shopee.saleBasePrice))
      ? Number(shopee.saleBasePrice)
      : Number.isFinite(Number(shopee.regularPrice))
        ? Number(shopee.regularPrice)
        : finalPrice;
    const shopeeWithFees = {
      ...shopee,
      saleBasePrice,
      estimatedFees: computeShopeeEstimatedFees(saleBasePrice) || shopee.estimatedFees || null,
      subsidies: computeShopeeSubsidyBenefits({
        salePrice: saleBasePrice,
        regularPrice: shopee.regularPrice,
        pixPrice: shopee.pixPrice,
        shippingMin: shopee.shippingMin,
      }),
    };

    return {
      marketplace: "Shopee",
      type: "product",
      item_id: shopeeWithFees.itemId,
      shop_id: shopeeWithFees.shopId,
      title,
      price: finalPrice,
      seller,
      brand: meta.brand || shopeeWithFees.brand,
      pictures: pictures.size,
      shipping: shippingText || (shopeeWithFees.shippingMin ? `${formatMoney(shopeeWithFees.shippingMin)}` : ""),
      sold: shopeeWithFees.sold != null ? String(shopeeWithFees.sold) : firstText(['[class*="sold"]', '[class*="Sold"]']),
      attributes: shopeeWithFees.attributes.map((row) => `${row.label}: ${row.value}`),
      stock: shopeeWithFees.stock,
      rating: shopeeWithFees.rating,
      reviews_count: shopeeWithFees.reviewsCount,
      liked_count: shopeeWithFees.likedCount,
      has_video: Boolean(shopeeWithFees.hasVideo),
      video_count: Number(shopeeWithFees.videoCount || 0),
      clip_count: Number(shopeeWithFees.clipCount || 0),
      review_video_count: Number(shopeeWithFees.reviewVideoCount || 0),
      created_at_iso: shopeeWithFees.createdAtIso || "",
      shipping_min: shopeeWithFees.shippingMin,
      shipping_max: shopeeWithFees.shippingMax,
      shop_location: shopeeWithFees.shopLocation,
      estimated_days: shopeeWithFees.estimatedDays,
      shopee: shopeeWithFees,
      url: location.href,
    };
  }

  function extractSearch(marketplace) {
    const isMl = marketplace === "ml";
    const cards = searchCardsFromDocument(document, marketplace);
    const items = extractSearchItemsFromCards(cards, marketplace);
    const prices = items.map((item) => item.price).filter(Number.isFinite);
    const avg = prices.length ? prices.reduce((sum, value) => sum + value, 0) / prices.length : null;
    const min = prices.length ? Math.min(...prices) : null;
    const max = prices.length ? Math.max(...prices) : null;
    const freeShippingCount = items.filter((item) => item.freeShipping).length;
    const sponsoredCount = items.filter((item) => item.sponsored).length;

    return {
      marketplace: isMl ? "Mercado Livre" : "Shopee",
      type: "search",
      title: document.title,
      count: items.length,
      avg,
      min,
      max,
      freeShippingCount,
      sponsoredCount,
      items,
      url: location.href,
    };
  }

  function searchCardsFromDocument(doc, marketplace) {
    const isMl = marketplace === "ml";
    return Array.from(
      doc.querySelectorAll(
        isMl
          ? ".ui-search-result, li.ui-search-layout__item, .poly-card, [class*='poly-card']"
          : "[data-sqe='item'], .shopee-search-item-result__item",
      ),
    );
  }

  function extractSearchItemsFromCards(cards, marketplace) {
    const isMl = marketplace === "ml";
    const items = cards
      .slice(0, isMl ? 60 : 24)
      .map((card) => {
        const link = card.querySelector("a[href*='MLB'], a[href*='/p/'], a[href]")?.href || "";
        const title = isMl
          ? firstText([".ui-search-item__title", ".poly-component__title", "[class*='poly-component__title']", "h2", "h3", "a"], card)
          : firstText(["[data-sqe='name']", "div", "a"], card);
        const price = parseMoney(firstText([".andes-money-amount__fraction", "[class*='price']"], card));
        const freeShipping = /frete gratis|frete gr\u00e1tis|free shipping/i.test(text(card.textContent));
        const sponsored = /patrocinado|ad|ads|sponsored/i.test(text(card.textContent));
        return { title, price, freeShipping, sponsored, url: link, item_id: isMl ? extractMlItemIdFromText(link) || mlIdMatches(link)[0] || "" : "" };
      })
      .filter((item) => item.title || item.price);
    return items;
  }

  function scoreProduct(data) {
    let score = 45;
    const warnings = [];
    const wins = [];
    const titleLength = text(data.title).length;
    const hasShopeeSignals = Boolean(data?.shopee);
    const clipCount = Number(data?.clip_count || data?.shopee?.clipCount || 0);
    const reviewVideoCount = Number(data?.review_video_count || data?.shopee?.reviewVideoCount || data?.video_count || data?.shopee?.videoCount || 0);
    const videoCount = clipCount + reviewVideoCount;
    const idealTitleMin = hasShopeeSignals ? 80 : 45;
    const idealTitleMax = hasShopeeSignals ? 100 : 90;

    if (titleLength >= idealTitleMin && titleLength <= idealTitleMax) {
      score += 14;
      wins.push(hasShopeeSignals ? "Titulo no intervalo ideal da Shopee (80-100)." : "Titulo em bom tamanho.");
    } else if (titleLength) {
      score += 5;
      warnings.push(hasShopeeSignals ? "Titulo fora do ideal da Shopee (80-100 caracteres)." : "Titulo pode ser melhorado em tamanho e clareza.");
    } else {
      warnings.push("Nao consegui ler o titulo do anuncio.");
    }

    if (Number.isFinite(data.price)) {
      score += 10;
      wins.push("Preco identificado.");
    } else {
      warnings.push("Preco nao identificado com seguranca.");
    }

    const minimumImages = hasShopeeSignals ? 3 : 5;
    if ((data.pictures || 0) >= minimumImages) {
      score += 12;
      wins.push(hasShopeeSignals ? "Galeria atende minimo de 3 imagens." : "Boa quantidade de imagens.");
    } else {
      warnings.push(hasShopeeSignals ? "Galeria com menos de 3 imagens." : "Poucas imagens detectadas. Avalie reforcar fotos.");
    }

    if (data.shipping) {
      score += 8;
      wins.push("Informacao de frete visivel.");
    } else {
      warnings.push("Frete nao identificado no primeiro carregamento.");
    }

    if (data.seller) score += 6;
    else warnings.push("Vendedor nao identificado no DOM atual.");

    if (!hasShopeeSignals) {
      if ((data.attributes || []).length >= 3) score += 5;
      else warnings.push("Poucos atributos tecnicos detectados.");
    }

    if (hasShopeeSignals) {
      if (data?.shopee?.hasBrandInAttributes) {
        score += 5;
        wins.push("Marca preenchida na ficha tecnica.");
      } else {
        warnings.push("Marca ausente na ficha tecnica.");
      }
      if (Number(data?.shopee?.filledAttributesExcludingBrandCount || 0) >= 3) {
        score += 5;
        wins.push("Ficha com 3+ atributos preenchidos (fora marca).");
      } else {
        warnings.push("Ficha com menos de 3 atributos preenchidos (fora marca).");
      }
      if (Number(data?.shopee?.descriptionLength || 0) > 100) {
        score += 5;
        wins.push("Descricao com mais de 100 caracteres.");
      } else {
        warnings.push("Descricao curta (menos de 100 caracteres).");
      }
      if (Number(data?.shopee?.galleryImagesCount || 0) >= 3) {
        score += 4;
      } else {
        warnings.push("Galeria principal com menos de 3 imagens.");
      }
      if (videoCount > 0) {
        score += 6;
        wins.push("Anuncio com midia em video detectada.");
      } else {
        warnings.push("Sem clip ou video de avaliacao detectado no anuncio.");
      }
    }

    return { score: Math.max(0, Math.min(100, score)), warnings: warnings.slice(0, 4), wins: wins.slice(0, 3) };
  }

  function scoreSearch(data) {
    const warnings = [];
    const wins = [];
    if (data.count >= 12) wins.push(`${data.count} anuncios lidos na pagina.`);
    else warnings.push("Poucos anuncios detectados. Role a pagina se necessario.");
    if (data.freeShippingCount) wins.push(`${data.freeShippingCount} anuncios com frete gratis/sinal equivalente.`);
    if (data.sponsoredCount) warnings.push(`${data.sponsoredCount} anuncios parecem patrocinados.`);
    if (Number.isFinite(data.avg)) wins.push(`Preco medio visivel: ${formatMoney(data.avg)}.`);
    return { score: Math.min(100, 50 + data.count * 2 + data.freeShippingCount), warnings, wins };
  }

  function analyzePage() {
    const marketplace = detectMarketplace();
    const pageType = detectPageType(marketplace);
    if (marketplace === "unknown" || pageType === "unknown") return null;
    const data = pageType === "search"
      ? extractSearch(marketplace)
      : marketplace === "ml" ? extractMlProduct() : extractShopeeProduct();
    const analysis = pageType === "search" ? scoreSearch(data) : scoreProduct(data);
    return { ...data, ...analysis, marketplaceKey: marketplace };
  }

  function extractRelatedTerms() {
    const selectors = [
      ".ui-search-related-searches a",
      ".andes-tag__label",
      ".ui-pdp-seller__header__title + div a",
      ".ui-pdp-other-sellers__item-title",
      ".search-related-queries a",
    ];
    const terms = new Set();
    selectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => {
        const value = text(node.textContent);
        if (value && value.length > 2 && value.length < 52) terms.add(value);
      });
    });
    return Array.from(terms).slice(0, 24);
  }

  function tokenizeKeywords(source) {
    const stopwords = new Set([
      "de", "da", "do", "dos", "das", "e", "em", "com", "para", "por",
      "um", "uma", "ao", "aos", "as", "os", "no", "na", "nos", "nas",
    ]);
    const bag = new Map();
    String(source || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !stopwords.has(token))
      .forEach((token) => bag.set(token, (bag.get(token) || 0) + 1));
    return Array.from(bag.entries())
      .sort((a, b) => b[1] - a[1])
      .map((entry) => entry[0]);
  }

  function classifyCompetition(term, data) {
    const size = term.length;
    const base = data?.count || 0;
    if (size >= 12 || /\d/.test(term) || base < 10) return { level: "low", label: "Concorrencia baixa" };
    if (size >= 8 || base < 22) return { level: "medium", label: "Concorrencia media" };
    return { level: "high", label: "Concorrencia alta" };
  }

  function buildKeywordInsights(data) {
    if (data?.marketplaceKey === "shopee" && data?.type === "product") {
      const competitorItems = extractShopeeYouMayAlsoLikeItems(80);
      const counts = keywordCountsFromTitles(competitorItems);
      const ranked = counts.slice(0, 12).map((row) => ({
        term: row.term,
        total: row.count,
        ...classifyCompetition(row.term, { count: competitorItems.length || row.count }),
      }));
      const baseTerms = ranked.map((row) => row.term);
      const longTail = baseTerms.slice(0, 6).map((term, idx) => {
        const next = baseTerms[(idx + 1) % baseTerms.length] || "";
        return `${term} ${next}`.trim();
      }).filter(Boolean);
      return { ranked, longTail };
    }

    const core = [
      ...tokenizeKeywords(data?.title || ""),
      ...extractRelatedTerms().flatMap((term) => tokenizeKeywords(term)),
    ];
    const unique = [];
    const seen = new Set();
    core.forEach((token) => {
      if (seen.has(token)) return;
      seen.add(token);
      unique.push(token);
    });
    const top = unique.slice(0, 12);
    const longTail = top.slice(0, 6).map((term, idx) => {
      const pairs = top[(idx + 1) % top.length];
      return `${term} ${pairs}`.trim();
    });
    const ranked = top.map((term) => ({
      term,
      ...classifyCompetition(term, data),
    }));
    return { ranked, longTail };
  }

  function keywordCountsFromTitles(items) {
    const stopwords = new Set([
      "de", "da", "do", "dos", "das", "e", "em", "com", "para", "por",
      "um", "uma", "ao", "aos", "as", "os", "no", "na", "nos", "nas",
    ]);
    const bag = new Map();
    items.forEach((item) => {
      String(item.title || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3 && !stopwords.has(token))
        .forEach((token) => bag.set(token, (bag.get(token) || 0) + 1));
    });
    return Array.from(bag.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([term, count]) => ({ term, count }));
  }

  function keywordRowsFromSearchTitles(items) {
    const stopwords = new Set([
      "de", "da", "do", "dos", "das", "e", "em", "com", "para", "por",
      "um", "uma", "ao", "aos", "as", "os", "no", "na", "nos", "nas",
      "novo", "nova", "kit", "mlb", "produto", "produtos",
    ]);
    const titles = (Array.isArray(items) ? items : [])
      .map((item) => text(item?.title || ""))
      .filter(Boolean);
    const bag = new Map();
    const tokenBag = new Map();
    titles.forEach((title) => {
      const tokens = title
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3 && !stopwords.has(token));
      const uniqueTokens = new Set(tokens.slice(0, 14));
      uniqueTokens.forEach((token) => tokenBag.set(token, (tokenBag.get(token) || 0) + 1));
      const uniqueTerms = new Set();
      for (let size = 2; size <= 3; size += 1) {
        for (let index = 0; index <= tokens.length - size; index += 1) {
          const term = tokens.slice(index, index + size).join(" ");
          if (term.length >= 7) uniqueTerms.add(term);
        }
      }
      uniqueTerms.forEach((term) => bag.set(term, (bag.get(term) || 0) + 1));
    });
    const phraseRows = Array.from(bag.entries())
      .map(([term, total]) => ({ term, total, tokens: term.split(/\s+/) }))
      .filter((row) => row.tokens.length >= 2)
      .sort((a, b) => (b.total - a.total) || (b.tokens.length - a.tokens.length) || a.term.localeCompare(b.term));
    const selected = [];
    const selectedTokenPairs = new Set();
    const selectedTokenCoverage = new Map();
    const maxPhraseTotal = phraseRows[0]?.total || 1;
    for (const row of phraseRows) {
      const tokenKey = row.tokens.slice().sort().join("|");
      const isContained = selected.some((current) => {
        const currentTokens = new Set(current.tokens);
        return row.tokens.every((token) => currentTokens.has(token))
          || current.tokens.every((token) => new Set(row.tokens).has(token));
      });
      const sharesTooMuch = selected.some((current) => {
        const overlap = row.tokens.filter((token) => current.tokens.includes(token)).length;
        return overlap >= Math.min(row.tokens.length, current.tokens.length) && Math.abs(row.total - current.total) <= 2;
      });
      const tokensAlreadyCovered = row.tokens.every((token) => Number(selectedTokenCoverage.get(token) || 0) > 0);
      if (selectedTokenPairs.has(tokenKey) || isContained || sharesTooMuch || (tokensAlreadyCovered && row.total <= maxPhraseTotal * 0.75)) continue;
      selected.push(row);
      selectedTokenPairs.add(tokenKey);
      row.tokens.forEach((token) => selectedTokenCoverage.set(token, Number(selectedTokenCoverage.get(token) || 0) + 1));
      if (selected.length >= 24) break;
    }
    const tokenRows = Array.from(tokenBag.entries())
      .map(([term, total]) => ({ term, total, tokens: [term] }))
      .filter((row) => !selected.some((current) => current.tokens.includes(row.term)))
      .sort((a, b) => (b.total - a.total) || a.term.localeCompare(b.term));
    const ranked = [...selected, ...tokenRows].slice(0, 30).map((row) => [row.term, row.total]);
    const max = ranked[0]?.[1] || 1;
    return ranked.map(([term, total]) => {
      const coverage = titles.length ? total / titles.length : 0;
      const level = coverage >= 0.45 ? "high" : coverage >= 0.22 ? "medium" : "low";
      const label = level === "high" ? "Muito usada pelos concorrentes" : level === "medium" ? "Uso recorrente" : "Uso pontual";
      return {
        term,
        total,
        sample_size: titles.length,
        coverage_pct: Number((coverage * 100).toFixed(1)),
        level,
        label,
        score: Math.max(1, Math.round((total / max) * 100)),
        source: "ml_search_html",
      };
    });
  }

  function slugSearchTerm(value) {
    return text(value)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function mlSearchUrlsForTitle(title, pages = 5) {
    const slug = slugSearchTerm(title);
    if (!slug) return [];
    const base = `https://lista.mercadolivre.com.br/${encodeURIComponent(slug).replace(/%2D/gi, "-")}`;
    return Array.from({ length: Math.max(1, Math.min(5, Number(pages) || 5)) }, (_, index) => {
      if (!index) return base;
      return `${base}_Desde_${index * 48 + 1}`;
    });
  }

  function fallbackMlSearchPageUrl(firstUrl, pageIndex) {
    if (!firstUrl || pageIndex <= 0) return firstUrl || "";
    const clean = String(firstUrl).replace(/_Desde_\d+(?:_NoIndex_True)?$/i, "");
    return `${clean}_Desde_${pageIndex * 48 + 1}_NoIndex_True`;
  }

  function nextMlSearchUrlFromDocument(doc, currentUrl, pageIndex = 0) {
    const current = String(currentUrl || "");
    const links = Array.from(doc.querySelectorAll("a[href]"))
      .map((link) => ({
        href: link.href || link.getAttribute("href") || "",
        label: text(`${link.getAttribute("aria-label") || ""} ${link.getAttribute("title") || ""} ${link.textContent || ""}`),
      }))
      .filter((link) => /mercadolivre\.com\.br|^\/|_Desde_/i.test(link.href));
    const next = links.find((link) => /seguinte|proxima|pr[oó]xima|next/i.test(link.label) && /_Desde_|page=/i.test(link.href));
    const offset = links
      .map((link) => link.href)
      .filter((href) => /_Desde_\d+/i.test(href))
      .sort((a, b) => {
        const aOffset = Number((a.match(/_Desde_(\d+)/i) || [])[1] || 0);
        const bOffset = Number((b.match(/_Desde_(\d+)/i) || [])[1] || 0);
        return aOffset - bOffset;
      })
      .find((href) => {
        const offsetValue = Number((href.match(/_Desde_(\d+)/i) || [])[1] || 0);
        return offsetValue > pageIndex * 48 + 1;
      });
    const candidate = next?.href || offset || fallbackMlSearchPageUrl(current, pageIndex + 1);
    try {
      return candidate ? new URL(candidate, current || location.href).href : "";
    } catch {
      return fallbackMlSearchPageUrl(current, pageIndex + 1);
    }
  }

  function buildLocalKeywordSuggestions(terms) {
    const clean = (Array.isArray(terms) ? terms : [])
      .map((term) => text(term).toLowerCase())
      .filter(Boolean);
    const suggestions = [];
    for (let index = 0; index < clean.length && suggestions.length < 10; index += 1) {
      const current = clean[index];
      const next = clean[index + 1] || clean[0] || "";
      const phrase = `${current} ${next}`.trim();
      if (phrase && !suggestions.includes(phrase)) suggestions.push(phrase);
    }
    return suggestions;
  }

  function searchItemDedupeKey(item) {
    const url = String(item?.url || "");
    const id = String(item?.item_id || extractMlItemIdFromText(url) || mlIdMatches(url)[0] || "").toUpperCase();
    if (id) return id;
    return text(item?.title || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function marketPageUrls(limit = 5) {
    const urls = new Set([location.href]);
    document.querySelectorAll(".andes-pagination__link, a[href*='_Desde_'], a[href*='page=']").forEach((link) => {
      const href = link.href || "";
      if (href && href.includes(location.hostname)) urls.add(href);
    });
    return Array.from(urls).slice(0, limit);
  }

  async function fetchSearchItemsFromUrl(url, marketplace) {
    if (url === location.href) {
      return extractSearchItemsFromCards(searchCardsFromDocument(document, marketplace), marketplace);
    }
    const page = await fetchSearchPageFromUrl(url, marketplace, 0);
    return page.items;
  }

  async function fetchSearchPageFromUrl(url, marketplace, pageIndex = 0) {
    const response = await proxyTextFetch(url);
    const html = response.text;
    if (/micro-landing-container|_bm_skipml|Challenge error|requires JavaScript/i.test(html)) {
      const error = new Error("Mercado Livre retornou pagina de validacao antes da busca.");
      error.code = "ml_validation_page";
      throw error;
    }
    const doc = new DOMParser().parseFromString(html, "text/html");
    const effectiveUrl = response.url || url;
    return {
      items: extractSearchItemsFromCards(searchCardsFromDocument(doc, marketplace), marketplace),
      url: effectiveUrl,
      nextUrl: marketplace === "ml" ? nextMlSearchUrlFromDocument(doc, effectiveUrl, pageIndex) : "",
    };
  }

  async function generateKeywordsFromMlSearchHtml(data) {
    const urls = mlSearchUrlsForTitle(data?.title || "", 5);
    if (!urls.length) throw new Error("Nao consegui montar uma busca pelo titulo do anuncio.");
    const batches = [];
    const diagnostics = {
      requested_pages: urls.length,
      fetched_pages: 0,
      sampled_titles: 0,
      source: "ml_search_html",
    };
    const visitedUrls = new Set();
    let nextUrl = urls[0];
    for (let pageIndex = 0; pageIndex < urls.length && nextUrl; pageIndex += 1) {
      const url = nextUrl;
      if (visitedUrls.has(url)) break;
      visitedUrls.add(url);
      try {
        const page = await fetchSearchPageFromUrl(url, "ml", pageIndex);
        diagnostics.fetched_pages += 1;
        batches.push(...page.items);
        nextUrl = page.nextUrl && !visitedUrls.has(page.nextUrl)
          ? page.nextUrl
          : fallbackMlSearchPageUrl(urls[0], pageIndex + 1);
        await delay(220);
      } catch (error) {
        diagnostics.last_error = error?.message || "Falha ao ler pagina de busca";
        diagnostics.failed_pages = Number(diagnostics.failed_pages || 0) + 1;
        nextUrl = fallbackMlSearchPageUrl(urls[0], pageIndex + 1);
      }
    }
    const currentId = resolveMlItemId(data);
    const seen = new Set();
    const items = batches.filter((item) => {
      const id = String(item?.item_id || "").toUpperCase();
      if (currentId && id === currentId) return false;
      const key = searchItemDedupeKey(item);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    diagnostics.sampled_titles = items.length;
    diagnostics.unique_pages = visitedUrls.size;
    const ranked = keywordRowsFromSearchTitles(items);
    const suggestions = buildLocalKeywordSuggestions(ranked.slice(0, 10).map((row) => row.term));
    return {
      data_quality: {
        keywords: ranked.length ? "busca_ml_titulos_ate_pagina_5" : "busca_ml_sem_ocorrencias_suficientes",
        keyword_search: diagnostics,
        keyword_ai: "nao_solicitado",
      },
      keywords: {
        ranked,
        suggestions,
      },
    };
  }

  async function refineKeywordsWithAi(data, keywordPack) {
    const ranked = Array.isArray(keywordPack?.keywords?.ranked) ? keywordPack.keywords.ranked : [];
    if (!ranked.length) return keywordPack;
    try {
      const category = data?.realtime?.product?.category_name
        || data?.realtime?.product?.category_path
        || data?.category
        || "";
      const payload = await apiFetch("/api/extension/keywords/refine", {
        method: "POST",
        body: {
          title: data?.title || "",
          category,
          candidates: ranked.slice(0, 80).map((row) => ({
            term: row.term,
            total: row.total,
            score: row.score,
            sample_size: row.sample_size,
            label: row.label,
          })),
        },
      });
      const refinement = payload?.refinement || null;
      if (!refinement?.available || !Array.isArray(refinement?.keywords?.ranked) || !refinement.keywords.ranked.length) {
        return {
          ...keywordPack,
          data_quality: {
            ...(keywordPack.data_quality || {}),
            keyword_ai: refinement?.reason || "ia_indisponivel",
          },
        };
      }
      return {
        ...keywordPack,
        data_quality: {
          ...(keywordPack.data_quality || {}),
          keyword_ai: refinement.cached ? "mistral_cache" : "mistral",
          keyword_ai_model: refinement.model || "",
          keyword_ai_removed: Array.isArray(refinement.keywords.removed) ? refinement.keywords.removed.length : 0,
        },
        keywords: {
          ranked: refinement.keywords.ranked,
          suggestions: Array.isArray(refinement.keywords.suggestions) && refinement.keywords.suggestions.length
            ? refinement.keywords.suggestions
            : keywordPack.keywords.suggestions,
          ai_notes: refinement.keywords.notes || [],
          ai_removed: refinement.keywords.removed || [],
        },
      };
    } catch (error) {
      return {
        ...keywordPack,
        data_quality: {
          ...(keywordPack.data_quality || {}),
          keyword_ai: error?.message || "ia_falhou",
        },
      };
    }
  }

  function summarizeMarketItems(items, pages) {
    const prices = items.map((item) => item.price).filter(Number.isFinite);
    const avg = prices.length ? prices.reduce((sum, value) => sum + value, 0) / prices.length : null;
    const sorted = prices.slice().sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    const min = sorted.length ? sorted[0] : null;
    const max = sorted.length ? sorted[sorted.length - 1] : null;
    return {
      pages,
      count: items.length,
      avg,
      median,
      min,
      max,
      freeShippingCount: items.filter((item) => item.freeShipping).length,
      sponsoredCount: items.filter((item) => item.sponsored).length,
      withPriceCount: prices.length,
      titleTerms: keywordCountsFromTitles(items),
      data_source: "HTML das paginas de busca",
      data_quality: "Valores lidos do card; totais e concorrencia sao estimados pela pagina carregada.",
      fetched_at: new Date().toISOString(),
    };
  }

  function marketTermLevel(count, total) {
    const ratio = total > 0 ? count / total : 0;
    if (count >= 10 || ratio >= 0.22) return "high";
    if (count >= 4 || ratio >= 0.1) return "medium";
    return "low";
  }

  function marketTermLabel(level) {
    if (level === "high") return "alta incidencia";
    if (level === "medium") return "media incidencia";
    return "baixa incidencia";
  }

  function renderMarketPanel(analysis, data) {
    const isReady = analysis && !analysis.loading && !analysis.error;
    const query = escapeHtml(analysis?.query || getQueryFromUrl(location.href, data?.marketplaceKey) || "busca atual");
    if (analysis?.loading) {
      return `
        <div class="dvti-market-box">
          <div class="dvti-market-head">
            <div>
              <span>Pesquisa de mercado</span>
              <strong>Analisando ate 5 paginas...</strong>
            </div>
            <em>HTML da busca</em>
          </div>
          <p class="dvti-foot">Estou lendo os cards carregados pelo marketplace para montar media de preco, frete, anuncios patrocinados e termos dos titulos.</p>
        </div>
      `;
    }
    if (analysis?.error) {
      return `
        <div class="dvti-market-box">
          <div class="dvti-market-head">
            <div>
              <span>Pesquisa de mercado</span>
              <strong>Nao foi possivel concluir agora</strong>
            </div>
            <em>indisponivel</em>
          </div>
          <p class="dvti-foot">${escapeHtml(analysis.error)}</p>
          <button class="dvti-action" data-action="analyze-market">Tentar novamente</button>
        </div>
      `;
    }
    if (!isReady) {
      return `
        <div class="dvti-market-box">
          <div class="dvti-market-head">
            <div>
              <span>Pesquisa de mercado</span>
              <strong>Analise a pagina atual</strong>
            </div>
            <em>ate 5 paginas</em>
          </div>
          <p class="dvti-foot">Varre os anuncios visiveis, calcula faixa de preco, peso de frete/patrocinados e termos mais usados nos titulos.</p>
          <button class="dvti-action dvti-primary" data-action="analyze-market">Analisar mercado</button>
        </div>
      `;
    }

    const terms = (analysis.titleTerms || []).slice(0, 8).map((row) => {
      const level = marketTermLevel(row.count, analysis.count);
      return `
        <li class="${level}">
          <span>${escapeHtml(row.term)}</span>
          <strong>${formatNumber(row.count)}</strong>
          <em>${marketTermLabel(level)}</em>
        </li>
      `;
    }).join("");

    return `
      <div class="dvti-market-box">
        <div class="dvti-market-head">
          <div>
            <span>Pesquisa de mercado</span>
            <strong>${query}</strong>
          </div>
          <em>${escapeHtml(analysis.data_source || "HTML da busca")}</em>
        </div>
        <div class="dvti-market-grid">
          ${metric("Anuncios lidos", formatNumber(analysis.count))}
          ${metric("Paginas", `${formatNumber(analysis.pages)} / 5`)}
          ${metric("Preco medio", formatMoney(analysis.avg))}
          ${metric("Mediana", formatMoney(analysis.median))}
          ${metric("Faixa", `${formatMoney(analysis.min)} - ${formatMoney(analysis.max)}`)}
          ${metric("Frete visivel", `${formatNumber(analysis.freeShippingCount)} cards`)}
          ${metric("Patrocinados", `${formatNumber(analysis.sponsoredCount)} cards`)}
          ${metric("Preco lido", `${formatNumber(analysis.withPriceCount)} cards`)}
        </div>
        <h5>Termos mais usados nos titulos</h5>
        <ul class="dvti-market-terms">${terms || "<li><span>Sem termos suficientes</span><strong>-</strong><em>-</em></li>"}</ul>
        <p class="dvti-mini-note">${escapeHtml(analysis.data_quality || "Leitura estimada a partir do HTML carregado.")}</p>
      </div>
    `;
  }

  function clearSearchDecorations() {
    document.querySelectorAll(".dvti-inline-summary").forEach((node) => node.remove());
    document.querySelectorAll(".dvti-card-annotated").forEach((node) => node.classList.remove("dvti-card-annotated"));
  }

  function clearProductDecorations(options = {}) {
    if (!options.keepInsight) {
      document.querySelectorAll(".dvti-product-insight-card").forEach((node) => node.remove());
    }
    document.querySelectorAll(".dvti-photo-alert").forEach((node) => node.classList.remove("dvti-photo-alert"));
    document.querySelectorAll(".dvti-photo-badge").forEach((node) => node.remove());
  }

  function shortText(value, max = 42) {
    const clean = text(value);
    if (!clean || clean.length <= max) return clean;
    return `${clean.slice(0, Math.max(0, max - 1)).trim()}...`;
  }

  function scoreClass(score) {
    const n = Number(score || 0);
    if (n >= 76) return "good";
    if (n >= 55) return "warn";
    return "bad";
  }

  function firstRankedKeyword(data) {
    const realtime = data?.realtime || null;
    const keywordInsights = buildKeywordInsights(data);
    const ranked = Array.isArray(realtime?.keywords?.ranked) && realtime.keywords.ranked.length
      ? realtime.keywords.ranked
      : keywordInsights.ranked;
    return ranked?.[0] || null;
  }

  function productLoadingInsightHtml(data) {
    const itemId = data.marketplaceKey === "ml"
      ? resolveMlItemId(data)
      : String(data?.shopee?.itemId || data?.item_id || "");
    const loadingLabel = defaultRealtimeLoadingText(data.marketplaceKey);
    return `
      <div class="dvti-product-loading-card">
        <div class="dvti-product-loading-brand">
          <img src="${BRAND_ICON_URL}" alt="DACHBYTE Seller" />
          <div>
            <strong>Informacoes DACHBYTE Seller</strong>
            <span>${escapeHtml(data.marketplace || "Marketplace")} em tempo real</span>
          </div>
        </div>
        <div class="dvti-product-loading-copy">
          <span class="dvti-spinner"></span>
          <div>
            <strong>${escapeHtml(data.realtimeLoadingText || loadingLabel)}</strong>
            <em>O painel completo abre automaticamente assim que a leitura terminar.</em>
          </div>
        </div>
        <div class="dvti-product-loading-tags">
          <span>Anuncio detectado</span>
          ${itemId ? `<span>${escapeHtml(itemId)}</span>` : ""}
          ${data.price ? `<span>${escapeHtml(formatMoney(data.price))}</span>` : ""}
        </div>
      </div>
    `;
  }

  function productInsightHtml(data) {
    if (data.realtimeLoading) return productLoadingInsightHtml(data);

    const realtime = data.realtime || null;
    const isShopee = data.marketplaceKey === "shopee";
    const product = realtime?.product || {};
    const seller = realtime?.seller || {};
    const shopeeBasePrice = isShopee
      ? Number(data?.shopee?.saleBasePrice || data?.shopee?.regularPrice || product?.price || data?.price || 0)
      : 0;
    const shopeeSignals = isShopee
      ? {
          ...(data.shopee || {}),
          estimatedFees: computeShopeeEstimatedFees(shopeeBasePrice)
            || data?.shopee?.estimatedFees
            || realtime?.fees
            || null,
          subsidies: computeShopeeSubsidyBenefits({
            salePrice: shopeeBasePrice,
            regularPrice: Number(data?.shopee?.regularPrice || 0),
            pixPrice: Number(data?.shopee?.pixPrice || 0),
            shippingMin: Number(data?.shopee?.shippingMin || 0),
          }),
        }
      : {};
    const realtimeSoldRaw = isShopee
      ? (product.historical_sold ?? product.sold)
      : product.sold_quantity;
    const soldRaw = parseCountValue(realtimeSoldRaw) > 0 ? realtimeSoldRaw : data.sold;
    const soldNumber = parseSoldNumber(soldRaw);
    const sold = soldNumber != null ? formatNumber(soldNumber) : soldRaw || "-";
    const monthlyProjection = realtime?.estimates?.monthly_sales_projection;
    const revenueProjection = realtime?.estimates?.gross_revenue_projection;
    const keyword = firstRankedKeyword(data);
    const scoreTone = scoreClass(data.score);
    const picturesCount = Number(data.pictures || product.pictures || 0);
    const hasEnoughPictures = picturesCount >= (isShopee ? 6 : 8);
    const sellerName = seller.nickname || seller.name || data.seller || "-";
    const listingType = isShopee ? (product.item_status || "shopee") : product.listing_type_id || "";
    const category = isShopee
      ? shopeeSignals.categoryPath || product.category_path || product.category_name || product.category_id || shopeeSignals.catId || ""
      : product.category_name || product.category_id || "";
    const warnings = Array.isArray(data.warnings) ? data.warnings.slice(0, 2) : [];
    const wins = Array.isArray(data.wins) ? data.wins.slice(0, 2) : [];
    const visits = Number(realtime?.traffic?.visits_30d || 0);
    const conversion = visits > 0 && soldNumber != null ? (soldNumber / visits) * 100 : null;
    const salesPerDay = monthlyProjection != null ? Number(monthlyProjection) / 30 : null;
    const visitsPerSale = visits > 0 && soldNumber > 0 ? Math.ceil(visits / soldNumber) : null;
    const sellEvery = salesPerDay && salesPerDay > 0
      ? salesPerDay >= 1 ? `${salesPerDay.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}/dia` : `1 a cada ${Math.ceil(1 / salesPerDay)} dias`
      : visitsPerSale ? `1 venda / ${formatNumber(visitsPerSale)} visitas` : "-";
    const fee = Number((isShopee ? shopeeSignals?.estimatedFees?.sale_fee : realtime?.fees?.sale_fee) || 0);
    const price = Number.isFinite(Number(data.price)) ? Number(data.price) : Number(product.price || 0);
    const receiveBase = isShopee
      ? (shopeeBasePrice > 0 ? shopeeBasePrice - fee : null)
      : (price > 0 ? price - fee : null);
    const receive = isShopee
      ? (receiveBase != null ? receiveBase + Number(shopeeSignals?.subsidies?.freightSubsidyAmount || 0) : null)
      : receiveBase;
    const feePercentBase = isShopee ? shopeeBasePrice : price;
    const feePercent = feePercentBase && fee ? (fee / feePercentBase) * 100 : null;
    const shopeeCommissionRule = isShopee ? shopeeCommissionRuleForPrice(shopeeBasePrice) : null;
    const shopeePixLabel = Number.isFinite(Number(shopeeSignals.pixPrice)) && Number(shopeeSignals.pixPrice) > 0
      ? formatMoney(Number(shopeeSignals.pixPrice))
      : "-";
    const shopeeRegularLabel = shopeeBasePrice > 0 ? formatMoney(shopeeBasePrice) : "-";
    const tax = Number(realtime?.fees?.tax_amount || 0);
    const fallbackRevenue = revenueProjection != null
      ? revenueProjection
      : soldNumber > 0 && price > 0 ? soldNumber * price : null;
    const salesLabel = monthlyProjection != null
      ? `${formatNumber(monthlyProjection)}/mes`
      : sold !== "-" ? `${sold} vend.` : "-";
    const eans = Array.isArray(product.eans) ? product.eans : [];
    const reviews = isShopee
      ? {
          count: Number(product?.reviews?.count || product?.cmt_count || data.reviews_count || shopeeSignals.reviewsCount || 0),
          rate: Number(product?.reviews?.rate || product?.rating_star || data.rating || shopeeSignals.rating || 0),
        }
      : (product.reviews || {});
    const promotions = isShopee
      ? (Array.isArray(shopeeSignals.couponPercents) ? shopeeSignals.couponPercents : [])
      : (Array.isArray(product.promotions) ? product.promotions : []);
    const recommendationMin = price ? price * 0.85 : null;
    const recommendationMax = price ? price * 1.15 : null;
    const rankingText = keyword?.term
      ? `${shortText(keyword.term, 24)}: ${keyword.label || "tendencia"}`
      : "Sem termo lido";
    const sourceLabel = isShopee
      ? (realtime?.available
        ? "Dados da API publica da Shopee combinados com leitura do HTML carregado."
        : "Leitura local do HTML + estado inicial da Shopee. Taxas sao estimadas.")
      : (realtime?.data_quality?.summary
        || (realtime?.source === "ml_public_api" ? "Produto lido via API publica; network usado para resolver o MLB quando necessario." : "Leitura local do HTML carregado."));
    const shopeeCreatedIso = isShopee
      ? (epochToIso(product?.ctime) || String(shopeeSignals?.createdAtIso || ""))
      : "";
    const createdLabel = isShopee
      ? formatDate(shopeeCreatedIso)
      : formatDate(product.date_created);
    const updatedLabel = formatDate(product.last_updated);
    const ageDays = isShopee
      ? daysSinceDate(shopeeCreatedIso)
      : positiveAgeDays(realtime, product);
    const ageLabel = ageDays != null ? `${formatNumber(ageDays)} dias` : "-";
    const salesVelocity = computeSalesVelocity(soldRaw, ageDays);
    const salesPerDayLabel = formatSalesPerDayLabel(salesVelocity.salesPerDay);
    const projectedMonthlySales = salesVelocity.projectedMonthly != null
      ? salesVelocity.projectedMonthly
      : (monthlyProjection != null ? Number(monthlyProjection) : null);
    const shopeeShippingValue = Number.isFinite(Number(shopeeSignals.shippingFinal))
      ? Number(shopeeSignals.shippingFinal)
      : Number.isFinite(Number(shopeeSignals.shippingMin))
        ? Number(shopeeSignals.shippingMin)
        : null;
    const shopeeShippingLabel = Number.isFinite(shopeeShippingValue)
      ? formatMoney(shopeeShippingValue)
      : data.shipping ? "Visivel" : "-";
    const shopeeDelivery = shopeeSignals.deliveryWindow || null;
    const shopeeDeliveryLabel = shopeeDelivery?.corridos || shopeeDelivery?.uteis
      ? `${Number(shopeeDelivery?.corridos || 0) > 0 ? `${formatNumber(Number(shopeeDelivery.corridos))} dias corridos` : "-"}${Number(shopeeDelivery?.uteis || 0) > 0 ? ` / ${formatNumber(Number(shopeeDelivery.uteis))} dias uteis` : ""}`
      : "-";
    const shopeeInstallmentLabel = shopeeSignals.installment?.count && Number.isFinite(Number(shopeeSignals.installment?.value))
      ? `${shopeeSignals.installment.count}x ${formatMoney(Number(shopeeSignals.installment.value))}`
      : "-";
    const shopeeClipCount = Number(shopeeSignals?.clipCount || data?.clip_count || 0);
    const shopeeReviewVideoCount = Number(shopeeSignals?.reviewVideoCount || data?.review_video_count || data?.video_count || 0);
    const compactDataPoints = isShopee
      ? [
          productDataPoint("Preco normal", shopeeRegularLabel),
          productDataPoint("Preco no Pix", shopeePixLabel),
          productDataPoint("Vendas", sold !== "-" ? `${sold} vend.` : "-"),
          productDataPoint("Estoque", Number.isFinite(Number(shopeeSignals.stock ?? data.stock)) ? formatNumber(Number(shopeeSignals.stock ?? data.stock)) : "-"),
          productDataPoint("Avaliacoes", reviews.count ? formatNumber(reviews.count) : "-"),
          productDataPoint("Nota", reviews.rate ? String(reviews.rate).replace(".", ",") : "-"),
          productDataPoint("Curtidas", Number.isFinite(Number(shopeeSignals.likedCount ?? data.liked_count)) ? formatNumber(Number(shopeeSignals.likedCount ?? data.liked_count)) : "-"),
          productDataPoint("Frete", shopeeShippingLabel),
          productDataPoint("Prazo frete", shopeeDeliveryLabel),
          productDataPoint("Vende a cada", salesPerDayLabel),
          productDataPoint("Clip (grade)", shopeeClipCount > 0 ? formatNumber(shopeeClipCount) : "-"),
          productDataPoint("Video (avaliacoes)", shopeeReviewVideoCount > 0 ? formatNumber(shopeeReviewVideoCount) : "-"),
          productDataPoint("Parcelamento", shopeeInstallmentLabel),
          productDataPoint("Rebate Pix", Number(shopeeSignals?.subsidies?.pixDiscountAmount || 0) > 0 ? formatMoney(Number(shopeeSignals.subsidies.pixDiscountAmount)) : "-"),
          productDataPoint("Subsidio frete", Number(shopeeSignals?.subsidies?.freightSubsidyAmount || 0) > 0 ? `${formatMoney(Number(shopeeSignals.subsidies.freightSubsidyAmount))} (ate ${formatMoney(Number(shopeeSignals?.subsidies?.freightCap || 0))})` : `ate ${formatMoney(Number(shopeeSignals?.subsidies?.freightCap || 0))}`),
          productDataPoint("Recebe estimado", receive != null ? formatMoney(receive) : "-", "wide"),
          productDataPoint("Comissao Shopee", fee ? `${shopeeCommissionRule?.label || "-"} = ${formatMoney(fee)}${feePercent ? ` (${formatPercent(feePercent)})` : ""}` : "-", "wide"),
          productDataPoint("Proj. vendas/mes", projectedMonthlySales != null ? formatProjectedMonthlyLabel(projectedMonthlySales) : "-", "wide"),
          createdLabel !== "-" ? productDataPoint("Criado em", createdLabel) : "",
          productDataPoint("Categoria", category || "-", "wide"),
          productDataPoint("Idade do anuncio", ageLabel),
        ]
      : [
          productDataPoint("Visitas", visits ? formatNumber(visits) : "-"),
          productDataPoint("Vende a cada", sellEvery),
          productDataPoint("Conversao", conversion != null ? formatPercent(conversion) : "-"),
          createdLabel !== "-" ? productDataPoint("Criado", createdLabel) : "",
          updatedLabel !== "-" ? productDataPoint("Atualizado", updatedLabel) : "",
          productDataPoint("Vendas", salesLabel),
          tax ? productDataPoint("Imposto", formatMoney(tax)) : "",
          productDataPoint("Recebe", receive != null ? formatMoney(receive) : "-"),
          eans.length ? productDataPoint("EAN(s)", eans.slice(0, 2).join(", ")) : "",
          productDataPoint("Avaliacoes", reviews.count ? `${formatNumber(reviews.count)} (${String(reviews.rate || "-").replace(".", ",")})` : "-"),
          promotions.length ? productDataPoint("Promocoes", `${formatNumber(promotions.length)} ativa(s)`) : "",
          productDataPoint("Recomendacao", recommendationMin ? `Entre ${formatMoney(recommendationMin)} e ${formatMoney(recommendationMax)}` : "-", "wide"),
          productDataPoint("Comissao ML", fee ? `${formatMoney(fee)}${feePercent ? ` (${formatPercent(feePercent)})` : ""}` : "-", "wide"),
          productDataPoint("Idade do anuncio", ageLabel),
        ];
    const modeLineA = isShopee ? `Shopee #${shortText(shopeeSignals.itemId || data.item_id || "-", 20)}` : listingTypeLabel(listingType);
    const modeLineB = isShopee
      ? (shopeeShippingLabel !== "-" ? `Frete ${shopeeShippingLabel}` : (data.shipping ? "Frete visivel" : "Frete nao lido"))
      : (product.shipping_free ? "Frete gratis" : data.shipping ? "Frete visivel" : "Frete nao lido");
    const modeLineC = isShopee
      ? `${formatNumber(shopeeSignals.variationCount || 0)} variacao(oes)`
      : (product.catalog_listing ? "Catalogo" : "Anuncio comum");
    const modeLabelPrice = isShopee ? "Faturamento potencial" : "Faturando";
    const finalDataPoints = compactDataPoints.filter(Boolean).join("");

    return `
      <div class="dvti-product-insight-head">
        <div class="dvti-product-brand">
          <img src="${BRAND_ICON_URL}" alt="DACHBYTE Seller" />
          <div>
            <strong>Informacoes DACHBYTE Seller</strong>
            <span>${escapeHtml(data.marketplace || "Marketplace")} em tempo real</span>
          </div>
        </div>
        <div class="dvti-product-score ${scoreTone}">
          <span>Score</span>
          <strong>${Number(data.score || 0)}</strong>
        </div>
      </div>
      <div class="dvti-product-mode-row">
        <span>${escapeHtml(modeLineA)}</span>
        <span>${escapeHtml(modeLineB)}</span>
        <span>${escapeHtml(modeLineC)}</span>
      </div>
      <div class="dvti-product-data-grid">
        ${finalDataPoints}
      </div>
      <div class="dvti-product-revenue">
        <span>${escapeHtml(modeLabelPrice)}</span>
        <strong>${fallbackRevenue != null ? formatMoney(fallbackRevenue) : "-"}</strong>
      </div>
      <div class="dvti-product-lines">
        <p><span>Vendedor</span><strong>${escapeHtml(shortText(sellerName, 34) || "-")}</strong></p>
        <p><span>Fotos</span><strong>${escapeHtml(`${picturesCount}/${isShopee ? "6" : "8"}+`)}</strong></p>
        ${category ? `<p><span>Categoria</span><strong>${escapeHtml(category)}</strong></p>` : ""}
      </div>
      <div class="dvti-product-status">
        <span class="${hasEnoughPictures ? "ok" : "warn"}">${hasEnoughPictures ? "Fotos em boa quantidade" : "Revisar fotos"}</span>
        ${keyword ? `<span class="${escapeHtml(keyword.level || "unknown")}">${escapeHtml(shortText(keyword.term, 22))}: ${escapeHtml(keyword.label || "Tendencia")}</span>` : ""}
      </div>
      <p class="dvti-product-source">${escapeHtml(sourceLabel)}</p>
      <details class="dvti-product-toggle">
        <summary>Rankeamento</summary>
        <p>${escapeHtml(rankingText)}</p>
      </details>
      <details class="dvti-product-toggle">
        <summary>Pontos negativos</summary>
        <p>${warnings.length ? warnings.map((item) => escapeHtml(item)).join(" | ") : "Nenhum ponto critico lido na primeira analise."}</p>
      </details>
      <div class="dvti-product-notes">
        ${wins.map((item) => `<p class="ok">${escapeHtml(item)}</p>`).join("")}
        ${warnings.map((item) => `<p class="warn">${escapeHtml(item)}</p>`).join("")}
      </div>
      <div class="dvti-product-actions">
        <button type="button" data-action="open-detail">Detalhar</button>
        ${isShopee ? `<button type="button" data-action="download-media">Baixar midia ZIP</button>` : ""}
        ${data.marketplaceKey === "ml" ? `<button type="button" data-action="clone">Clonar</button>` : ""}
      </div>
    `;
  }

  function findProductInsightAnchor(data = state.current) {
    const isShopee = data?.marketplaceKey === "shopee" || detectMarketplace() === "shopee";
    const targets = isShopee
      ? [
          { selector: "#sll2-pdp-product-shop", position: "beforebegin" },
          { selector: ".page-product__shop", position: "beforebegin" },
          { selector: ".page-product__content", position: "beforebegin" },
          { selector: ".page-product__content--left .product-detail.page-product__detail", position: "beforebegin" },
          { selector: ".page-product__content--left .product-detail", position: "beforebegin" },
          { selector: ".page-product__content--left", position: "afterbegin" },
          { selector: "main", position: "afterbegin" },
        ]
      : [
          { selector: ".ui-pdp-header", position: "afterend" },
          { selector: ".ui-pdp-container__col .ui-pdp-header", position: "afterend" },
          { selector: ".ui-pdp-container__col:nth-child(2)", position: "afterbegin" },
          { selector: ".ui-pdp--sticky-wrapper", position: "afterend" },
          { selector: "[class*='product-briefing']", position: "afterend" },
          { selector: "main h1", position: "afterend" },
          { selector: "h1.ui-pdp-title", position: "afterend" },
          { selector: "h1", position: "afterend" },
        ];
    for (const target of targets) {
      const node = document.querySelector(target.selector);
      if (!node) continue;
      const position = target.position || "afterend";
      const needsParent = position === "beforebegin" || position === "afterend";
      if (needsParent && !node.parentElement) continue;
      return { node, position };
    }
    return null;
  }

  function injectProductInsightCard(data) {
    const anchorRef = findProductInsightAnchor(data);
    if (!anchorRef?.node) return;
    const anchor = anchorRef.node;
    const insertPosition = anchorRef.position || "afterend";

    const signature = [
      data.title,
      data.price,
      data.sold,
      data.pictures,
      data.score,
      firstRankedKeyword(data)?.term,
      data.realtime?.traffic?.visits_30d,
      data.realtime?.estimates?.monthly_sales_projection,
      data.realtime?.fees?.sale_fee,
      data.realtime?.product?.reviews?.count,
      data.realtime?.product?.promotions?.length,
      data.realtime?.product?.eans?.join(","),
      data.realtime?.product?.date_created,
      data.realtime?.estimates?.age_days,
      data.shopee?.itemId,
      data.shopee?.shopId,
      data.shopee?.stock,
      data.shopee?.reviewsCount,
      data.shopee?.rating,
      data.shopee?.shippingMin,
      data.shopee?.shippingMax,
      data.shopee?.shippingFinal,
      data.shopee?.deliveryWindow?.corridos,
      data.shopee?.deliveryWindow?.uteis,
      data.shopee?.createdAtIso,
      data.shopee?.videoCount,
      data.shopee?.clipCount,
      data.shopee?.reviewVideoCount,
      data.shopee?.pixPrice,
      data.shopee?.regularPrice,
      data.shopee?.subsidies?.pixDiscountAmount,
      data.shopee?.subsidies?.freightSubsidyAmount,
      data.shopee?.subsidies?.totalSubsidyAmount,
      data.shopee?.couponPercents?.join(","),
      data.shopee?.estimatedFees?.sale_fee,
      data.realtimeLoading ? "loading" : "ready",
      data.realtimeLoadingText,
    ].join("|");

    const existing = document.querySelector(".dvti-product-insight-card");
    if (existing?.dataset.signature === signature) return;

    document.querySelectorAll(".dvti-product-insight-card").forEach((node) => node.remove());
    const card = document.createElement("section");
    card.className = `dvti-product-insight-card ${scoreClass(data.score)}${data.realtimeLoading ? " is-loading" : " is-ready"}`;
    if (data.marketplaceKey === "shopee") card.classList.add("is-shopee");
    card.dataset.signature = signature;
    card.innerHTML = productInsightHtml(data);
    card.addEventListener("click", handleActionClick);
    anchor.insertAdjacentElement(insertPosition, card);
  }

  function decorateSearchCards(data) {
    clearSearchDecorations();
    const selector = data.marketplaceKey === "ml"
      ? ".ui-search-result, li.ui-search-layout__item"
      : "[data-sqe='item'], .shopee-search-item-result__item";
    const cards = Array.from(document.querySelectorAll(selector)).slice(0, 24);
    cards.forEach((card, index) => {
      const item = data.items?.[index];
      if (!item) return;
      const score = Math.max(
        35,
        Math.min(
          99,
          55
            + (item.freeShipping ? 12 : 0)
            + (item.sponsored ? -10 : 8)
            + (String(item.title || "").length > 40 ? 8 : 0),
        ),
      );
      const rank = classifyCompetition(item.title || "", data);
      const box = document.createElement("div");
      box.className = `dvti-inline-summary ${rank.level}`;
      box.innerHTML = `
        <div class="dvti-inline-top">
          <strong>DACHBYTE Seller ${score}</strong>
          <em>${rank.label}</em>
        </div>
        <span>${item.sponsored ? "Patrocinado" : "Organico"} • ${item.freeShipping ? "Frete visivel" : "Sem frete"}</span>
        <small>${Number.isFinite(item.price) ? escapeHtml(formatMoney(item.price)) : "Preco nao lido"}</small>
      `;
      card.classList.add("dvti-card-annotated");
      card.appendChild(box);
    });
  }

  function decorateProductPage(data) {
    clearProductDecorations({ keepInsight: true });
    const shouldShowLoadingNow = Boolean(data?.realtimeLoading);
    if (!shouldShowLoadingNow && (Date.now() < state.inlineReadyAt || document.readyState !== "complete")) {
      clearTimeout(state.pendingInlineTimer);
      state.pendingInlineTimer = setTimeout(() => {
        if (state.current?.type === "product") decorateProductPage(state.current);
      }, 900);
      return;
    }
    if (shouldShowLoadingNow && document.readyState === "loading") {
      clearTimeout(state.pendingInlineTimer);
      state.pendingInlineTimer = setTimeout(() => {
        if (state.current?.type === "product") decorateProductPage(state.current);
      }, 350);
      return;
    }
    injectProductInsightCard(data);
  }

  function applyPageEnhancements(data) {
    if (!isLogged()) {
      clearSearchDecorations();
      clearProductDecorations();
      return;
    }
    if (!data) return;
    if (data.type === "search") {
      decorateSearchCards(data);
      clearProductDecorations();
      return;
    }
    if (data.type === "product") {
      decorateProductPage(data);
      clearSearchDecorations();
    }
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function getStorage(keys) {
    return chrome.storage.local.get(keys);
  }

  function setStorage(values) {
    return chrome.storage.local.set(values);
  }

  function removeStorage(keys) {
    return chrome.storage.local.remove(keys);
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function normalizeBaseUrl(value) {
    return String(value || DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  function apiUrl(path) {
    return `${normalizeBaseUrl(state.baseUrl)}${path.startsWith("/") ? path : `/${path}`}`;
  }

  async function proxyApiFetch(path, options = {}, tokenOverride = "") {
    const headers = {
      accept: "application/json",
      "content-type": "application/json",
      ...(options.headers || {}),
    };
    const bearer = tokenOverride || state.token;
    if (bearer) headers.authorization = `Bearer ${bearer}`;

    const message = {
      type: "DVTI_PROXY_FETCH",
      url: apiUrl(path),
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    };

    const result = await chrome.runtime.sendMessage(message);
    if (!result) {
      throw new Error("Sem resposta do proxy da extensao.");
    }

    if (!result.ok || result?.payload?.ok === false) {
      throw new Error(result?.payload?.error || result?.error || `Erro HTTP ${result.status || 0}`);
    }

    return result.payload;
  }

  async function directApiFetch(path, options = {}, tokenOverride = "") {
    const headers = {
      accept: "application/json",
      "content-type": "application/json",
      ...(options.headers || {}),
    };
    const bearer = tokenOverride || state.token;
    if (bearer) headers.authorization = `Bearer ${bearer}`;

    const response = await fetch(apiUrl(path), {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error || `Erro HTTP ${response.status}`);
    }
    return payload;
  }

  async function apiFetch(path, options = {}, tokenOverride = "") {
    try {
      return await proxyApiFetch(path, options, tokenOverride);
    } catch (proxyError) {
      try {
        return await directApiFetch(path, options, tokenOverride);
      } catch (directError) {
        const message = directError?.message || proxyError?.message || "Falha de rede ao comunicar com a DACHBYTE.";
        throw new Error(message);
      }
    }
  }

  async function proxyTextFetch(url) {
    const result = await chrome.runtime.sendMessage({
      type: "DVTI_PROXY_FETCH",
      url,
      method: "GET",
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      responseType: "text",
    });
    if (!result || !result.ok) {
      throw new Error(result?.error || `Erro HTTP ${result?.status || 0}`);
    }
    return {
      text: String(result.text || ""),
      url: result.url || url,
      status: result.status || 0,
    };
  }

  function getQueryFromUrl(url, marketplaceKey) {
    try {
      const parsed = new URL(String(url || ""));
      if (marketplaceKey === "ml") {
        return text(parsed.searchParams.get("as_word") || parsed.searchParams.get("q") || "");
      }
      if (marketplaceKey === "shopee") {
        return text(parsed.searchParams.get("keyword") || parsed.searchParams.get("q") || "");
      }
      return "";
    } catch {
      return "";
    }
  }

  function getItemIdFromUrl(url, marketplaceKey) {
    const raw = String(url || "");
    if (marketplaceKey === "ml") {
      const direct = extractMlItemIdFromText(raw);
      if (direct) return direct;
      const productId = mlProductIdFromUrl(raw);
      const matches = mlIdMatches(raw);
      return matches.find((id) => id !== productId) || (!productId ? matches[0] || "" : "");
    }
    if (marketplaceKey === "shopee") {
      const ids = extractShopeeIdsFromUrl(raw);
      if (ids.shopId && ids.itemId) return `${ids.shopId}.${ids.itemId}`;
      if (ids.itemId) return ids.itemId;
    }
    return "";
  }

  function realtimeKey(data) {
    let itemId = "";
    if (data?.type === "product" && data?.marketplaceKey === "ml") {
      itemId = resolveMlItemId(data);
    } else if (data?.type === "product" && data?.marketplaceKey === "shopee") {
      itemId = String(data?.shopee?.itemId || data?.item_id || extractShopeeIdsFromUrl(location.href).itemId || "");
    }
    return `${data.marketplaceKey || ""}|${data.type || ""}|${itemId || location.href}`;
  }

  function mergeRealtime(data, realtime) {
    if (!realtime || typeof realtime !== "object") return data;
    const isShopee = data?.marketplaceKey === "shopee";
    const realtimeSold = parseCountValue(
      isShopee
        ? (realtime?.product?.historical_sold ?? realtime?.product?.sold)
        : realtime?.product?.sold_quantity,
    );
    const shouldUseRealtimeSold = Number.isFinite(realtimeSold) && realtimeSold > 0;
    const realtimePrice = Number(realtime?.product?.price);
    const resolvedPrice = Number.isFinite(Number(data.price))
      ? Number(data.price)
      : Number.isFinite(realtimePrice) && realtimePrice > 0
        ? realtimePrice
        : data.price;
    const resolvedShopeeBasePrice = isShopee
      ? Number(data?.shopee?.saleBasePrice || data?.shopee?.regularPrice || resolvedPrice || 0)
      : 0;

    const mergedShopee = isShopee
      ? {
          ...(data?.shopee || {}),
          itemId: String(realtime?.product?.item_id || data?.shopee?.itemId || data?.item_id || ""),
          shopId: String(realtime?.product?.shop_id || data?.shopee?.shopId || data?.shop_id || ""),
          stock: Number.isFinite(Number(realtime?.product?.stock))
            ? Number(realtime.product.stock)
            : data?.shopee?.stock,
          rating: Number.isFinite(Number(realtime?.product?.rating_star))
            ? Number(realtime.product.rating_star)
            : data?.shopee?.rating,
          reviewsCount: Number.isFinite(Number(realtime?.product?.reviews?.count))
            ? Number(realtime.product.reviews.count)
            : Number.isFinite(Number(realtime?.product?.cmt_count))
              ? Number(realtime.product.cmt_count)
              : data?.shopee?.reviewsCount,
          likedCount: Number.isFinite(Number(realtime?.product?.liked_count))
            ? Number(realtime.product.liked_count)
            : data?.shopee?.likedCount,
          estimatedDays: Number.isFinite(Number(realtime?.product?.estimated_days))
            ? Number(realtime.product.estimated_days)
            : data?.shopee?.estimatedDays,
          brand: text(realtime?.product?.brand || data?.shopee?.brand || ""),
          catId: String(realtime?.product?.cat_id || data?.shopee?.catId || ""),
          createdAtTs: Number(realtime?.product?.ctime || data?.shopee?.createdAtTs || 0) || null,
          createdAtIso: epochToIso(realtime?.product?.ctime || data?.shopee?.createdAtTs || 0) || data?.shopee?.createdAtIso || "",
          modelCount: Number.isFinite(Number(realtime?.product?.model_count))
            ? Number(realtime.product.model_count)
            : data?.shopee?.modelCount || 0,
          variationCount: Number.isFinite(Number(realtime?.product?.variation_count))
            ? Number(realtime.product.variation_count)
            : data?.shopee?.variationCount || 0,
          shippingFinal: Number.isFinite(Number(data?.shopee?.shippingFinal)) ? Number(data.shopee.shippingFinal) : data?.shopee?.shippingMin,
          deliveryWindow: data?.shopee?.deliveryWindow || null,
          clipCount: Number(data?.shopee?.clipCount || 0),
          reviewVideoCount: Number(data?.shopee?.reviewVideoCount || 0),
          videoCount: Number(data?.shopee?.reviewVideoCount || data?.shopee?.videoCount || 0),
          saleBasePrice: resolvedShopeeBasePrice,
          estimatedFees:
            computeShopeeEstimatedFees(resolvedShopeeBasePrice)
            || data?.shopee?.estimatedFees
            || realtime?.fees
            || null,
          subsidies: computeShopeeSubsidyBenefits({
            salePrice: resolvedShopeeBasePrice,
            regularPrice: Number(data?.shopee?.regularPrice || 0),
            pixPrice: Number(data?.shopee?.pixPrice || 0),
            shippingMin: Number(data?.shopee?.shippingMin || 0),
          }),
        }
      : data?.shopee;

    return {
      ...data,
      realtime,
      seller: realtime?.seller?.nickname || data.seller,
      sold: shouldUseRealtimeSold ? String(realtimeSold) : data.sold,
      pictures: Number.isFinite(Number(data.pictures)) && Number(data.pictures) > 0
        ? Number(data.pictures)
        : Number.isFinite(Number(realtime?.product?.pictures))
          ? Number(realtime.product.pictures)
          : data.pictures,
      price: resolvedPrice,
      item_id: isShopee ? String(mergedShopee?.itemId || data?.item_id || "") : data.item_id,
      shop_id: isShopee ? String(mergedShopee?.shopId || data?.shop_id || "") : data.shop_id,
      stock: isShopee && Number.isFinite(Number(mergedShopee?.stock)) ? Number(mergedShopee.stock) : data.stock,
      rating: isShopee && Number.isFinite(Number(mergedShopee?.rating)) ? Number(mergedShopee.rating) : data.rating,
      reviews_count: isShopee && Number.isFinite(Number(mergedShopee?.reviewsCount))
        ? Number(mergedShopee.reviewsCount)
        : data.reviews_count,
      liked_count: isShopee && Number.isFinite(Number(mergedShopee?.likedCount))
        ? Number(mergedShopee.likedCount)
        : data.liked_count,
      shopee: mergedShopee,
    };
  }

  function hydrateRealtimeWithPageSignals(data, realtime) {
    if (!realtime || typeof realtime !== "object" || data?.marketplaceKey !== "ml" || data?.type !== "product") return realtime;
    const signals = extractMlPageSignals(data);
    const dateCreated = signals.start_time || signals.date_created || signals.dateCreated || "";
    const lastUpdated = signals.stop_time || signals.last_updated || signals.lastUpdated || "";
    const product = realtime.product && typeof realtime.product === "object" ? { ...realtime.product } : {};
    const estimates = realtime.estimates && typeof realtime.estimates === "object" ? { ...realtime.estimates } : {};
    const dataQuality = realtime.data_quality && typeof realtime.data_quality === "object" ? { ...realtime.data_quality } : {};

    if (dateCreated && !product.date_created) {
      product.date_created = dateCreated;
      const ageDays = daysSinceDate(dateCreated);
      if (ageDays != null && !Number(estimates.age_days)) estimates.age_days = ageDays;
      if (!dataQuality.date_created || dataQuality.date_created === "indisponivel") dataQuality.date_created = "page_initial_state_content";
    }
    if (lastUpdated && !product.last_updated) product.last_updated = lastUpdated;
    if (signals.item_id && !product.id) product.id = signals.item_id;

    return {
      ...realtime,
      product,
      estimates,
      data_quality: dataQuality,
    };
  }

  async function refreshRealtimeFromNetwork(data = state.current) {
    if (!isLogged() || !data || data.marketplaceKey !== "ml" || data.type !== "product") return;
    const key = realtimeKey(data);
    const version = state.networkVersion;
    if (!version || (state.lastRealtimeRefreshKey === key && state.lastRealtimeRefreshVersion === version)) return;

    try {
      const realtime = await fetchRealtimeInsights(data, { force: true, warmup: false });
      if (!realtime || location.href !== data.url) return;
      const merged = mergeRealtime({ ...data, realtimeLoading: false, realtimeLoadingText: "" }, realtime);
      state.current = merged;
      state.lastRealtimeRefreshKey = key;
      state.lastRealtimeRefreshVersion = version;
      renderPanel(merged);
      applyPageEnhancements(merged);
      if (state.modalOpen) renderDetailModal(merged);
    } catch {
      state.lastRealtimeRefreshKey = key;
      state.lastRealtimeRefreshVersion = version;
    }
  }

  function scheduleRealtimeRefresh(reason = "") {
    if (!isLogged() || !state.current || state.current.marketplaceKey !== "ml" || state.current.type !== "product") return;
    const key = realtimeKey(state.current);
    if (!state.networkVersion || (state.lastRealtimeRefreshKey === key && state.lastRealtimeRefreshVersion === state.networkVersion)) return;
    clearTimeout(state.pendingRealtimeRefreshTimer);
    state.pendingRealtimeRefreshTimer = setTimeout(() => {
      if (state.realtimeInflight.has(key)) {
        scheduleRealtimeRefresh(reason);
        return;
      }
      refreshRealtimeFromNetwork(state.current);
    }, 850);
  }

  async function waitForRealtimeSlot(key, timeoutMs = 8000) {
    const startedAt = Date.now();
    while (state.realtimeInflight.has(key)) {
      if (Date.now() - startedAt >= timeoutMs) return false;
      await delay(250);
    }
    return true;
  }

  async function fetchRealtimeInsights(data, options = {}) {
    if (!isLogged() || !data) return null;
    const key = realtimeKey(data);
    const force = Boolean(options.force);
    const generateKeywords = Boolean(options.generateKeywords);
    const warmup = options.warmup !== false;
    if (!force && state.realtimeCache.has(key)) return state.realtimeCache.get(key);
    if (state.realtimeInflight.has(key)) return null;

    state.realtimeInflight.add(key);
    try {
      if (warmup && data.marketplaceKey === "ml" && data.type === "product") {
        requestNetworkCache();
        await delay(state.networkEntries.length ? 350 : 850);
      }
      const shopeeSignals = data.marketplaceKey === "shopee" && data.type === "product"
        ? (data.shopee || extractShopeeProductSignals())
        : null;
      const payload = await apiFetch("/api/extension/insights/realtime", {
        method: "POST",
        body: {
          marketplace: data.marketplaceKey,
          page_type: data.type,
          url: location.href,
          title: data.title || "",
          query: getQueryFromUrl(location.href, data.marketplaceKey),
          item_id: data.marketplaceKey === "ml" && data.type === "product"
            ? resolveMlItemId(data)
            : data.marketplaceKey === "shopee" && data.type === "product"
              ? String(shopeeSignals?.itemId || getItemIdFromUrl(location.href, data.marketplaceKey) || "")
              : getItemIdFromUrl(location.href, data.marketplaceKey),
          product_id: data.marketplaceKey === "ml" ? mlProductIdFromUrl(location.href) : "",
          page_signals: data.marketplaceKey === "ml" && data.type === "product"
            ? extractMlPageSignals(data)
            : data.marketplaceKey === "shopee" && data.type === "product"
              ? {
                  item_id: String(shopeeSignals?.itemId || ""),
                  shop_id: String(shopeeSignals?.shopId || ""),
                  sold: shopeeSignals?.sold ?? null,
                  stock: shopeeSignals?.stock ?? null,
                  rating: shopeeSignals?.rating ?? null,
                  reviews_count: shopeeSignals?.reviewsCount ?? null,
                  price: Number.isFinite(Number(data.price)) ? Number(data.price) : null,
                  pix_price: Number.isFinite(Number(shopeeSignals?.pixPrice)) ? Number(shopeeSignals.pixPrice) : null,
                  regular_price: Number.isFinite(Number(shopeeSignals?.regularPrice)) ? Number(shopeeSignals.regularPrice) : null,
                  shipping_min: shopeeSignals?.shippingMin ?? null,
                  shipping_max: shopeeSignals?.shippingMax ?? null,
                  shipping_final: shopeeSignals?.shippingFinal ?? null,
                  delivery_window: shopeeSignals?.deliveryWindow || null,
                  created_at_ts: shopeeSignals?.createdAtTs ?? null,
                  created_at_iso: shopeeSignals?.createdAtIso || "",
                  coupons: Array.isArray(shopeeSignals?.couponPercents) ? shopeeSignals.couponPercents : [],
                  installment: shopeeSignals?.installment || null,
                }
              : {},
          network_entries: realtimeNetworkEntries(),
          account_id: state.accountId || "",
          generate_keywords: generateKeywords,
        },
      });
      const realtime = hydrateRealtimeWithPageSignals(data, payload?.realtime || null);
      state.realtimeCache.set(key, realtime);
      return realtime;
    } catch (error) {
      if (options.throwErrors) throw error;
      return null;
    } finally {
      state.realtimeInflight.delete(key);
    }
  }

  function metric(label, value) {
    return `<div class="dvti-metric"><span>${label}</span><strong>${value || "-"}</strong></div>`;
  }

  function formatNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "-";
    return number.toLocaleString("pt-BR");
  }

  function formatPercent(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "-";
    return `${number.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
  }

  function formatDate(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return "-";
    return date.toLocaleDateString("pt-BR");
  }

  function daysSinceDate(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return null;
    const diff = Date.now() - date.getTime();
    if (!Number.isFinite(diff) || diff < 0) return null;
    return Math.max(1, Math.round(diff / 86400000));
  }

  function positiveAgeDays(realtime, product = {}) {
    const raw = Number(realtime?.estimates?.age_days);
    if (Number.isFinite(raw) && raw > 0) return raw;
    return daysSinceDate(product.date_created);
  }

  function parseSoldNumber(value) {
    return parseCountValue(value);
  }

  function computeSalesVelocity(soldValue, ageDays) {
    const soldCount = parseCountValue(soldValue);
    const age = Number(ageDays || 0);
    if (!Number.isFinite(soldCount) || soldCount <= 0 || !Number.isFinite(age) || age <= 0) {
      return { soldCount: null, salesPerDay: null, projectedMonthly: null };
    }
    const salesPerDay = soldCount / age;
    const projectedMonthly = salesPerDay * 30;
    return {
      soldCount,
      salesPerDay: Number(salesPerDay.toFixed(4)),
      projectedMonthly: Number(projectedMonthly.toFixed(2)),
    };
  }

  function formatSalesPerDayLabel(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return "-";
    return `${number.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}/dia`;
  }

  function formatProjectedMonthlyLabel(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return "-";
    return number.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
  }

  function networkEntryRank(entry) {
    const haystack = `${entry?.url || ""}\n${entry?.body || ""}`;
    let score = 0;
    if (/api\.mercadolibre\.com\/melidata\/tracks/i.test(entry?.url || "")) score += 100;
    if (/[?&]item_id=MLB\d{6,}/i.test(entry?.url || "")) score += 85;
    if (/"item_id"\s*:\s*"MLB\d{6,}"/i.test(haystack)) score += 70;
    if (/"seller_id"\s*:|seller_id=|sellerId/i.test(haystack)) score += 45;
    if (/"sold_quantity"\s*:|"available_quantity"\s*:|"pictures"\s*:|"price"\s*:/i.test(haystack)) score += 35;
    if (/"reviews"\s*:|"available_promotions"\s*:|"shipping"\s*:/i.test(haystack)) score += 25;
    if (/\/(recommendations|items|reviews|visits|questions|p\/api|frontend|pdp|product|adn\/api)\b/i.test(entry?.url || "")) score += 15;
    return score;
  }

  function realtimeNetworkEntries() {
    const rows = state.networkEntries.slice();
    const byPriority = rows
      .filter((entry) => networkEntryRank(entry) > 0)
      .sort((a, b) => networkEntryRank(b) - networkEntryRank(a) || Number(b.captured_at || 0) - Number(a.captured_at || 0));
    const recent = rows.slice(-35).reverse();
    const selected = [];
    const seen = new Set();
    [...byPriority, ...recent].forEach((entry) => {
      if (!entry?.url || !entry?.body) return;
      const key = `${entry.url}|${String(entry.body).slice(0, 160)}`;
      if (seen.has(key)) return;
      seen.add(key);
      selected.push(entry);
    });
    return selected.slice(0, 55).map((entry) => ({
      url: entry.url,
      status: entry.status,
      body: String(entry.body || "").slice(0, 180000),
    }));
  }

  function productDataPoint(label, value, tone = "") {
    return `
      <div class="dvti-product-data ${tone}">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value || "-")}</strong>
      </div>
    `;
  }

  function listingTypeLabel(value) {
    const raw = String(value || "").toLowerCase();
    if (raw.includes("premium")) return "Premium";
    if (raw.includes("gold_special")) return "Classico";
    if (raw.includes("gold")) return "Gold";
    return value || "-";
  }

  function detailAction(title, body, tone = "") {
    return `
      <li class="dvti-detail-action ${tone}">
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(body)}</span>
      </li>
    `;
  }

  function detailTag(label, tone = "") {
    return `<span class="dvti-detail-tag ${tone}">${escapeHtml(label)}</span>`;
  }

  function list(items, className = "") {
    if (!items?.length) return "";
    return `<ul class="dvti-list ${className}">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
  }

  function accountOptionsHtml() {
    if (!state.accounts.length) {
      return `<option value="">Nenhuma conta ML encontrada</option>`;
    }
    return state.accounts
      .map((account) => {
        const selected = String(account.id) === String(state.accountId) ? "selected" : "";
        const disabled = account.has_tokens ? "" : "disabled";
        const label = escapeHtml(account.label || `Conta ${account.id}`);
        const extra = account.has_tokens ? "" : " - sem token";
        return `<option value="${escapeHtml(account.id)}" ${selected} ${disabled}>${label}${extra}</option>`;
      })
      .join("");
  }

  function selectedAccount() {
    return state.accounts.find((account) => String(account.id) === String(state.accountId)) || null;
  }

  function accountMetaText() {
    const account = selectedAccount();
    if (!account) return "Selecione uma conta conectada para enviar rascunho de clonagem.";
    const parts = [
      account.empresa_nome ? `Empresa: ${account.empresa_nome}` : "",
      account.meli_user_id ? `ML user: ${account.meli_user_id}` : "",
      account.has_tokens ? "Conectada" : "Sem token",
    ].filter(Boolean);
    return parts.join(" | ");
  }

  function isLogged() {
    return Boolean(state.token);
  }

  function panelFeedback(message = "", type = "") {
    const root = ensureRoot();
    const node = root.querySelector("[data-role='panel-feedback']");
    const toolNode = root.querySelector("[data-role='tool-feedback']");
    if (node) {
      node.textContent = message;
      node.className = `dvti-feedback ${type}`.trim();
    }
    if (toolNode) {
      toolNode.textContent = message;
      toolNode.className = `dvti-feedback ${type}`.trim();
    }
  }

  function drawerFeedback(message = "", type = "") {
    const root = ensureRoot();
    const node = root.querySelector("[data-role='drawer-feedback']");
    if (!node) return;
    node.textContent = message;
    node.className = `dvti-feedback ${type}`.trim();
  }

  function renderDetailModal(data = state.current) {
    const root = ensureRoot();
    const body = root.querySelector(".dvti-detail-body");
    if (!body) return;
    if (!data) {
      body.innerHTML = `
        <h3>Nenhum dado para detalhar</h3>
        <p>Abra uma busca ou anuncio para gerar dados completos.</p>
      `;
      return;
    }

    const realtime = data.realtime || {};
    const product = realtime.product || {};
    const seller = realtime.seller || {};
    const search = realtime.search || {};
    const isShopee = data.marketplaceKey === "shopee";
    const shopeeBasePrice = isShopee
      ? Number(data?.shopee?.saleBasePrice || data?.shopee?.regularPrice || product?.price || data?.price || 0)
      : 0;
    const shopeeSignals = isShopee
      ? {
          ...(data.shopee || {}),
          estimatedFees: computeShopeeEstimatedFees(shopeeBasePrice)
            || data?.shopee?.estimatedFees
            || realtime?.fees
            || null,
          subsidies: computeShopeeSubsidyBenefits({
            salePrice: shopeeBasePrice,
            regularPrice: Number(data?.shopee?.regularPrice || 0),
            pixPrice: Number(data?.shopee?.pixPrice || 0),
            shippingMin: Number(data?.shopee?.shippingMin || 0),
          }),
        }
      : {};
    const fallbackKeywords = buildKeywordInsights(data);
    const rankedKeywords = !isShopee && Array.isArray(realtime?.keywords?.ranked) && realtime.keywords.ranked.length
      ? realtime.keywords.ranked
      : fallbackKeywords.ranked;
    const suggestedKeywords = !isShopee && Array.isArray(realtime?.keywords?.suggestions) && realtime.keywords.suggestions.length
      ? realtime.keywords.suggestions
      : fallbackKeywords.longTail;
    const attributes = Array.isArray(product.attributes) && product.attributes.length
      ? product.attributes
      : (Array.isArray(data.attributes) ? data.attributes.map((value) => ({ name: value, value: "" })) : []);
    const price = Number.isFinite(Number(product.price)) ? Number(product.price) : Number(data.price);
    const originalPrice = Number(product.original_price || 0);
    const discount = originalPrice > 0 && price > 0 ? ((originalPrice - price) / originalPrice) * 100 : null;
    const picturesCount = Number(data.pictures || product.pictures || 0);
    const pictureTarget = data.marketplaceKey === "ml" ? 8 : 6;
    const missingPictures = Math.max(0, pictureTarget - picturesCount);
    const titleLength = text(data.title).length;
    const realtimeSold = parseCountValue(isShopee ? (product.historical_sold ?? product.sold) : product.sold_quantity);
    const soldFallback = parseCountValue(data.sold);
    const sold = Number.isFinite(realtimeSold) && realtimeSold > 0
      ? realtimeSold
      : soldFallback != null ? soldFallback : data.sold;
    const monthlyProjection = realtime?.estimates?.monthly_sales_projection;
    const shopeeCreatedIso = epochToIso(product?.ctime) || String(shopeeSignals?.createdAtIso || "");
    const ageDays = isShopee ? daysSinceDate(shopeeCreatedIso) : positiveAgeDays(realtime, product);
    const salesVelocity = computeSalesVelocity(sold, ageDays);
    const salesPerDayLabel = formatSalesPerDayLabel(salesVelocity.salesPerDay);
    const projectedMonthlySales = salesVelocity.projectedMonthly != null
      ? salesVelocity.projectedMonthly
      : (monthlyProjection != null ? Number(monthlyProjection) : null);
    const createdMetricLabel = isShopee ? formatDate(shopeeCreatedIso) : formatDate(product.date_created);
    const shopeeItemId = String(shopeeSignals.itemId || data.item_id || extractShopeeIdsFromUrl(data.url).itemId || "");
    const shopeeShopId = String(shopeeSignals.shopId || data.shop_id || extractShopeeIdsFromUrl(data.url).shopId || "");
    const itemId = isShopee
      ? [shopeeShopId, shopeeItemId].filter(Boolean).join(" / ")
      : product.id || getItemIdFromUrl(data.url, data.marketplaceKey);
    const category = isShopee
      ? shopeeSignals.categoryPath || product.category_path || product.category_name || product.category_id || shopeeSignals.catId || "-"
      : product.category_path || product.category_name || product.category_id || search.category_id || "-";
    const sellerLocation = isShopee
      ? text(shopeeSignals.shopLocation || data.shop_location || "")
      : [seller.city, seller.state].filter(Boolean).join(" / ");
    const shopeeReviewsCount = Number(product?.reviews?.count || product?.cmt_count || data.reviews_count || shopeeSignals.reviewsCount || 0);
    const shopeeRatingValue = Number(product?.reviews?.rate || product?.rating_star || data.rating || shopeeSignals.rating || 0);
    const sellerReputation = isShopee
      ? [
          shopeeRatingValue > 0 ? `Nota ${String(shopeeRatingValue).replace(".", ",")}` : "",
          shopeeReviewsCount > 0 ? `${formatNumber(shopeeReviewsCount)} avaliacoes` : "",
        ].filter(Boolean).join(" • ")
      : [seller.level_id, seller.power_seller_status].filter(Boolean).join(" • ");
    const topKeyword = rankedKeywords[0] || null;
    const productReviews = isShopee
      ? { count: shopeeReviewsCount, rate: shopeeRatingValue, pictures_quantity: 0, with_comment: 0 }
      : (product.reviews || {});
    const promotions = isShopee
      ? (Array.isArray(shopeeSignals.couponPercents) ? shopeeSignals.couponPercents : [])
      : (Array.isArray(product.promotions) ? product.promotions : []);
    const youMayAlsoLikeItems = isShopee ? extractShopeeYouMayAlsoLikeItems(80) : [];
    const youMayAlsoLikePrices = youMayAlsoLikeItems.map((row) => Number(row.price)).filter((value) => Number.isFinite(value) && value > 0);
    const youMayLikeAvg = youMayAlsoLikePrices.length
      ? youMayAlsoLikePrices.reduce((sum, value) => sum + value, 0) / youMayAlsoLikePrices.length
      : null;
    const idealTitleMin = isShopee ? 80 : 45;
    const idealTitleMax = isShopee ? 100 : 90;
    const pricePosition = isShopee && Number.isFinite(youMayLikeAvg) && Number.isFinite(price)
      ? (price > youMayLikeAvg ? `Acima da media (${formatMoney(youMayLikeAvg)})` : price < youMayLikeAvg ? `Abaixo da media (${formatMoney(youMayLikeAvg)})` : `Na media (${formatMoney(youMayLikeAvg)})`)
      : data.type === "search" && Number.isFinite(data.avg)
      ? price > data.avg ? "Acima da media visivel" : price < data.avg ? "Abaixo da media visivel" : "Na media visivel"
      : discount ? `${formatPercent(discount)} abaixo do preco original` : "Sem comparativo direto";
    const realtimeBusy = Boolean(data.realtimeLoading);
    const itemIdLabel = isShopee ? "Shop / Item" : "MLB / ID";
    const stockMetricValue = isShopee
      ? Number.isFinite(Number(shopeeSignals.stock ?? data.stock)) ? formatNumber(Number(shopeeSignals.stock ?? data.stock)) : "-"
      : product.available_quantity != null ? formatNumber(product.available_quantity) : "-";
    const shopeeShippingValue = Number.isFinite(Number(shopeeSignals.shippingFinal))
      ? Number(shopeeSignals.shippingFinal)
      : Number.isFinite(Number(shopeeSignals.shippingMin))
        ? Number(shopeeSignals.shippingMin)
        : null;
    const shopeeShippingLabel = Number.isFinite(shopeeShippingValue)
      ? formatMoney(shopeeShippingValue)
      : data.shipping ? "Visivel" : "Nao lido";
    const shippingMetricValue = isShopee
      ? shopeeShippingLabel
      : product.shipping_free ? "Gratis" : data.shipping ? "Visivel" : "Nao lido";
    const hasShippingSignal = Boolean(data.shipping || product.shipping_free || (isShopee && Number.isFinite(shopeeShippingValue)));
    const shopeeDelivery = shopeeSignals.deliveryWindow || null;
    const logisticsMetricValue = isShopee
      ? (shopeeDelivery?.corridos || shopeeDelivery?.uteis
        ? `${Number(shopeeDelivery?.corridos || 0) > 0 ? `${formatNumber(Number(shopeeDelivery.corridos))} dias corridos` : "-"}${Number(shopeeDelivery?.uteis || 0) > 0 ? ` / ${formatNumber(Number(shopeeDelivery.uteis))} dias uteis` : ""}`
        : shopeeSignals.estimatedDays ? `Ate ${formatNumber(shopeeSignals.estimatedDays)} dia(s)` : "-")
      : product.logistic_type || product.shipping_mode || "-";
    const listingMetricValue = isShopee ? product.item_status || "shopee" : product.listing_type_id || "-";
    const catalogMetricValue = isShopee
      ? Number(shopeeSignals.modelCount || 0) > 0
        ? `Modelos: ${formatNumber(Number(shopeeSignals.modelCount || 0))}`
        : Number(shopeeSignals.variationCount || 0) > 0
          ? `Variacoes: ${formatNumber(Number(shopeeSignals.variationCount || 0))}`
          : "-"
      : product.catalog_listing ? "Sim" : "Nao";
    const reviewsMetricValue = isShopee
      ? productReviews.count ? `${formatNumber(productReviews.count)} total` : "-"
      : productReviews.count ? `${formatNumber(productReviews.count)} (${formatNumber(productReviews.with_comment || 0)} comentarios)` : "-";
    const ratingMetricValue = productReviews.rate ? String(productReviews.rate).replace(".", ",") : "-";
    const promotionsMetricValue = promotions.length ? `${formatNumber(promotions.length)} ativa(s)` : "-";
    const shopeeFeeValue = isShopee ? Number(shopeeSignals?.estimatedFees?.sale_fee || 0) : 0;
    const shopeeFeePercent = isShopee && shopeeBasePrice > 0 && shopeeFeeValue > 0 ? (shopeeFeeValue / shopeeBasePrice) * 100 : 0;
    const shopeeCommissionRule = isShopee ? shopeeCommissionRuleForPrice(shopeeBasePrice) : null;
    const shopeeReceiveBase = isShopee && shopeeBasePrice > 0 ? shopeeBasePrice - shopeeFeeValue : null;
    const shopeeReceiveWithSubsidy = isShopee && shopeeReceiveBase != null
      ? shopeeReceiveBase + Number(shopeeSignals?.subsidies?.freightSubsidyAmount || 0)
      : null;
    const shopeeClipCount = Number(shopeeSignals?.clipCount || data?.clip_count || 0);
    const shopeeReviewVideoCount = Number(shopeeSignals?.reviewVideoCount || data?.review_video_count || data?.video_count || 0);
    const shopeePixRebateLabel = Number(shopeeSignals?.subsidies?.pixDiscountAmount || 0) > 0
      ? `${formatMoney(Number(shopeeSignals.subsidies.pixDiscountAmount))}${Number(shopeeSignals?.subsidies?.pixDiscountRate || 0) > 0 ? ` (${formatPercent(Number(shopeeSignals.subsidies.pixDiscountRate))})` : ""}`
      : "-";
    const shopeeFreightSubsidyLabel = Number(shopeeSignals?.subsidies?.freightSubsidyAmount || 0) > 0
      ? `${formatMoney(Number(shopeeSignals.subsidies.freightSubsidyAmount))} (ate ${formatMoney(Number(shopeeSignals?.subsidies?.freightCap || 0))})`
      : `ate ${formatMoney(Number(shopeeSignals?.subsidies?.freightCap || 0))}`;
    const sellerGridMetrics = isShopee
      ? `
          ${metric("Nome", escapeHtml(seller.nickname || data.seller || "-"))}
          ${metric("Local", escapeHtml(sellerLocation || "-"))}
          ${metric("Avaliacoes", shopeeReviewsCount > 0 ? formatNumber(shopeeReviewsCount) : "-")}
          ${metric("Shop ID", escapeHtml(shopeeShopId || "-"))}
        `
      : `
          ${metric("Nome", escapeHtml(seller.nickname || data.seller || "-"))}
          ${metric("Local", escapeHtml(sellerLocation || "-"))}
          ${metric("Reputacao", escapeHtml(sellerReputation || "-"))}
          ${metric("Power seller", escapeHtml(seller.power_seller_status || "-"))}
          ${metric("Loja oficial", seller.official_store_id ? `#${escapeHtml(seller.official_store_id)}` : "-")}
          ${metric("Transacoes", seller.transactions_completed != null ? formatNumber(seller.transactions_completed) : "-")}
          ${metric("Total historico", seller.transactions_total != null ? formatNumber(seller.transactions_total) : "-")}
          ${metric("Reclamacoes", seller.claims_rate != null ? formatPercent(Number(seller.claims_rate) * 100) : "-")}
          ${metric("Atrasos", seller.delayed_handling_time_rate != null ? formatPercent(Number(seller.delayed_handling_time_rate) * 100) : "-")}
          ${metric("Cancelamentos", seller.cancellations_rate != null ? formatPercent(Number(seller.cancellations_rate) * 100) : "-")}
          ${metric("Conta", escapeHtml(String(seller.id || "-")))}
        `;

    const actions = [];
    if (titleLength < idealTitleMin) {
      actions.push(detailAction("Titulo curto", "Aumente o titulo com termos de busca, caracteristicas e variacao principal.", "warn"));
    } else if (titleLength > idealTitleMax) {
      actions.push(detailAction("Titulo longo", "Revise excesso de palavras para manter leitura clara nos cards de busca.", "warn"));
    } else {
      actions.push(detailAction("Titulo em bom tamanho", isShopee ? "O titulo esta no intervalo ideal da Shopee (80-100)." : "O titulo tem boa extensao para leitura e indexacao.", "ok"));
    }
    if (missingPictures > 0) {
      actions.push(detailAction("Reforcar fotos", `Adicione pelo menos mais ${missingPictures} foto(s). Objetivo operacional: ${pictureTarget}+ imagens.`, "warn"));
    } else {
      actions.push(detailAction("Galeria forte", "Quantidade de fotos acima do alvo minimo operacional.", "ok"));
    }
    if (!hasShippingSignal) {
      actions.push(detailAction("Frete pouco claro", "O frete nao apareceu na primeira leitura. Confira se a promessa de entrega esta evidente.", "warn"));
    }
    if (!attributes.length) {
      actions.push(detailAction("Atributos invisiveis", "Poucos atributos foram lidos na pagina. Valide ficha tecnica, variacoes e especificacoes.", "warn"));
    }
    if (topKeyword?.level === "high") {
      actions.push(detailAction("Concorrencia alta", `O termo "${topKeyword.term}" parece disputado. Use cauda longa para diferenciar.`, "bad"));
    } else if (topKeyword?.term) {
      actions.push(detailAction("Termo aproveitavel", `O termo "${topKeyword.term}" pode ajudar no posicionamento do anuncio.`, "ok"));
    }
    if (!actions.length) {
      actions.push(detailAction("Sem alerta critico", "A leitura atual nao encontrou gargalo evidente no HTML carregado.", "ok"));
    }

    const keywordRows = rankedKeywords.length
      ? rankedKeywords
          .slice(0, 12)
          .map(
            (row) => `
            <li class="${escapeHtml(row.level || "unknown")}">
              <span>${escapeHtml(row.term || "-")}</span>
              <strong>${escapeHtml(row.label || "-")}</strong>
              <em>${row.total != null ? `${Number(row.total).toLocaleString("pt-BR")} anuncios` : "sem total"}</em>
            </li>`,
          )
          .join("")
      : "<li><span>Sem termos ranqueados</span><strong>-</strong><em>-</em></li>";

    const generatedRows = suggestedKeywords.length
      ? suggestedKeywords.slice(0, 10).map((term) => `<li>${escapeHtml(term)}</li>`).join("")
      : "<li>Sem sugestoes geradas</li>";

    const attributeRows = attributes.length
      ? attributes
          .slice(0, 10)
          .map((row) => {
            const label = row.name || row.id || row;
            const value = row.value || row.value_name || "";
            return `<li><span>${escapeHtml(label)}</span>${value ? `<strong>${escapeHtml(value)}</strong>` : ""}</li>`;
          })
          .join("")
      : `<li><span>Nenhum atributo tecnico lido</span><strong>Revise na pagina do ${isShopee ? "Shopee" : "Mercado Livre"}</strong></li>`;

    body.innerHTML = `
      <div class="dvti-detail-head">
        <h3>${escapeHtml(data.title || "Detalhamento")}</h3>
        <span>${escapeHtml(data.marketplace || "-")} • ${escapeHtml(data.type || "-")}</span>
      </div>

      <section class="dvti-detail-hero ${scoreClass(data.score)}">
        <div>
          <span class="dvti-detail-eyebrow">Diagnostico DACHBYTE Seller</span>
          <h4>${data.score >= 80 ? "Anuncio competitivo, mas ainda da para lapidar." : data.score >= 55 ? "Anuncio com base boa e pontos claros de ajuste." : "Anuncio precisa de revisao antes de escalar."}</h4>
          <p>Leitura combinando HTML da pagina, dados publicos do marketplace e sinais comerciais disponiveis no momento.</p>
          <div class="dvti-detail-tags">
            ${detailTag(`${picturesCount} fotos`, missingPictures ? "warn" : "ok")}
            ${detailTag(titleLength ? `${titleLength} caracteres no titulo` : "titulo nao lido", titleLength >= idealTitleMin && titleLength <= idealTitleMax ? "ok" : "warn")}
            ${detailTag(hasShippingSignal ? "frete visivel" : "frete nao lido", hasShippingSignal ? "ok" : "warn")}
            ${topKeyword ? detailTag(topKeyword.label || "termo lido", topKeyword.level || "") : detailTag("sem tendencia externa", "warn")}
          </div>
        </div>
        <div class="dvti-detail-score">
          <span>Score</span>
          <strong>${formatNumber(data.score)}</strong>
          <em>${scoreClass(data.score) === "good" ? "forte" : scoreClass(data.score) === "warn" ? "atenção" : "critico"}</em>
        </div>
      </section>

      <section class="dvti-detail-section">
        <h4>O que fazer agora</h4>
        <ul class="dvti-detail-actions">${actions.slice(0, 6).join("")}</ul>
      </section>

      <section class="dvti-detail-section">
        <h4>Resumo comercial</h4>
        <div class="dvti-detail-grid">
          ${metric("Score", data.score != null ? String(data.score) : "-")}
          ${metric("Preco atual", formatMoney(price))}
          ${metric("Vendidos", escapeHtml(String(sold || "-")))}
          ${metric("Vende a cada", salesPerDayLabel)}
          ${metric("Estoque", stockMetricValue)}
          ${metric("Fotos", `${picturesCount}/${pictureTarget}+`)}
          ${metric("Frete", shippingMetricValue)}
          ${metric(isShopee ? "Prazo/Frete" : "Logistica", escapeHtml(logisticsMetricValue))}
          ${!isShopee ? metric("Tipo de anuncio", escapeHtml(listingMetricValue)) : ""}
          ${metric(isShopee ? "Modelos/variacoes" : "Catalogo", escapeHtml(catalogMetricValue))}
          ${metric(isShopee ? "Cat / Dominio" : "Dominio", escapeHtml(shortText(isShopee ? String(shopeeSignals.catId || "-") : (product.domain_id || "-"), 28)))}
          ${metric("Avaliacoes", reviewsMetricValue)}
          ${metric("Nota", ratingMetricValue)}
          ${isShopee ? metric("Comissao Shopee", shopeeFeeValue > 0 ? `${shopeeCommissionRule?.label || "-"} = ${formatMoney(shopeeFeeValue)}${shopeeFeePercent > 0 ? ` (${formatPercent(shopeeFeePercent)})` : ""}` : "-") : ""}
          ${isShopee ? metric("Clip (grade)", shopeeClipCount > 0 ? formatNumber(shopeeClipCount) : "-") : ""}
          ${isShopee ? metric("Video (avaliacoes)", shopeeReviewVideoCount > 0 ? formatNumber(shopeeReviewVideoCount) : "-") : ""}
          ${isShopee ? metric("Rebate Pix", shopeePixRebateLabel) : ""}
          ${isShopee ? metric("Subsidio frete", shopeeFreightSubsidyLabel) : ""}
          ${isShopee ? metric("Recebe estimado", shopeeReceiveWithSubsidy != null ? formatMoney(shopeeReceiveWithSubsidy) : "-") : ""}
          ${isShopee ? "" : metric("Promocoes", promotionsMetricValue)}
          ${metric("Categoria", escapeHtml(shortText(category, 28)))}
          ${metric(itemIdLabel, escapeHtml(itemId || "-"))}
          ${isShopee ? metric("Criado em", createdMetricLabel !== "-" ? createdMetricLabel : "Nao identificado") : ""}
          ${metric("Idade do anuncio", ageDays != null ? `${formatNumber(ageDays)} dias` : "-")}
          ${metric("Proj. vendas/mes", projectedMonthlySales != null ? formatProjectedMonthlyLabel(projectedMonthlySales) : "-")}
          ${metric("Posicao de preco", escapeHtml(pricePosition))}
        </div>
      </section>

      <section class="dvti-detail-section">
        <h4>Dados do vendedor</h4>
        <div class="dvti-detail-grid">
          ${sellerGridMetrics}
        </div>
      </section>

      <section class="dvti-detail-section">
        <h4>Fotos, conteudo e ficha tecnica</h4>
        <div class="dvti-detail-two">
          <div>
            <p class="dvti-detail-copy">${missingPictures ? `Galeria abaixo do alvo operacional. Priorize fotos de uso, detalhe, medidas, embalagem e comparativo.` : "Galeria acima do alvo operacional. Mantenha padrao visual e imagens informativas."}</p>
            <div class="dvti-picture-meter"><span style="width:${Math.min(100, (picturesCount / pictureTarget) * 100)}%"></span></div>
          </div>
          <ul class="dvti-attr-list">${attributeRows}</ul>
        </div>
      </section>

      <section class="dvti-detail-section">
        <h4>Palavras chave dos concorrentes</h4>
        <ul class="dvti-detail-keywords">${keywordRows}</ul>
      </section>
      ${realtimeBusy ? `<div class="dvti-loading-row"><span class="dvti-spinner"></span>${escapeHtml(data.realtimeLoadingText || defaultRealtimeLoadingText(data.marketplaceKey))}</div>` : ""}

      <section class="dvti-detail-section">
        <h4>Sugestoes de cauda longa</h4>
        <ul class="dvti-detail-generated">${generatedRows}</ul>
      </section>
    `;
  }

  function toolLabel(tool) {
    const labels = {
      market: "Mercado",
      keywords: "Palavras chave",
      ean: "EAN-13",
      clone: "Clonar anuncio",
    };
    return labels[tool] || "DACHBYTE Seller";
  }

  function toolShell(title, subtitle, content, tone = "") {
    return `
      <div class="dvti-tool-hero ${tone}">
        <div>
          <span>DACHBYTE Seller</span>
          <h3>${escapeHtml(title)}</h3>
          <p>${escapeHtml(subtitle)}</p>
        </div>
      </div>
      ${content}
      <p class="dvti-feedback" data-role="tool-feedback"></p>
    `;
  }

  function renderMarketTool(data = state.current) {
    if (!data) {
      return toolShell("Mercado", "Abra um anuncio ou uma busca para montar a leitura de concorrencia.", `
        <div class="dvti-tool-empty">Nenhuma pagina compativel detectada agora.</div>
      `, "warn");
    }

    const realtime = data.realtime || {};
    const product = realtime.product || {};
    const estimates = realtime.estimates || {};
    const isSearch = data.type === "search";
    const isShopee = data.marketplaceKey === "shopee";
    const marketplaceName = marketplaceNameByKey(data.marketplaceKey);
    const analysis = state.marketAnalysis;
    const basePrice = isShopee
      ? Number(data?.shopee?.saleBasePrice || data?.shopee?.regularPrice || product.price || data.price || 0)
      : Number(product.price || data.price || 0);
    const shopeeFees = isShopee
      ? (computeShopeeEstimatedFees(basePrice) || data?.shopee?.estimatedFees || realtime?.fees || null)
      : null;
    const shopeeSubsidies = isShopee
      ? computeShopeeSubsidyBenefits({
          salePrice: basePrice,
          regularPrice: Number(data?.shopee?.regularPrice || 0),
          pixPrice: Number(data?.shopee?.pixPrice || 0),
          shippingMin: Number(data?.shopee?.shippingMin || 0),
        })
      : null;
    const shopeeCommissionRule = isShopee ? shopeeCommissionRuleForPrice(basePrice) : null;
    const saleFeeValue = isShopee ? Number(shopeeFees?.sale_fee || 0) : Number(product.sale_fee || 0);
    const hasSaleFee = Number.isFinite(saleFeeValue) && saleFeeValue >= 0;
    const netAmountValue = isShopee
      ? (Number.isFinite(basePrice) && hasSaleFee ? (basePrice - saleFeeValue + Number(shopeeSubsidies?.freightSubsidyAmount || 0)) : null)
      : (product.net_amount != null ? Number(product.net_amount) : null);
    const shopeeClipCount = Number(data?.clip_count || data?.shopee?.clipCount || 0);
    const shopeeReviewVideoCount = Number(data?.review_video_count || data?.shopee?.reviewVideoCount || data?.video_count || data?.shopee?.videoCount || 0);
    const soldForVelocity = isShopee
      ? (product.historical_sold ?? product.sold ?? data.sold)
      : (product.sold_quantity ?? data.sold);
    const createdIsoForVelocity = isShopee
      ? (epochToIso(product?.ctime) || String(data?.shopee?.createdAtIso || ""))
      : (product.date_created || "");
    const ageDaysForVelocity = isShopee
      ? daysSinceDate(createdIsoForVelocity)
      : positiveAgeDays(realtime, product);
    const velocity = computeSalesVelocity(soldForVelocity, ageDaysForVelocity);
    const velocityPerDayLabel = formatSalesPerDayLabel(velocity.salesPerDay);
    const projectedMonthlyLabel = formatProjectedMonthlyLabel(velocity.projectedMonthly);
    const effectiveRate = isShopee && shopeeFees?.effective_rate != null ? formatPercent(Number(shopeeFees.effective_rate)) : "-";
    const content = isSearch
      ? `
        ${renderMarketPanel(analysis, data)}
        <div class="dvti-tool-actions">
          <button class="dvti-action dvti-primary" data-action="analyze-market">${analysis?.loading ? "Analisando..." : "Analisar mercado"}</button>
          <button class="dvti-action" data-action="refresh">Atualizar pagina</button>
        </div>
      `
      : `
        <div class="dvti-tool-grid">
          ${metric("Visitas", estimates.visits != null ? formatNumber(estimates.visits) : "-")}
          ${metric("Conversao", estimates.conversion_rate != null ? formatPercent(estimates.conversion_rate) : "-")}
          ${metric("Vende a cada", velocityPerDayLabel)}
          ${metric("Vendidos", product.sold_quantity != null ? formatNumber(product.sold_quantity) : product.historical_sold != null ? formatNumber(product.historical_sold) : data.sold || "-")}
          ${metric("Proj. vendas/mes", projectedMonthlyLabel)}
          ${metric("Preco atual", formatMoney(Number(data?.shopee?.pixPrice || product.price || data.price)))}
          ${isShopee ? metric("Preco normal", basePrice > 0 ? formatMoney(basePrice) : "-") : ""}
          ${metric(isShopee ? "Recebe estimado" : "Recebe", netAmountValue != null ? formatMoney(netAmountValue) : "-")}
          ${metric(isShopee ? "Comissao Shopee" : "Comissao ML", hasSaleFee ? (isShopee ? `${shopeeCommissionRule?.label || "-"} = ${formatMoney(saleFeeValue)}` : formatMoney(saleFeeValue)) : "-")}
          ${isShopee ? metric("Clip (grade)", shopeeClipCount > 0 ? formatNumber(shopeeClipCount) : "-") : ""}
          ${isShopee ? metric("Video (avaliacoes)", shopeeReviewVideoCount > 0 ? formatNumber(shopeeReviewVideoCount) : "-") : ""}
          ${isShopee ? metric("Rebate Pix", Number(shopeeSubsidies?.pixDiscountAmount || 0) > 0 ? formatMoney(Number(shopeeSubsidies.pixDiscountAmount)) : "-") : ""}
          ${isShopee ? metric("Subsidio frete", Number(shopeeSubsidies?.freightSubsidyAmount || 0) > 0 ? `${formatMoney(Number(shopeeSubsidies.freightSubsidyAmount))} (ate ${formatMoney(Number(shopeeSubsidies?.freightCap || 0))})` : `ate ${formatMoney(Number(shopeeSubsidies?.freightCap || 0))}`) : ""}
          ${isShopee ? metric("Taxa efetiva", effectiveRate) : ""}
          ${metric("Recomendacao", escapeHtml(product.price_recommendation || realtime?.recommendation || "-"))}
        </div>
        <div class="dvti-tool-note">
          <strong>Leitura do anuncio atual</strong>
          <span>Para comparar com concorrentes em lote, abra uma busca do ${escapeHtml(marketplaceName)} e use esta mesma tela.</span>
        </div>
        <div class="dvti-tool-actions">
          <button class="dvti-action dvti-primary" data-action="open-ml-search">${isShopee ? "Buscar titulo na Shopee" : "Buscar titulo no ML"}</button>
          ${isShopee ? `<button class="dvti-action" data-action="download-media">Baixar midia ZIP</button>` : ""}
          <button class="dvti-action" data-action="refresh">Atualizar dados</button>
        </div>
      `;

    return toolShell(
      "Mercado",
      isSearch
        ? `Concorrencia, precos e termos dos cards de busca no ${marketplaceName}.`
        : `Sinais comerciais do anuncio no ${marketplaceName} e caminho rapido para comparar concorrentes.`,
      content,
      "market",
    );
  }

  function renderKeywordsTool(data = state.current) {
    if (!data) {
      return toolShell("Palavras chave", "Abra um anuncio do Mercado Livre para gerar termos dos concorrentes.", `
        <div class="dvti-tool-empty">Nenhum anuncio detectado.</div>
      `, "warn");
    }
    if (data.marketplaceKey !== "ml") {
      return toolShell("Palavras chave", "Esta ferramenta usa varredura do Mercado Livre para ranquear termos.", `
        <div class="dvti-tool-empty">No momento, a geracao automatica funciona apenas com anuncios do Mercado Livre.</div>
        <div class="dvti-tool-actions">
          <button class="dvti-action dvti-primary" data-action="open-ml-search">Buscar este titulo no ML</button>
          <button class="dvti-action" data-action="refresh">Atualizar leitura</button>
        </div>
      `, "warn");
    }

    const realtime = data.realtime || {};
    const key = realtimeKey(data);
    const busy = state.generatingKeywords && state.generatedKeywordsKey === key;
    const keywordMode = realtime?.data_quality?.keywords || "";
    const generated = keywordMode === "busca_ml_titulos_ate_pagina_5" || keywordMode === "busca_ml_sem_ocorrencias_suficientes";
    const hasSearchRanking = keywordMode === "busca_ml_titulos_ate_pagina_5";
    const ranked = hasSearchRanking && Array.isArray(realtime?.keywords?.ranked)
      ? realtime.keywords.ranked.slice(0, 30)
      : [];
    const suggestions = hasSearchRanking && Array.isArray(realtime?.keywords?.suggestions) && realtime.keywords.suggestions.length
      ? realtime.keywords.suggestions
      : [];
    const keywordSearch = realtime?.data_quality?.keyword_search || {};
    const pageSize = 15;
    const totalPages = Math.max(1, Math.ceil(ranked.length / pageSize));
    const storedPage = state.keywordPageByKey.get(key) || state.keywordPage || 1;
    const page = Math.min(Math.max(1, Number(storedPage || 1)), totalPages);
    state.keywordPage = page;
    state.keywordPageByKey.set(key, page);
    const maxTotal = ranked.reduce((max, row) => Math.max(max, Number(row?.total || row?.occurrence_count || 0)), 0) || 1;
    const pageRows = ranked.slice((page - 1) * pageSize, page * pageSize);
    const rows = pageRows.map((row, index) => {
      const total = Number(row?.total || row?.occurrence_count || 0);
      const score = Math.max(1, Math.min(100, Number(row?.score || Math.round((total / maxTotal) * 100) || 0)));
      const absoluteIndex = (page - 1) * pageSize + index + 1;
      return `
      <li class="${escapeHtml(row.level || "unknown")}">
        <strong>${absoluteIndex}</strong>
        <div class="dvti-keyword-rank-main">
          <span>${escapeHtml(row.term || "-")}</span>
          <small>${total ? `${formatNumber(total)} ocorrencia${total === 1 ? "" : "s"}` : escapeHtml(row.label || "Sem total")}</small>
          <div class="dvti-keyword-progress"><i style="width:${score}%"></i></div>
        </div>
        <em>${score}/100</em>
      </li>
    `;
    }).join("");
    const suggestionRows = suggestions.slice(0, 8).map((term) => `<button type="button" data-action="copy-keyword" data-keyword="${escapeHtml(term)}">${escapeHtml(term)}</button>`).join("");
    const pager = generated && ranked.length
      ? `
        <div class="dvti-keyword-pager">
          <button type="button" data-action="keyword-page-prev" ${page <= 1 ? "disabled" : ""}>Anterior</button>
          <span>Pagina ${page} de ${totalPages} · ${formatNumber(ranked.length)} palavras</span>
          <button type="button" data-action="keyword-page-next" ${page >= totalPages ? "disabled" : ""}>Proxima</button>
        </div>
      `
      : "";
    const emptyState = generated && !ranked.length
      ? `<div class="dvti-tool-empty">Nao encontrei ocorrencias suficientes nas buscas do Mercado Livre. Tente gerar novamente ou use uma busca mais ampla pelo titulo.</div>`
      : !generated && !busy
        ? `<div class="dvti-tool-empty">Clique em gerar para varrer ate 5 paginas de busca pelo titulo do produto e rankear as ocorrencias.</div>`
        : "";
    const diagnostics = generated && !busy
      ? `
        <div class="dvti-keyword-diagnostics">
          <span>${formatNumber(keywordSearch.sampled_titles || 0)} titulos analisados</span>
          <span>${formatNumber(keywordSearch.fetched_pages || 0)} leituras de busca</span>
          <span>${formatNumber(keywordSearch.unique_pages || keywordSearch.fetched_pages || 0)} paginas unicas</span>
          <span>IA: ${escapeHtml(realtime?.data_quality?.keyword_ai === "mistral" || realtime?.data_quality?.keyword_ai === "mistral_cache" ? "Mistral" : "fallback local")}</span>
          <span>${formatNumber(ranked.length)}/30 palavras ranqueadas</span>
        </div>
      `
      : "";
    const loadingCard = busy
      ? `
        <div class="dvti-keyword-loading-card">
          <div class="dvti-keyword-loading-brand">
            <img src="${BRAND_ICON_URL}" alt="DACHBYTE Seller" />
            <div>
              <strong>Palavras chave DACHBYTE Seller</strong>
              <span>Mercado Livre em tempo real</span>
            </div>
          </div>
          <div class="dvti-keyword-loading-copy">
            <span class="dvti-spinner"></span>
            <div>
              <strong>Coletando titulos dos concorrentes...</strong>
              <em>Varrendo ate 5 paginas e refinando termos redundantes quando a IA estiver disponivel.</em>
            </div>
          </div>
          <div class="dvti-keyword-loading-tags">
            <span>Busca ativa</span>
            <span>Ate 30 palavras</span>
            <span>Curadoria IA opcional</span>
          </div>
        </div>
      `
      : "";

    return toolShell("Palavras chave", "Gere e copie termos relevantes usados por anuncios parecidos.", `
      <div class="dvti-tool-actions">
        <button class="dvti-action dvti-primary" data-action="generate-keywords" ${busy ? "disabled" : ""}>
          ${busy ? `<span class="dvti-spinner"></span> Varrendo ate 5 paginas...` : "Gerar palavras chave"}
        </button>
        <button class="dvti-action" data-action="refresh">Atualizar leitura</button>
      </div>
      ${loadingCard}
      ${diagnostics}
      ${emptyState}
      ${!busy && rows ? `<ul class="dvti-tool-keywords">${rows}</ul>${pager}` : ""}
      ${!busy && suggestionRows ? `<h4 class="dvti-tool-subtitle">Sugestoes rapidas</h4><div class="dvti-tool-chips">${suggestionRows}</div>` : ""}
    `, "keywords");
  }

  function renderEanTool() {
    if (!state.eanValue) state.eanValue = generateEan13();
    return toolShell("EAN-13", "Gere um codigo e copie sem mexer nos campos do Mercado Livre.", `
      <div class="dvti-ean-display">${escapeHtml(state.eanValue)}</div>
      <div class="dvti-tool-actions">
        <button class="dvti-action dvti-primary" data-action="copy-ean">Copiar</button>
        <button class="dvti-action" data-action="new-ean">Gerar outro</button>
      </div>
    `, "ean");
  }

  function renderCloneTool(data = state.current) {
    const isProduct = data?.marketplaceKey === "ml" && data?.type === "product";
    const content = !isProduct
      ? `
        <div class="dvti-tool-empty">A clonagem fica disponivel em anuncios de produto do Mercado Livre.</div>
        <div class="dvti-tool-actions"><button class="dvti-action" data-action="refresh">Atualizar leitura</button></div>
      `
      : `
        <div class="dvti-tool-summary">
          <strong>${escapeHtml(shortText(data.title || "Anuncio detectado", 80))}</strong>
          <span>${escapeHtml(resolveMlItemId(data) || getItemIdFromUrl(data.url, data.marketplaceKey) || "MLB nao identificado")}</span>
        </div>
        <label class="dvti-inline-field">
          Conta para rascunho
          <select data-role="account-select">${accountOptionsHtml()}</select>
        </label>
        <p class="dvti-mini-note">${escapeHtml(accountMetaText())}</p>
        <div class="dvti-tool-actions">
          <button class="dvti-action dvti-primary" data-action="clone">Clonar para minha conta</button>
          <button class="dvti-action" data-action="refresh">Atualizar leitura</button>
        </div>
      `;
    return toolShell("Clonar anuncio", "Envie este produto como rascunho para a conta Mercado Livre selecionada.", content, "clone");
  }

  function renderToolModal() {
    const root = ensureRoot();
    const body = root.querySelector(".dvti-tool-body");
    const title = root.querySelector("[data-role='tool-title']");
    if (!body) return;
    const tool = state.activeTool;
    if (title) title.textContent = toolLabel(tool);
    if (tool === "market") body.innerHTML = renderMarketTool(state.current);
    else if (tool === "keywords") body.innerHTML = renderKeywordsTool(state.current);
    else if (tool === "ean") body.innerHTML = renderEanTool();
    else if (tool === "clone") body.innerHTML = renderCloneTool(state.current);
    else body.innerHTML = toolShell("DACHBYTE Seller", "Escolha uma ferramenta no icone para comecar.", "", "");
  }

  function renderPanel(data = state.current) {
    const root = ensureRoot();
    const body = root.querySelector(".dvti-panel-body");
    const logged = isLogged();

    if (!logged) {
      body.innerHTML = `
        <div class="dvti-chip-row">
          <span class="dvti-chip warn">Login obrigatorio</span>
          <span class="dvti-chip muted">Hub DACHBYTE</span>
        </div>
        <h3>Entre para usar a extensao</h3>
          <p class="dvti-foot">Todas as funcoes ficam ativas apenas com login validado pelo Hub DACHBYTE.</p>
        <div class="dvti-actions">
          <button class="dvti-action dvti-primary" data-action="open-login">Entrar na DACHBYTE</button>
        </div>
      `;
      return;
    }

    if (!data) {
      body.innerHTML = `
        <div class="dvti-chip-row">
          <span class="dvti-chip muted">Aguardando pagina de anuncio</span>
        </div>
        <h3>Abra um anuncio ou busca no Mercado Livre/Shopee</h3>
        <p class="dvti-foot">A extensao injeta insights quando detecta cards de busca ou pagina de produto.</p>
      `;
      return;
    }
    const title = escapeHtml(text(data.title) || "Pagina detectada");
    const isProduct = data.type === "product";
    const realtime = data.realtime || null;
    const keywordInsights = buildKeywordInsights(data);
    const keywordKey = realtimeKey(data);
    const keywordsAvailable = data.marketplaceKey === "ml";
    const keywordMode = realtime?.data_quality?.keywords || "";
    const hasGeneratedKeywords = keywordsAvailable
      && keywordMode === "busca_ml_titulos_ate_pagina_5";
    const keywordBusy = keywordsAvailable && state.generatingKeywords && state.generatedKeywordsKey === keywordKey;
    const rankedKeywords = hasGeneratedKeywords && Array.isArray(realtime?.keywords?.ranked) && realtime.keywords.ranked.length
      ? realtime.keywords.ranked
      : keywordInsights.ranked;
    const suggestedKeywords = hasGeneratedKeywords && Array.isArray(realtime?.keywords?.suggestions) && realtime.keywords.suggestions.length
      ? realtime.keywords.suggestions
      : keywordInsights.longTail;
    const realtimeBusy = Boolean(data.realtimeLoading);
    const realtimeStatus = realtimeBusy
      ? `<div class="dvti-loading-row"><span class="dvti-spinner"></span>${escapeHtml(data.realtimeLoadingText || defaultRealtimeLoadingText(data.marketplaceKey))}</div>`
      : "";

    const keywordList = (hasGeneratedKeywords ? rankedKeywords : [])
      .slice(0, 8)
      .map((row) => `<li class="${escapeHtml(row.level || "unknown")}"><span>${escapeHtml(row.term)}</span><em>${escapeHtml(row.label || "-")}</em></li>`)
      .join("");
    const longTailList = (hasGeneratedKeywords ? suggestedKeywords : [])
      .slice(0, 4)
      .map((term) => `<li>${escapeHtml(term)}</li>`)
      .join("");
    const keywordStatus = !keywordsAvailable
      ? "<p class=\"dvti-keyword-empty\">Geracao automatica disponivel no momento apenas para Mercado Livre.</p>"
      : keywordBusy
        ? "<p class=\"dvti-keyword-empty\"><span class=\"dvti-spinner\"></span>Varrendo ate 5 paginas no Mercado Livre...</p>"
        : hasGeneratedKeywords
          ? ""
          : "<p class=\"dvti-keyword-empty\">Clique para buscar anuncios parecidos e rankear palavras repetidas pelos concorrentes.</p>";
    const sellerName = realtime?.seller?.nickname || data.seller || "-";
    const sellerLocation = [realtime?.seller?.city, realtime?.seller?.state].filter(Boolean).join(" / ");
    const sellerTransactions = realtime?.seller?.transactions_completed;
    const monthlyProjection = realtime?.estimates?.monthly_sales_projection;
    const panelCreatedIso = data.marketplaceKey === "shopee"
      ? (epochToIso(realtime?.product?.ctime) || String(data?.shopee?.createdAtIso || ""))
      : (realtime?.product?.date_created || "");
    const panelAgeDays = data.marketplaceKey === "shopee"
      ? daysSinceDate(panelCreatedIso)
      : positiveAgeDays(realtime, realtime?.product || {});
    const panelVelocity = computeSalesVelocity(data?.sold, panelAgeDays);
    const panelProjectedMonthly = panelVelocity.projectedMonthly != null
      ? panelVelocity.projectedMonthly
      : (monthlyProjection != null ? Number(monthlyProjection) : null);
    const sellerDetail = isProduct
      ? `
        <div class="dvti-seller-box">
          <h4>Dados do vendedor</h4>
          <div class="dvti-seller-grid">
            ${metric("Vendedor", escapeHtml(sellerName))}
            ${metric("Marca", escapeHtml(data.brand || "-"))}
            ${metric("Vendidos", escapeHtml(data.sold || "-"))}
            ${metric("Fotos", data.pictures || "0")}
            ${metric("Transacoes", sellerTransactions != null ? String(sellerTransactions) : "-")}
            ${metric("Local", escapeHtml(sellerLocation || "-"))}
            ${metric("Proj. vendas/mes", panelProjectedMonthly != null ? formatProjectedMonthlyLabel(panelProjectedMonthly) : "-")}
          </div>
        </div>
      `
      : "";

    const cloneButton = data.marketplaceKey === "ml" && isProduct
      ? logged
        ? `<button class="dvti-action dvti-primary" data-action="clone">Clonar para minha conta</button>`
        : `<button class="dvti-action dvti-primary" data-action="open-login">Entrar para clonar</button>`
      : `<button class="dvti-action" data-action="open-app">Abrir DACHBYTE</button>`;

    const accountBlock = logged && data.marketplaceKey === "ml" && isProduct
      ? `
        <label class="dvti-inline-field">
          Conta para rascunho
          <select data-role="account-select">${accountOptionsHtml()}</select>
        </label>
        <p class="dvti-mini-note">${escapeHtml(accountMetaText())}</p>
      `
      : "";
    const marketBlock = !isProduct ? renderMarketPanel(state.marketAnalysis, data) : "";

    body.innerHTML = `
      <div class="dvti-chip-row">
        <span class="dvti-chip">${escapeHtml(data.marketplace)}</span>
        <span class="dvti-chip muted">${isProduct ? "Anuncio" : "Busca"}</span>
        ${logged ? `<span class="dvti-chip ok">Logado</span>` : `<span class="dvti-chip warn">Visitante</span>`}
        ${realtime?.source ? `<span class="dvti-chip ok">${escapeHtml(realtime.source)}</span>` : ""}
      </div>
      <h3>${title}</h3>
      ${realtimeStatus}
      <div class="dvti-score"><span>Score DACHBYTE</span><strong>${data.score}</strong></div>
      <div class="dvti-grid">
        ${isProduct ? metric("Preco", formatMoney(data.price)) : metric("Media", formatMoney(data.avg))}
        ${isProduct ? metric("Fotos", data.pictures || "-") : metric("Lidos", data.count || "-")}
        ${isProduct ? metric("Vendedor", escapeHtml(data.seller || "-")) : metric("Frete gratis", data.freeShippingCount || "0")}
        ${isProduct ? metric("Frete", data.shipping ? "Visivel" : "Nao lido") : metric("Patrocinados", data.sponsoredCount || "0")}
      </div>
      ${list(data.wins, "ok")}
      ${list(data.warnings, "warn")}
      ${marketBlock}
      ${sellerDetail}
      ${accountBlock}
      <div class="dvti-keyword-box">
        <div class="dvti-keyword-head">
          <h4>Palavras chave</h4>
          <button type="button" class="dvti-keyword-generate" data-action="generate-keywords" ${keywordBusy || !keywordsAvailable ? "disabled" : ""}>
            ${keywordBusy ? `<span class="dvti-spinner"></span>Gerando` : "Gerar palavras chave"}
          </button>
        </div>
        ${keywordStatus}
        <ul class="dvti-keyword-list">${keywordsAvailable ? (keywordList || (hasGeneratedKeywords ? "<li><span>Sem termos</span><em>-</em></li>" : "")) : ""}</ul>
        ${keywordsAvailable && hasGeneratedKeywords ? "<h5>Sugestoes rapidas</h5>" : ""}
        <ul class="dvti-longtail-list">${keywordsAvailable ? (longTailList || (hasGeneratedKeywords ? "<li>Sem sugestoes</li>" : "")) : ""}</ul>
      </div>
      <div class="dvti-actions">
        <button class="dvti-action" data-action="refresh">Atualizar leitura</button>
        <button class="dvti-action" data-action="open-detail">Ver detalhe completo</button>
        ${cloneButton}
      </div>
      <p class="dvti-feedback" data-role="panel-feedback"></p>
      <p class="dvti-foot">Analise local da pagina atual. Dados estimados dependem do HTML carregado.</p>
    `;
  }

  function defaultLauncherPosition() {
    return {
      x: Math.max(12, window.innerWidth - 70),
      y: Math.max(12, window.innerHeight - 146),
    };
  }

  function clampLauncherPosition(position = defaultLauncherPosition()) {
    const size = 54;
    const margin = 10;
    return {
      x: Math.min(Math.max(margin, Number(position.x) || margin), Math.max(margin, window.innerWidth - size - margin)),
      y: Math.min(Math.max(margin, Number(position.y) || margin), Math.max(margin, window.innerHeight - size - margin)),
    };
  }

  function applyLauncherPosition() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    const position = clampLauncherPosition(state.launcherPosition || defaultLauncherPosition());
    state.launcherPosition = position;
    root.style.left = `${position.x}px`;
    root.style.top = `${position.y}px`;
    root.style.right = "auto";
    root.style.bottom = "auto";
    root.classList.toggle("menu-below", position.y < 120);
    root.classList.toggle("menu-above", position.y >= 120);
    root.classList.toggle("menu-left", position.x > window.innerWidth - 180);
    root.classList.toggle("menu-right", position.x <= window.innerWidth - 180);
  }

  function persistLauncherPosition() {
    if (!state.launcherPosition) return;
    setStorage({ [STORAGE_KEYS.launcherPosition]: state.launcherPosition }).catch(() => {});
  }

  function setLauncherOpen(open) {
    state.launcherOpen = Boolean(open);
    const root = ensureRoot();
    root.classList.toggle("launcher-open", state.launcherOpen);
  }

  function initLauncherDrag(root) {
    const fab = root.querySelector(".dvti-fab");
    if (!fab || fab.dataset.dragReady === "1") return;
    fab.dataset.dragReady = "1";

    fab.addEventListener("pointerdown", (event) => {
      if (event.button != null && event.button !== 0) return;
      state.launcherDrag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: state.launcherPosition?.x ?? defaultLauncherPosition().x,
        originY: state.launcherPosition?.y ?? defaultLauncherPosition().y,
        moved: false,
      };
      root.classList.add("is-dragging");
      fab.setPointerCapture?.(event.pointerId);
    });

    fab.addEventListener("pointermove", (event) => {
      const drag = state.launcherDrag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      event.preventDefault();
      state.launcherPosition = clampLauncherPosition({ x: drag.originX + dx, y: drag.originY + dy });
      applyLauncherPosition();
    });

    const stopDrag = (event) => {
      const drag = state.launcherDrag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      root.classList.remove("is-dragging");
      fab.releasePointerCapture?.(event.pointerId);
      state.launcherDrag = null;
      if (drag.moved) {
        state.suppressLauncherClick = true;
        setLauncherOpen(false);
        persistLauncherPosition();
        setTimeout(() => {
          state.suppressLauncherClick = false;
        }, 0);
      }
    };

    fab.addEventListener("pointerup", stopDrag);
    fab.addEventListener("pointercancel", stopDrag);
  }

  function ensureRoot() {
    let root = document.getElementById(ROOT_ID);
    if (root) {
      applyLauncherPosition();
      return root;
    }
    root = document.createElement("div");
    root.id = ROOT_ID;
    root.innerHTML = `
      <button class="dvti-fab" type="button" aria-label="Abrir DACHBYTE" data-action="toggle-panel">
        <img class="dvti-fab-icon" src="${BRAND_ICON_URL}" alt="DACHBYTE Seller" />
      </button>

      <aside class="dvti-launcher-menu" aria-label="Acoes DACHBYTE">
        <button type="button" class="dvti-quick-btn" data-action="quick-insights" title="Insights">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 18h16M7 14l3-3 3 2 4-5" /></svg>
          <span>Detalhes</span>
        </button>
        <button type="button" class="dvti-quick-btn" data-action="quick-market" title="Pesquisa de mercado">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V5M4 19h16M8 16v-5M12 16V8M16 16v-8" /></svg>
          <span>Mercado</span>
        </button>
        <button type="button" class="dvti-quick-btn" data-action="quick-keywords" title="Palavras chave">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5h8M5 12h14M9 19h10M4 5h.01M4 12h.01M4 19h.01" /></svg>
          <span>Palavras</span>
        </button>
        <button type="button" class="dvti-quick-btn" data-action="quick-ean" title="Gerar EAN-13">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5v14M8 5v14M12 5v14M15 5v14M19 5v14" /></svg>
          <span>EAN-13</span>
        </button>
        <button type="button" class="dvti-quick-btn" data-action="quick-clone" title="Clonar">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8h10v10H8zM6 16H4V6h10v2" /></svg>
          <span>Clonar</span>
        </button>
      </aside>

      <aside class="dvti-panel">
        <header>
          <div class="dvti-head-brand">
            <img class="dvti-head-logo" src="${BRAND_ICON_URL}" alt="DACHBYTE Seller" />
            <strong>DACHBYTE Seller</strong>
          </div>
          <button type="button" class="dvti-close" aria-label="Fechar" data-action="close-panel">x</button>
        </header>
        <div class="dvti-panel-body"></div>
      </aside>

      <div class="dvti-overlay" data-action="close-drawer"></div>
      <div class="dvti-modal-overlay" data-action="close-modal"></div>
      <div class="dvti-tool-overlay" data-action="close-tool"></div>

      <aside class="dvti-auth-drawer" aria-label="Login DACHBYTE">
        <header>
          <div class="dvti-head-block">
            <div class="dvti-head-brand">
              <img class="dvti-head-logo" src="${BRAND_ICON_URL}" alt="DACHBYTE Seller" />
              <strong>Entrar na DACHBYTE</strong>
            </div>
            <p>Use seu login global para habilitar recursos conectados.</p>
          </div>
          <button type="button" class="dvti-close" aria-label="Fechar login" data-action="close-drawer">x</button>
        </header>
        <div class="dvti-auth-body">
          <label class="dvti-inline-field">
            E-mail DACHBYTE
            <input data-role="email" type="email" autocomplete="email" placeholder="voce@empresa.com" />
          </label>
          <label class="dvti-inline-field">
            Senha
            <input data-role="password" type="password" autocomplete="current-password" placeholder="Sua senha" />
          </label>
          <button class="dvti-action dvti-primary" data-action="login-submit">Entrar</button>
          <div class="dvti-auth-links">
            <p>Ainda nao tem cadastro? <button type="button" class="dvti-inline-link" data-action="open-landing">Clique aqui!</button></p>
            <p>Esta com algum problema? <button type="button" class="dvti-inline-link" data-action="open-support">Fale com suporte.</button></p>
          </div>
          <p class="dvti-feedback" data-role="drawer-feedback"></p>
        </div>
      </aside>

      <aside class="dvti-detail-modal" aria-label="Detalhamento DACHBYTE">
        <header>
          <div class="dvti-head-brand">
            <img class="dvti-head-logo" src="${BRAND_ICON_URL}" alt="DACHBYTE Seller" />
            <strong>Detalhamento completo</strong>
          </div>
          <button type="button" class="dvti-close" aria-label="Fechar detalhe" data-action="close-modal">x</button>
        </header>
        <div class="dvti-detail-body"></div>
      </aside>

      <aside class="dvti-tool-modal" aria-label="Ferramenta DACHBYTE">
        <header>
          <div class="dvti-head-brand">
            <img class="dvti-head-logo" src="${BRAND_ICON_URL}" alt="DACHBYTE Seller" />
            <strong data-role="tool-title">DACHBYTE Seller</strong>
          </div>
          <button type="button" class="dvti-close" aria-label="Fechar ferramenta" data-action="close-tool">x</button>
        </header>
        <div class="dvti-tool-body"></div>
      </aside>
    `;

    document.documentElement.appendChild(root);
    root.addEventListener("click", handleActionClick);
    root.addEventListener("change", handleChange);
    root.addEventListener("keydown", handleKeyDown);
    initLauncherDrag(root);
    applyLauncherPosition();
    setOpen(state.open);
    setLauncherOpen(state.launcherOpen);
    setDrawerOpen(false);
    setModalOpen(false);
    setToolOpen(state.toolOpen, state.activeTool);
    return root;
  }

  function setOpen(open) {
    state.open = open;
    const root = ensureRoot();
    root.classList.toggle("is-open", open);
    if (open) setLauncherOpen(false);
  }

  function setDrawerOpen(open) {
    state.drawerOpen = open;
    const root = ensureRoot();
    root.classList.toggle("drawer-open", open);
  }

  function setModalOpen(open) {
    state.modalOpen = open;
    const root = ensureRoot();
    root.classList.toggle("modal-open", open);
    if (open) {
      setToolOpen(false);
      renderDetailModal(state.current);
    }
  }

  function setToolOpen(open, tool = state.activeTool) {
    state.toolOpen = Boolean(open);
    state.activeTool = open ? (tool || state.activeTool) : "";
    const root = ensureRoot();
    root.classList.toggle("tool-open", state.toolOpen);
    if (state.toolOpen) {
      setOpen(false);
      setModalOpen(false);
      renderToolModal();
    }
  }

  function openTool(tool) {
    if (!isLogged()) {
      setLauncherOpen(false);
      setToolOpen(false);
      setDrawerOpen(true);
      drawerFeedback("Entre para habilitar os recursos.");
      return;
    }
    if (tool === "ean") state.eanValue = state.eanValue || generateEan13();
    setLauncherOpen(false);
    setToolOpen(true, tool);
  }

  function syncAuthUi() {
    const root = ensureRoot();
    root.classList.toggle("logged-in", isLogged());
    root.classList.toggle("has-product", state.current?.type === "product");
    root.classList.toggle("has-search", state.current?.type === "search");
    if (!isLogged()) {
      state.current = null;
      setOpen(false);
      setLauncherOpen(false);
      setModalOpen(false);
      setToolOpen(false);
    }
    renderPanel();
    applyPageEnhancements(state.current);
    if (state.modalOpen) renderDetailModal(state.current);
    if (state.toolOpen) renderToolModal();
  }

  async function loadAccounts() {
    const payload = await apiFetch("/api/extension/accounts");
    const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
    state.accounts = accounts;
    if (
      !state.accountId ||
      !accounts.some((account) => String(account.id) === String(state.accountId) && account.has_tokens)
    ) {
      const firstAvailable = accounts.find((account) => account.has_tokens) || null;
      state.accountId = firstAvailable ? String(firstAvailable.id) : "";
    }
    await setStorage({ [STORAGE_KEYS.accountId]: state.accountId });
  }

  async function hydrateSession() {
    const saved = await getStorage(Object.values(STORAGE_KEYS));
    state.baseUrl = DEFAULT_BASE_URL;
    state.token = String(saved[STORAGE_KEYS.token] || "");
    state.user = saved[STORAGE_KEYS.user] || null;
    state.accountId = String(saved[STORAGE_KEYS.accountId] || "");
    state.launcherPosition = saved[STORAGE_KEYS.launcherPosition] || null;

    if (!state.token) return;

    try {
      const me = await apiFetch("/api/extension/me");
      state.user = me?.user || state.user;
      state.accounts = Array.isArray(me?.accounts) ? me.accounts : [];
      if (!state.accounts.length) {
        await loadAccounts();
      }
    } catch (_) {
      state.token = "";
      state.user = null;
      state.accounts = [];
      state.accountId = "";
      await removeStorage([STORAGE_KEYS.token, STORAGE_KEYS.user, STORAGE_KEYS.accountId]);
    }
  }

  function setButtonBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      button.dataset.originalText = button.textContent;
      button.textContent = label || "Aguarde...";
      button.disabled = true;
      return;
    }
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }

  async function loginFromDrawer(button) {
    if (state.loggingIn) return;

    const root = ensureRoot();
    const email = text(root.querySelector("[data-role='email']")?.value || "");
    const password = String(root.querySelector("[data-role='password']")?.value || "");
    state.baseUrl = DEFAULT_BASE_URL;

    if (!email || !password) {
      drawerFeedback("Informe e-mail e senha.", "error");
      return;
    }

    state.loggingIn = true;
    setButtonBusy(button, true, "Entrando...");
    drawerFeedback("Validando credenciais...");

    try {
      const payload = await apiFetch("/api/extension/auth/login", {
        method: "POST",
        body: { email, senha: password },
      });

      state.token = payload?.extension_token || "";
      state.user = payload?.user || null;
      if (!state.token) {
        throw new Error("Login aceito, mas sem token da extensao.");
      }

      await setStorage({
        [STORAGE_KEYS.token]: state.token,
        [STORAGE_KEYS.user]: state.user,
      });

      await loadAccounts();
      root.querySelector("[data-role='password']").value = "";
      setDrawerOpen(false);
      syncAuthUi();
      runAnalysis();
      panelFeedback("Login realizado. Selecione a conta para clonar.", "ok");
    } catch (error) {
      drawerFeedback(error.message || "Falha ao entrar.", "error");
    } finally {
      state.loggingIn = false;
      setButtonBusy(button, false);
    }
  }

  async function logoutFromDrawer() {
    state.token = "";
    state.user = null;
    state.accounts = [];
    state.accountId = "";
    state.current = null;
    state.realtimeCache.clear();
    state.realtimeInflight.clear();
    await removeStorage([STORAGE_KEYS.token, STORAGE_KEYS.user, STORAGE_KEYS.accountId]);
    setDrawerOpen(false);
    syncAuthUi();
    applyPageEnhancements(null);
    panelFeedback("Sessao encerrada.");
  }

  async function cloneFromPage(button) {
    if (state.cloning) return;

    if (!isLogged()) {
      setDrawerOpen(true);
      drawerFeedback("Entre para enviar rascunho de clonagem.");
      return;
    }

    const account = selectedAccount();
    if (!account?.has_tokens) {
      panelFeedback("Selecione uma conta ML conectada para clonar.", "error");
      return;
    }

    state.cloning = true;
    setButtonBusy(button, true, "Enviando...");
    panelFeedback("Capturando pagina atual...");

    try {
      const payload = await apiFetch("/api/extension/clonar-anuncio/browser-capture", {
        method: "POST",
        body: {
          account_id: state.accountId,
          url: location.href,
          title: document.title || "",
          html: document.documentElement ? document.documentElement.outerHTML : "",
          captured_at: new Date().toISOString(),
        },
      });

      panelFeedback(
        payload?.draft?.id
          ? `Rascunho #${payload.draft.id} criado com sucesso.`
          : "Rascunho criado com sucesso.",
        "ok",
      );
    } catch (error) {
      panelFeedback(error.message || "Falha ao clonar anuncio.", "error");
    } finally {
      state.cloning = false;
      setButtonBusy(button, false);
      renderPanel();
      if (state.toolOpen) renderToolModal();
    }
  }

  function ean13CheckDigit(base12) {
    const digits = String(base12 || "").replace(/\D/g, "").slice(0, 12);
    if (digits.length !== 12) return "";
    const sum = digits
      .split("")
      .reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
    return String((10 - (sum % 10)) % 10);
  }

  function generateEan13() {
    const randomPart = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10)).join("");
    const base = `789${randomPart}`;
    return `${base}${ean13CheckDigit(base)}`;
  }

  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      const input = document.createElement("textarea");
      input.value = value;
      input.setAttribute("readonly", "readonly");
      input.style.position = "fixed";
      input.style.left = "-9999px";
      document.body.appendChild(input);
      input.select();
      const copied = document.execCommand("copy");
      input.remove();
      return copied;
    }
  }

  function sanitizeFilename(value, fallback = "arquivo") {
    const cleaned = String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    return cleaned || fallback;
  }

  function fileExtensionFromUrl(url, mime = "") {
    const parsedMime = String(mime || "").toLowerCase();
    if (parsedMime.includes("jpeg")) return "jpg";
    if (parsedMime.includes("png")) return "png";
    if (parsedMime.includes("webp")) return "webp";
    if (parsedMime.includes("mp4")) return "mp4";
    if (parsedMime.includes("mpegurl") || parsedMime.includes("m3u8")) return "m3u8";
    const source = String(url || "").split("?")[0];
    const match = source.match(/\.([a-z0-9]{2,5})$/i);
    return match ? String(match[1] || "").toLowerCase() : "bin";
  }

  let crc32Table = null;
  function getCrc32Table() {
    if (crc32Table) return crc32Table;
    crc32Table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crc32Table[n] = c >>> 0;
    }
    return crc32Table;
  }

  function crc32(bytes) {
    const table = getCrc32Table();
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i += 1) {
      crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function concatBytes(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    parts.forEach((part) => {
      out.set(part, offset);
      offset += part.length;
    });
    return out;
  }

  function zipStoredFiles(files) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    files.forEach((file) => {
      const nameBytes = encoder.encode(file.name);
      const dataBytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes || []);
      const crc = crc32(dataBytes);
      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034B50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, 0, true);
      lv.setUint16(12, 0, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, dataBytes.length, true);
      lv.setUint32(22, dataBytes.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      localParts.push(local, dataBytes);

      const central = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014B50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, dataBytes.length, true);
      cv.setUint32(24, dataBytes.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      central.set(nameBytes, 46);
      centralParts.push(central);

      offset += local.length + dataBytes.length;
    });

    const centralBytes = concatBytes(centralParts);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054B50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralBytes.length, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    return concatBytes([...localParts, centralBytes, end]);
  }

  async function fetchMediaBytes(url, timeoutMs = 18000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        signal: controller.signal,
      });
      if (response.type === "opaque") {
        throw new Error("Resposta bloqueada por CORS na CDN de midia.");
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const arrayBuffer = await response.arrayBuffer();
      return {
        bytes: new Uint8Array(arrayBuffer),
        mime: response.headers.get("content-type") || "",
      };
    } finally {
      clearTimeout(timer);
    }
  }

  function collectShopeeMediaForDownload(data) {
    const currentSignals = data?.shopee && typeof data.shopee === "object" ? data.shopee : extractShopeeProductSignals();
    const media = currentSignals?.media || collectShopeeMediaAssets(readShopeeItemFromInitialData() || {});
    const galleryImageUrls = Array.isArray(media?.galleryImageUrls) ? media.galleryImageUrls.filter(Boolean) : [];
    const clipUrls = Array.isArray(media?.clipUrls) ? media.clipUrls.filter(Boolean) : [];
    const videoUrls = clipUrls.length
      ? clipUrls
      : (Array.isArray(media?.videoUrls) ? media.videoUrls.filter(Boolean) : []);
    return {
      imageUrls: Array.from(new Set(galleryImageUrls)).slice(0, 80),
      videoUrls: Array.from(new Set(videoUrls)).slice(0, 8),
    };
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function downloadShopeeMedia(button) {
    if (state.mediaDownloading) return;
    const data = state.current || analyzePage();
    if (!data || data.type !== "product" || data.marketplaceKey !== "shopee") {
      panelFeedback("Download de midia disponivel apenas em anuncios da Shopee.", "error");
      return;
    }

    state.mediaDownloading = true;
    setButtonBusy(button, true, "Baixando...");
    panelFeedback("Preparando midia do anuncio...");
    try {
      const media = collectShopeeMediaForDownload(data);
      if (!media.imageUrls.length && !media.videoUrls.length) {
        throw new Error("Nao encontrei imagens da galeria principal nem clip para baixar neste anuncio.");
      }

      const files = [];
      let imagesAdded = 0;
      let videosAdded = 0;

      for (let i = 0; i < media.imageUrls.length; i += 1) {
        const sourceUrl = media.imageUrls[i];
        try {
          const payload = await fetchMediaBytes(sourceUrl);
          const ext = fileExtensionFromUrl(sourceUrl, payload.mime);
          files.push({
            name: `imagens/imagem-${String(i + 1).padStart(2, "0")}.${ext}`,
            bytes: payload.bytes,
          });
          imagesAdded += 1;
        } catch (_) {
          // ignora falhas pontuais e segue com as demais midias
        }
      }

      for (let i = 0; i < media.videoUrls.length; i += 1) {
        const sourceUrl = media.videoUrls[i];
        try {
          const payload = await fetchMediaBytes(sourceUrl, 28000);
          const ext = fileExtensionFromUrl(sourceUrl, payload.mime);
          files.push({
            name: `videos/clip-${String(i + 1).padStart(2, "0")}.${ext}`,
            bytes: payload.bytes,
          });
          videosAdded += 1;
        } catch (_) {
          // ignora falhas pontuais e segue com os demais arquivos
        }
      }

      if (!files.length) {
        throw new Error("Nao consegui baixar os arquivos de midia (bloqueio de acesso do host/CDN).");
      }

      const zipBytes = zipStoredFiles(files);
      const titlePart = sanitizeFilename(data.title || "anuncio-shopee", "anuncio-shopee");
      const zipName = `${titlePart}-midias.zip`;
      downloadBlob(new Blob([zipBytes], { type: "application/zip" }), zipName);
      panelFeedback(
        `ZIP gerado: ${imagesAdded} imagem(ns)${videosAdded ? ` e ${videosAdded} clip(s)` : ""}.`,
        "ok",
      );
    } catch (error) {
      panelFeedback(error?.message || "Falha ao baixar midia do anuncio.", "error");
    } finally {
      state.mediaDownloading = false;
      setButtonBusy(button, false);
      renderPanel(state.current || data);
      if (state.toolOpen) renderToolModal();
    }
  }

  function fillFocusedTextField(value) {
    const target = document.activeElement;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return false;
    if (target.readOnly || target.disabled) return false;
    target.value = value;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  async function generateEan13FromRail() {
    if (!isLogged()) {
      setDrawerOpen(true);
      drawerFeedback("Entre para gerar EAN-13 pela extensao.");
      return;
    }

    const ean = generateEan13();
    state.eanValue = ean;
    const copied = await copyText(ean);
    panelFeedback(
      `${ean} ${copied ? "copiado para a area de transferencia" : "gerado"}. Valide o uso antes de publicar.`,
      "ok",
    );
    if (state.toolOpen) renderToolModal();
  }

  async function openApp() {
    window.open(`${normalizeBaseUrl(state.baseUrl)}/painel`, "_blank", "noopener,noreferrer");
  }

  function openLanding() {
    window.open(DAVANTTI_LANDING_URL, "_blank", "noopener,noreferrer");
  }

  function openSupport() {
    window.open(DAVANTTI_CONTACT_URL, "_blank", "noopener,noreferrer");
  }

  function openMlSearchFromCurrent() {
    const data = state.current || analyzePage();
    const query = text(data?.title || document.title || "")
      .replace(/\s*\|\s*Mercado Livre.*$/i, "")
      .replace(/\s*\|\s*Shopee.*$/i, "");
    if (!query) {
      panelFeedback("Nao consegui identificar um titulo para buscar.", "error");
      return;
    }
    const marketplaceKey = data?.marketplaceKey || detectMarketplace();
    const url = marketplaceKey === "shopee"
      ? `https://shopee.com.br/search?keyword=${encodeURIComponent(query)}`
      : `https://lista.mercadolivre.com.br/${encodeURIComponent(query).replace(/%20/g, "-")}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function togglePanel() {
    if (state.suppressLauncherClick) return;
    if (!isLogged()) {
      setLauncherOpen(false);
      setToolOpen(false);
      setDrawerOpen(true);
      drawerFeedback("Entre para habilitar os recursos.");
      return;
    }
    setOpen(false);
    setToolOpen(false);
    setLauncherOpen(!state.launcherOpen);
  }

  function handleChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    if (target.matches("[data-role='account-select']")) {
      state.accountId = String(target.value || "");
      state.realtimeCache.clear();
      setStorage({ [STORAGE_KEYS.accountId]: state.accountId });
      renderPanel();
      if (state.toolOpen) renderToolModal();
      return;
    }
  }

  function handleKeyDown(event) {
    if (event.key === "Escape") {
      if (state.launcherOpen) setLauncherOpen(false);
      if (state.toolOpen) setToolOpen(false);
      if (state.modalOpen) setModalOpen(false);
      if (state.drawerOpen) setDrawerOpen(false);
      return;
    }
    if (event.key !== "Enter") return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.matches("[data-role='email']") || target.matches("[data-role='password']")) {
      event.preventDefault();
      const button = ensureRoot().querySelector("[data-action='login-submit']");
      loginFromDrawer(button);
    }
  }

  async function runMarketAnalysis() {
    if (!isLogged()) {
      setDrawerOpen(true);
      return;
    }
    const data = state.current || analyzePage();
    if (!data || data.type !== "search") {
      if (!state.toolOpen) setOpen(true);
      panelFeedback("A analise de mercado fica disponivel em paginas de busca/listagem.", "error");
      return;
    }

    if (!state.toolOpen) setOpen(true);
    state.current = data;
    state.analyzingMarket = true;
    state.marketAnalysis = {
      loading: true,
      url: location.href,
      query: getQueryFromUrl(location.href, data.marketplaceKey),
    };
    renderPanel(data);
    if (state.toolOpen) renderToolModal();

    try {
      const urls = marketPageUrls(5);
      const batches = [];
      for (const url of urls) {
        batches.push(await fetchSearchItemsFromUrl(url, data.marketplaceKey));
      }
      const seen = new Set();
      const items = batches.flat().filter((item) => {
        const key = item.url || `${item.title}|${item.price}`;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      state.marketAnalysis = {
        ...summarizeMarketItems(items, urls.length),
        url: location.href,
        query: getQueryFromUrl(location.href, data.marketplaceKey),
        marketplace: data.marketplace,
      };
      state.analyzingMarket = false;
      renderPanel(state.current);
      if (state.toolOpen) renderToolModal();
    } catch (error) {
      state.analyzingMarket = false;
      state.marketAnalysis = {
        error: error?.message || "Falha ao ler as paginas de busca.",
        url: location.href,
        query: getQueryFromUrl(location.href, data.marketplaceKey),
      };
      renderPanel(state.current);
      if (state.toolOpen) renderToolModal();
    }
  }

  async function generateKeywordsFromPanel(button) {
    const data = state.current || analyzePage();
    if (!data || data.marketplaceKey !== "ml") {
      panelFeedback("Palavras chave estao disponiveis para paginas do Mercado Livre.", "error");
      return;
    }
    if (!isLogged()) {
      panelFeedback("Entre na DACHBYTE para gerar palavras chave.", "error");
      return;
    }

    const key = realtimeKey(data);
    state.keywordPage = 1;
    state.keywordPageByKey.set(key, 1);
    if (!state.toolOpen) setOpen(true);
    state.current = data;
    state.generatingKeywords = true;
    state.generatedKeywordsKey = key;
    state.realtimeCache.delete(key);
    setButtonBusy(button, true, "Gerando...");
    renderPanel(data);
    if (state.toolOpen) renderToolModal();

    let feedbackMessage = "";
    let feedbackType = "";
    try {
      const localKeywords = await generateKeywordsFromMlSearchHtml(data);
      const refinedKeywords = await refineKeywordsWithAi(data, localKeywords);
      const previousRealtime = data?.realtime && typeof data.realtime === "object" ? data.realtime : {};
      const realtime = {
        ...previousRealtime,
        data_quality: {
          ...(previousRealtime.data_quality || {}),
          ...(refinedKeywords.data_quality || {}),
        },
        keywords: refinedKeywords.keywords,
      };
      const keywordMode = realtime.data_quality?.keywords || "";
      if (keywordMode !== "busca_ml_titulos_ate_pagina_5" && keywordMode !== "busca_ml_sem_ocorrencias_suficientes") {
        throw new Error("A busca de palavras chave nao retornou dados novos.");
      }
      const merged = mergeRealtime(data, realtime);
      state.current = merged;
      state.realtimeCache.set(key, realtime);
      applyPageEnhancements(merged);
      if (state.modalOpen) renderDetailModal(merged);
      if (state.toolOpen) renderToolModal();
      if (keywordMode === "busca_ml_titulos_ate_pagina_5") {
        const usedAi = realtime.data_quality?.keyword_ai === "mistral" || realtime.data_quality?.keyword_ai === "mistral_cache";
        feedbackMessage = usedAi
          ? "Palavras chave geradas e refinadas com IA."
          : "Palavras chave geradas com fallback local.";
        feedbackType = "ok";
      } else {
        feedbackMessage = "Busca concluida, mas nao encontrei ocorrencias suficientes.";
        feedbackType = "error";
      }
    } catch (error) {
      state.generatedKeywordsKey = "";
      feedbackMessage = error?.message || "Falha ao gerar palavras chave.";
      feedbackType = "error";
    } finally {
      state.generatingKeywords = false;
      setButtonBusy(button, false);
      renderPanel(state.current || data);
      if (state.toolOpen) renderToolModal();
      panelFeedback(feedbackMessage, feedbackType);
    }
  }

  function handleActionClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    if (action === "refresh") runAnalysis();
    if (action === "toggle-panel") togglePanel();
    if (action === "close-panel") setOpen(false);
    if (action === "open-login") setDrawerOpen(true);
    if (action === "close-drawer") setDrawerOpen(false);
    if (action === "close-tool") setToolOpen(false);
    if (action === "open-detail") setModalOpen(true);
    if (action === "close-modal") setModalOpen(false);
    if (action === "download-media") downloadShopeeMedia(button);
    if (action === "clone") cloneFromPage(button);
    if (action === "login-submit") loginFromDrawer(button);
    if (action === "logout") logoutFromDrawer();
    if (action === "open-app") openApp();
    if (action === "open-landing") openLanding();
    if (action === "open-support") openSupport();
    if (action === "quick-insights") {
      setLauncherOpen(false);
      setModalOpen(true);
    }
    if (action === "quick-market" || action === "analyze-market") {
      setLauncherOpen(false);
      if (action === "quick-market") openTool("market");
      else runMarketAnalysis();
    }
    if (action === "generate-keywords") generateKeywordsFromPanel(button);
    if (action === "quick-keywords") {
      openTool("keywords");
    }
    if (action === "quick-ean") {
      openTool("ean");
    }
    if (action === "quick-clone") {
      openTool("clone");
    }
    if (action === "new-ean") {
      state.eanValue = generateEan13();
      renderToolModal();
    }
    if (action === "copy-ean") {
      copyText(state.eanValue || generateEan13()).then((copied) => {
        panelFeedback(copied ? "EAN copiado." : "EAN gerado, mas nao consegui copiar automaticamente.", copied ? "ok" : "error");
      });
    }
    if (action === "copy-keyword") {
      const value = button.dataset.keyword || "";
      copyText(value).then((copied) => {
        panelFeedback(copied ? "Palavra chave copiada." : "Nao consegui copiar automaticamente.", copied ? "ok" : "error");
      });
    }
    if (action === "keyword-page-prev") {
      event.preventDefault();
      event.stopPropagation();
      const key = realtimeKey(state.current || analyzePage() || {});
      const currentPage = Number(state.keywordPageByKey.get(key) || state.keywordPage || 1);
      state.keywordPage = Math.max(1, currentPage - 1);
      if (key) state.keywordPageByKey.set(key, state.keywordPage);
      renderToolModal();
      ensureRoot().querySelector(".dvti-tool-body")?.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (action === "keyword-page-next") {
      event.preventDefault();
      event.stopPropagation();
      const key = realtimeKey(state.current || analyzePage() || {});
      const currentPage = Number(state.keywordPageByKey.get(key) || state.keywordPage || 1);
      state.keywordPage = currentPage + 1;
      if (key) state.keywordPageByKey.set(key, state.keywordPage);
      renderToolModal();
      ensureRoot().querySelector(".dvti-tool-body")?.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (action === "open-ml-search") openMlSearchFromCurrent();
  }

  async function runAnalysis() {
    try {
      if (!isLogged()) {
        state.current = null;
        state.marketAnalysis = null;
        renderPanel();
        if (state.toolOpen) setToolOpen(false);
        applyPageEnhancements(null);
        return;
      }
      const data = analyzePage();
      if (!data) {
        state.current = null;
        state.marketAnalysis = null;
        renderPanel();
        if (state.toolOpen) renderToolModal();
        applyPageEnhancements(null);
        return;
      }
      if (state.marketAnalysis?.url && state.marketAnalysis.url !== location.href) {
        state.marketAnalysis = null;
      }
      const loadingData = data.type === "product"
        ? {
            ...data,
            realtimeLoading: true,
            realtimeLoadingText: defaultRealtimeLoadingText(data.marketplaceKey),
          }
        : data;
      state.current = loadingData;
      syncAuthUi();
      renderPanel(loadingData);
      if (state.toolOpen) renderToolModal();
      applyPageEnhancements(loadingData);
      if (state.modalOpen) renderDetailModal(loadingData);

      const realtime = await fetchRealtimeInsights(data);
      if (!realtime) {
        if (state.realtimeInflight.has(realtimeKey(data))) return;
        if (location.href === data.url && state.current?.url === data.url) {
          state.current = { ...state.current, realtimeLoading: false, realtimeLoadingText: "" };
          renderPanel(state.current);
          if (state.toolOpen) renderToolModal();
          applyPageEnhancements(state.current);
          if (state.modalOpen) renderDetailModal(state.current);
        }
        return;
      }
      if (location.href !== data.url) return;
      const merged = mergeRealtime({ ...data, realtimeLoading: false, realtimeLoadingText: "" }, realtime);
      state.current = merged;
      renderPanel(merged);
      if (state.toolOpen) renderToolModal();
      applyPageEnhancements(merged);
      if (state.modalOpen) renderDetailModal(merged);
      state.lastRealtimeRefreshKey = realtimeKey(data);
      state.lastRealtimeRefreshVersion = state.networkVersion;
    } catch {
      // falha silenciosa para nao quebrar a pagina do marketplace
    }
  }

  const observer = new MutationObserver(() => {
    clearTimeout(observer._timer);
    observer._timer = setTimeout(runAnalysis, 700);
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== "davantti-extension") return;
    if (event.data?.type === NETWORK_EVENT_CAPTURE) {
      if (rememberNetworkEntries(event.data.payload)) scheduleRealtimeRefresh("capture");
      return;
    }
    if (event.data?.type === NETWORK_EVENT_CACHE_RESPONSE) {
      const added = rememberNetworkEntries(event.data.payload);
      runAnalysis();
      if (added) scheduleRealtimeRefresh("cache");
    }
  });

  async function boot() {
    await hydrateSession();
    state.inlineReadyAt = Date.now() + (detectMarketplace() === "ml" ? 5000 : 1500);
    requestNetworkCache();
    syncAuthUi();
    window.addEventListener("resize", () => {
      state.launcherPosition = clampLauncherPosition(state.launcherPosition || defaultLauncherPosition());
      applyLauncherPosition();
      persistLauncherPosition();
    });
    runAnalysis();
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(runAnalysis, 350);
    setTimeout(requestNetworkCache, 700);
    setTimeout(runAnalysis, 1800);
    setTimeout(runAnalysis, 4200);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      boot().catch(() => {});
    }, { once: true });
  } else {
    boot().catch(() => {});
  }
})();
