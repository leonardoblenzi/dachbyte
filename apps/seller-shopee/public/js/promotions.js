class PromotionManager {
  constructor() {
    this.currentShopId = null;
    this.campaigns = [];
    this.currentCampaign = null;
    this.eventsBound = false;
    this.loadedOnce = false;
    this.syncProgressTimer = null;
    this.syncProgressValue = 0;
    this.editorState = null;
    this.editorSearchResults = [];
    this.init();
  }

  init() {
    this.setupEventListeners();
  }

  setupEventListeners() {
    if (this.eventsBound) return;
    this.eventsBound = true;

    document
      .getElementById("btnCreatePromotion")
      ?.addEventListener("click", () => this.openCampaignModal({ mode: "create" }));
    document
      .getElementById("btnImportPromotions")
      ?.addEventListener("click", () => this.importPromotions());
    document
      .getElementById("btnExportPromotions")
      ?.addEventListener("click", () => this.exportPromotions());
    document
      .getElementById("btnSyncPromotions")
      ?.addEventListener("click", () => this.loadCampaigns({ sync: true }));
    document
      .getElementById("promotions-status-filter")
      ?.addEventListener("change", () => this.filterCampaigns());
    document
      .getElementById("promotions-search")
      ?.addEventListener("input", () => this.filterCampaigns());

    if (!this.loadedOnce) {
      this.loadedOnce = true;
      this.loadCampaigns({ sync: false }).catch(() => {});
    }
  }

  async api(path, options = {}) {
    const response = await fetch(path, {
      credentials: "include",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      const error = new Error(
        (json && (json.message || json.error)) || text || `HTTP ${response.status}`,
      );
      error.status = response.status;
      error.payload = json;
      throw error;
    }
    return json;
  }

  escape(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  getActiveShopId() {
    this.currentShopId =
      typeof ACTIVE_SHOP_ID !== "undefined" && ACTIVE_SHOP_ID
        ? ACTIVE_SHOP_ID
        : this.currentShopId;
    return this.currentShopId;
  }

  toIsoFromLocal(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  }

  formatDateTimeLocal(value) {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return "";
    const pad = (part) => String(part).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  formatDateTimePt(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return "-";
    return date.toLocaleString("pt-BR", {
      dateStyle: "short",
      timeStyle: "short",
    });
  }

  formatMoneyCents(cents) {
    return (Number(cents || 0) / 100).toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
    });
  }

  moneyToCents(value) {
    const n = Number(value || 0);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 100);
  }

  centsToInput(cents) {
    return (Number(cents || 0) / 100).toFixed(2);
  }

  isPromotionLockBlocked(lock) {
    return Boolean(lock?.isBlockedNow);
  }

  getPromotionLockInfo(lock) {
    if (!this.isPromotionLockBlocked(lock)) {
      return {
        blocked: false,
        statusLabel: "Liberado",
        releaseLabel: "Liberado",
        remainingLabel: "Liberado",
      };
    }
    const releaseLabel = lock?.lockUntil
      ? this.formatDateTimePt(lock.lockUntil)
      : "-";
    return {
      blocked: true,
      statusLabel: "Bloqueado (aumento de preco)",
      releaseLabel,
      remainingLabel: lock?.remainingLabel || "-",
    };
  }

  getCampaignStatus(campaign) {
    const now = new Date();
    const start = new Date(campaign.startTime);
    const end = new Date(campaign.endTime);
    if (campaign.status) return String(campaign.status).toLowerCase();
    if (now < start) return "upcoming";
    if (now <= end) return "ongoing";
    return "expired";
  }

  getCampaignMeta(campaign) {
    const status = this.getCampaignStatus(campaign);
    return {
      status,
      editable: status === "draft" || status === "upcoming",
      publishable: status === "draft" && !campaign.syncedToShopee,
      endable: status === "ongoing",
    };
  }

  setSyncProgress(value, text) {
    const status = document.getElementById("promotions-sync-status");
    const bar = document.getElementById("promotions-sync-bar");
    const valueEl = document.getElementById("promotions-sync-value");
    const textEl = document.getElementById("promotions-sync-text");
    const safeValue = Math.max(0, Math.min(100, Math.round(Number(value || 0))));

    if (status) status.style.display = "block";
    if (bar) bar.style.width = `${safeValue}%`;
    if (valueEl) valueEl.textContent = `${safeValue}%`;
    if (textEl) textEl.textContent = text || "Sincronizando promocoes...";
  }

  startSyncProgress() {
    const btn = document.getElementById("btnSyncPromotions");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Sincronizando...";
    }
    if (this.syncProgressTimer) clearInterval(this.syncProgressTimer);
    this.syncProgressValue = 4;
    this.setSyncProgress(this.syncProgressValue, "Conectando a Shopee...");
    this.syncProgressTimer = window.setInterval(() => {
      if (this.syncProgressValue >= 93) return;
      this.syncProgressValue += this.syncProgressValue < 55 ? 8 : 3;
      this.setSyncProgress(this.syncProgressValue, "Atualizando campanhas...");
    }, 320);
  }

  finishSyncProgress(total, itemTotal = null) {
    if (this.syncProgressTimer) clearInterval(this.syncProgressTimer);
    this.syncProgressTimer = null;
    const itemSuffix = itemTotal == null ? "" : ` e ${Number(itemTotal || 0)} item(ns)`;
    this.setSyncProgress(100, `${Number(total || 0)} campanha(s)${itemSuffix} sincronizada(s).`);
    const btn = document.getElementById("btnSyncPromotions");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Sincronizar Promocoes";
    }
  }

  failSyncProgress(message) {
    if (this.syncProgressTimer) clearInterval(this.syncProgressTimer);
    this.syncProgressTimer = null;
    this.setSyncProgress(
      this.syncProgressValue || 0,
      `Falha: ${message || "erro inesperado"}`,
    );
    const btn = document.getElementById("btnSyncPromotions");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Sincronizar Promocoes";
    }
  }

  setButtonLoading(button, isLoading, loadingLabel = "Abrindo campanha...") {
    if (!button) return;
    if (isLoading) {
      if (!button.dataset.originalLabel) {
        button.dataset.originalLabel = button.innerHTML;
      }
      button.disabled = true;
      button.classList.add("btn-loading");
      button.innerHTML = `<span class="btn-loading__spinner" aria-hidden="true"></span><span>${this.escape(loadingLabel)}</span>`;
      return;
    }

    button.disabled = false;
    button.classList.remove("btn-loading");
    if (button.dataset.originalLabel) {
      button.innerHTML = button.dataset.originalLabel;
      delete button.dataset.originalLabel;
    }
  }

  async runButtonAction(button, label, action) {
    this.setButtonLoading(button, true, label);
    try {
      await action();
    } catch (error) {
      window.alert(error.message || "Erro ao executar a acao.");
    } finally {
      this.setButtonLoading(button, false, label);
    }
  }

  async loadCampaigns({ sync = false } = {}) {
    if (sync) this.startSyncProgress();
    try {
      this.getActiveShopId();
      const result = await this.api(`/shopee/discounts${sync ? "?sync=1" : ""}`);
      if (!result.success) throw new Error(result.error || "Erro ao listar campanhas");
      this.campaigns = Array.isArray(result.data) ? result.data : [];
      this.renderCampaigns();
      if (sync) this.finishSyncProgress(result.sync?.campaigns ?? this.campaigns.length, result.sync?.items ?? null);
    } catch (error) {
      if (sync) this.failSyncProgress(error.message);
      throw error;
    }
  }

  filterCampaigns() {
    const status = document.getElementById("promotions-status-filter")?.value || "active";
    const search = String(
      document.getElementById("promotions-search")?.value || "",
    ).toLowerCase();
    const filtered = this.campaigns.filter((campaign) => {
      const normalizedStatus = this.getCampaignStatus(campaign);
      const matchesStatus =
        status === "all" ||
        (status === "active" && ["upcoming", "ongoing"].includes(normalizedStatus)) ||
        normalizedStatus === status;
      const matchesSearch =
        String(campaign.name || "").toLowerCase().includes(search) ||
        String(campaign.id || "").includes(search);
      return matchesStatus && matchesSearch;
    });
    this.renderCampaignsFiltered(filtered);
  }

  renderCampaigns() {
    this.renderCampaignsFiltered(this.campaigns);
  }

  renderCampaignsFiltered(campaigns) {
    const container = document.getElementById("promotions-list");
    if (!container) return;

    if (!campaigns.length) {
      container.innerHTML = '<div class="muted">Nenhuma campanha encontrada.</div>';
      return;
    }

    container.innerHTML = campaigns
      .map((campaign) => {
        const meta = this.getCampaignMeta(campaign);
        const badgeClass = `promotion-card-badge--${meta.status === "draft" ? "draft" : meta.status}`;
        const itemCount = Array.isArray(campaign.items) ? campaign.items.length : 0;
        return `
          <div class="promotion-card" data-campaign-id="${this.escape(campaign.id)}">
            <div class="promotion-card-header">
              <h3 class="promotion-card-title">${this.escape(campaign.name)}</h3>
              <span class="promotion-card-badge ${badgeClass}">${this.escape(meta.status)}</span>
            </div>
            <div class="promotion-card-dates">
              <div><span class="promotion-card-dates-label">Inicio:</span> ${this.escape(this.formatDateTimePt(campaign.startTime))}</div>
              <div><span class="promotion-card-dates-label">Fim:</span> ${this.escape(this.formatDateTimePt(campaign.endTime))}</div>
            </div>
            <div class="promotion-card-stats">
              <div class="promotion-card-stat">
                <div class="promotion-card-stat-label">Produtos</div>
                <div class="promotion-card-stat-value">${itemCount}</div>
              </div>
              <div class="promotion-card-stat">
                <div class="promotion-card-stat-label">Sincronizado</div>
                <div class="promotion-card-stat-value">${campaign.syncedToShopee ? "Sim" : "Nao"}</div>
              </div>
            </div>
            <div class="promotion-card-actions">
              <button class="btn btn-primary btn-edit">Abrir campanha</button>
              ${meta.publishable ? '<button class="btn btn-primary btn-publish">Publicar</button>' : ""}
              <details class="promotion-card-more">
                <summary aria-label="Mais ações da campanha">Mais ações</summary>
                <div class="promotion-card-more__menu">
                  <button class="btn btn-ghost btn-duplicate">Duplicar</button>
                  ${meta.endable ? '<button class="btn btn-danger btn-end">Encerrar</button>' : ""}
                  <button class="btn btn-danger btn-delete">Excluir</button>
                </div>
              </details>
            </div>
          </div>
        `;
      })
      .join("");

    campaigns.forEach((campaign) => {
      const card = container.querySelector(
        `[data-campaign-id="${String(campaign.id)}"]`,
      );
      card
        ?.querySelector(".btn-edit")
        ?.addEventListener("click", async (event) => {
          const button = event.currentTarget;
          await this.runButtonAction(button, "Abrindo campanha...", () =>
            this.editCampaign(campaign.id),
          );
        });
      card
        ?.querySelector(".btn-duplicate")
        ?.addEventListener("click", async (event) => {
          await this.runButtonAction(
            event.currentTarget,
            "Duplicando campanha...",
            () => this.duplicateCampaign(campaign.id),
          );
        });
      card
        ?.querySelector(".btn-publish")
        ?.addEventListener("click", async (event) => {
          await this.runButtonAction(
            event.currentTarget,
            "Publicando campanha...",
            () => this.publishCampaign(campaign.id),
          );
        });
      card
        ?.querySelector(".btn-end")
        ?.addEventListener("click", async (event) => {
          await this.runButtonAction(
            event.currentTarget,
            "Encerrando campanha...",
            () => this.endCampaign(campaign.id),
          );
        });
      card
        ?.querySelector(".btn-delete")
        ?.addEventListener("click", async (event) => {
          await this.runButtonAction(
            event.currentTarget,
            "Excluindo campanha...",
            () => this.deleteCampaign(campaign.id),
          );
        });
    });
  }

  getDiscountPct(row) {
    const base = Number(row.basePriceCents || 0);
    const promo = Number(row.promotionPriceCents || 0);
    if (!base || promo <= 0 || promo >= base) return 0;
    return Number((((base - promo) / base) * 100).toFixed(2));
  }

  buildRowKey(itemId, modelId) {
    return `${itemId}:${modelId || "item"}`;
  }

  normalizePromotionItem(item, overrides = {}) {
    const rawBasePrice =
      overrides.rawBasePrice ??
      item.rawBasePrice ??
      item.product?.priceMin ??
      item.priceMin ??
      item.basePrice ??
      0;
    const basePriceCents =
      overrides.basePriceCents ??
      item.basePriceCents ??
      this.moneyToCents(rawBasePrice);
    const promotionPriceCents =
      overrides.promotionPriceCents ??
      item.promotionPrice ??
      item.modelPromotionPrice ??
      basePriceCents;
    const promotionStock =
      overrides.promotionStock ??
      item.promotionStock ??
      item.modelPromotionStock ??
      0;
    const promotionLock = overrides.promotionLock || item.promotionLock || null;

    return {
      uid:
        overrides.uid ||
        item.uid ||
        this.buildRowKey(item.itemId, item.modelId),
      existing: Boolean(overrides.existing ?? item.existing ?? false),
      dbId: overrides.dbId ?? item.id ?? null,
      productId: overrides.productId ?? item.productId ?? item.product?.id ?? null,
      itemId: String(item.itemId),
      modelId: item.modelId ? String(item.modelId) : "",
      title:
        overrides.title ||
        item.title ||
        item.product?.title ||
        item.itemName ||
        `Item ${item.itemId}`,
      modelName: overrides.modelName || item.modelName || "",
      basePriceCents: Number(basePriceCents || 0) || 0,
      promotionPriceCents: Number(promotionPriceCents || 0) || 0,
      promotionStock: Number(promotionStock || 0) || 0,
      purchaseLimit:
        Number(overrides.purchaseLimit ?? item.purchaseLimit ?? 0) || 0,
      selected: Boolean(overrides.selected ?? item.selected ?? false),
      promotionLock,
    };
  }

  async attachPromotionLocksToRows(rows) {
    const itemIds = Array.from(
      new Set(
        (Array.isArray(rows) ? rows : [])
          .map((row) => String(row?.itemId || "").trim())
          .filter((value) => /^\d+$/.test(value)),
      ),
    );
    if (!itemIds.length) return rows;

    try {
      const data = await this.api(
        `/shopee/shops/active/products/promotion-locks?itemIds=${encodeURIComponent(itemIds.join(","))}`,
      );
      const locks = Array.isArray(data?.locks) ? data.locks : [];
      const lockMap = new Map(locks.map((lock) => [String(lock.itemId), lock]));
      return rows.map((row) => ({
        ...row,
        promotionLock: lockMap.get(String(row.itemId)) || row.promotionLock || null,
      }));
    } catch (_error) {
      return rows;
    }
  }

  async loadCampaignDetail(id) {
    const result = await this.api(`/shopee/discounts/${id}`);
    if (!result.success) throw new Error(result.error || "Erro ao carregar campanha");
    return result.data;
  }

  buildEditorState({
    mode,
    editable = true,
    id = null,
    name = "",
    startTime = "",
    endTime = "",
    description = "",
    rows = [],
    syncedToShopee = false,
    status = "draft",
  }) {
    return {
      mode,
      editable,
      id,
      name,
      startTime,
      endTime,
      description,
      rows,
      removedRows: [],
      searchQuery: "",
      bulkDiscountPct: "",
      bulkStock: "",
      bulkLimit: "",
      syncedToShopee,
      status,
    };
  }

  async editCampaign(id) {
    const campaign = await this.loadCampaignDetail(id);
    const meta = this.getCampaignMeta(campaign);
    this.currentCampaign = campaign;
    this.editorSearchResults = [];
    this.editorState = this.buildEditorState({
      mode: "edit",
      editable: meta.editable,
      id: campaign.id,
      name: campaign.name || "",
      startTime: this.formatDateTimeLocal(campaign.startTime),
      endTime: this.formatDateTimeLocal(campaign.endTime),
      description: campaign.description || "",
      rows: Array.isArray(campaign.items)
        ? campaign.items.map((item) =>
            this.normalizePromotionItem(item, { existing: true }),
          )
        : [],
      syncedToShopee: Boolean(campaign.syncedToShopee),
      status: meta.status,
    });
    this.editorState.rows = await this.attachPromotionLocksToRows(this.editorState.rows);
    this.renderCampaignModal();
  }

  async duplicateCampaign(id) {
    const campaign = await this.loadCampaignDetail(id);
    this.currentCampaign = null;
    this.editorSearchResults = [];
    const now = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    this.editorState = this.buildEditorState({
      mode: "duplicate",
      editable: true,
      name: `${campaign.name} (Copia)`,
      startTime: this.formatDateTimeLocal(now),
      endTime: this.formatDateTimeLocal(end),
      description: campaign.description || "",
      rows: Array.isArray(campaign.items)
        ? campaign.items.map((item) =>
            this.normalizePromotionItem(item, { existing: false, dbId: null }),
          )
        : [],
      syncedToShopee: false,
      status: "draft",
    });
    this.editorState.rows = await this.attachPromotionLocksToRows(this.editorState.rows);
    this.renderCampaignModal();
  }

  openCampaignModal({ mode = "create" } = {}) {
    this.currentCampaign = null;
    this.editorSearchResults = [];
    const now = new Date(Date.now() + 60 * 60 * 1000);
    const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    this.editorState = this.buildEditorState({
      mode,
      editable: true,
      name: "",
      startTime: this.formatDateTimeLocal(now),
      endTime: this.formatDateTimeLocal(end),
      description: "",
      rows: [],
      syncedToShopee: false,
      status: "draft",
    });
    this.renderCampaignModal();
  }

  buildPromotionSearchResults() {
    if (!this.editorSearchResults.length) {
      return `<div class="muted">Use a busca para listar produtos.</div>`;
    }

    return this.editorSearchResults
      .map((product) => {
        const lockInfo = this.getPromotionLockInfo(product?.promotionLock);
        const disabledAttr = lockInfo.blocked ? "disabled" : "";
        const buttonLabel = lockInfo.blocked ? "Bloqueado" : "Adicionar";
        const lockMeta = lockInfo.blocked
          ? ` � ${this.escape(lockInfo.statusLabel)} � Restante: ${this.escape(lockInfo.remainingLabel)}`
          : "";
        return `
          <div class="promo-search-card">
            <div>
              <strong>${this.escape(product.title || `Item ${product.itemId}`)}</strong>
              <div class="promo-search-card__meta">
                Item ${this.escape(product.itemId)} � Estoque ${this.escape(
                  product.totalStock ?? product.stock ?? "-",
                )} � Preco ${this.escape(
                  Number(product.priceMin || 0).toLocaleString("pt-BR", {
                    style: "currency",
                    currency: "BRL",
                  }),
                )}${lockMeta}
              </div>
            </div>
            <button
              class="btn btn-primary promo-editor-add-product"
              type="button"
              data-item-id="${this.escape(product.itemId)}"
              ${disabledAttr}
            >
              ${buttonLabel}
            </button>
          </div>
        `;
      })
      .join("");
  }
  buildPromotionRowsTable(rows, editable) {
    if (!rows.length) {
      return `<div class="muted">Nenhum produto adicionado.</div>`;
    }

    return `
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th><input id="promotionEditorSelectAll" type="checkbox" ${
                editable ? "" : "disabled"
              } /></th>
              <th>Produto</th>
              <th>Preco base</th>
              <th>Desconto %</th>
              <th>Preco promo</th>
              <th>Estoque promo</th>
              <th>Limite</th>
              <th>Bloqueio promocao</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map((row) => {
                const rowLabel = row.modelId
                  ? `${this.escape(row.title)}<div class="muted">Modelo: ${this.escape(row.modelName || row.modelId)}</div>`
                  : `${this.escape(row.title)}<div class="muted">Item ${this.escape(row.itemId)}</div>`;
                const lockInfo = this.getPromotionLockInfo(row?.promotionLock);
                const rowEditDisabled = !editable || lockInfo.blocked;
                return `
                  <tr data-promo-editor-row="${this.escape(row.uid)}">
                    <td><input class="promo-editor-row-select" type="checkbox" ${
                      row.selected ? "checked" : ""
                    } ${rowEditDisabled ? "disabled" : ""} /></td>
                    <td>${rowLabel}</td>
                    <td>${this.escape(this.formatMoneyCents(row.basePriceCents))}</td>
                    <td><input class="input promo-editor-discount" type="number" min="0" max="99" step="0.01" value="${this.escape(this.getDiscountPct(row))}" ${
                      rowEditDisabled ? "disabled" : ""
                    } /></td>
                    <td><input class="input promo-editor-price" type="number" min="0" step="0.01" value="${this.escape(this.centsToInput(row.promotionPriceCents))}" ${
                      rowEditDisabled ? "disabled" : ""
                    } /></td>
                    <td><input class="input promo-editor-stock" type="number" min="0" step="1" value="${this.escape(row.promotionStock || 0)}" ${
                      rowEditDisabled ? "disabled" : ""
                    } /></td>
                    <td><input class="input promo-editor-limit" type="number" min="0" step="1" value="${this.escape(row.purchaseLimit || 0)}" ${
                      rowEditDisabled ? "disabled" : ""
                    } /></td>
                    <td>${this.escape(lockInfo.blocked ? `${lockInfo.remainingLabel} (libera: ${lockInfo.releaseLabel})` : "Liberado")}</td>
                    <td>
                      ${
                        editable
                          ? '<button class="btn btn-ghost promo-editor-remove" type="button">Remover</button>'
                          : "-"
                      }
                    </td>
                  </tr>
                `;
              })
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }
  renderCampaignModal() {
    const state = this.editorState;
    if (!state) return;

    const isEdit = state.mode === "edit";
    const title = isEdit
      ? `Editar campanha #${state.id}`
      : state.mode === "duplicate"
        ? "Duplicar campanha"
        : "Nova campanha";
    const metaBadges = [
      `<span class="promo-badge">${this.escape(state.status || "draft")}</span>`,
      `<span class="promo-badge">${state.syncedToShopee ? "Sincronizada" : "Rascunho local"}</span>`,
    ].join("");

    openModal(
      title,
      `
        <div class="promo-modal-shell">
          <div class="promo-modal-headline">
            <div>
              <div class="promo-modal-title">${this.escape(title)}</div>
              <div class="muted">Central de promocoes com criacao, edicao, duplicacao e publicacao em popup.</div>
            </div>
            <div class="promo-modal-badges">${metaBadges}</div>
          </div>

          <div class="promo-modal-card">
            <div class="promo-modal-card__title">Dados da campanha</div>
            <div class="promo-modal-grid promo-modal-grid--3">
              <label class="field">
                <span>Nome da campanha</span>
                <input id="promotionEditorName" class="input" type="text" value="${this.escape(state.name)}" ${
                  state.editable ? "" : "disabled"
                } />
              </label>
              <label class="field">
                <span>Inicio</span>
                <input id="promotionEditorStart" class="input" type="datetime-local" value="${this.escape(state.startTime)}" ${
                  state.mode === "edit" ? "disabled" : ""
                } />
              </label>
              <label class="field">
                <span>Fim</span>
                <input id="promotionEditorEnd" class="input" type="datetime-local" value="${this.escape(state.endTime)}" ${
                  state.editable ? "" : "disabled"
                } />
              </label>
            </div>
            <label class="field" style="margin-top:12px;">
              <span>Descricao</span>
              <textarea id="promotionEditorDescription" class="input" rows="3" ${
                state.editable ? "" : "disabled"
              }>${this.escape(state.description)}</textarea>
            </label>
            ${
              !state.editable
                ? '<div class="promo-inline-help">Campanhas em andamento ou encerradas ficam em modo de consulta. Para criar uma variacao, use Duplicar.</div>'
                : ""
            }
          </div>

          <div class="promo-modal-card">
            <div class="promo-modal-card__title">Adicionar produtos</div>
            <div class="promo-modal-grid promo-modal-grid--3">
              <label class="field">
                <span>Buscar produto</span>
                <input id="promotionEditorSearch" class="input" type="text" value="${this.escape(state.searchQuery || "")}" placeholder="Nome, SKU ou item id" ${
                  state.editable ? "" : "disabled"
                } />
              </label>
              <div class="field promo-modal-actions-inline">
                <span>&nbsp;</span>
                <button id="btnPromotionEditorSearch" class="btn btn-primary" type="button" ${
                  state.editable ? "" : "disabled"
                }>Buscar produtos</button>
              </div>
              <div class="field promo-modal-actions-inline">
                <span>&nbsp;</span>
                <div class="muted">${this.escape(state.rows.length)} produto(s) no rascunho</div>
              </div>
            </div>
            <div id="promotionEditorSearchResults" class="promo-search-results" style="margin-top:12px;">
              ${this.buildPromotionSearchResults()}
            </div>
          </div>

          <div class="promo-modal-card">
            <div class="promo-modal-card__title">Edicao em lote</div>
            <div class="promo-modal-grid promo-modal-grid--4">
              <label class="field">
                <span>Desconto %</span>
                <input id="promotionEditorBulkDiscount" class="input" type="number" min="0" max="99" step="0.01" value="${this.escape(state.bulkDiscountPct)}" placeholder="Ex.: 10" ${
                  state.editable ? "" : "disabled"
                } />
              </label>
              <label class="field">
                <span>Estoque promocional</span>
                <input id="promotionEditorBulkStock" class="input" type="number" min="0" step="1" value="${this.escape(state.bulkStock)}" placeholder="Ex.: 20" ${
                  state.editable ? "" : "disabled"
                } />
              </label>
              <label class="field">
                <span>Limite por cliente</span>
                <input id="promotionEditorBulkLimit" class="input" type="number" min="0" step="1" value="${this.escape(state.bulkLimit)}" placeholder="0 = sem limite" ${
                  state.editable ? "" : "disabled"
                } />
              </label>
              <div class="field promo-modal-actions-inline">
                <span>&nbsp;</span>
                <div class="section-actions">
                  <button id="btnPromotionApplySelected" class="btn btn-ghost" type="button" ${
                    state.editable ? "" : "disabled"
                  }>Aplicar aos selecionados</button>
                  <button id="btnPromotionApplyAll" class="btn btn-primary" type="button" ${
                    state.editable ? "" : "disabled"
                  }>Aplicar a todos</button>
                </div>
              </div>
            </div>
          </div>

          <div class="promo-modal-card">
            <div class="promo-modal-card__title">Produtos da campanha</div>
            <div id="promotionEditorRows">
              ${this.buildPromotionRowsTable(state.rows, state.editable)}
            </div>
          </div>

          <div class="promo-modal-footer">
            <div class="section-actions">
              ${
                isEdit && state.status === "draft" && state.syncedToShopee === false
                  ? '<button id="btnPromotionModalPublish" class="btn btn-primary" type="button">Publicar campanha</button>'
                  : ""
              }
              ${
                isEdit && state.status === "ongoing"
                  ? '<button id="btnPromotionModalEnd" class="btn btn-danger" type="button">Encerrar campanha</button>'
                  : ""
              }
            </div>
            <div class="section-actions">
              <button id="btnPromotionEditorClose" class="btn btn-ghost" type="button">Fechar</button>
              ${
                state.editable
                  ? '<button id="btnPromotionEditorSave" class="btn btn-primary" type="button">Salvar campanha</button>'
                  : ""
              }
            </div>
          </div>
        </div>
      `,
    );

    this.bindCampaignModalEvents();
  }

  bindCampaignModalEvents() {
    const state = this.editorState;
    if (!state) return;

    document
      .getElementById("btnPromotionEditorClose")
      ?.addEventListener("click", () => closeModal());
    document
      .getElementById("btnPromotionEditorSearch")
      ?.addEventListener("click", async (event) =>
        this.runButtonAction(
          event.currentTarget,
          "Buscando produtos...",
          () => this.searchProductsForEditor(),
        ),
      );
    document
      .getElementById("btnPromotionApplySelected")
      ?.addEventListener("click", () => this.applyBulkChanges("selected"));
    document
      .getElementById("btnPromotionApplyAll")
      ?.addEventListener("click", () => this.applyBulkChanges("all"));
    document
      .getElementById("btnPromotionEditorSave")
      ?.addEventListener("click", async (event) =>
        this.runButtonAction(
          event.currentTarget,
          "Salvando campanha...",
          () => this.saveCampaign(),
        ),
      );
    document
      .getElementById("btnPromotionModalPublish")
      ?.addEventListener("click", async (event) =>
        this.runButtonAction(
          event.currentTarget,
          "Publicando campanha...",
          () => this.publishCampaign(state.id),
        ),
      );
    document
      .getElementById("btnPromotionModalEnd")
      ?.addEventListener("click", async (event) =>
        this.runButtonAction(
          event.currentTarget,
          "Encerrando campanha...",
          () => this.endCampaign(state.id),
        ),
      );
    document
      .getElementById("promotionEditorSearch")
      ?.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          this.searchProductsForEditor();
        }
      });
    document
      .getElementById("promotionEditorSelectAll")
      ?.addEventListener("change", (event) => {
        const checked = Boolean(event.target.checked);
        state.rows = state.rows.map((row) => ({ ...row, selected: checked }));
        this.renderCampaignModal();
      });

    document.querySelectorAll("[data-promo-editor-row]").forEach((tr) => {
      const uid = tr.getAttribute("data-promo-editor-row");
      tr.querySelector(".promo-editor-row-select")?.addEventListener("change", (event) => {
        this.patchRow(uid, { selected: Boolean(event.target.checked) });
      });
      tr.querySelector(".promo-editor-discount")?.addEventListener("change", (event) => {
        this.applyDiscountToRow(uid, event.target.value);
      });
      tr.querySelector(".promo-editor-price")?.addEventListener("change", (event) => {
        this.patchRow(uid, {
          promotionPriceCents: this.moneyToCents(event.target.value),
        });
      });
      tr.querySelector(".promo-editor-stock")?.addEventListener("change", (event) => {
        this.patchRow(uid, { promotionStock: Number(event.target.value || 0) });
      });
      tr.querySelector(".promo-editor-limit")?.addEventListener("change", (event) => {
        this.patchRow(uid, { purchaseLimit: Number(event.target.value || 0) });
      });
      tr.querySelector(".promo-editor-remove")?.addEventListener("click", () => {
        this.removeRow(uid);
      });
    });

    document.querySelectorAll(".promo-editor-add-product").forEach((button) => {
      button.addEventListener("click", async () => {
        await this.runButtonAction(button, "Adicionando produto...", () =>
          this.addProductToEditor(button.getAttribute("data-item-id")),
        );
      });
    });
  }

  patchRow(uid, patch) {
    this.editorState.rows = this.editorState.rows.map((row) =>
      row.uid === uid ? { ...row, ...patch } : row,
    );
  }

  applyDiscountToRow(uid, discountPctValue) {
    const discountPct = Number(discountPctValue || 0);
    this.editorState.rows = this.editorState.rows.map((row) => {
      if (row.uid !== uid) return row;
      const base = Number(row.basePriceCents || 0);
      if (!base || !Number.isFinite(discountPct)) return row;
      const promotionPriceCents = Math.max(
        1,
        Math.round(base * (1 - discountPct / 100)),
      );
      return { ...row, promotionPriceCents };
    });
    this.renderCampaignModal();
  }

  removeRow(uid) {
    const row = this.editorState.rows.find((item) => item.uid === uid);
    if (row?.existing) {
      const key = this.buildRowKey(row.itemId, row.modelId);
      const hasKey = this.editorState.removedRows.some(
        (entry) => this.buildRowKey(entry.itemId, entry.modelId) === key,
      );
      if (!hasKey) {
        this.editorState.removedRows.push({
          itemId: row.itemId,
          modelId: row.modelId || "",
        });
      }
    }
    this.editorState.rows = this.editorState.rows.filter((item) => item.uid !== uid);
    this.renderCampaignModal();
  }

  async searchProductsForEditor() {
    const q = document.getElementById("promotionEditorSearch")?.value?.trim() || "";
    this.editorState.searchQuery = q;
    const params = new URLSearchParams({ q, page: "1", pageSize: "25" });
    const data = await this.api(`/shopee/shops/active/products?${params.toString()}`);
    this.editorSearchResults = Array.isArray(data.items) ? data.items : [];
    this.renderCampaignModal();
  }

  async addProductToEditor(itemId) {
    const data = await this.api(
      `/shopee/shops/active/products/${encodeURIComponent(itemId)}/full`,
    );
    const product = data.product || null;
    if (!product) {
      window.alert("Nao foi possivel carregar o produto.");
      return;
    }
    const lockInfo = this.getPromotionLockInfo(product?.promotionLock);
    if (lockInfo.blocked) {
      window.alert(`Este produto esta bloqueado para promocao por aumento de preco recente. Restante: ${lockInfo.remainingLabel}.`);
      return;
    }

    const nextRows = [];
    const models = Array.isArray(product.models) ? product.models : [];
    if (models.length) {
      models.forEach((model) => {
        nextRows.push(
          this.normalizePromotionItem(
            {
              itemId: product.itemId,
              modelId: model.modelId,
              itemName: product.title,
              modelName: model.name || `Modelo ${model.modelId}`,
              rawBasePrice: model.price ?? product.priceMin ?? 0,
              promotionStock: Number(model.stock || 0) || 0,
              purchaseLimit: 0,
            },
            {
              existing: false,
              productId: product.id,
              promotionLock: product.promotionLock || null,
            },
          ),
        );
      });
    } else {
      nextRows.push(
        this.normalizePromotionItem(
          {
            itemId: product.itemId,
            itemName: product.title,
            rawBasePrice: product.priceMin ?? product.priceMax ?? 0,
            promotionStock: Number(product.totalStock ?? product.stock ?? 0) || 0,
            purchaseLimit: 0,
          },
          {
            existing: false,
            productId: product.id,
              promotionLock: product.promotionLock || null,
            },
        ),
      );
    }

    const existingKeys = new Set(this.editorState.rows.map((row) => row.uid));
    nextRows.forEach((row) => {
      if (!existingKeys.has(row.uid)) this.editorState.rows.push(row);
    });
    this.renderCampaignModal();
  }

  getBulkValuesFromForm() {
    return {
      discountPct:
        document.getElementById("promotionEditorBulkDiscount")?.value ?? "",
      stock: document.getElementById("promotionEditorBulkStock")?.value ?? "",
      limit: document.getElementById("promotionEditorBulkLimit")?.value ?? "",
    };
  }

  applyBulkChanges(scope) {
    const values = this.getBulkValuesFromForm();
    this.editorState.bulkDiscountPct = values.discountPct;
    this.editorState.bulkStock = values.stock;
    this.editorState.bulkLimit = values.limit;

    const discountPct = Number(values.discountPct);
    const stock = values.stock === "" ? null : Number(values.stock);
    const limit = values.limit === "" ? null : Number(values.limit);

    this.editorState.rows = this.editorState.rows.map((row) => {
      const shouldApply = scope === "all" ? true : Boolean(row.selected);
      if (!shouldApply) return row;

      let promotionPriceCents = row.promotionPriceCents;
      if (Number.isFinite(discountPct) && Number(row.basePriceCents || 0) > 0) {
        promotionPriceCents = Math.max(
          1,
          Math.round(Number(row.basePriceCents) * (1 - discountPct / 100)),
        );
      }

      return {
        ...row,
        promotionPriceCents,
        promotionStock: Number.isFinite(stock) ? stock : row.promotionStock,
        purchaseLimit: Number.isFinite(limit) ? limit : row.purchaseLimit,
      };
    });
    this.renderCampaignModal();
  }

  validateRows(rows) {
    if (!rows.length) {
      throw new Error("Adicione pelo menos um produto na campanha.");
    }
    rows.forEach((row) => {
      const lockInfo = this.getPromotionLockInfo(row?.promotionLock);
      if (lockInfo.blocked) {
        throw new Error(`Produto bloqueado para promocao: ${row.title} (restante: ${lockInfo.remainingLabel}).`);
      }
      if (Number(row.promotionPriceCents || 0) <= 0) {
        throw new Error(`Preco promocional invalido para ${row.title}.`);
      }
      if (Number(row.basePriceCents || 0) > 0 && row.promotionPriceCents >= row.basePriceCents) {
        throw new Error(`O desconto precisa reduzir o preco de ${row.title}.`);
      }
      if (Number(row.promotionStock || 0) < 0) {
        throw new Error(`Estoque promocional invalido para ${row.title}.`);
      }
    });
  }

  getEditorPayload() {
    const name = document.getElementById("promotionEditorName")?.value?.trim() || "";
    const startTime = document.getElementById("promotionEditorStart")?.value || "";
    const endTime = document.getElementById("promotionEditorEnd")?.value || "";
    const description =
      document.getElementById("promotionEditorDescription")?.value?.trim() || "";
    return {
      name,
      startTime,
      endTime,
      description,
    };
  }

  buildCreateItemsPayload(rows) {
    return rows.map((row) => ({
      itemId: String(row.itemId),
      ...(row.modelId ? { modelId: String(row.modelId) } : {}),
      ...(row.modelId
        ? { modelPromotionPrice: Number(row.promotionPriceCents || 0) }
        : { promotionPrice: Number(row.promotionPriceCents || 0) }),
      ...(row.modelId
        ? { modelPromotionStock: Number(row.promotionStock || 0) }
        : { promotionStock: Number(row.promotionStock || 0) }),
      purchaseLimit: Number(row.purchaseLimit || 0) || 0,
      ...(row.productId ? { productId: row.productId } : {}),
    }));
  }

  async saveCampaign() {
    const state = this.editorState;
    if (!state) return;

    try {
      const shopId = this.getActiveShopId();
      if (!shopId) throw new Error("Selecione uma loja antes de salvar.");

      const payload = this.getEditorPayload();
      if (!payload.name) throw new Error("Informe o nome da campanha.");
      if (!payload.startTime || !payload.endTime) {
        throw new Error("Informe inicio e fim da campanha.");
      }
      this.validateRows(state.rows);

      if (state.mode === "edit") {
        await this.api(`/shopee/discounts/${encodeURIComponent(state.id)}`, {
          method: "POST",
          body: JSON.stringify({
            name: payload.name,
            startTime: this.toIsoFromLocal(payload.startTime),
            endTime: this.toIsoFromLocal(payload.endTime),
            description: payload.description,
          }),
        });

        for (const removed of state.removedRows) {
          const query = removed.modelId
            ? `?modelId=${encodeURIComponent(removed.modelId)}`
            : "";
          await this.api(
            `/shopee/discounts/${encodeURIComponent(state.id)}/items/${encodeURIComponent(removed.itemId)}/delete${query}`,
            {
              method: "POST",
              body: JSON.stringify({}),
            },
          );
        }

        const existingRows = state.rows.filter((row) => row.existing);
        const newRows = state.rows.filter((row) => !row.existing);

        for (const row of existingRows) {
          await this.api(
            `/shopee/discounts/${encodeURIComponent(state.id)}/items/${encodeURIComponent(row.itemId)}/update`,
            {
              method: "POST",
              body: JSON.stringify({
                ...(row.modelId ? { modelId: row.modelId } : {}),
                promotionPrice: Number(row.promotionPriceCents || 0),
                promotionStock: Number(row.promotionStock || 0),
                purchaseLimit: Number(row.purchaseLimit || 0) || 0,
              }),
            },
          );
        }

        if (newRows.length) {
          await this.api(`/shopee/discounts/${encodeURIComponent(state.id)}/items`, {
            method: "POST",
            body: JSON.stringify({
              items: this.buildCreateItemsPayload(newRows),
            }),
          });
        }
      } else {
        await this.api("/shopee/discounts", {
          method: "POST",
          body: JSON.stringify({
            shopId,
            name: payload.name,
            startTime: this.toIsoFromLocal(payload.startTime),
            endTime: this.toIsoFromLocal(payload.endTime),
            description: payload.description,
            items: this.buildCreateItemsPayload(state.rows),
          }),
        });
      }

      closeModal();
      await this.loadCampaigns({ sync: false });
    } catch (error) {
      const blockedItems = Array.isArray(error?.payload?.blockedItems)
        ? error.payload.blockedItems
        : [];
      if (blockedItems.length) {
        const preview = blockedItems
          .slice(0, 5)
          .map((row) => `Item ${row.itemId}${row.modelId ? `/${row.modelId}` : ""} (${row.remainingLabel || "-"})`)
          .join(", ");
        window.alert(`Nao foi possivel salvar/publicar. Existem produtos bloqueados por aumento de preco: ${preview}`);
        return;
      }
      window.alert(error.message || "Erro ao salvar campanha.");
    }
  }

  async publishCampaign(id) {
    if (!id) return;
    try {
      await this.api(`/shopee/discounts/${encodeURIComponent(id)}/publish`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      closeModal();
      await this.loadCampaigns({ sync: true });
    } catch (error) {
      window.alert(error.message || "Erro ao publicar campanha.");
    }
  }

  async endCampaign(id) {
    if (!id) return;
    if (!window.confirm("Encerrar esta campanha agora?")) return;
    try {
      await this.api(`/shopee/discounts/${encodeURIComponent(id)}/end`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      closeModal();
      await this.loadCampaigns({ sync: false });
    } catch (error) {
      window.alert(error.message || "Erro ao encerrar campanha.");
    }
  }

  async deleteCampaign(id) {
    if (!id) return;
    if (!window.confirm("Excluir esta campanha?")) return;
    try {
      await this.api(`/shopee/discounts/${encodeURIComponent(id)}/delete`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (this.editorState?.id === id) closeModal();
      await this.loadCampaigns({ sync: false });
    } catch (error) {
      window.alert(error.message || "Erro ao excluir campanha.");
    }
  }

  exportPromotions() {
    const shopId = this.getActiveShopId();
    if (!shopId) {
      window.alert("Selecione uma loja antes de exportar.");
      return;
    }
    const url = `/shopee/discounts/export/file?format=json&shopId=${encodeURIComponent(shopId)}`;
    window.open(url, "_blank");
  }

  importPromotions() {
    const shopId = this.getActiveShopId();
    if (!shopId) {
      window.alert("Selecione uma loja antes de importar.");
      return;
    }

    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const campaigns = Array.isArray(parsed) ? parsed : parsed?.campaigns;
        if (!Array.isArray(campaigns)) {
          throw new Error("Arquivo invalido para importacao.");
        }
        await this.api("/shopee/discounts/import/file", {
          method: "POST",
          body: JSON.stringify({ shopId, campaigns }),
        });
        await this.loadCampaigns({ sync: false });
      } catch (error) {
        window.alert(error.message || "Erro ao importar campanhas.");
      }
    });
    input.click();
  }
}

window.promotionManager = new PromotionManager();

