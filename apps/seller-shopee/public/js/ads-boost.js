class AdsBoostManager {
  constructor() {
    this.overview = null;
    this.selectedItemIds = [];
    this.searchResults = [];
    this.statusState = { text: "", type: "" };
    this.chart = null;
    this.autoEnabled = false;
    this.autoTickHandle = null;
    this.autoTickDeferredHandle = null;
    this.autoTickRunning = false;
    this.autoRunInFlight = false;
    this.lastObservedSlotsAvailable = null;
    this.nextAutoCheckAtMs = 0;
    this.storageKey = "shopee_ads_boost_auto_state_v1";
    this.lastBoostSentAtStorageKey = "shopee_ads_boost_last_sent_at_v1";
    this.autoStateLoaded = false;
    this.lastBoostSentAtMs = 0;
    this.autoTickIntervalMs = 4 * 60 * 60 * 1000;
    this.overviewFetchCooldownMs = 4 * 60 * 60 * 1000;
    this.backgroundAutoInitialized = false;
    this.initBackgroundAuto();
  }

  initBackgroundAuto() {
    if (this.backgroundAutoInitialized) return;
    this.backgroundAutoInitialized = true;
    this.loadAutoState();
    this.startAutoTick();
    if (this.autoEnabled && this.selectedItemIds.length) {
      this.runAutoTick({ immediate: true });
    }
  }

  getRoot() {
    return document.getElementById("adsBoostRoot");
  }

  parseJsonResponse(response) {
    return response.text().then((text) => (text ? JSON.parse(text) : {}));
  }

  async apiGet(path) {
    const response = await fetch(`/shopee${path}`, {
      method: "GET",
      credentials: "include",
    });
    const json = await this.parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(json?.message || json?.error?.message || json?.error || `HTTP ${response.status}`);
    }
    return json;
  }

  async apiPost(path, body) {
    const response = await fetch(`/shopee${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const json = await this.parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(json?.message || json?.error?.message || json?.error || `HTTP ${response.status}`);
    }
    return json;
  }

  escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  normalizeItemId(value) {
    return /^\d+$/.test(String(value || "").trim()) ? String(value).trim() : "";
  }

  formatMoneyCents(value) {
    const amount = Number(value || 0) / 100;
    return Number.isFinite(amount)
      ? amount.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
      : "—";
  }

  formatInteger(value) {
    const amount = Number(value || 0);
    return Number.isFinite(amount) ? amount.toLocaleString("pt-BR") : "0";
  }

  formatDuration(seconds) {
    const total = Math.max(0, Number(seconds || 0));
    if (!total) return "Livre agora";
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const parts = [];
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (!hours && !minutes) parts.push(`${secs}s`);
    return parts.join(" ");
  }

  formatDateTime(value) {
    if (!value) return "—";
    try {
      return new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
      }).format(new Date(value));
    } catch (_error) {
      return String(value);
    }
  }

  getCurrentRange() {
    const defaultFrom = document.getElementById("adsDateFrom")?.value || "";
    const defaultTo = document.getElementById("adsDateTo")?.value || "";
    let from = document.getElementById("adsBoostDateFrom")?.value || defaultFrom || this.overview?.range?.dateFrom || "";
    let to = document.getElementById("adsBoostDateTo")?.value || defaultTo || this.overview?.range?.dateTo || "";

    if (!from || !to) {
      const now = new Date();
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
      const toISO = (d) => d.toISOString().slice(0, 10);
      from = from || toISO(firstDay);
      to = to || toISO(now);
    }

    return { dateFrom: from, dateTo: to };
  }

  setStatus(text, type = "") {
    this.statusState = { text: text || "", type };
    const el = document.getElementById("adsBoostStatus");
    if (!el) return;
    el.className = type ? `muted ui-state ui-state--${type}` : "muted";
    el.textContent = text || "";
  }

  setSelectedItemIds(itemIds) {
    this.selectedItemIds = Array.from(
      new Set(
        (Array.isArray(itemIds) ? itemIds : [])
          .map((itemId) => this.normalizeItemId(itemId))
          .filter(Boolean),
      ),
    ).slice(0, 5);
    if (!this.selectedItemIds.length && this.autoEnabled) {
      this.autoEnabled = false;
      this.nextAutoCheckAtMs = 0;
      this.clearDeferredAutoTick();
    }
    this.saveAutoState();
    this.render();
    if (this.autoEnabled && this.selectedItemIds.length) {
      this.runAutoTick({ immediate: true });
    }
  }

  addSelectedItemId(itemId) {
    const normalized = this.normalizeItemId(itemId);
    if (!normalized) return;
    if (this.selectedItemIds.includes(normalized)) return;
    if (this.selectedItemIds.length >= 5) {
      this.setStatus("A selecao de boost aceita no maximo 5 IDs por vez.", "error");
      return;
    }
    this.selectedItemIds = [...this.selectedItemIds, normalized];
    this.saveAutoState();
    this.render();
    if (this.autoEnabled) {
      this.runAutoTick({ immediate: true });
    }
  }

  removeSelectedItemId(itemId) {
    this.selectedItemIds = this.selectedItemIds.filter((value) => value !== String(itemId));
    if (!this.selectedItemIds.length && this.autoEnabled) {
      this.autoEnabled = false;
      this.nextAutoCheckAtMs = 0;
      this.clearDeferredAutoTick();
    }
    this.saveAutoState();
    this.render();
  }

  notify({
    title = "Impulsionar",
    message = "",
    type = "info",
    showToast = true,
    kind = "",
  } = {}) {
    if (typeof window.shopeeNotify === "function") {
      window.shopeeNotify({ title, message, type, showToast, kind });
    }
  }

  loadAutoState() {
    if (this.autoStateLoaded) return;
    this.autoStateLoaded = true;
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const selected = Array.isArray(parsed?.selectedItemIds) ? parsed.selectedItemIds : [];
      this.selectedItemIds = Array.from(
        new Set(selected.map((itemId) => this.normalizeItemId(itemId)).filter(Boolean)),
      ).slice(0, 5);
      this.autoEnabled = Boolean(parsed?.autoEnabled);
      this.lastBoostSentAtMs = Math.max(
        0,
        Number(localStorage.getItem(this.lastBoostSentAtStorageKey) || 0) || 0,
      );
    } catch (_error) {}
  }

  saveAutoState() {
    try {
      localStorage.setItem(
        this.storageKey,
        JSON.stringify({
          selectedItemIds: this.selectedItemIds,
          autoEnabled: this.autoEnabled,
        }),
      );
      localStorage.setItem(
        this.lastBoostSentAtStorageKey,
        String(Math.max(0, Number(this.lastBoostSentAtMs || 0))),
      );
    } catch (_error) {}
  }

  getNextOverviewFetchAtMs() {
    if (!this.lastBoostSentAtMs) return 0;
    return Number(this.lastBoostSentAtMs) + this.overviewFetchCooldownMs;
  }

  canFetchOverviewNow() {
    const nextAt = this.getNextOverviewFetchAtMs();
    if (!nextAt) return true;
    return Date.now() >= nextAt;
  }

  markBoostSentNow() {
    this.lastBoostSentAtMs = Date.now();
    this.saveAutoState();
  }

  formatDateTimeLocal(value) {
    if (!value) return "—";
    try {
      return new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
      }).format(new Date(value));
    } catch (_error) {
      return String(value);
    }
  }

  buildSelectedPills() {
    if (!this.selectedItemIds.length) {
      return '<div class="muted">Nenhum ID selecionado para impulsionar.</div>';
    }

    return this.selectedItemIds
      .map(
        (itemId) => `
          <button class="listing-clone-pill" type="button" data-boost-remove="${this.escapeHtml(itemId)}">
            ${this.escapeHtml(itemId)} ×
          </button>
        `,
      )
      .join("");
  }

  renderCurrentBoostedList() {
    const items = Array.isArray(this.overview?.current?.items) ? this.overview.current.items : [];
    if (!items.length) {
      return '<div class="muted ui-state ui-state--empty">Nenhum item impulsionado no momento.</div>';
    }

    return `
      <div class="table-wrap ads-boost-ranking-scroll">
        <table class="table">
          <thead>
            <tr>
              <th>Produto</th>
              <th>Cooldown</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${items
              .map(
                (item) => `
                  <tr>
                    <td>
                      <div class="ads-boost-product">
                        ${
                          item?.imageUrl
                            ? `<img class="product-thumb" src="${this.escapeHtml(item.imageUrl)}" alt="">`
                            : '<div class="product-thumb"></div>'
                        }
                        <div>
                          <strong>${this.escapeHtml(item?.title || `Item ${item?.itemId || ""}`)}</strong>
                          <div class="muted">ID ${this.escapeHtml(item?.itemId || "")}</div>
                        </div>
                      </div>
                    </td>
                    <td>${this.escapeHtml(this.formatDuration(item?.coolDownSecond || 0))}</td>
                    <td>${this.escapeHtml(item?.status || "—")}</td>
                    <td>
                      <button class="btn btn-ghost" type="button" data-boost-add="${this.escapeHtml(item?.itemId || "")}">
                        Usar ID
                      </button>
                    </td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  renderRanking() {
    const ranking = Array.isArray(this.overview?.ranking) ? this.overview.ranking : [];
    if (!ranking.length) {
      return '<div class="muted ui-state ui-state--empty">Sem historico suficiente para gerar ranking no periodo.</div>';
    }

    return `
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Boosts</th>
              <th>Vendas</th>
              <th>Pedidos</th>
              <th>Cliques</th>
              <th>Views 30d</th>
              <th>GMV</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${ranking
              .slice(0, 12)
              .map(
                (entry) => `
                  <tr>
                    <td>
                      <div class="ads-boost-product">
                        ${
                          entry?.imageUrl
                            ? `<img class="product-thumb" src="${this.escapeHtml(entry.imageUrl)}" alt="">`
                            : '<div class="product-thumb"></div>'
                        }
                        <div>
                          <strong>${this.escapeHtml(entry?.title || `Item ${entry?.itemId || ""}`)}</strong>
                          <div class="muted">ID ${this.escapeHtml(entry?.itemId || "")}</div>
                        </div>
                      </div>
                    </td>
                    <td>${this.escapeHtml(this.formatInteger(entry?.boosts || 0))}</td>
                    <td>${this.escapeHtml(this.formatInteger(entry?.quantitySold || 0))}</td>
                    <td>${this.escapeHtml(this.formatInteger(entry?.ordersCount || 0))}</td>
                    <td>${this.escapeHtml(this.formatInteger(entry?.clicks || 0))}</td>
                    <td>${this.escapeHtml(this.formatInteger(entry?.views30d || entry?.impressions30d || 0))}</td>
                    <td>${this.escapeHtml(this.formatMoneyCents(entry?.gmvCents || 0))}</td>
                    <td>
                      <button class="btn btn-ghost" type="button" data-boost-add="${this.escapeHtml(entry?.itemId || "")}">
                        Usar ID
                      </button>
                    </td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  renderHistory() {
    const history = Array.isArray(this.overview?.history) ? this.overview.history : [];
    if (!history.length) {
      return '<div class="muted ui-state ui-state--empty">Nenhum boost salvo em historico ainda.</div>';
    }

    return `
      <div class="ads-boost-history">
        ${history
          .slice(0, 16)
          .map(
            (batch) => `
              <article class="ads-boost-history-card">
                <div class="ads-boost-history-card__head">
                  <div>
                    <strong>Boost #${this.escapeHtml(batch?.id || "")}</strong>
                    <div class="muted">Executado em ${this.escapeHtml(this.formatDateTime(batch?.createdAt))}</div>
                  </div>
                  <button class="btn btn-ghost" type="button" data-boost-repeat="${this.escapeHtml((batch?.items || []).filter((item) => item?.success).map((item) => item.itemId).join(","))}">
                    Reusar IDs
                  </button>
                </div>
                <div class="listing-clone-pill-row">
                  <span class="listing-clone-pill">Sucessos ${this.escapeHtml(batch?.successCount || 0)}</span>
                  <span class="listing-clone-pill">Falhas ${this.escapeHtml(batch?.failureCount || 0)}</span>
                  <span class="listing-clone-pill">Vendas ${this.escapeHtml(batch?.metrics?.quantitySold || 0)}</span>
                  <span class="listing-clone-pill">Cliques ${this.escapeHtml(batch?.metrics?.clicks || 0)}</span>
                </div>
                <div class="ads-boost-history-card__items">
                  ${(Array.isArray(batch?.items) ? batch.items : [])
                    .map(
                      (item) => `
                        <div class="ads-boost-history-item">
                          <div>
                            <strong>${this.escapeHtml(item?.product?.title || `Item ${item?.itemId || ""}`)}</strong>
                            <div class="muted">
                              ID ${this.escapeHtml(item?.itemId || "")}
                              • ${item?.success ? "impulsionado" : this.escapeHtml(item?.failedReason || "falhou")}
                            </div>
                          </div>
                          <div class="ads-boost-history-item__meta">
                            <span>${this.escapeHtml(this.formatInteger(item?.metrics?.quantitySold || 0))} vendas</span>
                            <button class="btn btn-ghost" type="button" data-boost-add="${this.escapeHtml(item?.itemId || "")}">
                              Usar ID
                            </button>
                          </div>
                        </div>
                      `,
                    )
                    .join("")}
                </div>
              </article>
            `,
          )
          .join("")}
      </div>
    `;
  }

  renderSearchResults() {
    const results = Array.isArray(this.searchResults) ? this.searchResults : [];
    if (!results.length) {
      return '<div class="muted">Busque produtos por nome ou ID para selecionar o boost.</div>';
    }

    return `
      <div class="ads-boost-search-results">
        ${results
          .map(
            (item) => `
              <article class="ads-boost-search-card">
                <div class="ads-boost-product">
                  ${
                    item?.imageUrl
                      ? `<img class="product-thumb" src="${this.escapeHtml(item.imageUrl)}" alt="">`
                      : '<div class="product-thumb"></div>'
                  }
                  <div>
                    <strong>${this.escapeHtml(item?.title || `Item ${item?.itemId || ""}`)}</strong>
                    <div class="muted">ID ${this.escapeHtml(item?.itemId || "")}</div>
                  </div>
                </div>
                <button class="btn btn-ghost" type="button" data-boost-add="${this.escapeHtml(item?.itemId || "")}">
                  Selecionar
                </button>
              </article>
            `,
          )
          .join("")}
      </div>
    `;
  }

  render() {
    const root = this.getRoot();
    if (!root) return;

    const summary = this.overview?.summary || {};
    const current = this.overview?.current || {
      slotsUsed: 0,
      slotsAvailable: 5,
      nextSlotInSeconds: 0,
      items: [],
    };
    const range = this.getCurrentRange();

    root.innerHTML = `
      <div class="ads-boost-shell">
        <div class="section-card">
          <div class="section-card__header">
            <div>
              <div class="section-title">Impulsionar produtos</div>
              <div class="muted">
                Impulsione at\u00e9 5 IDs por janela de 4 horas e acompanhe vendas e tr\u00e1fego durante o boost.
              </div>
            </div>
            <div class="section-actions ads-boost-header-actions">
              <label class="field">
                <span class="muted">De</span>
                <input id="adsBoostDateFrom" class="input" type="date" value="${this.escapeHtml(range.dateFrom || "")}">
              </label>
              <label class="field">
                <span class="muted">At\u00e9</span>
                <input id="adsBoostDateTo" class="input" type="date" value="${this.escapeHtml(range.dateTo || "")}">
              </label>
              <button id="btnAdsBoostReload" class="btn btn-ghost" type="button">Atualizar</button>
            </div>
          </div>
          <div class="section-card__body">
            <div class="ads-boost-compose">
              <div class="ads-boost-compose__main">
                <label class="field">
                  <span class="muted">IDs para impulsionar (separados por v\u00edrgula)</span>
                  <input id="adsBoostCsv" class="input" type="text" placeholder="123456789, 987654321">
                </label>
                <div class="ads-boost-actions">
                  <button id="btnAdsBoostApplyCsv" class="btn btn-ghost" type="button">Aplicar IDs</button>
                  <button id="btnAdsBoostRun" class="btn btn-primary" type="button">Impulsionar selecionados</button>
                  <button id="btnAdsBoostUseLast" class="btn btn-ghost" type="button">Usar \u00faltimo boost</button>
                </div>
                <label class="logistics-option-toggle">
                  <input id="adsBoostAutoToggle" type="checkbox" ${this.autoEnabled ? "checked" : ""}>
                  <span>Impulsionamento automatico ativo</span>
                </label>
                <div class="muted">
                  Com IDs selecionados, o sistema tenta novo boost em background a cada 4 horas.
                </div>
                <div class="listing-clone-pill-row">${this.buildSelectedPills()}</div>
              </div>
              <div class="ads-boost-compose__side">
                <div class="ads-boost-kpi-grid">
                  <div class="kpi">
                    <div class="kpi-label">Fila usada</div>
                    <div class="kpi-value">${this.escapeHtml(this.formatInteger(current.slotsUsed || 0))}/5</div>
                  </div>
                  <div class="kpi">
                    <div class="kpi-label">Pr\u00f3xima vaga</div>
                    <div class="kpi-value">${this.escapeHtml(this.formatDuration(current.nextSlotInSeconds || 0))}</div>
                  </div>
                  <div class="kpi">
                    <div class="kpi-label">Auto boost</div>
                    <div class="kpi-value">${this.autoEnabled && this.selectedItemIds.length ? "Ativo" : "Pausado"}</div>
                  </div>
                  <div class="kpi">
                    <div class="kpi-label">Boosts no per\u00edodo</div>
                    <div class="kpi-value">${this.escapeHtml(this.formatInteger(summary.boosts || 0))}</div>
                  </div>
                  <div class="kpi">
                    <div class="kpi-label">Itens vendidos em boost</div>
                    <div class="kpi-value">${this.escapeHtml(this.formatInteger(summary.quantitySold || 0))}</div>
                  </div>
                  <div class="kpi">
                    <div class="kpi-label">Cliques em boost</div>
                    <div class="kpi-value">${this.escapeHtml(this.formatInteger(summary.clicks || 0))}</div>
                  </div>
                  <div class="kpi">
                    <div class="kpi-label">GMV em boost</div>
                    <div class="kpi-value">${this.escapeHtml(this.formatMoneyCents(summary.gmvCents || 0))}</div>
                  </div>
                </div>
              </div>
            </div>

            <div class="ads-boost-search">
              <label class="field ads-boost-search__field">
                <span class="muted">Buscar produtos para selecionar</span>
                <input id="adsBoostSearch" class="input" type="text" placeholder="Digite nome ou ID do produto">
              </label>
              <button id="btnAdsBoostSearch" class="btn btn-ghost" type="button">Buscar</button>
            </div>
            <div id="adsBoostStatus" class="${
              this.statusState?.type ? `muted ui-state ui-state--${this.escapeHtml(this.statusState.type)}` : "muted"
            }">${this.escapeHtml(this.statusState?.text || "")}</div>
            ${this.renderSearchResults()}
          </div>
        </div>

        <div class="section-card">
          <div class="section-card__header">
            <div>
              <div class="section-title">Impulsionados agora</div>
              <div class="muted">
                Espa\u00e7os livres: ${this.escapeHtml(this.formatInteger(current.slotsAvailable || 0))}.
              </div>
            </div>
          </div>
          <div class="section-card__body">
            ${this.renderCurrentBoostedList()}
          </div>
        </div>

        <div class="section-card">
          <div class="section-card__header">
            <div>
              <div class="section-title">Evolu\u00e7\u00e3o do boost</div>
              <div class="muted">Boosts, vendas e cliques dentro da janela de impulsionamento.</div>
            </div>
          </div>
          <div class="section-card__body">
            <canvas id="adsBoostTrendChart" height="220"></canvas>
          </div>
        </div>

        <div class="ads-boost-two-column">
          <div class="section-card">
            <div class="section-card__header">
              <div>
                <div class="section-title">Ranking de IDs</div>
                <div class="muted">Mais boostados e com mais resultado durante a janela do boost.</div>
              </div>
            </div>
            <div class="section-card__body">
              ${this.renderRanking()}
            </div>
          </div>

          <div class="section-card">
            <div class="section-card__header">
              <div>
                <div class="section-title">Hist\u00f3rico de impulsionamentos</div>
                <div class="muted">Recupera lotes anteriores e permite repetir IDs rapidamente.</div>
              </div>
            </div>
            <div class="section-card__body">
              ${this.renderHistory()}
            </div>
          </div>
        </div>
      </div>
    `;

    this.bindEvents();
    this.renderTrendChart();
  }

  bindEvents() {
    document.getElementById("btnAdsBoostReload")?.addEventListener("click", () =>
      this.load({ force: false }),
    );
    document.getElementById("btnAdsBoostSearch")?.addEventListener("click", () => this.searchProducts());
    document.getElementById("btnAdsBoostApplyCsv")?.addEventListener("click", () => this.applyCsvSelection());
    document.getElementById("btnAdsBoostRun")?.addEventListener("click", () => this.runBoost());
    document.getElementById("btnAdsBoostUseLast")?.addEventListener("click", () => {
      this.setSelectedItemIds(this.overview?.lastSuccessfulItemIds || []);
    });
    document.getElementById("adsBoostAutoToggle")?.addEventListener("change", (event) => {
      this.autoEnabled = Boolean(event?.target?.checked);
      if (this.autoEnabled && !this.selectedItemIds.length) {
        this.autoEnabled = false;
        if (event?.target) event.target.checked = false;
        this.saveAutoState();
        this.setStatus("Selecione ao menos um ID antes de ativar o boost automatico.", "error");
        this.render();
        return;
      }
      this.saveAutoState();
      this.setStatus(
        this.autoEnabled
          ? "Impulsionamento automatico ativado para os IDs selecionados."
          : "Impulsionamento automatico pausado.",
      );
      if (this.autoEnabled) {
        this.runAutoTick({ immediate: true });
      } else {
        this.nextAutoCheckAtMs = 0;
        this.clearDeferredAutoTick();
      }
    });
    document.getElementById("adsBoostSearch")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.searchProducts();
      }
    });

    this.getRoot()
      ?.querySelectorAll("[data-boost-add]")
      .forEach((button) => {
        button.addEventListener("click", () => this.addSelectedItemId(button.getAttribute("data-boost-add")));
      });
    this.getRoot()
      ?.querySelectorAll("[data-boost-remove]")
      .forEach((button) => {
        button.addEventListener("click", () => this.removeSelectedItemId(button.getAttribute("data-boost-remove")));
      });
    this.getRoot()
      ?.querySelectorAll("[data-boost-repeat]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          const itemIds = String(button.getAttribute("data-boost-repeat") || "")
            .split(",")
            .map((itemId) => this.normalizeItemId(itemId))
            .filter(Boolean);
          this.setSelectedItemIds(itemIds);
        });
      });
  }

  startAutoTick() {
    if (this.autoTickHandle) return;
    this.autoTickHandle = setInterval(() => {
      this.runAutoTick();
    }, this.autoTickIntervalMs);
  }

  clearDeferredAutoTick() {
    if (!this.autoTickDeferredHandle) return;
    clearTimeout(this.autoTickDeferredHandle);
    this.autoTickDeferredHandle = null;
  }

  scheduleDeferredAutoTick(targetMs) {
    const normalizedTarget = Math.max(0, Number(targetMs || 0));
    if (!normalizedTarget) return;
    const delayMs = normalizedTarget - Date.now();
    if (delayMs <= 0) return;
    this.clearDeferredAutoTick();
    this.autoTickDeferredHandle = setTimeout(() => {
      this.autoTickDeferredHandle = null;
      if (!this.autoEnabled || !this.selectedItemIds.length) return;
      this.runAutoTick({ immediate: true });
    }, delayMs);
  }

  scheduleNextAutoCheck(nextSlotInSeconds) {
    const seconds = Math.max(0, Number(nextSlotInSeconds || 0));
    if (!Number.isFinite(seconds)) return;
    const targetBySlotMs = Date.now() + (seconds + 60) * 1000;
    const cooldownTargetMs = Number(this.getNextOverviewFetchAtMs() || 0);
    const targetMs = Math.max(targetBySlotMs, cooldownTargetMs || 0);
    this.nextAutoCheckAtMs = targetMs;
    this.scheduleDeferredAutoTick(targetMs);
  }

  async runAutoTick({ immediate = false } = {}) {
    if (this.autoTickRunning) return;
    if (!this.autoEnabled || !this.selectedItemIds.length) {
      this.nextAutoCheckAtMs = 0;
      this.clearDeferredAutoTick();
      return;
    }
    if (!immediate && this.nextAutoCheckAtMs && Date.now() < this.nextAutoCheckAtMs) return;
    if (!this.canFetchOverviewNow()) return;
    this.autoTickRunning = true;
    try {
      const range = this.getCurrentRange();
      const response = await this.apiGet(
        `/shops/active/ads/boost/overview?dateFrom=${encodeURIComponent(range.dateFrom || "")}&dateTo=${encodeURIComponent(range.dateTo || "")}`,
      );
      this.overview = response || null;
      this.render();
      await this.tryAutoRun();
    } catch (_error) {
      // mantém silencioso para não poluir status manual do usuário
    } finally {
      this.autoTickRunning = false;
    }
  }

  async tryAutoRun() {
    if (!this.autoEnabled || this.autoRunInFlight) return;
    if (!this.selectedItemIds.length) return;

    const current = this.overview?.current || {};
    const slotsAvailable = Number(current?.slotsAvailable || 0);
    const nextSlotInSeconds = Number(current?.nextSlotInSeconds || 0);
    if (
      this.lastObservedSlotsAvailable != null &&
      this.lastObservedSlotsAvailable > 0 &&
      slotsAvailable === 0
    ) {
      this.notify({
        title: "Fila de boost ocupada",
        message: `Sem vagas no momento. Nova vaga em ${this.formatDuration(nextSlotInSeconds)}.`,
        type: "warning",
      });
    }
    if (this.lastObservedSlotsAvailable === 0 && slotsAvailable > 0) {
      this.notify({
        title: "Fila de boost liberada",
        message: "Há vagas disponíveis para novo impulsionamento.",
      });
    }
    this.lastObservedSlotsAvailable = slotsAvailable;

    if (slotsAvailable <= 0) {
      if (!this.lastBoostSentAtMs) this.markBoostSentNow();
      this.scheduleNextAutoCheck(nextSlotInSeconds);
      return;
    }

    this.nextAutoCheckAtMs = 0;
    this.clearDeferredAutoTick();

    const idsToRun = this.selectedItemIds.slice(0, Math.min(5, this.selectedItemIds.length));
    if (!idsToRun.length) return;

    this.autoRunInFlight = true;
    try {
      const response = await this.apiPost("/shops/active/ads/boost/run", {
        itemIds: idsToRun,
      });
      if (response?.current) {
        this.overview = this.overview || {};
        this.overview.current = response.current;
        this.render();
      }
      if (response?.ok) {
        this.markBoostSentNow();
        this.notify({
          title: "Boost automático executado",
          message: `IDs impulsionados: ${idsToRun.join(", ")}.`,
        });
      } else {
        const nextSlotInSecondsFromResponse = Number(
          response?.nextSlotInSeconds ?? response?.current?.nextSlotInSeconds ?? nextSlotInSeconds ?? 0,
        );
        if (response?.slotLimitReached || nextSlotInSecondsFromResponse > 0) {
          if (!this.lastBoostSentAtMs || response?.slotLimitReached) {
            this.markBoostSentNow();
          }
          this.scheduleNextAutoCheck(nextSlotInSecondsFromResponse);
        }
        this.notify({
          title: "Boost automático com alerta",
          message:
            response?.message ||
            `Shopee recusou o lote automático. Próxima tentativa em ${this.formatDuration(nextSlotInSeconds)}.`,
          type: "warning",
        });
      }
    } catch (error) {
      this.notify({
        title: "Falha no boost automático",
        message: error?.message || "Erro ao impulsionar IDs automaticamente.",
        type: "error",
      });
    } finally {
      this.autoRunInFlight = false;
    }
  }

  renderTrendChart() {
    const canvas = document.getElementById("adsBoostTrendChart");
    if (!canvas || !window.Chart) return;

    const trend = Array.isArray(this.overview?.trend) ? this.overview.trend : [];
    if (this.chart) {
      this.chart.destroy();
      this.chart = null;
    }
    if (!trend.length) return;

    this.chart = new Chart(canvas, {
      type: "bar",
      data: {
        labels: trend.map((entry) => entry.date),
        datasets: [
          {
            type: "bar",
            label: "Boosts",
            data: trend.map((entry) => Number(entry.boosts || 0)),
            backgroundColor: "rgba(255, 153, 0, 0.45)",
            borderColor: "rgba(255, 153, 0, 0.95)",
            borderWidth: 1,
          },
          {
            type: "line",
            label: "Itens vendidos",
            data: trend.map((entry) => Number(entry.quantitySold || 0)),
            borderColor: "#22c55e",
            backgroundColor: "rgba(34, 197, 94, 0.15)",
            tension: 0.25,
            borderWidth: 2,
            pointRadius: 2,
            yAxisID: "y1",
          },
          {
            type: "line",
            label: "Cliques",
            data: trend.map((entry) => Number(entry.clicks || 0)),
            borderColor: "#38bdf8",
            backgroundColor: "rgba(56, 189, 248, 0.15)",
            tension: 0.25,
            borderWidth: 2,
            pointRadius: 2,
            yAxisID: "y1",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true,
          },
          y1: {
            beginAtZero: true,
            position: "right",
            grid: { drawOnChartArea: false },
          },
        },
      },
    });
  }

  applyCsvSelection() {
    const raw = document.getElementById("adsBoostCsv")?.value || "";
    const itemIds = raw
      .split(",")
      .map((itemId) => this.normalizeItemId(itemId))
      .filter(Boolean);
    this.setSelectedItemIds(itemIds);
  }

  async searchProducts() {
    const query = String(document.getElementById("adsBoostSearch")?.value || "").trim();
    if (!query) {
      this.setStatus("Digite um nome ou ID para buscar produtos.", "error");
      return;
    }

    this.setStatus("Buscando produtos...", "loading");

    try {
      const response = await this.apiGet(
        `/shops/active/products?q=${encodeURIComponent(query)}&page=1&pageSize=25`,
      );
      this.searchResults = Array.isArray(response?.items)
        ? response.items.map((item) => ({
            itemId: this.normalizeItemId(item?.itemId),
            title: item?.title || "",
            imageUrl: item?.images?.[0]?.url || null,
          }))
        : [];
      this.render();
      this.setStatus(
        this.searchResults.length
          ? `${this.searchResults.length} produto(s) encontrado(s).`
          : "Nenhum produto encontrado para a busca.",
        this.searchResults.length ? "" : "empty",
      );
    } catch (error) {
      this.setStatus(`Falha ao buscar produtos: ${error.message}`, "error");
    }
  }

  async runBoost() {
    if (!this.selectedItemIds.length) {
      this.setStatus("Selecione ao menos um ID para impulsionar.", "error");
      return;
    }

    if (
      !window.confirm(
        `Confirmar impulsionamento de ${this.selectedItemIds.length} ID(s): ${this.selectedItemIds.join(", ")}?`,
      )
    ) {
      return;
    }

    this.setStatus("Enviando impulso para a Shopee...", "loading");

    try {
      const response = await this.apiPost("/shops/active/ads/boost/run", {
        itemIds: this.selectedItemIds,
      });

      if (response?.current) {
        this.overview = this.overview || {};
        this.overview.current = response.current;
      }
      if (response?.ok) {
        this.markBoostSentNow();
        this.setStatus("Boost executado. A fila e o historico foram atualizados.");
        this.notify({
          title: "Boost executado",
          message: `IDs impulsionados: ${this.selectedItemIds.join(", ")}.`,
          kind: "user_action",
        });
      } else {
        const nextSlotInSecondsFromResponse = Number(
          response?.nextSlotInSeconds ?? response?.current?.nextSlotInSeconds ?? 0,
        );
        if (response?.slotLimitReached || nextSlotInSecondsFromResponse > 0) {
          if (!this.lastBoostSentAtMs || response?.slotLimitReached) {
            this.markBoostSentNow();
          }
          this.scheduleNextAutoCheck(nextSlotInSecondsFromResponse);
        }
        this.setStatus(
          response?.slotLimitReached
            ? `Fila de boost ocupada. Nova vaga em ${this.formatDuration(nextSlotInSecondsFromResponse)}.`
            : response?.message || "A Shopee recusou os IDs deste impulso.",
          "error",
        );
        this.notify({
          title: "Boost com alerta",
          message:
            response?.slotLimitReached
              ? `Sem vagas no momento. Nova vaga em ${this.formatDuration(nextSlotInSecondsFromResponse)}.`
              : response?.message || "Shopee recusou os IDs enviados.",
          type: "warning",
          kind: "user_action",
        });
      }
      this.render();
      await this.load({ silent: true, force: false });
    } catch (error) {
      this.setStatus(`Falha ao impulsionar: ${error.message}`, "error");
      this.notify({
        title: "Falha ao impulsionar",
        message: error?.message || "Erro interno ao impulsionar IDs.",
        type: "error",
        kind: "user_action",
      });
    }
  }

  async load({ silent = false, force = false } = {}) {
    this.initBackgroundAuto();
    const root = this.getRoot();
    if (!root) return;

    if (!silent) {
      this.setStatus("Carregando dados de boost...", "loading");
    }

    const range = this.getCurrentRange();
    if (!force && !this.canFetchOverviewNow()) {
      const nextAt = this.getNextOverviewFetchAtMs();
      this.render();
      if (!silent) {
        this.setStatus(
          `Overview bloqueado ate ${this.formatDateTimeLocal(nextAt)} (janela de 4h apos o ultimo boost).`,
        );
      }
      return;
    }

    try {
      const response = await this.apiGet(
        `/shops/active/ads/boost/overview?dateFrom=${encodeURIComponent(range.dateFrom || "")}&dateTo=${encodeURIComponent(range.dateTo || "")}`,
      );
      this.overview = response || null;
      this.render();
      await this.tryAutoRun();
      if (!silent) {
        this.setStatus("Dados de boost atualizados.");
      }
    } catch (error) {
      this.render();
      this.setStatus(`Falha ao carregar boost: ${error.message}`, "error");
    }
  }
}

window.adsBoostManager = new AdsBoostManager();
