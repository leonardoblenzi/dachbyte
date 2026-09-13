"use strict";

(() => {
  const state = {
    currentTab: "explorar",
    selectedCategoryId: null,
    selectedDomainId: null,
    lastSearch: null,
    lastAnalysis: null,
    categories: new Map(),
    requestSeq: 0,
    suggestSeq: 0,
    keywordSeq: 0,
    keywordData: null,
    keywordPage: 1,
    keywordPageSize: 25,
    generalTrends: [],
    categoryTrendData: null,
    trendMode: "general",
    trendSeq: 0,
    suggestTimer: null,
  };

  const $ = (id) => document.getElementById(id);
  const qsa = (selector) => Array.from(document.querySelectorAll(selector));

  function appUrl(path) {
    return window.ML?.url
      ? window.ML.url(path)
      : typeof window.withBase === "function"
        ? window.withBase(path)
        : path;
  }

  async function apiJson(path) {
    const response = await fetch(appUrl(path), {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      const error = new Error(data.error || data.detail || `HTTP ${response.status}`);
      error.code = data.code || null;
      error.upstream = data.upstream || null;
      throw error;
    }
    return data;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function safeUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      const url = new URL(raw, window.location.origin);
      if (!/^https?:$/.test(url.protocol)) return "";
      return url.href;
    } catch {
      return "";
    }
  }

  function money(value) {
    if (value === null || value === undefined || value === "") return "-";
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function number(value) {
    if (value === null || value === undefined || value === "") return "-";
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    return n.toLocaleString("pt-BR");
  }

  function percent(value) {
    if (value === null || value === undefined || value === "") return "-";
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    return `${n.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  }

  function setAlert(message, tone = "warn") {
    const box = $("marketAlert");
    if (!box) return;
    if (!message) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    box.hidden = false;
    box.dataset.tone = tone;
    box.innerHTML = `<span class="market-alert__icon" aria-hidden="true">!</span><span>${escapeHtml(message)}</span>`;
  }

  function warningMessage(warnings) {
    const rows = Array.isArray(warnings) ? warnings : [];
    return rows.map((warning) => warning?.message).filter(Boolean).join(" ");
  }

  function setStatus(message, stateName = "ready") {
    const status = $("marketStatus");
    if (!status) return;
    status.dataset.state = stateName;
    const text = status.querySelector("span:last-child");
    if (text) text.textContent = message || "Pronto para analisar";
    else status.textContent = message || "Pronto para analisar";
  }

  function setLoading(message) {
    setStatus(message || "Carregando", "loading");
  }

  function show(id, visible = true) {
    const el = $(id);
    if (el) el.hidden = !visible;
  }

  function renderEmpty(target, message, colspan = null) {
    const el = typeof target === "string" ? $(target) : target;
    if (!el) return;
    if (colspan) {
      el.innerHTML = `<tr><td colspan="${colspan}" class="rank-empty">${escapeHtml(message)}</td></tr>`;
      return;
    }
    el.innerHTML = `<div class="rank-empty">${escapeHtml(message)}</div>`;
  }

  function resetAnalysisPanels() {
    show("marketKpis", false);
    show("analysisSummaryCard", false);
    show("marketExplorerCard", false);
    show("bestSellersCard", false);
    show("categoryTrendsCard", false);
    show("marketProductsCard", false);
    state.lastAnalysis = null;
    state.selectedCategoryId = null;
    state.selectedDomainId = null;
  }

  function resetExploreResults() {
    show("categoryResultsCard", false);
    show("catalogResultsCard", false);
    resetAnalysisPanels();
    setAlert("");
    state.lastSearch = null;
    state.categories.clear();
    setStatus("Pronto para analisar", "ready");
  }

  function renderKpis(analysis) {
    const grid = $("marketKpis");
    if (!grid) return;
    if (!analysis) {
      grid.innerHTML = "";
      grid.hidden = true;
      return;
    }

    const market = analysis.market || {};
    const opportunity = analysis.opportunity || {};
    const rows = [
      ["Score Davantti", `${number(opportunity.score)}/100`, opportunity.label || "Heurística interna", "score"],
      ["Itens na categoria", number(market.category_total_items), "Total informado pela categoria", "category"],
      ["Sellers na amostra", number(market.sellers_in_sample), `${number(market.sample_count)} ofertas avaliadas`, "sellers"],
      ["Preço mediano", money(market.median_price), `Média ${money(market.avg_price)}`, "price"],
      ["Frete grátis", percent(market.free_shipping_pct), `Full ${percent(market.full_pct)}`, "shipping"],
    ];

    grid.hidden = false;
    grid.innerHTML = rows.map(([label, value, sub, kind]) => `
      <article class="rank-kpi market-kpi market-kpi--${escapeHtml(kind)}">
        <div class="rank-kpi__label">${escapeHtml(label)}</div>
        <div class="rank-kpi__value">${escapeHtml(value)}</div>
        <div class="rank-kpi__sub">${escapeHtml(sub)}</div>
      </article>
    `).join("");
  }

  function renderCategories(categories) {
    const grid = $("categoryResults");
    const label = $("categoryResultLabel");
    const rows = Array.isArray(categories) ? categories : [];
    state.categories.clear();
    rows.forEach((category) => state.categories.set(category.id, category));

    if (label) {
      label.textContent = rows.length
        ? `${rows.length} categoria(s) sugerida(s). A primeira tende a ser a mais provável.`
        : "Nenhuma categoria encontrada para esse termo.";
    }
    if (!grid) return;
    if (!rows.length) {
      renderEmpty(grid, "Nenhuma categoria encontrada para esse termo.");
      return;
    }

    grid.innerHTML = rows.map((category, index) => `
      <article class="market-category-card ${index === 0 ? "is-primary" : ""}">
        <div class="market-category-card__top">
          <span class="market-category-card__eyebrow">${escapeHtml(category.id)}</span>
          ${index === 0 ? '<span class="market-pill market-pill--blue">Mais provável</span>' : ""}
        </div>
        <div>
          <h3 class="market-category-card__title">${escapeHtml(category.name)}</h3>
          <div class="market-category-card__meta">${escapeHtml(category.domain_name || category.domain_id || "Categoria Mercado Livre")}</div>
        </div>
        <div class="market-category-card__actions">
          <button
            class="rank-btn rank-btn--ghost rank-btn--compact"
            type="button"
            data-keywords-category="${escapeHtml(category.id)}">
            Palavras-chave
          </button>
          <button
            class="rank-btn rank-btn--ghost rank-btn--compact"
            type="button"
            data-trend-category="${escapeHtml(category.id)}">
            Tendências
          </button>
          <button
            class="rank-btn rank-btn--primary rank-btn--compact"
            type="button"
            data-analyze-category="${escapeHtml(category.id)}"
            data-domain-id="${escapeHtml(category.domain_id || "")}">
            Analisar categoria
          </button>
        </div>
      </article>
    `).join("");
  }

  function renderCatalogProducts(products) {
    const grid = $("catalogResults");
    const label = $("catalogResultLabel");
    const rows = Array.isArray(products) ? products : [];
    if (label) {
      label.textContent = rows.length
        ? `${rows.length} produto(s) de catálogo relacionado(s) ao termo.`
        : "Nenhum produto de catálogo relacionado foi retornado.";
    }
    if (!grid) return;
    if (!rows.length) {
      renderEmpty(grid, "Nenhum produto de catálogo foi encontrado. Isso não impede a análise da categoria.");
      return;
    }

    grid.innerHTML = rows.map((product) => {
      const href = safeUrl(product.permalink);
      const picture = product.thumbnail
        ? `<img src="${escapeHtml(product.thumbnail)}" alt="" loading="lazy" />`
        : '<div class="market-catalog-card__placeholder" aria-hidden="true">▦</div>';
      const title = href
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(product.title || product.id)}</a>`
        : `<span>${escapeHtml(product.title || product.id)}</span>`;
      return `
        <article class="market-catalog-card">
          ${picture}
          <div class="market-catalog-card__body">
            <div class="market-catalog-card__id">${escapeHtml(product.id || "")}</div>
            <div class="market-catalog-card__title">${title}</div>
            <div class="market-catalog-card__meta">
              <span>${escapeHtml(product.domain_id || "Catálogo")}</span>
              ${product.listing_strategy ? `<span class="market-pill market-pill--blue">${escapeHtml(product.listing_strategy)}</span>` : ""}
            </div>
          </div>
        </article>
      `;
    }).join("");
  }

  function renderTrends(trends, targetId = "categoryTrends", max = 50) {
    const grid = $(targetId);
    if (!grid) return;
    const rows = Array.isArray(trends) ? trends.slice(0, max) : [];
    if (!rows.length) {
      renderEmpty(grid, "Nenhuma tendência retornada para esta consulta.");
      return;
    }

    grid.innerHTML = rows.map((trend) => {
      const href = safeUrl(trend.url);
      return `
        <article class="market-trend-card">
          <div class="market-trend-card__top">
            <span class="market-trend-card__rank">#${number(trend.rank)}</span>
            <span class="market-trend-card__segment">${escapeHtml(trend.segment_label || "Tendência semanal")}</span>
          </div>
          <div class="market-trend-card__keyword">${escapeHtml(trend.keyword)}</div>
          <div class="market-trend-card__actions">
            ${href ? `<a class="market-link" href="${escapeHtml(href)}" target="_blank" rel="noopener">Abrir no ML</a>` : "<span></span>"}
            <button class="rank-btn rank-btn--ghost rank-btn--compact" type="button" data-search-keyword="${escapeHtml(trend.keyword)}">Explorar</button>
          </div>
        </article>
      `;
    }).join("");
  }

  function renderBestSellers(bestSellers) {
    const grid = $("bestSellersGrid");
    const label = $("bestSellersLabel");
    const rows = Array.isArray(bestSellers) ? bestSellers : [];
    if (label) {
      label.textContent = rows.length
        ? `${rows.length} posição(ões) retornada(s) pelo ranking de mais vendidos.`
        : "O ranking de mais vendidos não foi retornado para esta categoria.";
    }
    if (!grid) return;
    if (!rows.length) {
      renderEmpty(grid, "Ranking indisponível para esta categoria. Os demais dados podem continuar válidos.");
      return;
    }

    grid.innerHTML = rows.map((row) => {
      const href = safeUrl(row.permalink);
      const image = row.thumbnail
        ? `<img src="${escapeHtml(row.thumbnail)}" alt="" loading="lazy" />`
        : '<div class="market-best-card__placeholder" aria-hidden="true">↗</div>';
      const title = href
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(row.title || row.id)}</a>`
        : `<span>${escapeHtml(row.title || row.id)}</span>`;
      return `
        <article class="market-best-card">
          <div class="market-best-card__rank">#${number(row.position)}</div>
          ${image}
          <div class="market-best-card__body">
            <div class="market-best-card__type">${escapeHtml(row.type_label || row.type || "Ranking")}</div>
            <div class="market-best-card__title">${title}</div>
            <div class="market-best-card__footer">
              <span>${row.price == null ? escapeHtml(row.id || "") : money(row.price)}</span>
              ${row.logistic_type === "fulfillment" ? '<span class="market-pill market-pill--green">Full</span>' : ""}
            </div>
          </div>
        </article>
      `;
    }).join("");
  }

  function logisticsLabel(item) {
    const type = String(item?.logistic_type || "").toLowerCase();
    if (type === "fulfillment") return "Full";
    if (type === "cross_docking") return "Coleta";
    if (type === "xd_drop_off") return "Agência";
    if (type === "self_service") return "Flex";
    return type || "-";
  }

  function renderProducts(products) {
    const body = $("marketProductsBody");
    if (!body) return;
    const rows = Array.isArray(products) ? products : [];
    if (!rows.length) {
      renderEmpty(body, "Nenhuma oferta concorrente pôde ser montada para esta categoria.", 6);
      return;
    }

    body.innerHTML = rows.map((item) => {
      const href = safeUrl(item.permalink);
      const image = item.thumbnail
        ? `<img src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy" />`
        : '<span class="market-product__placeholder" aria-hidden="true">▦</span>';
      const title = href
        ? `<a class="market-product__title" href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(item.title || item.id || "-")}</a>`
        : `<span class="market-product__title">${escapeHtml(item.title || item.id || "-")}</span>`;
      const sourceClass = item.source === "best_seller_item" ? "market-pill--yellow" : "market-pill--blue";
      return `
        <tr>
          <td>
            <div class="market-product">
              ${image}
              <div>
                ${title}
                <div class="market-product__id">${escapeHtml(item.id || "")}${item.catalog_product_id ? ` · PDP ${escapeHtml(item.catalog_product_id)}` : ""}</div>
              </div>
            </div>
          </td>
          <td><span class="rank-value">${money(item.price)}</span></td>
          <td>${escapeHtml(item.seller_nickname || (item.seller_id ? `#${item.seller_id}` : "-"))}</td>
          <td>${item.free_shipping ? '<span class="market-pill market-pill--green">Grátis</span>' : '<span class="market-pill">Pago</span>'}</td>
          <td>${escapeHtml(logisticsLabel(item))}</td>
          <td><span class="market-pill ${sourceClass}">${escapeHtml(item.source_label || "Amostra")}</span></td>
        </tr>
      `;
    }).join("");
  }

  function renderSummary(analysis) {
    const wrap = $("analysisSummary");
    const label = $("analysisLabel");
    if (!wrap) return;
    if (!analysis) {
      renderEmpty(wrap, "Aguardando categoria.");
      return;
    }

    const category = analysis.category || {};
    const market = analysis.market || {};
    const opp = analysis.opportunity || {};
    const path = (category.path_from_root || []).map((row) => row.name).filter(Boolean).join(" › ");
    if (label) label.textContent = `${category.name || category.id || "Categoria"}${path ? ` · ${path}` : ""}`;

    const sources = [
      market.best_sellers_count > 0 ? `${number(market.best_sellers_count)} mais vendidos` : null,
      analysis.trends?.length ? `${number(analysis.trends.length)} tendências` : null,
      market.pdp_products_analyzed > 0 ? `${number(market.pdp_products_analyzed)} PDPs analisadas` : null,
      market.user_products_analyzed > 0 ? `${number(market.user_products_analyzed)} User Products` : null,
      market.sample_count > 0 ? `${number(market.sample_count)} ofertas na amostra` : null,
    ].filter(Boolean);

    wrap.innerHTML = `
      <div class="market-score">
        <div class="market-score__top">
          <div class="market-score__label">Score Davantti</div>
          <span class="market-confidence">Confiança ${escapeHtml(opp.confidence || "baixa")}</span>
        </div>
        <div class="market-score__value">${number(opp.score)}</div>
        <div class="market-score__text">${escapeHtml(opp.label || "-")}</div>
        <div class="market-score__sub">Heurística interna baseada em sinais de demanda, ticket e concorrência. Não é uma métrica oficial do Mercado Livre.</div>
        <div class="market-source-chips">${sources.map((source) => `<span>${escapeHtml(source)}</span>`).join("")}</div>
      </div>
      <div class="market-detail-grid">
        <div class="market-detail"><span>Categoria</span><strong>${escapeHtml(category.name || category.id || "-")}</strong><small>${escapeHtml(category.id || "")}</small></div>
        <div class="market-detail"><span>Itens na categoria</span><strong>${number(market.category_total_items)}</strong><small>Informado pelo recurso de categoria</small></div>
        <div class="market-detail"><span>Sellers na amostra</span><strong>${number(market.sellers_in_sample)}</strong><small>${number(market.sample_count)} ofertas avaliadas</small></div>
        <div class="market-detail"><span>Preço mediano</span><strong>${money(market.median_price)}</strong><small>${money(market.min_price)} a ${money(market.max_price)}</small></div>
        <div class="market-detail"><span>Frete grátis</span><strong>${percent(market.free_shipping_pct)}</strong><small>Full em ${percent(market.full_pct)} da amostra</small></div>
        <div class="market-detail"><span>Catálogo na amostra</span><strong>${percent(market.catalog_pct)}</strong><small>${number(market.catalog_products_found)} produto(s) relacionado(s)</small></div>
      </div>
    `;
  }

  function categoryPathHtml(rows, action = "analyze") {
    const path = Array.isArray(rows) ? rows : [];
    if (!path.length) return "";
    return path.map((row, index) => {
      const attr = action === "trend" ? "data-trend-category" : "data-analyze-category";
      const separator = index ? '<span class="market-category-path__sep">›</span>' : "";
      return `${separator}<button type="button" ${attr}="${escapeHtml(row.id || "")}">${escapeHtml(row.name || row.id || "Categoria")}</button>`;
    }).join("");
  }

  function categoryNavigationCards(rows, { context = "market" } = {}) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return '<div class="rank-empty">Nenhuma categoria próxima disponível nesta parte da árvore.</div>';
    return list.map((row) => `
      <article class="market-submarket-card">
        <div class="market-submarket-card__id">${escapeHtml(row.id || "")}</div>
        <h3>${escapeHtml(row.name || row.id || "Categoria")}</h3>
        <div class="market-submarket-card__meta">${row.total_items_in_this_category == null ? "Quantidade não informada" : `${number(row.total_items_in_this_category)} itens na categoria`}</div>
        <div class="market-submarket-card__actions">
          <button class="rank-btn rank-btn--ghost rank-btn--compact" type="button" data-keywords-category="${escapeHtml(row.id || "")}">Palavras-chave</button>
          <button class="rank-btn rank-btn--ghost rank-btn--compact" type="button" data-trend-category="${escapeHtml(row.id || "")}">Tendências</button>
          ${context === "market" ? `<button class="rank-btn rank-btn--primary rank-btn--compact" type="button" data-analyze-category="${escapeHtml(row.id || "")}" data-category-name="${escapeHtml(row.name || "")}">Analisar</button>` : `<button class="rank-btn rank-btn--primary rank-btn--compact" type="button" data-analyze-category="${escapeHtml(row.id || "")}" data-category-name="${escapeHtml(row.name || "")}">Mercado</button>`}
        </div>
      </article>
    `).join("");
  }

  function renderMarketExplorer(analysis) {
    const card = $("marketExplorerCard");
    const grid = $("marketExplorerGrid");
    const pathHost = $("marketExplorerPath");
    const label = $("marketExplorerLabel");
    if (!card || !grid || !pathHost) return;
    const navigation = analysis?.navigation || {};
    const children = Array.isArray(navigation.children) ? navigation.children : [];
    const siblings = Array.isArray(navigation.siblings) ? navigation.siblings : [];
    const rows = children.length ? children : siblings;
    card.hidden = false;
    pathHost.innerHTML = categoryPathHtml(navigation.path, "analyze");
    if (label) {
      label.textContent = children.length
        ? `${number(children.length)} subcategoria(s) para aprofundar a análise sem voltar à busca geral.`
        : siblings.length
          ? `Categoria final. Mostrando ${number(siblings.length)} categoria(s) próxima(s) dentro de ${navigation.parent?.name || "sua categoria pai"}.`
          : "Esta categoria não retornou subcategorias ou categorias irmãs navegáveis.";
    }
    grid.innerHTML = categoryNavigationCards(rows, { context: "market" });
  }

  function showAnalysisPanels() {
    show("marketKpis", true);
    show("analysisSummaryCard", true);
    show("marketExplorerCard", true);
    show("bestSellersCard", true);
    show("categoryTrendsCard", true);
    show("marketProductsCard", true);
  }

  async function analyzeCategory(categoryId, domainId = "") {
    const id = String(categoryId || "").trim();
    if (!id) return;

    const seq = ++state.requestSeq;
    const sampleLimit = $("sampleLimit")?.value || "50";
    const searchQuery = String($("marketQuery")?.value || state.lastSearch?.query || "").trim();
    const category = state.categories.get(id) || {};
    const resolvedDomainId = String(domainId || category.domain_id || "").trim();

    state.selectedCategoryId = id;
    state.selectedDomainId = resolvedDomainId || null;
    setAlert("");
    setLoading("Analisando categoria");
    showAnalysisPanels();
    renderEmpty("analysisSummary", "Carregando análise...");
    renderEmpty("marketExplorerGrid", "Carregando árvore da categoria...");
    $("marketExplorerPath") && ($("marketExplorerPath").innerHTML = "");
    renderEmpty("bestSellersGrid", "Carregando mais vendidos...");
    renderEmpty("categoryTrends", "Carregando tendências...");
    renderEmpty("marketProductsBody", "Montando amostra concorrente...", 6);

    const params = new URLSearchParams({ sample_limit: sampleLimit });
    if (searchQuery) params.set("q", searchQuery);
    if (resolvedDomainId) params.set("domain_id", resolvedDomainId);

    try {
      const data = await apiJson(`/api/market-analysis/category/${encodeURIComponent(id)}?${params.toString()}`);
      if (seq !== state.requestSeq) return;

      state.lastAnalysis = data;
      renderKpis(data);
      renderSummary(data);
      renderMarketExplorer(data);
      renderBestSellers(data.best_sellers);
      renderTrends(data.trends);
      renderProducts(data.products);

      const trendsLabel = $("trendsLabel");
      const productsLabel = $("productsLabel");
      if (trendsLabel) {
        trendsLabel.textContent = data.trends?.length
          ? `${number(data.trends.length)} tendência(s) semanal(is) retornada(s).`
          : "Tendências indisponíveis nesta consulta; os demais dados continuam visíveis.";
      }
      if (productsLabel) {
        const sourceParts = [];
        if (data.market?.pdp_products_analyzed) sourceParts.push(`${number(data.market.pdp_products_analyzed)} PDP(s)`);
        if (data.market?.user_products_analyzed) sourceParts.push(`${number(data.market.user_products_analyzed)} User Product(s)`);
        if (data.market?.best_sellers_count) sourceParts.push("ranking de mais vendidos");
        productsLabel.textContent = data.market?.sample_count
          ? `${number(data.market.sample_count)} oferta(s) concorrente(s) na amostra${sourceParts.length ? ` · fontes: ${sourceParts.join(", ")}` : ""}.`
          : "Nenhuma oferta concorrente pôde ser montada para esta categoria.";
      }

      if (Array.isArray(data.warnings) && data.warnings.length) {
        setAlert(warningMessage(data.warnings), "warn");
        setStatus("Análise parcial carregada", "warn");
      } else {
        setAlert("");
        setStatus("Análise carregada", "ready");
      }
    } catch (error) {
      setAlert(error.message || "Falha ao analisar categoria.", "error");
      setStatus("Erro na análise", "error");
      renderEmpty("analysisSummary", "Não foi possível carregar a análise.");
      renderEmpty("marketExplorerGrid", "Não foi possível carregar a árvore da categoria.");
      renderEmpty("bestSellersGrid", "Não foi possível carregar o ranking.");
      renderEmpty("categoryTrends", "Não foi possível carregar tendências.");
      renderEmpty("marketProductsBody", "Não foi possível montar a amostra concorrente.", 6);
    }
  }

  async function suggestCategories(query) {
    const q = String(query || "").trim();
    window.clearTimeout(state.suggestTimer);

    if (q.length < 3) {
      if (!q) resetExploreResults();
      return;
    }

    state.suggestTimer = window.setTimeout(async () => {
      const seq = ++state.suggestSeq;
      show("categoryResultsCard", true);
      show("catalogResultsCard", false);
      resetAnalysisPanels();
      renderEmpty("categoryResults", "Buscando sugestões de categorias...");
      setLoading("Sugerindo categorias");

      try {
        const data = await apiJson(`/api/market-analysis/categories/suggest?q=${encodeURIComponent(q)}`);
        if (seq !== state.suggestSeq) return;
        renderCategories(data.categories);
        if (data.warnings?.length) {
          setAlert(warningMessage(data.warnings), "warn");
          setStatus("Sugestão parcial", "warn");
        } else {
          setStatus("Categorias sugeridas", "ready");
        }
      } catch (error) {
        if (seq !== state.suggestSeq) return;
        setAlert(error.message || "Falha ao buscar sugestões de categorias.", "error");
        setStatus("Erro na sugestão", "error");
        renderEmpty("categoryResults", "Não foi possível buscar categorias.");
      }
    }, 320);
  }

  async function searchMarket(query) {
    const q = String(query || "").trim();
    if (!q) {
      setAlert("Digite um produto, categoria ou palavra-chave para pesquisar.", "warn");
      return;
    }

    const seq = ++state.requestSeq;
    state.suggestSeq += 1;
    window.clearTimeout(state.suggestTimer);
    setAlert("");
    setLoading("Buscando mercado");
    resetAnalysisPanels();
    show("categoryResultsCard", true);
    show("catalogResultsCard", true);
    renderEmpty("categoryResults", "Buscando categorias...");
    renderEmpty("catalogResults", "Buscando produtos de catálogo relacionados...");

    try {
      const data = await apiJson(`/api/market-analysis/search?q=${encodeURIComponent(q)}`);
      if (seq !== state.requestSeq) return;
      state.lastSearch = data;
      renderCategories(data.categories);
      renderCatalogProducts(data.catalog_products);

      if (Array.isArray(data.warnings) && data.warnings.length) {
        setAlert(warningMessage(data.warnings), "warn");
        setStatus("Busca parcial carregada", "warn");
      } else {
        setStatus("Busca carregada", "ready");
      }
    } catch (error) {
      setAlert(error.message || "Falha ao buscar mercado.", "error");
      setStatus("Erro na busca", "error");
      renderEmpty("categoryResults", "Não foi possível buscar categorias.");
      renderEmpty("catalogResults", "Não foi possível buscar produtos de catálogo.");
    }
  }


  function keywordSourceLabel(source) {
    if (source === "trends") return "Trends";
    if (source === "leaders") return "Líderes";
    if (source === "catalog") return "Catálogo";
    if (source === "parent_trends") return "Categoria pai";
    if (source === "category") return "Árvore";
    if (source === "related_category") return "Categoria relacionada";
    if (source === "query") return "Busca";
    return source || "Sinal";
  }

  function keywordSegmentClass(segment) {
    if (segment === "growth") return "market-pill--green";
    if (segment === "desired") return "market-pill--blue";
    if (segment === "popular") return "market-pill--yellow";
    return "";
  }

  function renderKeywordContext(data) {
    const card = $("keywordContextCard");
    const host = $("keywordContext");
    const label = $("keywordContextLabel");
    if (!card || !host) return;

    const input = data?.input || {};
    const category = data?.category || {};
    const item = data?.item || null;
    const typeLabel = input.type === "item" ? "MLB" : input.type === "category" ? "Categoria" : "Termo";
    card.hidden = false;
    if (label) {
      label.textContent = item
        ? `MLB identificado e associado à categoria ${category.id || "-"}.`
        : `${typeLabel} resolvido para a categoria ${category.id || "-"}.`;
    }

    const image = item?.thumbnail
      ? `<img class="market-keyword-context__image" src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy" />`
      : '<div class="market-keyword-context__image market-keyword-context__placeholder" aria-hidden="true">⌕</div>';
    const href = safeUrl(item?.permalink);
    const title = item
      ? href
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(item.title || item.id)}</a>`
        : escapeHtml(item.title || item.id)
      : escapeHtml(input.resolved_query || category.name || input.value || "Pesquisa");

    host.innerHTML = `
      <div class="market-keyword-context__main">
        ${item ? image : ""}
        <div>
          <div class="market-keyword-context__type">${escapeHtml(typeLabel)}</div>
          <div class="market-keyword-context__title">${title}</div>
          <div class="market-keyword-context__meta">
            ${item?.id ? `<span class="market-pill market-pill--blue">${escapeHtml(item.id)}</span>` : ""}
            <span>${escapeHtml(category.name || "Categoria Mercado Livre")}</span>
            <strong>${escapeHtml(category.id || "-")}</strong>
          </div>
        </div>
      </div>
      <div class="market-keyword-context__aside">
        <span>Entrada</span>
        <strong>${escapeHtml(input.value || "-")}</strong>
        <small>${data?.domain_id ? `Domínio: ${escapeHtml(data.domain_id)}` : "Categoria identificada automaticamente"}</small>
      </div>
    `;
  }

  function renderKeywordKpis(data) {
    const grid = $("keywordKpis");
    if (!grid) return;
    const summary = data?.summary || {};
    const isItem = data?.input?.type === "item";
    const rows = [
      ["Palavras ranqueadas", number(summary.keyword_count), `${number(summary.official_trends_analyzed)} Trends oficial(is) · ${number(summary.parent_trends_analyzed)} da categoria pai`],
      ["Líderes analisados", number(summary.leaders_analyzed), `${number(summary.leader_term_count)} termo(s) recorrente(s)`],
      ["Produtos de catálogo", number(summary.catalog_products_analyzed), `${number(summary.catalog_term_count)} termo(s) com sinal de catálogo`],
      isItem
        ? ["Cobertura SEO", percent(summary.coverage_pct), `${number(summary.covered_count)} de ${number(summary.coverage_base_count)} termos fortes`]
        : ["Categoria", data?.category?.id || "-", data?.category?.name || "Categoria resolvida"],
      isItem
        ? ["Oportunidades", number(summary.opportunity_count), `${number(summary.high_opportunity_count)} de alta prioridade`]
        : ["Top sinais", number((data?.keywords || []).filter((row) => Number(row.score) >= 70).length), "Score Davantti ≥ 70"],
    ];

    grid.hidden = false;
    grid.innerHTML = rows.map(([label, value, sub]) => `
      <article class="rank-kpi market-kpi market-keyword-kpi">
        <div class="rank-kpi__label">${escapeHtml(label)}</div>
        <div class="rank-kpi__value">${escapeHtml(value)}</div>
        <div class="rank-kpi__sub">${escapeHtml(sub)}</div>
      </article>
    `).join("");
  }

  function keywordFilteredRows(data = state.keywordData) {
    const allRows = Array.isArray(data?.keywords) ? [...data.keywords] : [];
    const text = String($("keywordFilter")?.value || "").trim().toLocaleLowerCase("pt-BR");
    const source = $("keywordSourceFilter")?.value || "all";
    const sort = $("keywordSort")?.value || "score";
    const rows = allRows.filter((row) => {
      if (text && !String(row.keyword || "").toLocaleLowerCase("pt-BR").includes(text)) return false;
      if (source === "category") {
        return (row.sources || []).includes("category") || (row.sources || []).includes("related_category");
      }
      if (source !== "all" && !(row.sources || []).includes(source)) return false;
      return true;
    });

    if (sort === "trend") {
      rows.sort((a, b) => {
        const aTrend = a.trend_rank ? 0 : a.parent_trend_rank ? 1 : 2;
        const bTrend = b.trend_rank ? 0 : b.parent_trend_rank ? 1 : 2;
        return (aTrend - bTrend)
          || ((a.trend_rank || a.parent_trend_rank || 999) - (b.trend_rank || b.parent_trend_rank || 999))
          || (Number(b.score || 0) - Number(a.score || 0));
      });
    } else if (sort === "leaders") {
      rows.sort((a, b) => (Number(b.leader_presence_pct || 0) - Number(a.leader_presence_pct || 0)) || (Number(b.score || 0) - Number(a.score || 0)));
    } else if (sort === "az") {
      rows.sort((a, b) => String(a.keyword || "").localeCompare(String(b.keyword || ""), "pt-BR"));
    } else {
      rows.sort((a, b) => (Number(b.score || 0) - Number(a.score || 0)) || (Number(a.rank || 9999) - Number(b.rank || 9999)));
    }
    return rows;
  }

  function renderKeywordPagination(totalRows) {
    const pagination = $("keywordPagination");
    const info = $("keywordPageInfo");
    const prev = $("keywordPrev");
    const next = $("keywordNext");
    const count = $("keywordCountLabel");
    const pageSize = state.keywordPageSize;
    const totalPages = Math.max(1, Math.ceil(Number(totalRows || 0) / pageSize));
    state.keywordPage = Math.min(Math.max(1, state.keywordPage), totalPages);
    if (count) count.textContent = `${number(totalRows)} palavra(s) encontrada(s)`;
    if (!pagination) return;
    pagination.hidden = Number(totalRows || 0) <= pageSize;
    if (info) {
      const start = totalRows ? ((state.keywordPage - 1) * pageSize) + 1 : 0;
      const finish = Math.min(state.keywordPage * pageSize, totalRows);
      info.textContent = `${number(start)}–${number(finish)} de ${number(totalRows)} · Página ${number(state.keywordPage)} de ${number(totalPages)}`;
    }
    if (prev) prev.disabled = state.keywordPage <= 1;
    if (next) next.disabled = state.keywordPage >= totalPages;
  }

  function renderKeywordTable(data = state.keywordData) {
    const body = $("keywordTableBody");
    const card = $("keywordTopCard");
    const statusHead = $("keywordItemStatusHead");
    if (!body || !card) return;
    const isItem = data?.input?.type === "item";
    card.hidden = false;
    if (statusHead) statusHead.textContent = isItem ? "No anúncio" : "Contexto";

    const filtered = keywordFilteredRows(data);
    renderKeywordPagination(filtered.length);
    if (!filtered.length) {
      renderEmpty(body, "Nenhuma palavra corresponde aos filtros atuais.", 7);
      return;
    }

    const start = (state.keywordPage - 1) * state.keywordPageSize;
    const rows = filtered.slice(start, start + state.keywordPageSize);
    body.innerHTML = rows.map((row) => {
      const sources = (row.sources || []).map((source) => `<span class="market-mini-source market-mini-source--${escapeHtml(source)}">${escapeHtml(keywordSourceLabel(source))}</span>`).join("");
      let trend = '<span class="market-keyword-muted">—</span>';
      if (row.trend_segment_label) {
        trend = `<span class="market-pill ${keywordSegmentClass(row.trend_segment)}">${escapeHtml(row.trend_segment_label)}</span>${row.trend_rank ? `<small>Oficial #${number(row.trend_rank)}</small>` : ""}`;
      } else if (row.parent_trend_segment_label) {
        trend = `<span class="market-pill market-pill--neutral">Categoria pai</span><small>${escapeHtml(row.parent_trend_segment_label)}${row.parent_trend_rank ? ` · #${number(row.parent_trend_rank)}` : ""}</small>`;
      }
      const leaders = row.leader_total
        ? `<strong>${percent(row.leader_presence_pct)}</strong><small>${number(row.leader_count)} de ${number(row.leader_total)} líder(es)</small>`
        : '<span class="market-keyword-muted">Sem amostra</span>';
      let itemStatus = '<span class="market-keyword-muted">Categoria</span>';
      if (isItem) {
        itemStatus = row.present_in_item
          ? `<span class="market-positive-text">Presente</span><small>${escapeHtml((row.item_locations || []).join(" + ") || "Título/atributos")}</small>`
          : row.opportunity_level
            ? `<span class="market-warning-text">Oportunidade</span><small>Validar aderência</small>`
            : '<span class="market-keyword-muted">Ausente</span>';
      }
      return `
        <tr>
          <td class="market-keyword-rank">#${number(row.rank)}</td>
          <td><strong class="market-keyword-name">${escapeHtml(row.keyword)}</strong></td>
          <td><div class="market-mini-sources">${sources || '<span class="market-keyword-muted">—</span>'}</div></td>
          <td><div class="market-keyword-stack">${trend}</div></td>
          <td><div class="market-keyword-stack">${leaders}</div></td>
          <td><span class="market-keyword-score">${number(row.score)}</span><small>/100</small></td>
          <td><div class="market-keyword-stack">${itemStatus}</div></td>
        </tr>
      `;
    }).join("");
  }

  function renderLeaderTerms(data) {
    const card = $("keywordLeadersCard");
    const grid = $("keywordLeaderTerms");
    if (!card || !grid) return;
    const rows = Array.isArray(data?.leader_terms) ? data.leader_terms : [];
    card.hidden = false;
    if (!rows.length) {
      renderEmpty(grid, "Não houve títulos suficientes no ranking de mais vendidos para formar termos recorrentes.");
      return;
    }
    grid.innerHTML = rows.map((row) => `
      <article class="market-keyword-chip-card">
        <div class="market-keyword-chip-card__top">
          <strong>${escapeHtml(row.keyword)}</strong>
          <span>${number(row.score)}/100</span>
        </div>
        <div class="market-keyword-chip-card__bar"><i style="width:${Math.max(0, Math.min(100, Number(row.leader_presence_pct || 0)))}%"></i></div>
        <small>Presente em ${percent(row.leader_presence_pct)} dos líderes analisados</small>
      </article>
    `).join("");
  }

  function renderKeywordOpportunities(data) {
    const card = $("keywordOpportunitiesCard");
    const grid = $("keywordOpportunities");
    if (!card || !grid) return;
    const isItem = data?.input?.type === "item";
    const rows = Array.isArray(data?.opportunities) ? data.opportunities : [];
    card.hidden = !isItem;
    if (!isItem) return;
    if (!rows.length) {
      renderEmpty(grid, "Nenhuma oportunidade forte foi identificada entre as palavras ranqueadas. Isso não significa que o anúncio esteja totalmente otimizado.");
      return;
    }
    grid.innerHTML = rows.map((row) => {
      const priority = row.opportunity_level === "high" ? "Alta" : row.opportunity_level === "medium" ? "Média" : "Revisar";
      const pillClass = row.opportunity_level === "high" ? "market-pill--green" : row.opportunity_level === "medium" ? "market-pill--blue" : "market-pill--yellow";
      return `
        <article class="market-opportunity-card">
          <div class="market-opportunity-card__top">
            <span class="market-pill ${pillClass}">${priority}</span>
            <strong>${number(row.score)}/100</strong>
          </div>
          <h3>${escapeHtml(row.keyword)}</h3>
          <div class="market-opportunity-card__meta">
            ${row.trend_segment_label ? `<span>${escapeHtml(row.trend_segment_label)}</span>` : ""}
            ${row.leader_total ? `<span>${percent(row.leader_presence_pct)} dos líderes</span>` : ""}
          </div>
          <p>O termo é forte na categoria, mas não foi localizado no título ou atributos deste MLB. Confirme se descreve o produto antes de usar.</p>
        </article>
      `;
    }).join("");
  }

  function resetKeywordResults() {
    state.keywordData = null;
    state.keywordPage = 1;
    show("keywordPagination", false);
    show("keywordContextCard", false);
    show("keywordKpis", false);
    show("keywordTopCard", false);
    show("keywordLeadersCard", false);
    show("keywordOpportunitiesCard", false);
  }

  async function searchKeywords(query) {
    const q = String(query || "").trim();
    if (!q) {
      setAlert("Digite um termo, categoria ou MLB para analisar palavras-chave.", "warn");
      return;
    }
    const seq = ++state.keywordSeq;
    setAlert("");
    setLoading("Analisando palavras-chave");
    resetKeywordResults();
    show("keywordTopCard", true);
    renderEmpty("keywordTableBody", "Coletando tendências, líderes e catálogo...", 7);

    try {
      const data = await apiJson(`/api/market-analysis/keywords?q=${encodeURIComponent(q)}`);
      if (seq !== state.keywordSeq) return;
      state.keywordData = data;
      state.keywordPage = 1;
      if ($("keywordFilter")) $("keywordFilter").value = "";
      if ($("keywordSourceFilter")) $("keywordSourceFilter").value = "all";
      if ($("keywordSort")) $("keywordSort").value = "score";
      renderKeywordContext(data);
      renderKeywordKpis(data);
      renderKeywordTable(data);
      renderLeaderTerms(data);
      renderKeywordOpportunities(data);
      if (Array.isArray(data.warnings) && data.warnings.length) {
        setAlert(warningMessage(data.warnings), "warn");
        setStatus("Palavras-chave com dados parciais", "warn");
      } else {
        setStatus("Palavras-chave carregadas", "ready");
      }
    } catch (error) {
      if (seq !== state.keywordSeq) return;
      setAlert(error.message || "Falha ao analisar palavras-chave.", "error");
      setStatus("Erro nas palavras-chave", "error");
      show("keywordTopCard", true);
      renderEmpty("keywordTableBody", "Não foi possível carregar as palavras-chave.", 7);
    }
  }

  function filteredGeneralTrends() {
    const text = String($("generalTrendFilter")?.value || "").trim().toLocaleLowerCase("pt-BR");
    const segment = $("generalTrendSegment")?.value || "all";
    return (Array.isArray(state.generalTrends) ? state.generalTrends : []).filter((trend) => {
      if (text && !String(trend.keyword || "").toLocaleLowerCase("pt-BR").includes(text)) return false;
      if (segment !== "all" && trend.segment !== segment) return false;
      return true;
    });
  }

  function renderGeneralTrends() {
    const rows = filteredGeneralTrends();
    renderTrends(rows, "suggestionsGrid", 50);
    const count = $("generalTrendCount");
    if (count) {
      count.textContent = state.generalTrends.length
        ? `${number(rows.length)} de ${number(state.generalTrends.length)} tendência(s) oficial(is) exibida(s).`
        : "Nenhuma tendência geral carregada.";
    }
  }

  function switchTrendMode(mode) {
    const next = mode === "category" ? "category" : "general";
    state.trendMode = next;
    qsa("[data-trend-mode]").forEach((button) => {
      const active = button.dataset.trendMode === next;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    qsa("[data-trend-mode-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.trendModePanel !== next;
    });
    show("generalTrendsCard", next === "general");
    show("categoryTrendExplorerCard", next === "category" && Boolean(state.categoryTrendData));
    if (next === "general" && state.currentTab === "sugestoes" && !$("suggestionsGrid")?.dataset.loaded) {
      $("suggestionsGrid").dataset.loaded = "1";
      loadSuggestions();
    }
  }

  function renderTrendCategorySuggestions(categories) {
    const host = $("trendCategorySuggestions");
    if (!host) return;
    const rows = Array.isArray(categories) ? categories : [];
    if (!rows.length) {
      renderEmpty(host, "Nenhuma categoria sugerida para esse termo.");
      return;
    }
    host.innerHTML = rows.map((category, index) => `
      <article class="market-trend-category-option ${index === 0 ? "is-primary" : ""}">
        <div>
          <span>${escapeHtml(category.id || "")}</span>
          <strong>${escapeHtml(category.name || category.id || "Categoria")}</strong>
          <small>${escapeHtml(category.domain_name || category.domain_id || "Categoria Mercado Livre")}</small>
        </div>
        <div class="market-trend-category-option__actions">
          <button class="rank-btn rank-btn--ghost rank-btn--compact" type="button" data-keywords-category="${escapeHtml(category.id || "")}">Palavras-chave</button>
          <button class="rank-btn rank-btn--primary rank-btn--compact" type="button" data-trend-category="${escapeHtml(category.id || "")}">Ver tendências</button>
        </div>
      </article>
    `).join("");
  }

  async function searchTrendCategories(query) {
    const q = String(query || "").trim();
    if (!q) {
      renderEmpty("trendCategorySuggestions", "Digite uma categoria ou termo para explorar.");
      return;
    }
    if (/^MLB\d+$/i.test(q.replace(/\s+/g, ""))) {
      await loadCategoryTrends(q.replace(/\s+/g, "").toUpperCase());
      return;
    }
    const seq = ++state.trendSeq;
    renderEmpty("trendCategorySuggestions", "Buscando categorias relacionadas...");
    setLoading("Buscando categorias");
    try {
      const data = await apiJson(`/api/market-analysis/categories/suggest?q=${encodeURIComponent(q)}`);
      if (seq !== state.trendSeq) return;
      renderTrendCategorySuggestions(data.categories);
      if (data.warnings?.length) {
        setAlert(warningMessage(data.warnings), "warn");
        setStatus("Categorias carregadas parcialmente", "warn");
      } else {
        setStatus("Categorias prontas para explorar", "ready");
      }
    } catch (error) {
      if (seq !== state.trendSeq) return;
      renderEmpty("trendCategorySuggestions", "Não foi possível buscar categorias.");
      setAlert(error.message || "Falha ao buscar categorias.", "error");
      setStatus("Erro ao buscar categorias", "error");
    }
  }

  function categoryTrendFilteredRows() {
    const text = String($("categoryTrendFilter")?.value || "").trim().toLocaleLowerCase("pt-BR");
    const rows = Array.isArray(state.categoryTrendData?.trends) ? state.categoryTrendData.trends : [];
    return rows.filter((trend) => !text || String(trend.keyword || "").toLocaleLowerCase("pt-BR").includes(text));
  }

  function renderCategoryTrendExplorer(data = state.categoryTrendData) {
    const card = $("categoryTrendExplorerCard");
    if (!card || !data) return;
    state.categoryTrendData = data;
    card.hidden = false;
    const category = data.category || {};
    const navigation = data.navigation || {};
    const title = $("categoryTrendTitle");
    const label = $("categoryTrendLabel");
    const badge = $("categoryTrendCountBadge");
    const path = $("categoryTrendPath");
    const status = $("categoryTrendStatus");
    if (title) title.textContent = `Tendências · ${category.name || category.id || "Categoria"}`;
    if (label) label.textContent = `${category.id || ""}${navigation.parent?.name ? ` · dentro de ${navigation.parent.name}` : ""}`;
    if (badge) badge.textContent = `${number(data.trends?.length || 0)} oficial(is)`;
    if (path) path.innerHTML = categoryPathHtml(navigation.path, "trend");

    const filtered = categoryTrendFilteredRows();
    renderTrends(filtered, "categoryTrendGrid", 50);
    if (status) status.textContent = `${number(filtered.length)} de ${number(data.trends?.length || 0)} tendência(s) oficial(is) exibida(s).`;

    const rows = navigation.children?.length ? navigation.children : navigation.siblings || [];
    const navHost = $("categoryTrendNavigation");
    if (navHost) navHost.innerHTML = categoryNavigationCards(rows, { context: "trend" });
  }

  async function loadCategoryTrends(categoryId) {
    const id = String(categoryId || "").trim().toUpperCase();
    if (!id) return;
    const seq = ++state.trendSeq;
    switchTrendMode("category");
    switchTab("sugestoes");
    show("categoryTrendExplorerCard", true);
    renderEmpty("categoryTrendGrid", "Carregando tendências oficiais da categoria...");
    renderEmpty("categoryTrendNavigation", "Carregando árvore da categoria...");
    setLoading("Carregando tendências da categoria");
    try {
      const data = await apiJson(`/api/market-analysis/trends/category/${encodeURIComponent(id)}`);
      if (seq !== state.trendSeq) return;
      if ($("categoryTrendFilter")) $("categoryTrendFilter").value = "";
      renderCategoryTrendExplorer(data);
      if (data.warnings?.length) {
        setAlert(warningMessage(data.warnings), "warn");
        setStatus("Tendências da categoria com dados parciais", "warn");
      } else {
        setAlert("");
        setStatus("Tendências da categoria carregadas", "ready");
      }
    } catch (error) {
      if (seq !== state.trendSeq) return;
      state.categoryTrendData = null;
      renderEmpty("categoryTrendGrid", "Não foi possível carregar tendências desta categoria.");
      renderEmpty("categoryTrendNavigation", "A árvore da categoria não ficou disponível.");
      setAlert(error.message || "Falha ao carregar tendências da categoria.", "error");
      setStatus("Erro nas tendências da categoria", "error");
    }
  }

  async function loadSuggestions() {
    setAlert("");
    setLoading("Carregando tendências");
    renderEmpty("suggestionsGrid", "Carregando tendências gerais...");
    try {
      const data = await apiJson("/api/market-analysis/trends/general");
      state.generalTrends = Array.isArray(data.trends) ? data.trends : [];
      renderGeneralTrends();
      setStatus("Tendências carregadas", "ready");
    } catch (error) {
      state.generalTrends = [];
      setAlert(error.message || "Falha ao carregar tendências.", "error");
      setStatus("Erro nas tendências", "error");
      renderEmpty("suggestionsGrid", "Não foi possível carregar tendências gerais.");
      const count = $("generalTrendCount");
      if (count) count.textContent = "Falha ao carregar tendências gerais.";
    }
  }

  function switchTab(tab) {
    state.currentTab = tab;
    qsa("[data-market-tab]").forEach((button) => {
      const active = button.dataset.marketTab === tab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    qsa("[data-market-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.marketPanel !== tab;
    });
    qsa("[data-explore-control]").forEach((control) => {
      control.hidden = tab !== "explorar";
    });
    if (tab === "sugestoes" && state.trendMode === "general" && !$("suggestionsGrid")?.dataset.loaded) {
      $("suggestionsGrid").dataset.loaded = "1";
      loadSuggestions();
    }
  }

  function bindEvents() {
    $("marketSearchForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      searchMarket($("marketQuery")?.value);
    });

    $("marketQuery")?.addEventListener("input", (event) => {
      suggestCategories(event.target.value);
    });

    $("keywordSearchForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      searchKeywords($("keywordQuery")?.value);
    });

    ["keywordFilter", "keywordSourceFilter", "keywordSort"].forEach((id) => {
      $(id)?.addEventListener(id === "keywordFilter" ? "input" : "change", () => {
        state.keywordPage = 1;
        if (state.keywordData) renderKeywordTable(state.keywordData);
      });
    });
    $("keywordPrev")?.addEventListener("click", () => {
      state.keywordPage = Math.max(1, state.keywordPage - 1);
      renderKeywordTable(state.keywordData);
    });
    $("keywordNext")?.addEventListener("click", () => {
      state.keywordPage += 1;
      renderKeywordTable(state.keywordData);
    });

    $("btnLoadSuggestions")?.addEventListener("click", loadSuggestions);
    $("generalTrendFilter")?.addEventListener("input", renderGeneralTrends);
    $("generalTrendSegment")?.addEventListener("change", renderGeneralTrends);
    $("categoryTrendFilter")?.addEventListener("input", () => renderCategoryTrendExplorer(state.categoryTrendData));
    $("trendCategorySearchForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      searchTrendCategories($("trendCategoryQuery")?.value);
    });
    qsa("[data-trend-mode]").forEach((button) => {
      button.addEventListener("click", () => switchTrendMode(button.dataset.trendMode));
    });

    qsa("[data-market-tab]").forEach((button) => {
      button.addEventListener("click", () => switchTab(button.dataset.marketTab));
    });

    document.addEventListener("click", (event) => {
      const categoryButton = event.target.closest("[data-analyze-category]");
      if (categoryButton) {
        const comingFromTrends = Boolean(categoryButton.closest('[data-market-panel="sugestoes"]'));
        if (comingFromTrends) {
          switchTab("explorar");
          const name = categoryButton.dataset.categoryName || "";
          if (name && $("marketQuery")) $("marketQuery").value = name;
        }
        analyzeCategory(categoryButton.dataset.analyzeCategory, categoryButton.dataset.domainId || "");
        return;
      }

      const keywordsCategoryButton = event.target.closest("[data-keywords-category]");
      if (keywordsCategoryButton) {
        const categoryId = keywordsCategoryButton.dataset.keywordsCategory || "";
        switchTab("palavras");
        const keywordInput = $("keywordQuery");
        if (keywordInput) keywordInput.value = categoryId;
        searchKeywords(categoryId);
        return;
      }

      const trendCategoryButton = event.target.closest("[data-trend-category]");
      if (trendCategoryButton) {
        loadCategoryTrends(trendCategoryButton.dataset.trendCategory || "");
        return;
      }

      const keywordButton = event.target.closest("[data-search-keyword]");
      if (keywordButton) {
        const keyword = keywordButton.dataset.searchKeyword || "";
        switchTab("explorar");
        const input = $("marketQuery");
        if (input) input.value = keyword;
        searchMarket(keyword);
      }
    });
  }

  function init() {
    bindEvents();
    renderKpis(null);
    switchTrendMode("general");
    setStatus("Pronto para analisar", "ready");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
