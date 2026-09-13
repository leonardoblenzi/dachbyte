class FlashSaleManager {
  constructor() {
    this.criteria = [];
    this.flashSales = [];
    this.selectedFlashSale = null;
    this.initialized = false;
    this.loadedOnce = false;
    this.editorState = null;
    this.editorSearchResults = [];
  }

  init() {
    if (this.initialized) return;
    this.initialized = true;
    this.setDefaultDateWindows();

    document
      .getElementById("btnFlashSaleRefresh")
      ?.addEventListener("click", () => this.loadOverview());
    document
      .getElementById("btnFlashSaleCreateToggle")
      ?.addEventListener("click", () => this.openCreateModal());
    document
      .getElementById("btnFlashSaleFilterApply")
      ?.addEventListener("click", () => this.loadFlashSales());
    document
      .getElementById("btnFlashSaleViewSessions")
      ?.addEventListener("click", () => this.focusSessions());
    document
      .getElementById("btnFlashSaleViewCreate")
      ?.addEventListener("click", () => this.openCreateModal());
    document
      .getElementById("btnFlashSaleViewEditor")
      ?.addEventListener("click", () => {
        if (this.selectedFlashSale?.flash_sale_id) {
          this.openEditModal(this.selectedFlashSale.flash_sale_id);
          return;
        }
        window.alert("Abra uma Flash Sale primeiro.");
      });

    this.focusSessions();

    if (!this.loadedOnce) {
      this.loadedOnce = true;
      this.loadOverview().catch((error) => {
        this.showMessage(
          "flashSaleList",
          `Erro ao carregar Flash Sale: ${error.message}`,
        );
      });
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

  showMessage(id, text) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = `<div class="muted">${this.escape(text)}</div>`;
  }

  setHtml(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
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

  fmtDateTime(value) {
    if (!value) return "-";
    const num = Number(value);
    const date = Number.isFinite(num) ? new Date(num * 1000) : new Date(value);
    return Number.isNaN(date.getTime())
      ? "-"
      : date.toLocaleString("pt-BR", {
          dateStyle: "short",
          timeStyle: "short",
        });
  }

  fmtMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    return n.toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
    });
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
    const releaseLabel = lock?.lockUntil ? this.fmtDateTime(lock.lockUntil) : "-";
    return {
      blocked: true,
      statusLabel: "Bloqueado por aumento de preco",
      releaseLabel,
      remainingLabel: lock?.remainingLabel || "-",
    };
  }

  formatLocalDateTime(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  setDefaultDateWindows() {
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 0, 0);
    const startValue = this.formatLocalDateTime(start);
    const endValue = this.formatLocalDateTime(end);
    ["flashSaleFilterStart"].forEach((id) => {
      const el = document.getElementById(id);
      if (el && !el.value) el.value = startValue;
    });
    ["flashSaleFilterEnd"].forEach((id) => {
      const el = document.getElementById(id);
      if (el && !el.value) el.value = endValue;
    });
  }

  focusSessions() {
    const createPanel = document.getElementById("flashSaleCreatePanel");
    const detailPanel = document.getElementById("flashSaleDetailSection");
    const sessionsPanel = document.getElementById("flashSaleSessionsPanel");
    if (createPanel) createPanel.style.display = "none";
    if (detailPanel) detailPanel.style.display = "none";
    if (sessionsPanel) sessionsPanel.style.display = "block";
    document
      .querySelectorAll(".flash-sale-subtab")
      .forEach((button) => button.classList.remove("is-active"));
    document
      .getElementById("btnFlashSaleViewSessions")
      ?.classList.add("is-active");
  }

  getListFilters() {
    return {
      type: document.getElementById("flashSaleTypeFilter")?.value || "0",
      startTime: document.getElementById("flashSaleFilterStart")?.value || "",
      endTime: document.getElementById("flashSaleFilterEnd")?.value || "",
    };
  }

  async loadOverview() {
    await Promise.all([this.loadCriteria(), this.loadFlashSales()]);
  }

  async loadCriteria() {
    this.showMessage("flashSaleCriteriaBody", "Carregando criterios...");
    try {
      const data = await this.api("/shopee/shops/active/flash-sales/criteria");
      this.criteria = Array.isArray(data.criteria) ? data.criteria : [];
      this.renderCriteria();
    } catch (error) {
      this.showMessage(
        "flashSaleCriteriaBody",
        `Erro ao carregar criterios: ${error.message}`,
      );
    }
  }

  renderCriteria() {
    if (!this.criteria.length) {
      this.showMessage(
        "flashSaleCriteriaBody",
        "Nenhum criterio retornado pela Shopee para esta loja.",
      );
      return;
    }
    this.setHtml(
      "flashSaleCriteriaBody",
      this.criteria
        .map((criterion) => {
          const summary = [
            `Rating minimo: ${criterion.min_product_rating}`,
            `Pedidos 30d: ${criterion.min_order_total}`,
            `Dias para envio: ${criterion.max_days_to_ship}`,
            `Estoque promo: ${criterion.min_promo_stock} - ${criterion.max_promo_stock}`,
            `Desconto: ${criterion.min_discount}% - ${criterion.max_discount}%`,
            `Menor preco 7 dias: ${criterion.need_lowest_price ? "Sim" : "Nao"}`,
          ].join(" • ");
          return `
            <div class="card" style="margin-bottom:10px;">
              <div class="card-title">Criterio #${this.escape(criterion.criteria_id)}</div>
              <div class="muted">${this.escape(summary)}</div>
            </div>
          `;
        })
        .join(""),
    );
  }

  async loadFlashSales() {
    this.showMessage("flashSaleList", "Carregando sessoes...");
    try {
      const filters = this.getListFilters();
      const params = new URLSearchParams({
        type: filters.type,
        offset: "0",
        limit: "50",
      });
      if (filters.startTime && filters.endTime) {
        params.set("startTime", filters.startTime);
        params.set("endTime", filters.endTime);
      }
      const data = await this.api(
        `/shopee/shops/active/flash-sales?${params.toString()}`,
      );
      this.flashSales = Array.isArray(data.flashSales) ? data.flashSales : [];
      this.renderFlashSales();
    } catch (error) {
      this.showMessage("flashSaleList", `Erro ao listar sessoes: ${error.message}`);
    }
  }

  renderFlashSales() {
    if (!this.flashSales.length) {
      this.showMessage("flashSaleList", "Nenhuma Flash Sale encontrada.");
      return;
    }
    this.setHtml(
      "flashSaleList",
      this.flashSales
        .map((flashSale) => {
          const actions = [
            `<button class="btn btn-primary btn-flash-open">Abrir</button>`,
            `<button class="btn btn-ghost btn-flash-duplicate">Duplicar</button>`,
          ];
          if (Number(flashSale.status) === 1) {
            actions.push(`<button class="btn btn-ghost btn-flash-disable">Desabilitar</button>`);
          } else if (Number(flashSale.status) === 2) {
            actions.push(`<button class="btn btn-ghost btn-flash-enable">Habilitar</button>`);
          }
          if (Number(flashSale.type) === 1) {
            actions.push(`<button class="btn btn-ghost btn-flash-delete">Excluir</button>`);
          }
          return `
            <div class="card" data-flash-sale-id="${this.escape(flashSale.flash_sale_id)}" style="margin-bottom:10px;">
              <div class="card-title">Flash Sale #${this.escape(flashSale.flash_sale_id)}</div>
              <div class="muted" style="margin:6px 0 10px 0;">
                ${this.escape(flashSale.typeLabel)} • ${this.escape(flashSale.statusLabel)} •
                Slot ${this.escape(flashSale.timeslot_id)} •
                ${this.escape(this.fmtDateTime(flashSale.start_time))} ate ${this.escape(this.fmtDateTime(flashSale.end_time))}
              </div>
              <div class="muted" style="margin-bottom:10px;">
                Itens ativos: ${this.escape(flashSale.enabled_item_count)} / ${this.escape(flashSale.item_count)}
                • Cliques: ${this.escape(flashSale.click_count ?? 0)}
                • Lembretes: ${this.escape(flashSale.remindme_count ?? 0)}
              </div>
              <div class="section-actions">${actions.join("")}</div>
            </div>
          `;
        })
        .join(""),
    );
    document.querySelectorAll("[data-flash-sale-id]").forEach((card) => {
      const flashSaleId = card.getAttribute("data-flash-sale-id");
      card.querySelector(".btn-flash-open")?.addEventListener("click", async (event) => {
        await this.runButtonAction(
          event.currentTarget,
          "Abrindo campanha...",
          () => this.openEditModal(flashSaleId),
        );
      });
      card.querySelector(".btn-flash-duplicate")?.addEventListener("click", async (event) =>
        this.runButtonAction(
          event.currentTarget,
          "Duplicando campanha...",
          () => this.openDuplicateModal(flashSaleId),
        ),
      );
      card.querySelector(".btn-flash-enable")?.addEventListener("click", async (event) =>
        this.runButtonAction(
          event.currentTarget,
          "Habilitando sessao...",
          () => this.updateFlashSaleStatus(flashSaleId, 1),
        ),
      );
      card.querySelector(".btn-flash-disable")?.addEventListener("click", async (event) =>
        this.runButtonAction(
          event.currentTarget,
          "Desabilitando sessao...",
          () => this.updateFlashSaleStatus(flashSaleId, 2),
        ),
      );
      card.querySelector(".btn-flash-delete")?.addEventListener("click", async (event) =>
        this.runButtonAction(
          event.currentTarget,
          "Excluindo campanha...",
          () => this.deleteFlashSale(flashSaleId),
        ),
      );
    });
  }

  normalizeFlashRow(row, overrides = {}) {
    const originalPrice = Number(overrides.originalPrice ?? row.originalPrice ?? 0) || 0;
    const promotionPrice =
      Number(
        overrides.promotionPrice ??
          row.inputPromotionPrice ??
          row.promotionPrice ??
          originalPrice,
      ) || 0;
    const campaignStock =
      Number(overrides.campaignStock ?? row.campaignStock ?? row.stock ?? 0) || 0;
    const purchaseLimit =
      Number(overrides.purchaseLimit ?? row.purchaseLimit ?? 0) || 0;

    return {
      uid:
        overrides.uid ||
        row.uid ||
        `${row.kind || "item"}:${row.itemId}:${row.modelId || "item"}`,
      existing: Boolean(overrides.existing ?? row.existing ?? false),
      kind: row.kind || (row.modelId ? "model" : "item"),
      itemId: String(row.itemId),
      itemName: row.itemName || `Item ${row.itemId}`,
      modelId: row.modelId ? String(row.modelId) : null,
      modelName: row.modelName || null,
      originalPrice,
      promotionPrice,
      campaignStock,
      purchaseLimit,
      stock: Number(row.stock ?? campaignStock ?? 0) || 0,
      flashSaleStatus:
        overrides.flashSaleStatus ?? row.flashSaleStatus ?? row.itemStatus ?? 1,
      flashSaleStatusLabel:
        overrides.flashSaleStatusLabel ??
        row.flashSaleStatusLabel ??
        row.statusLabel ??
        "enabled",
      rejectReason: row.rejectReason || null,
      selected: Boolean(overrides.selected ?? row.selected ?? false),
      promotionLock: overrides.promotionLock || row.promotionLock || null,
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

  async loadFlashSaleDetails(flashSaleId) {
    const [detail, items] = await Promise.all([
      this.api(`/shopee/shops/active/flash-sales/${encodeURIComponent(flashSaleId)}`),
      this.api(
        `/shopee/shops/active/flash-sales/${encodeURIComponent(
          flashSaleId,
        )}/items?offset=0&limit=100`,
      ),
    ]);

    return {
      flashSale: detail.flashSale || null,
      rows: Array.isArray(items.rows)
        ? items.rows.map((row) => this.normalizeFlashRow(row, { existing: true }))
        : [],
    };
  }

  buildEditorState({ mode, flashSale = null, rows = [], sourceFlashSaleId = null }) {
    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() + 7);

    return {
      mode,
      flashSale,
      sourceFlashSaleId,
      rows,
      removedItemIds: new Set(),
      timeSlots: [],
      slotWindowStart: this.formatLocalDateTime(now),
      slotWindowEnd: this.formatLocalDateTime(end),
      selectedTimeslotId: "",
      searchQuery: "",
      eligibleOnly: true,
      bulkDiscountPct: "",
      bulkStock: "",
      bulkLimit: "",
    };
  }

  async openCreateModal() {
    this.editorSearchResults = [];
    this.editorState = this.buildEditorState({ mode: "create" });
    this.renderEditorModal();
  }

  async openEditModal(flashSaleId) {
    const data = await this.loadFlashSaleDetails(flashSaleId);
    this.selectedFlashSale = data.flashSale;
    this.editorSearchResults = [];
    const rowsWithLocks = await this.attachPromotionLocksToRows(data.rows);
    this.editorState = this.buildEditorState({
      mode: "edit",
      flashSale: data.flashSale,
      rows: rowsWithLocks,
    });
    this.renderEditorModal();
  }

  async openDuplicateModal(flashSaleId) {
    const data = await this.loadFlashSaleDetails(flashSaleId);
    this.editorSearchResults = [];
    const rowsWithLocks = await this.attachPromotionLocksToRows(data.rows);
    this.editorState = this.buildEditorState({
      mode: "duplicate",
      flashSale: data.flashSale,
      rows: rowsWithLocks.map((row) =>
        this.normalizeFlashRow(row, {
          existing: false,
          selected: false,
          flashSaleStatus: 1,
          flashSaleStatusLabel: "enabled",
        }),
      ),
      sourceFlashSaleId: flashSaleId,
    });
    this.renderEditorModal();
  }

  getDiscountPct(row) {
    const original = Number(row.originalPrice || 0);
    const promotion = Number(row.promotionPrice || 0);
    if (!original || promotion <= 0 || promotion >= original) return 0;
    return Number((((original - promotion) / original) * 100).toFixed(2));
  }

  buildSearchResults() {
    if (!this.editorSearchResults.length) {
      return `<div class="muted">Use a busca para listar produtos.</div>`;
    }

    return this.editorSearchResults
      .map((product) => {
        const lockInfo = this.getPromotionLockInfo(product?.promotionLock);
        const disabledAttr = lockInfo.blocked ? "disabled" : "";
        const buttonLabel = lockInfo.blocked ? "Bloqueado" : "Adicionar";
        const lockMeta = lockInfo.blocked
          ? ` • ${this.escape(lockInfo.statusLabel)} • Restante ${this.escape(lockInfo.remainingLabel)}`
          : "";
        return `
          <div class="flash-editor-search-card">
            <div>
              <strong>${this.escape(product.title || `Item ${product.itemId}`)}</strong>
              <div class="muted">Item ${this.escape(product.itemId)} • Estoque ${this.escape(product.totalStock ?? product.stock ?? "-")}${lockMeta}</div>
            </div>
            <div class="section-actions">
              <button class="btn btn-primary flash-editor-add-product" type="button" data-item-id="${this.escape(product.itemId)}" ${disabledAttr}>${buttonLabel}</button>
            </div>
          </div>
        `;
      })
      .join("");
  }

  buildFlashRowTable(rows) {
    if (!rows.length) {
      return `<div class="muted">Nenhum produto adicionado.</div>`;
    }

    return `
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th><input id="flashSaleEditorSelectAll" type="checkbox" /></th>
              <th>Produto</th>
              <th>Preco base</th>
              <th>Desconto %</th>
              <th>Preco promo</th>
              <th>Estoque reservado</th>
              <th>Limite</th>
              <th>Status</th>
              <th>Bloqueio promocao</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map((row) => {
                const rowLabel = row.modelId
                  ? `${this.escape(row.itemName)}<div class="muted">Modelo: ${this.escape(row.modelName || row.modelId)}</div>`
                  : `${this.escape(row.itemName)}<div class="muted">Item ${this.escape(row.itemId)}</div>`;
                const lockInfo = this.getPromotionLockInfo(row?.promotionLock);
                const rowEditDisabled = lockInfo.blocked;
                return `
                  <tr data-flash-editor-row="${this.escape(row.uid)}">
                    <td><input class="flash-editor-row-select" type="checkbox" ${row.selected ? "checked" : ""} ${rowEditDisabled ? "disabled" : ""} /></td>
                    <td>${rowLabel}</td>
                    <td>${this.escape(this.fmtMoney(row.originalPrice))}</td>
                    <td><input class="input flash-editor-discount" type="number" min="0" max="99" step="0.01" value="${this.escape(this.getDiscountPct(row))}" ${rowEditDisabled ? "disabled" : ""} /></td>
                    <td><input class="input flash-editor-price" type="number" min="0" step="0.01" value="${this.escape(Number(row.promotionPrice || 0).toFixed(2))}" ${rowEditDisabled ? "disabled" : ""} /></td>
                    <td><input class="input flash-editor-stock" type="number" min="1" step="1" value="${this.escape(row.campaignStock || "")}" ${rowEditDisabled ? "disabled" : ""} /></td>
                    <td><input class="input flash-editor-limit" type="number" min="0" step="1" value="${this.escape(row.purchaseLimit || 0)}" ${rowEditDisabled ? "disabled" : ""} /></td>
                    <td>${this.escape(row.flashSaleStatusLabel || "-")}</td>
                    <td>${this.escape(lockInfo.blocked ? `${lockInfo.remainingLabel} (libera: ${lockInfo.releaseLabel})` : "Liberado")}</td>
                    <td><button class="btn btn-ghost flash-editor-remove" type="button">Remover</button></td>
                  </tr>
                `;
              })
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  renderEditorModal() {
    const state = this.editorState;
    if (!state) return;

    const isEdit = state.mode === "edit";
    const isDuplicate = state.mode === "duplicate";
    const needsTimeslot = !isEdit;
    const title = isEdit
      ? `Editar Flash Sale #${state.flashSale?.flash_sale_id || ""}`
      : isDuplicate
        ? `Duplicar Flash Sale #${state.sourceFlashSaleId || ""}`
        : "Nova Flash Sale";

    const flashMeta = state.flashSale
      ? `<div class="muted">Status: ${this.escape(
          state.flashSale.statusLabel || "-",
        )} • ${this.escape(this.fmtDateTime(state.flashSale.start_time))} ate ${this.escape(this.fmtDateTime(state.flashSale.end_time))}</div>`
      : `<div class="muted">Monte a sessao, configure os produtos e salve em popup.</div>`;

    openModal(
      title,
      `
        <div class="promo-modal-shell flash-editor-shell">
          <div class="promo-modal-headline">
            <div>
              <div class="promo-modal-title">${this.escape(title)}</div>
              ${flashMeta}
            </div>
            ${
              isEdit
                ? `<div class="section-actions">
                    <button id="btnFlashSaleEditorEnable" class="btn btn-ghost" type="button">Habilitar sessao</button>
                    <button id="btnFlashSaleEditorDisable" class="btn btn-ghost" type="button">Desabilitar sessao</button>
                  </div>`
                : ""
            }
          </div>

          ${
            needsTimeslot
              ? `
                <div class="promo-modal-card">
                  <div class="promo-modal-card__title">Timeslot da nova sessao</div>
                  <div class="promo-modal-grid promo-modal-grid--3">
                    <label class="field">
                      <span>Inicio da janela</span>
                      <input id="flashSaleEditorStart" class="input" type="datetime-local" value="${this.escape(state.slotWindowStart)}" />
                    </label>
                    <label class="field">
                      <span>Fim da janela</span>
                      <input id="flashSaleEditorEnd" class="input" type="datetime-local" value="${this.escape(state.slotWindowEnd)}" />
                    </label>
                    <div class="field promo-modal-actions-inline">
                      <span>&nbsp;</span>
                      <button id="btnFlashSaleEditorLoadSlots" class="btn btn-primary" type="button">Buscar timeslots</button>
                    </div>
                  </div>
                  <div id="flashSaleEditorSlotsWrap" style="margin-top:12px;">
                    ${
                      state.timeSlots.length
                        ? `
                          <label class="field">
                            <span>Timeslot</span>
                            <select id="flashSaleEditorTimeslot" class="select">
                              <option value="">Selecione</option>
                              ${state.timeSlots
                                .map(
                                  (slot) => `
                                    <option value="${this.escape(slot.timeslot_id)}" ${
                                      String(state.selectedTimeslotId) === String(slot.timeslot_id)
                                        ? "selected"
                                        : ""
                                    }>
                                      ${this.escape(this.fmtDateTime(slot.start_time))} ate ${this.escape(this.fmtDateTime(slot.end_time))} • ${this.escape(slot.timeslot_id)}
                                    </option>
                                  `,
                                )
                                .join("")}
                            </select>
                          </label>
                        `
                        : `<div class="muted">Busque os timeslots disponiveis.</div>`
                    }
                  </div>
                </div>
              `
              : ""
          }

          <div class="promo-modal-card">
            <div class="promo-modal-card__title">Adicionar produtos</div>
            <div class="promo-modal-grid promo-modal-grid--3">
              <label class="field">
                <span>Buscar produto</span>
                <input id="flashSaleEditorSearch" class="input" type="text" value="${this.escape(state.searchQuery || "")}" placeholder="Nome, SKU ou item id" />
              </label>
              <label class="field promo-modal-checkline">
                <span>Filtro</span>
                <label class="promo-check">
                  <input id="flashSaleEditorEligibleOnly" type="checkbox" ${state.eligibleOnly ? "checked" : ""} />
                  <span>Somente elegiveis</span>
                </label>
              </label>
              <div class="field promo-modal-actions-inline">
                <span>&nbsp;</span>
                <button id="btnFlashSaleEditorSearch" class="btn btn-primary" type="button">Buscar produtos</button>
              </div>
            </div>
            <div id="flashSaleEditorSearchResults" class="promo-search-results" style="margin-top:12px;">
              ${this.buildSearchResults()}
            </div>
          </div>

          <div class="promo-modal-card">
            <div class="promo-modal-card__title">Edicao em lote</div>
            <div class="promo-modal-grid promo-modal-grid--4">
              <label class="field">
                <span>Desconto %</span>
                <input id="flashSaleEditorBulkDiscount" class="input" type="number" min="0" max="99" step="0.01" value="${this.escape(state.bulkDiscountPct)}" placeholder="Ex.: 15" />
              </label>
              <label class="field">
                <span>Estoque reservado</span>
                <input id="flashSaleEditorBulkStock" class="input" type="number" min="1" step="1" value="${this.escape(state.bulkStock)}" placeholder="Ex.: 10" />
              </label>
              <label class="field">
                <span>Limite por cliente</span>
                <input id="flashSaleEditorBulkLimit" class="input" type="number" min="0" step="1" value="${this.escape(state.bulkLimit)}" placeholder="0 = ilimitado" />
              </label>
              <div class="field promo-modal-actions-inline">
                <span>&nbsp;</span>
                <div class="section-actions">
                  <button id="btnFlashSaleApplySelected" class="btn btn-ghost" type="button">Aplicar aos selecionados</button>
                  <button id="btnFlashSaleApplyAll" class="btn btn-primary" type="button">Aplicar a todos</button>
                </div>
              </div>
            </div>
          </div>

          <div class="promo-modal-card">
            <div class="promo-modal-card__title">Produtos da Flash Sale</div>
            <div id="flashSaleEditorRows">${this.buildFlashRowTable(state.rows)}</div>
          </div>

          <div class="promo-modal-footer">
            <div class="muted">${this.escape(state.rows.length)} item(ns) configurado(s)</div>
            <div class="section-actions">
              <button id="btnFlashSaleEditorClose" class="btn btn-ghost" type="button">Fechar</button>
              <button id="btnFlashSaleEditorSave" class="btn btn-primary" type="button">${isEdit ? "Salvar alteracoes" : "Criar Flash Sale"}</button>
            </div>
          </div>
        </div>
      `,
    );

    this.bindEditorEvents();
  }

  bindEditorEvents() {
    const state = this.editorState;
    if (!state) return;

    document.getElementById("btnFlashSaleEditorClose")?.addEventListener("click", () => closeModal());
    document.getElementById("btnFlashSaleEditorLoadSlots")?.addEventListener("click", async (event) =>
      this.runButtonAction(
        event.currentTarget,
        "Buscando timeslots...",
        () => this.loadTimeSlotsForEditor(),
      ),
    );
    document.getElementById("btnFlashSaleEditorSearch")?.addEventListener("click", async (event) =>
      this.runButtonAction(
        event.currentTarget,
        "Buscando produtos...",
        () => this.searchProductsForEditor(),
      ),
    );
    document.getElementById("btnFlashSaleApplySelected")?.addEventListener("click", () => this.applyBulkChanges("selected"));
    document.getElementById("btnFlashSaleApplyAll")?.addEventListener("click", () => this.applyBulkChanges("all"));
    document.getElementById("btnFlashSaleEditorSave")?.addEventListener("click", async (event) =>
      this.runButtonAction(
        event.currentTarget,
        state.mode === "edit" ? "Salvando campanha..." : "Criando campanha...",
        () => this.saveEditor(),
      ),
    );
    document.getElementById("btnFlashSaleEditorEnable")?.addEventListener("click", async (event) =>
      this.runButtonAction(
        event.currentTarget,
        "Habilitando sessao...",
        () => this.updateSessionStatusFromModal(1),
      ),
    );
    document.getElementById("btnFlashSaleEditorDisable")?.addEventListener("click", async (event) =>
      this.runButtonAction(
        event.currentTarget,
        "Desabilitando sessao...",
        () => this.updateSessionStatusFromModal(2),
      ),
    );
    document.getElementById("flashSaleEditorSearch")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.searchProductsForEditor();
      }
    });
    document.getElementById("flashSaleEditorSelectAll")?.addEventListener("change", (event) => {
      const checked = Boolean(event.target.checked);
      state.rows = state.rows.map((row) => ({ ...row, selected: checked }));
      this.renderEditorModal();
    });

    document.querySelectorAll("[data-flash-editor-row]").forEach((tr) => {
      const uid = tr.getAttribute("data-flash-editor-row");
      tr.querySelector(".flash-editor-row-select")?.addEventListener("change", (event) => {
        this.patchRow(uid, { selected: Boolean(event.target.checked) });
      });
      tr.querySelector(".flash-editor-discount")?.addEventListener("change", (event) => {
        this.applyDiscountToRow(uid, event.target.value);
      });
      tr.querySelector(".flash-editor-price")?.addEventListener("change", (event) => {
        this.patchRow(uid, { promotionPrice: Number(event.target.value || 0) });
      });
      tr.querySelector(".flash-editor-stock")?.addEventListener("change", (event) => {
        this.patchRow(uid, { campaignStock: Number(event.target.value || 0) });
      });
      tr.querySelector(".flash-editor-limit")?.addEventListener("change", (event) => {
        this.patchRow(uid, { purchaseLimit: Number(event.target.value || 0) });
      });
      tr.querySelector(".flash-editor-remove")?.addEventListener("click", () => {
        this.removeRow(uid);
      });
    });

    document.querySelectorAll(".flash-editor-add-product").forEach((button) => {
      button.addEventListener("click", async () =>
        this.runButtonAction(button, "Adicionando produto...", () =>
          this.addProductToEditor(button.getAttribute("data-item-id")),
        ),
      );
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
      const original = Number(row.originalPrice || 0);
      if (!original || !Number.isFinite(discountPct)) return row;
      const promotionPrice = Math.max(
        0.01,
        Number((original * (1 - discountPct / 100)).toFixed(2)),
      );
      return { ...row, promotionPrice };
    });
    this.renderEditorModal();
  }

  removeRow(uid) {
    const row = this.editorState.rows.find((item) => item.uid === uid);
    if (row?.existing) {
      this.editorState.removedItemIds.add(String(row.itemId));
    }
    this.editorState.rows = this.editorState.rows.filter((item) => item.uid !== uid);
    this.renderEditorModal();
  }

  async loadTimeSlotsForEditor() {
    const start = document.getElementById("flashSaleEditorStart")?.value || "";
    const end = document.getElementById("flashSaleEditorEnd")?.value || "";
    if (!start || !end) {
      window.alert("Informe a janela de busca.");
      return;
    }
    this.editorState.slotWindowStart = start;
    this.editorState.slotWindowEnd = end;
    const params = new URLSearchParams({ startTime: start, endTime: end });
    const data = await this.api(`/shopee/shops/active/flash-sales/time-slots?${params.toString()}`);
    this.editorState.timeSlots = Array.isArray(data.timeSlots) ? data.timeSlots : [];
    this.editorState.selectedTimeslotId = "";
    this.renderEditorModal();
  }

  async searchProductsForEditor() {
    const q = document.getElementById("flashSaleEditorSearch")?.value?.trim() || "";
    this.editorState.searchQuery = q;
    this.editorState.eligibleOnly = Boolean(document.getElementById("flashSaleEditorEligibleOnly")?.checked);
    const params = new URLSearchParams({ q, page: "1", pageSize: "25" });
    const data = await this.api(`/shopee/shops/active/products?${params.toString()}`);
    const items = Array.isArray(data.items) ? data.items : [];
    this.editorSearchResults = this.editorState.eligibleOnly
      ? items.filter((item) => Number(item.totalStock ?? item.stock ?? 0) > 0)
      : items;
    this.renderEditorModal();
  }

  priceCentsToBrl(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return n > 1000 ? Number((n / 100).toFixed(2)) : Number(n.toFixed(2));
  }

  async addProductToEditor(itemId) {
    const data = await this.api(`/shopee/shops/active/products/${encodeURIComponent(itemId)}/full`);
    const product = data.product || null;
    if (!product) {
      window.alert("Nao foi possivel carregar o produto.");
      return;
    }
    const lockInfo = this.getPromotionLockInfo(product?.promotionLock);
    if (lockInfo.blocked) {
      window.alert(`Este produto esta bloqueado para Flash Sale por aumento de preco recente. Restante: ${lockInfo.remainingLabel}.`);
      return;
    }

    const rows = [];
    const models = Array.isArray(product.models) ? product.models : [];
    if (models.length) {
      models.forEach((model) => {
        const originalPrice = this.priceCentsToBrl(model.price);
        rows.push(
          this.normalizeFlashRow(
            {
              kind: "model",
              itemId: product.itemId,
              itemName: product.title || `Item ${product.itemId}`,
              modelId: model.modelId,
              modelName: model.name || `Modelo ${model.modelId}`,
              originalPrice,
              inputPromotionPrice: originalPrice,
              campaignStock: Number(model.stock || 0) || 0,
              stock: Number(model.stock || 0) || 0,
              purchaseLimit: 0,
            },
            { existing: false, promotionLock: product.promotionLock || null },
          ),
        );
      });
    } else {
      const basePrice = this.priceCentsToBrl(product.priceMin ?? product.priceMax ?? 0);
      rows.push(
        this.normalizeFlashRow(
          {
            kind: "item",
            itemId: product.itemId,
            itemName: product.title || `Item ${product.itemId}`,
            originalPrice: basePrice,
            inputPromotionPrice: basePrice,
            campaignStock: Number(product.totalStock ?? product.stock ?? 0) || 0,
            stock: Number(product.totalStock ?? product.stock ?? 0) || 0,
            purchaseLimit: 0,
          },
          { existing: false, promotionLock: product.promotionLock || null },
        ),
      );
    }

    const existingKeys = new Set(this.editorState.rows.map((row) => row.uid));
    rows.forEach((row) => {
      if (!existingKeys.has(row.uid)) this.editorState.rows.push(row);
    });
    this.renderEditorModal();
  }

  getBulkValuesFromForm() {
    return {
      discountPct: document.getElementById("flashSaleEditorBulkDiscount")?.value ?? "",
      stock: document.getElementById("flashSaleEditorBulkStock")?.value ?? "",
      limit: document.getElementById("flashSaleEditorBulkLimit")?.value ?? "",
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
      let promotionPrice = row.promotionPrice;
      if (Number.isFinite(discountPct) && Number(row.originalPrice || 0) > 0) {
        promotionPrice = Math.max(
          0.01,
          Number((Number(row.originalPrice) * (1 - discountPct / 100)).toFixed(2)),
        );
      }
      return {
        ...row,
        promotionPrice,
        campaignStock: Number.isFinite(stock) ? stock : row.campaignStock,
        purchaseLimit: Number.isFinite(limit) ? limit : row.purchaseLimit,
      };
    });
    this.renderEditorModal();
  }

  buildRowsPayload(rows, { includeStatus = false } = {}) {
    const grouped = new Map();
    rows.forEach((row) => {
      const itemId = Number(row.itemId);
      if (!Number.isFinite(itemId)) return;
      if (!grouped.has(itemId)) {
        grouped.set(itemId, {
          itemId: String(itemId),
          purchaseLimit: Number(row.purchaseLimit || 0) || 0,
        });
      }
      const entry = grouped.get(itemId);
      entry.purchaseLimit = Number(row.purchaseLimit || entry.purchaseLimit || 0) || 0;
      if (row.kind === "model") {
        if (!Array.isArray(entry.models)) entry.models = [];
        entry.models.push({
          modelId: String(row.modelId),
          inputPromoPrice: Number(row.promotionPrice || 0),
          stock: Number(row.campaignStock || 0),
          ...(includeStatus ? { status: Number(row.flashSaleStatus || 1) || 1 } : {}),
        });
        return;
      }
      entry.itemInputPromoPrice = Number(row.promotionPrice || 0);
      entry.itemStock = Number(row.campaignStock || 0);
      if (includeStatus) entry.itemStatus = Number(row.flashSaleStatus || 1) || 1;
    });

    return Array.from(grouped.values()).filter((item) => {
      if (Array.isArray(item.models) && item.models.length) return true;
      return Number(item.itemInputPromoPrice || 0) > 0 && Number(item.itemStock || 0) > 0;
    });
  }

  validateRows(rows) {
    if (!rows.length) throw new Error("Adicione pelo menos um produto na Flash Sale.");
    rows.forEach((row) => {
      const lockInfo = this.getPromotionLockInfo(row?.promotionLock);
      if (lockInfo.blocked) {
        throw new Error(`Produto bloqueado para Flash Sale: ${row.itemName} (restante: ${lockInfo.remainingLabel}).`);
      }
      if (Number(row.promotionPrice || 0) <= 0) {
        throw new Error(`Preco promocional invalido para ${row.itemName}.`);
      }
      if (Number(row.campaignStock || 0) <= 0) {
        throw new Error(`Estoque reservado invalido para ${row.itemName}.`);
      }
    });
  }

  async updateSessionStatusFromModal(status) {
    if (!this.editorState?.flashSale?.flash_sale_id) return;
    await this.updateFlashSaleStatus(this.editorState.flashSale.flash_sale_id, status);
    const refreshed = await this.loadFlashSaleDetails(this.editorState.flashSale.flash_sale_id);
    const rowsWithLocks = await this.attachPromotionLocksToRows(refreshed.rows);
    this.selectedFlashSale = refreshed.flashSale;
    this.editorState.flashSale = refreshed.flashSale;
    this.editorState.rows = rowsWithLocks;
    this.renderEditorModal();
  }

  async saveEditor() {
    const state = this.editorState;
    if (!state) return;
    const selectedTimeslotId = document.getElementById("flashSaleEditorTimeslot")?.value || state.selectedTimeslotId;
    state.selectedTimeslotId = selectedTimeslotId;

    try {
      this.validateRows(state.rows);
      if (state.mode !== "edit" && !selectedTimeslotId) {
        throw new Error("Selecione um timeslot para criar a sessao.");
      }

      if (state.mode === "edit") {
        const existingRows = state.rows.filter((row) => row.existing);
        const newRows = state.rows.filter((row) => !row.existing);

        if (state.removedItemIds.size) {
          await this.api(`/shopee/shops/active/flash-sales/${encodeURIComponent(state.flashSale.flash_sale_id)}/items/delete`, {
            method: "POST",
            body: JSON.stringify({ itemIds: Array.from(state.removedItemIds) }),
          });
        }

        if (existingRows.length) {
          await this.api(`/shopee/shops/active/flash-sales/${encodeURIComponent(state.flashSale.flash_sale_id)}/items/update`, {
            method: "POST",
            body: JSON.stringify({ items: this.buildRowsPayload(existingRows, { includeStatus: true }) }),
          });
        }

        if (newRows.length) {
          await this.api(`/shopee/shops/active/flash-sales/${encodeURIComponent(state.flashSale.flash_sale_id)}/items`, {
            method: "POST",
            body: JSON.stringify({ items: this.buildRowsPayload(newRows) }),
          });
        }

        await this.loadFlashSales();
        const refreshed = await this.loadFlashSaleDetails(state.flashSale.flash_sale_id);
        const rowsWithLocks = await this.attachPromotionLocksToRows(refreshed.rows);
        this.selectedFlashSale = refreshed.flashSale;
        this.editorState = this.buildEditorState({
          mode: "edit",
          flashSale: refreshed.flashSale,
          rows: rowsWithLocks,
        });
        this.renderEditorModal();
        return;
      }

      const created = await this.api("/shopee/shops/active/flash-sales", {
        method: "POST",
        body: JSON.stringify({ timeslotId: selectedTimeslotId }),
      });
      const flashSaleId = created?.flashSale?.flash_sale_id;
      if (!flashSaleId) throw new Error("A Shopee nao retornou a nova sessao.");

      await this.api(`/shopee/shops/active/flash-sales/${encodeURIComponent(flashSaleId)}/items`, {
        method: "POST",
        body: JSON.stringify({ items: this.buildRowsPayload(state.rows) }),
      });

      closeModal();
      await this.loadFlashSales();
      this.selectedFlashSale = created.flashSale || null;
    } catch (error) {
      const blockedItems = Array.isArray(error?.payload?.blockedItems)
        ? error.payload.blockedItems
        : [];
      if (blockedItems.length) {
        const preview = blockedItems
          .slice(0, 5)
          .map((row) => `Item ${row.itemId} (${row.remainingLabel || "-"})`)
          .join(", ");
        window.alert(`Nao foi possivel salvar/publicar Flash Sale. Existem produtos bloqueados por aumento de preco: ${preview}`);
        return;
      }
      window.alert(error.message || "Erro ao salvar Flash Sale.");
    }
  }

  async updateFlashSaleStatus(flashSaleId, status) {
    await this.api(`/shopee/shops/active/flash-sales/${encodeURIComponent(flashSaleId)}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    });
    await this.loadFlashSales();
  }

  async deleteFlashSale(flashSaleId) {
    if (!window.confirm("Excluir esta Flash Sale?")) return;
    await this.api(`/shopee/shops/active/flash-sales/${encodeURIComponent(flashSaleId)}/delete`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    await this.loadFlashSales();
  }
}

window.flashSaleManager = new FlashSaleManager();
