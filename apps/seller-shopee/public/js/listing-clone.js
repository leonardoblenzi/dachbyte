class ListingCloneManager {
  constructor() {
    this.bound = false;
    this.draft = null;
    this.drafts = [];
    this.categories = [];
    this.categoriesLoading = false;
    this.dragImageIndex = null;
    this.activeSubtab = "editor";
    this.draftStatusState = { text: "", type: "" };
    this.logisticsValidation = null;
    this.lastPublishResult = null;
    this.statusState = { text: "", type: "" };
    this.publishStatusState = { text: "", type: "" };
    this.maxImages = 9;
    this.categoryTreeQuery = "";
    this.categoryAttributesCache = new Map();
    this.activeEditorSection = "details";
  }

  getRoot() {
    return document.getElementById("listingCloneRoot");
  }

  escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  parseJsonResponse(response) {
    return response.text().then((text) => (text ? JSON.parse(text) : {}));
  }

  getApiErrorMessage(payload, status) {
    if (typeof payload?.message === "string" && payload.message.trim()) return payload.message;
    if (typeof payload?.error === "string" && payload.error.trim()) return payload.error;
    if (typeof payload?.error?.message === "string" && payload.error.message.trim()) return payload.error.message;
    return `HTTP ${status}`;
  }

  async apiGet(path) {
    const response = await fetch(`/shopee${path}`, {
      method: "GET",
      credentials: "include",
    });
    const json = await this.parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(this.getApiErrorMessage(json, response.status));
    }
    return json;
  }

  async apiPost(path, body, { asFormData = false } = {}) {
    const options = {
      method: "POST",
      credentials: "include",
    };

    if (asFormData) {
      options.body = body;
    } else {
      options.headers = { "Content-Type": "application/json" };
      options.body = JSON.stringify(body || {});
    }

    const response = await fetch(`/shopee${path}`, options);
    const json = await this.parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(this.getApiErrorMessage(json, response.status));
    }
    return json;
  }

  async requestConfirmation({ title, message, confirmLabel = "Confirmar", danger = false }) {
    return new Promise((resolve) => {
      document.getElementById("listingCloneConfirmDialog")?.remove();
      const overlay = document.createElement("div");
      overlay.id = "listingCloneConfirmDialog";
      overlay.className = "listing-clone-dialog-backdrop";
      overlay.innerHTML = `
        <div class="listing-clone-dialog" role="dialog" aria-modal="true" aria-labelledby="listingCloneDialogTitle">
          <div><strong id="listingCloneDialogTitle">${this.escapeHtml(title)}</strong><p>${this.escapeHtml(message)}</p></div>
          <div class="section-actions">
            <button class="btn btn-ghost" type="button" data-dialog-cancel>Voltar</button>
            <button class="btn ${danger ? "btn-danger" : "btn-primary"}" type="button" data-dialog-confirm>${this.escapeHtml(confirmLabel)}</button>
          </div>
        </div>`;
      const finish = (value) => { overlay.remove(); resolve(value); };
      overlay.querySelector("[data-dialog-cancel]")?.addEventListener("click", () => finish(false));
      overlay.querySelector("[data-dialog-confirm]")?.addEventListener("click", () => finish(true));
      overlay.addEventListener("click", (event) => { if (event.target === overlay) finish(false); });
      document.body.appendChild(overlay);
      overlay.querySelector("[data-dialog-confirm]")?.focus();
    });
  }

  setImportBusy(busy) {
    const button = document.getElementById("btnListingClonePreview");
    const progress = document.getElementById("listingCloneImportProgress");
    if (button) {
      button.disabled = Boolean(busy);
      button.textContent = busy ? "Importando..." : "Importar anuncio";
    }
    if (progress) progress.hidden = !busy;
  }

  async apiDelete(path) {
    const response = await fetch(`/shopee${path}`, {
      method: "DELETE",
      credentials: "include",
    });
    const json = await this.parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(this.getApiErrorMessage(json, response.status));
    }
    return json;
  }

  setStatus(text, type = "") {
    this.statusState = { text: text || "", type };
    const el = document.getElementById("listingCloneStatus");
    if (!el) return;
    el.className = type ? `muted ui-state ui-state--${type}` : "muted";
    el.textContent = text || "";
  }

  setPublishStatus(text, type = "") {
    this.publishStatusState = { text: text || "", type };
    const el = document.getElementById("listingClonePublishStatus");
    if (!el) return;
    el.className = type ? `muted ui-state ui-state--${type}` : "muted";
    el.textContent = text || "";
  }

  setDraftStatus(text, type = "") {
    this.draftStatusState = { text: text || "", type };
    const el = document.getElementById("listingCloneDraftStatus");
    if (!el) return;
    el.className = type ? `muted ui-state ui-state--${type}` : "muted";
    el.textContent = text || "";
  }

  deepClone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  normalizeText(value) {
    return String(value || "").trim();
  }

  toNumber(value) {
    if (value == null || value === "") return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;

    const raw = String(value).trim();
    if (!raw) return null;

    let normalized = raw.replace(/[^\d,.-]/g, "");
    const hasComma = normalized.includes(",");
    const hasDot = normalized.includes(".");

    if (hasComma && hasDot) {
      if (normalized.lastIndexOf(",") > normalized.lastIndexOf(".")) {
        normalized = normalized.replace(/\./g, "").replace(",", ".");
      } else {
        normalized = normalized.replace(/,/g, "");
      }
    } else if (hasComma) {
      normalized = normalized.replace(",", ".");
    }

    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  toInteger(value) {
    const parsed = this.toNumber(value);
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
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

  buildCategoryDisplayValue(category) {
    if (!category) return "";
    const categoryId = this.normalizeText(category?.categoryId);
    const path = this.normalizeText(category?.path || category?.displayName || "");
    if (!categoryId && !path) return "";
    if (!categoryId) return path;
    return path ? `${categoryId} - ${path}` : categoryId;
  }

  resolveCategoryEntryById(categoryId) {
    const target = this.normalizeText(categoryId);
    if (!target) return null;
    return (Array.isArray(this.categories) ? this.categories : []).find(
      (entry) => this.normalizeText(entry?.categoryId) === target,
    ) || null;
  }

  resolveCategoryEntryFromInput(inputValue) {
    const raw = this.normalizeText(inputValue);
    if (!raw) return null;
    const match = raw.match(/^(\d+)/);
    const byId = match ? this.resolveCategoryEntryById(match[1]) : null;
    if (byId) return byId;

    const exact = (Array.isArray(this.categories) ? this.categories : []).find((entry) => {
      const display = this.buildCategoryDisplayValue(entry);
      return this.normalizeText(display) === raw;
    }) || null;
    if (exact) return exact;

    const normalizedRaw = raw.toLowerCase();
    const partialMatches = (Array.isArray(this.categories) ? this.categories : []).filter((entry) => {
      const display = this.buildCategoryDisplayValue(entry).toLowerCase();
      const path = this.normalizeText(entry?.path || entry?.displayName || "").toLowerCase();
      return display.includes(normalizedRaw) || path.includes(normalizedRaw);
    });
    if (partialMatches.length === 1) return partialMatches[0];
    return null;
  }

  filterCategoriesByQuery(categories = []) {
    const query = this.normalizeText(this.categoryTreeQuery).toLowerCase();
    if (!query) return categories;
    return categories.filter((category) => {
      const displayName = this.normalizeText(category?.displayName || category?.path || "").toLowerCase();
      const categoryId = this.normalizeText(category?.categoryId).toLowerCase();
      return displayName.includes(query) || categoryId.includes(query);
    });
  }

  renderCategoryDatalist() {
    const categories = Array.isArray(this.categories) ? this.categories : [];
    return `
      <datalist id="listingCloneCategoryTreeList">
        ${categories
          .map((category) => {
            const value = this.buildCategoryDisplayValue(category);
            return value ? `<option value="${this.escapeHtml(value)}"></option>` : "";
          })
          .join("")}
      </datalist>
    `;
  }

  renderCategoryTreeSelect(selectedCategoryId) {
    const categories = Array.isArray(this.categories) ? this.categories : [];
    const filteredCategories = this.filterCategoriesByQuery(categories);
    if (!categories.length) {
      return `
        <div class="muted ui-state ui-state--empty">
          A arvore de categorias ainda nao foi carregada.
        </div>
      `;
    }

    if (!filteredCategories.length) {
      return `
        <div class="muted ui-state ui-state--empty">
          Nenhuma categoria encontrada para "${this.escapeHtml(this.categoryTreeQuery)}".
        </div>
      `;
    }

    return `
      <select id="listingCloneCategoryTreeSelect" class="select listing-clone-category-tree-select" size="10">
        ${filteredCategories
          .map((category) => {
            const categoryId = this.normalizeText(category?.categoryId);
            if (!categoryId) return "";
            const level = Number(category?.level || 0);
            const indent = "\u00A0\u00A0".repeat(Math.max(0, level));
            const label = `${indent}${categoryId} - ${this.normalizeText(category?.displayName || category?.path || "")}`;
            return `<option value="${this.escapeHtml(categoryId)}" ${String(selectedCategoryId || "") === categoryId ? "selected" : ""}>${this.escapeHtml(label)}</option>`;
          })
          .join("")}
      </select>
      <div class="muted">
        ${this.escapeHtml(filteredCategories.length)} de ${this.escapeHtml(categories.length)} categoria(s). Use o campo acima ou selecione diretamente na lista.
      </div>
    `;
  }

  renderCategorySuggestions(draft) {
    const detected = draft?.detectedCategory && typeof draft.detectedCategory === "object"
      ? draft.detectedCategory
      : null;
    const recommended = Array.isArray(draft?.recommendedCategories)
      ? draft.recommendedCategories
      : [];

    if (!detected && !recommended.length) return "";

    return `
      <div class="listing-clone-category-suggestions listing-clone-form-grid__full">
        <div class="muted">Sugestoes de categoria (com base no anuncio clonado)</div>
        ${detected
          ? `
            <div class="listing-clone-category-suggestion__current">
              <span class="listing-clone-pill">Categoria atual detectada</span>
              <button
                class="btn btn-ghost"
                type="button"
                data-clone-category-suggestion="${this.escapeHtml(detected?.categoryId || "")}"
              >
                ${this.escapeHtml(detected?.categoryId || "")} - ${this.escapeHtml(
                  detected?.displayName || detected?.path || "",
                )}
              </button>
            </div>
          `
          : ""
        }
        ${
          recommended.length
            ? `
              <div class="listing-clone-category-suggestion__list">
                ${recommended
                  .map(
                    (entry) => `
                      <button
                        class="btn btn-ghost"
                        type="button"
                        data-clone-category-suggestion="${this.escapeHtml(entry?.categoryId || "")}"
                      >
                        ${this.escapeHtml(entry?.categoryId || "")} - ${this.escapeHtml(
                          entry?.displayName || entry?.path || "",
                        )}
                      </button>
                    `,
                  )
                  .join("")}
              </div>
            `
            : ""
        }
      </div>
    `;
  }

  async ensureCategoriesLoaded({ force = false, silent = true } = {}) {
    if (this.categoriesLoading) return;
    if (!force && Array.isArray(this.categories) && this.categories.length) return;

    this.categoriesLoading = true;
    if (!silent) this.setStatus("Carregando arvore completa de categorias Shopee...", "loading");

    try {
      const response = await this.apiGet("/shops/active/listing-clone/categories");
      this.categories = Array.isArray(response?.categories) ? response.categories : [];
      if (!silent) {
        this.setStatus(
          this.categories.length
            ? `${this.categories.length} categorias carregadas da Shopee.`
            : "Nenhuma categoria retornada pela Shopee.",
          this.categories.length ? "" : "warning",
        );
      }
      if (this.draft && document.getElementById("listingCloneItemName")) {
        this.renderEditor();
      }
    } catch (error) {
      if (!silent) this.setStatus(`Falha ao carregar categorias: ${error.message}`, "error");
    } finally {
      this.categoriesLoading = false;
    }
  }

  switchSubtab(nextSubtab) {
    this.activeSubtab = nextSubtab === "drafts" ? "drafts" : "editor";
    this.setDraftStatus("");
    if (this.activeSubtab === "drafts") {
      this.loadDrafts();
      return;
    }
    this.renderCurrentEditorView();
  }

  renderSubtabs() {
    return `
      <div class="listing-clone-subtabs">
        <button class="btn ${this.activeSubtab === "editor" ? "btn-primary" : "btn-ghost"}" type="button" data-listing-clone-subtab="editor">
          Novo clone
        </button>
        <button class="btn ${this.activeSubtab === "drafts" ? "btn-primary" : "btn-ghost"}" type="button" data-listing-clone-subtab="drafts">
          Rascunhos
        </button>
      </div>
    `;
  }

  bindSubtabs() {
    this.getRoot()
      ?.querySelectorAll("[data-listing-clone-subtab]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          this.switchSubtab(button.getAttribute("data-listing-clone-subtab"));
        });
      });
  }

  collectBasicValidation(draft) {
    const issues = [];

    if (!this.normalizeText(draft?.itemName)) issues.push("Titulo");
    if (!this.normalizeText(draft?.description)) issues.push("Descricao");
    if (!this.normalizeText(draft?.categoryId)) issues.push("Categoria Shopee");
    if (!this.normalizeText(draft?.brandName)) issues.push("Marca");
    if (!Number.isFinite(this.toNumber(draft?.originalPrice)) && !draft?.variations?.enabled) {
      issues.push("Preco");
    }
    if (!Number.isFinite(this.toNumber(draft?.weight))) issues.push("Peso");
    if (!Number.isFinite(this.toInteger(draft?.dimension?.package_width))) issues.push("Largura");
    if (!Number.isFinite(this.toInteger(draft?.dimension?.package_length))) issues.push("Comprimento");
    if (!Number.isFinite(this.toInteger(draft?.dimension?.package_height))) issues.push("Altura");
    if (!Array.isArray(draft?.images) || draft.images.length < 3) issues.push("Minimo 3 imagens");
    if (
      !Array.isArray(draft?.logisticInfo) ||
      !draft.logisticInfo.some((entry) => entry?.enabled)
    ) {
      issues.push("Logistica");
    }

    const missingMandatoryAttributes = (Array.isArray(draft?.attributes) ? draft.attributes : [])
      .filter((attribute) => attribute?.isMandatory)
      .filter((attribute) => {
        const values = Array.isArray(attribute?.values)
          ? attribute.values.map((value) => this.normalizeText(value)).filter(Boolean)
          : [];
        return !values.length;
      });
    if (missingMandatoryAttributes.length) issues.push("Atributos obrigatorios");

    if (this.logisticsValidation?.requiresSpxAdjustment) {
      issues.push("Regras SPX/logistica");
    }

    if (draft?.variations?.enabled) {
      const models = Array.isArray(draft?.variations?.models) ? draft.variations.models : [];
      if (!models.length) issues.push("Modelos");
      if (
        models.some((model) => !Number.isFinite(this.toNumber(model?.originalPrice ?? draft?.originalPrice)))
      ) {
        issues.push("Preco dos modelos");
      }
    }

    return issues;
  }

  renderExtractionSummary(draft) {
    const extraction = draft?.extraction || {};
    const counts = extraction?.counts || {};
    const methodLabel = extraction?.method === "official-api" ? "API oficial Shopee" : extraction?.method === "madeiramadeira-jsonld" ? "MadeiraMadeira (dados publicos)" : extraction?.method === "generic-jsonld-meta" ? "Dados estruturados da pagina" : "Pagina publica";
    const items = [
      ["Titulo", Boolean(draft?.itemName)],
      ["Descricao", Boolean(draft?.description)],
      [`${Number(counts.images || draft?.images?.length || 0)} imagens`, Number(counts.images || draft?.images?.length || 0) > 0],
      [`${Number(counts.attributes || draft?.sourceAttributes?.length || 0)} atributos`, Number(counts.attributes || draft?.sourceAttributes?.length || 0) > 0],
      [`${Number(counts.variations || draft?.variations?.models?.length || 0)} variacoes`, Number(counts.variations || draft?.variations?.models?.length || 0) > 0],
      ["Categoria", Boolean(draft?.categoryId || draft?.recommendedCategories?.length)],
      ["Clip", Boolean(draft?.clip?.sourceUrl || draft?.clip?.videoUploadId)],
    ];

    return `
      <div class="listing-clone-import-summary">
        <div class="listing-clone-import-summary__head">
          <div><strong>Conteudo importado</strong><span class="muted">Fonte: ${this.escapeHtml(methodLabel)}</span></div>
          <span class="listing-clone-import-summary__count">${items.filter((item) => item[1]).length}/${items.length}</span>
        </div>
        <div class="listing-clone-import-summary__items">
          ${items.map(([label, ok]) => `<span class="listing-clone-import-item ${ok ? "is-ready" : "is-missing"}">${ok ? "OK" : "Revisar"} · ${this.escapeHtml(label)}</span>`).join("")}
        </div>
      </div>
    `;
  }

  renderHome() {
    const root = this.getRoot();
    if (!root) return;

    root.innerHTML = `
      <div class="section-card listing-clone-shell">
        <div class="section-card__header">
          <div>
            <div class="section-title">Clonar anuncio</div>
            <div class="muted">Importe um anuncio, confira o conteudo e publique somente depois da revisao.</div>
          </div>
        </div>
        <div class="section-card__body">
          ${this.renderSubtabs()}
          <div class="listing-clone-workflow" aria-label="Etapas da clonagem">
            <span class="is-active"><strong>1</strong> Importar</span>
            <span><strong>2</strong> Revisar</span>
            <span><strong>3</strong> Publicar</span>
          </div>
          <form id="listingClonePreviewForm" class="listing-clone-preview-form">
            <label class="field listing-clone-preview-form__field">
              <span class="muted">Link do anuncio de origem</span>
              <input id="listingCloneSourceUrl" class="input" type="url" autocomplete="url" placeholder="Cole o link público do produto" required>
            </label>
            <button id="btnListingClonePreview" class="btn btn-primary" type="submit">Importar anuncio</button>
          </form>
          <div id="listingCloneImportProgress" class="listing-clone-import-progress" hidden>
            <span></span><span></span><span></span>
          </div>
          <div id="listingCloneStatus" class="${this.statusState?.type ? `muted ui-state ui-state--${this.escapeHtml(this.statusState.type)}` : "muted"}">${this.escapeHtml(this.statusState?.text || "")}</div>
        </div>
      </div>
    `;

    document.getElementById("listingClonePreviewForm")?.addEventListener("submit", (event) => this.handlePreview(event));
    this.bindSubtabs();
  }

  renderNotes(draft) {
    const notes = Array.isArray(draft?.notes) ? draft.notes.filter(Boolean) : [];
    if (!notes.length) return "";

    return `
      <div class="listing-clone-notes">
        ${notes
          .map(
            (note) =>
              `<div class="listing-clone-note">${this.escapeHtml(String(note))}</div>`,
          )
          .join("")}
      </div>
    `;
  }

  renderChecklist(draft) {
    const issues = this.collectBasicValidation(draft);
    const tone = issues.length ? "warning" : "success";
    const title = issues.length
      ? `${issues.length} ponto(s) pedem revisao antes de publicar`
      : "Checklist basico pronto para publicacao";

    return `
      <div class="listing-clone-checklist listing-clone-checklist--${tone}">
        <div class="listing-clone-checklist__title">${this.escapeHtml(title)}</div>
        <div class="listing-clone-checklist__items">
          ${
            issues.length
              ? issues
                  .map(
                    (issue) =>
                      `<span class="listing-clone-pill listing-clone-pill--warning">${this.escapeHtml(issue)}</span>`,
                  )
                  .join("")
              : '<span class="listing-clone-pill listing-clone-pill--success">Campos principais preenchidos</span>'
          }
        </div>
      </div>
    `;
  }

  renderImageCards(images) {
    const list = (Array.isArray(images) ? images : []).slice(0, this.maxImages);
    const slots = Array.from(
      { length: this.maxImages },
      (_entry, index) => list[index] || null,
    );

    return slots
      .map((image, index) => {
        const hasImage = Boolean(image?.url || image?.imageId);
        return `
          <article
            class="listing-clone-image-card ${hasImage ? "" : "listing-clone-image-card--empty"}"
            data-clone-image-row
            data-image-index="${index}"
            ${hasImage ? 'draggable="true"' : ""}
          >
            ${
              image?.url
                ? `<img class="listing-clone-image-card__thumb" src="${this.escapeHtml(image.url)}" alt="">`
                : '<div class="listing-clone-image-card__thumb listing-clone-image-card__thumb--empty">Adicionar foto</div>'
            }
            <div class="listing-clone-image-card__meta">
              <strong>Imagem ${index + 1}</strong>
              <span class="muted">${
                hasImage
                  ? `${this.escapeHtml(image?.imageId || "Sem image_id")} - arraste para reordenar`
                  : "Slot vazio (maximo 9 imagens)"
              }</span>
            </div>
            <input type="hidden" data-clone-image-url value="${this.escapeHtml(image?.url || "")}">
            <input type="hidden" data-clone-image-id value="${this.escapeHtml(image?.imageId || "")}">
            <input type="hidden" data-clone-image-key value="${this.escapeHtml(image?.key || `image-${index}`)}">
            <div class="listing-clone-image-card__actions">
              <input class="input" type="file" accept="image/jpeg,image/png" data-image-slot-file>
              <button class="btn btn-ghost" type="button" data-image-slot-upload="1">${hasImage ? "Substituir" : "Adicionar"}</button>
              ${hasImage ? '<button class="btn btn-ghost" type="button" data-image-remove="1">Remover</button>' : ""}
            </div>
          </article>
        `;
      })
      .join("");
  }

  renderSourceSpecs(draft) {
    const specs = Array.isArray(draft?.sourceSpecifications) ? draft.sourceSpecifications : [];
    if (!specs.length) {
      return '<div class="muted ui-state ui-state--empty">A origem nao trouxe caracteristicas estruturadas.</div>';
    }

    return `
      <div class="listing-clone-spec-grid">
        ${specs
          .map(
            (entry) => `
              <div class="listing-clone-spec">
                <strong>${this.escapeHtml(entry?.name || "")}</strong>
                <span>${this.escapeHtml(entry?.value || "")}</span>
              </div>
            `,
          )
          .join("")}
      </div>
    `;
  }

  renderAttributes(draft) {
    const attributes = Array.isArray(draft?.attributes) ? draft.attributes : [];
    if (!attributes.length) {
      return '<div class="muted ui-state ui-state--empty">Carregue a categoria Shopee para preparar os atributos editaveis.</div>';
    }

    return attributes
      .map(
        (attribute, index) => `
          <div class="listing-clone-attribute" data-clone-attribute-row>
            <div class="listing-clone-attribute__head">
              <strong>${this.escapeHtml(attribute?.name || `Atributo ${index + 1}`)}</strong>
              ${attribute?.isMandatory ? '<span class="listing-clone-pill listing-clone-pill--warning">Obrigatorio</span>' : ""}
            </div>
            ${attribute?.complianceRequirement === "anvisa" ? '<div class="listing-clone-attribute__notice">Exigencia Shopee para novos anuncios a partir de 21/09/2026.</div>' : attribute?.complianceRequirement === "inmetro" ? '<div class="listing-clone-attribute__notice">Certificacao ou registro INMETRO obrigatorio para esta categoria.</div>' : this.normalizeText(attribute?.name).toLowerCase() === "assembly" ? '<div class="listing-clone-attribute__notice">Informe se o produto requer montagem.</div>' : ""}
            <input
              class="input"
              type="text"
              data-attribute-values
              value="${this.escapeHtml((attribute?.values || []).join(", "))}"
              placeholder="Valor 1, Valor 2"
            />
            <input type="hidden" data-attribute-id value="${this.escapeHtml(attribute?.attributeId || "")}">
            <input type="hidden" data-attribute-name value="${this.escapeHtml(attribute?.name || "")}">
            <input type="hidden" data-attribute-required value="${attribute?.isMandatory ? "1" : "0"}">
            <input type="hidden" data-attribute-compliance value="${this.escapeHtml(attribute?.complianceRequirement || "")}">
            <input type="hidden" data-attribute-required-from value="${this.escapeHtml(attribute?.requiredFrom || "")}">
          </div>
        `,
      )
      .join("");
  }

  renderLogistics(draft) {
    const logistics = Array.isArray(draft?.logisticInfo) ? draft.logisticInfo : [];
    if (!logistics.length) {
      return '<div class="muted ui-state ui-state--empty">Nenhum canal logistico padrao encontrado na loja ativa.</div>';
    }

    return `
      <div class="listing-clone-logistics">
        ${logistics
          .map(
            (entry, index) => `
              <div class="listing-clone-logistics__row" data-clone-logistic-row data-logistic-index="${index}">
                <label class="listing-clone-logistics__toggle">
                  <input type="checkbox" data-logistic-enabled ${entry?.enabled ? "checked" : ""}>
                  <span>Habilitado</span>
                </label>
                <label class="field">
                  <span class="muted">Canal</span>
                  <input class="input" type="text" data-logistic-name value="${this.escapeHtml(entry?.name || "")}" />
                </label>
                <label class="field">
                  <span class="muted">logistic_id</span>
                  <input class="input" type="text" data-logistic-id value="${this.escapeHtml(entry?.logisticId || "")}" />
                </label>
                <label class="field">
                  <span class="muted">size_id</span>
                  <input class="input" type="number" data-logistic-size value="${this.escapeHtml(entry?.sizeId ?? "")}" />
                </label>
                <label class="listing-clone-logistics__toggle">
                  <input type="checkbox" data-logistic-free ${entry?.isFree ? "checked" : ""}>
                  <span>Frete gratis</span>
                </label>
              </div>
            `,
          )
          .join("")}
        <div class="muted">
          O frete e calculado automaticamente pela Shopee no lancamento. Se nao houver estimativa agora, o calculo final acontece ao subir o anuncio.
        </div>
      </div>
    `;
  }

  renderLogisticsValidation() {
    if (!this.logisticsValidation) {
      return `
        <div class="listing-clone-logistics-summary">
          <div class="muted">Valide a logistica para conferir elegibilidade SPX com as dimensoes atuais.</div>
        </div>
      `;
    }

    const validation = this.logisticsValidation;
    const reasons = Array.isArray(validation?.spxEligibilityReasons)
      ? validation.spxEligibilityReasons
      : [];

    return `
      <div class="listing-clone-logistics-summary">
        <div class="listing-clone-pill-row">
          <span class="listing-clone-pill ${validation?.spxPhysicalEligible ? "listing-clone-pill--success" : "listing-clone-pill--warning"}">
            SPX fisico: ${validation?.spxPhysicalEligible ? "Elegivel" : "Nao elegivel"}
          </span>
          <span class="listing-clone-pill">
            Modo: ${this.escapeHtml(validation?.shippingMode || "Nao definido")}
          </span>
          <span class="listing-clone-pill">
            SPX ativo: ${validation?.spxEnabled ? "Sim" : "Nao"}
          </span>
        </div>
        ${
          reasons.length
            ? `<div class="listing-clone-notes">${reasons
                .map((reason) => `<div class="listing-clone-note">${this.escapeHtml(reason)}</div>`)
                .join("")}</div>`
            : '<div class="muted">As dimensoes atuais estao compativeis com as regras fisicas do SPX.</div>'
        }
      </div>
    `;
  }

  renderVariationEditor(draft) {
    const variations = draft?.variations || {};
    const tiers = Array.isArray(variations?.tiers) ? variations.tiers : [];
    const models = Array.isArray(variations?.models) ? variations.models : [];

    return `
      <div class="listing-clone-variation-shell">
        <label class="listing-clone-logistics__toggle">
          <input id="listingCloneVariationsEnabled" type="checkbox" ${variations?.enabled ? "checked" : ""}>
          <span>Publicar com variacoes</span>
        </label>
        <div class="muted">
          Quando habilitado, o sistema cria o item base e em seguida monta as variacoes com os modelos detectados/editados.
        </div>

        ${
          tiers.length
            ? `
              <div class="listing-clone-variation-grid">
                ${tiers
                  .map(
                    (tier, tierIndex) => `
                      <div class="listing-clone-variation-card" data-clone-tier-row data-tier-index="${tierIndex}">
                        <label class="field">
                          <span class="muted">Nome da variacao</span>
                          <input class="input" type="text" data-tier-name value="${this.escapeHtml(tier?.name || "")}" />
                        </label>
                        <div class="listing-clone-variation-card__options">
                          ${(Array.isArray(tier?.options) ? tier.options : [])
                            .map(
                              (option, optionIndex) => `
                                <div class="listing-clone-variation-option" data-clone-tier-option-row data-option-index="${optionIndex}">
                                  ${
                                    option?.imageUrl
                                      ? `<img src="${this.escapeHtml(option.imageUrl)}" alt="">`
                                      : '<div class="listing-clone-variation-option__empty">sem imagem</div>'
                                  }
                                  <div class="listing-clone-variation-option__editor">
                                    <input class="input" type="text" data-tier-option-name value="${this.escapeHtml(option?.optionName || "")}" />
                                    <div class="listing-clone-variation-option__actions">
                                      <input class="input" type="file" accept="image/jpeg,image/png" data-tier-option-file>
                                      <button class="btn btn-ghost" type="button" data-tier-option-upload>Adicionar imagem principal</button>
                                    </div>
                                  </div>
                                  <input type="hidden" data-tier-option-image-url value="${this.escapeHtml(option?.imageUrl || "")}">
                                  <input type="hidden" data-tier-option-image-id value="${this.escapeHtml(option?.imageId || "")}">
                                </div>
                              `,
                            )
                            .join("")}
                        </div>
                      </div>
                    `,
                  )
                  .join("")}
              </div>
            `
            : '<div class="muted ui-state ui-state--empty">Nenhuma variacao estruturada veio da origem.</div>'
        }

        ${
          models.length
            ? `
              <div class="table-wrap">
                <table class="table listing-clone-model-table">
                  <thead>
                    <tr>
                      <th>Modelo</th>
                      <th>SKU</th>
                      <th>Preco</th>
                      <th>Estoque</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${models
                      .map(
                        (model, index) => `
                          <tr data-clone-model-row data-model-index="${index}">
                            <td>
                              <div class="listing-clone-model-name">${this.escapeHtml(model?.displayName || `Modelo ${index + 1}`)}</div>
                              <input type="hidden" data-model-key value="${this.escapeHtml(model?.key || `${index}`)}">
                              <input type="hidden" data-model-display-name value="${this.escapeHtml(model?.displayName || "")}">
                              <input type="hidden" data-model-tier-index value="${this.escapeHtml((model?.tierIndex || []).join(","))}">
                            </td>
                            <td>
                              <input class="input" type="text" data-model-sku value="${this.escapeHtml(model?.modelSku || "")}">
                            </td>
                            <td>
                              <input class="input" type="number" step="0.01" data-model-price value="${this.escapeHtml(model?.originalPrice ?? "")}" placeholder="${this.escapeHtml(draft?.originalPrice ?? "")}">
                            </td>
                            <td>
                              <input class="input" type="number" step="1" data-model-stock value="${this.escapeHtml(model?.stock ?? 0)}">
                            </td>
                          </tr>
                        `,
                      )
                      .join("")}
                  </tbody>
                </table>
              </div>
            `
            : ""
        }
      </div>
    `;
  }

  renderDraftsView() {
    const root = this.getRoot();
    if (!root) return;

    const drafts = Array.isArray(this.drafts) ? this.drafts : [];

    root.innerHTML = `
      <div class="section-card listing-clone-shell">
        <div class="section-card__header">
          <div>
            <div class="section-title">Clonar anuncio</div>
            <div class="muted">
              Retome clones salvos como rascunho e siga com o lancamento quando a ficha estiver pronta.
            </div>
          </div>
        </div>
        <div class="section-card__body">
          ${this.renderSubtabs()}
          <div id="listingCloneDraftStatus" class="${
            this.draftStatusState?.type
              ? `muted ui-state ui-state--${this.escapeHtml(this.draftStatusState.type)}`
              : "muted"
          }">${this.escapeHtml(this.draftStatusState?.text || "")}</div>
          <div class="listing-clone-drafts-grid">
            ${
              drafts.length
                ? drafts
                    .map(
                      (draft) => `
                        <article class="listing-clone-draft-card" data-draft-id="${this.escapeHtml(draft?.id || "")}">
                          <div class="listing-clone-draft-card__head">
                            <div>
                              <strong>${this.escapeHtml(draft?.title || "Rascunho sem titulo")}</strong>
                              <div class="muted">
                                ${this.escapeHtml(draft?.sourcePlatform || "origem")} • Atualizado em ${this.escapeHtml(this.formatDateTime(draft?.updatedAt))}
                              </div>
                            </div>
                            <span class="listing-clone-pill">${this.escapeHtml(draft?.summary?.imageCount ?? 0)} img</span>
                          </div>
                          <div class="listing-clone-pill-row">
                            <span class="listing-clone-pill">${draft?.summary?.hasBrand ? "Marca ok" : "Marca pendente"}</span>
                            <span class="listing-clone-pill">
                              Atributos: ${this.escapeHtml(draft?.summary?.filledMandatoryAttributeCount ?? 0)}/${this.escapeHtml(draft?.summary?.mandatoryAttributeCount ?? 0)}
                            </span>
                            ${
                              draft?.summary?.categoryId
                                ? `<span class="listing-clone-pill">Categoria ${this.escapeHtml(draft.summary.categoryId)}</span>`
                                : ""
                            }
                          </div>
                          <div class="listing-clone-draft-card__actions">
                            <button class="btn btn-primary" type="button" data-draft-open="${this.escapeHtml(draft?.id || "")}">
                              Seguir com lancamento
                            </button>
                            <button class="btn btn-ghost" type="button" data-draft-delete="${this.escapeHtml(draft?.id || "")}">
                              Excluir rascunho
                            </button>
                          </div>
                        </article>
                      `,
                    )
                    .join("")
                : '<div class="muted ui-state ui-state--empty">Nenhum rascunho salvo ainda.</div>'
            }
          </div>
        </div>
      </div>
    `;

    this.bindSubtabs();
    this.getRoot()
      ?.querySelectorAll("[data-draft-open]")
      .forEach((button) => {
        button.addEventListener("click", () => this.openDraft(button.getAttribute("data-draft-open")));
      });
    this.getRoot()
      ?.querySelectorAll("[data-draft-delete]")
      .forEach((button) => {
        button.addEventListener("click", () => this.deleteDraft(button.getAttribute("data-draft-delete")));
      });
  }

  renderCurrentEditorView() {
    if (this.draft) {
      this.renderEditor();
      return;
    }

    this.renderHome();
  }

  renderEditorNavigation() {
    const sections = [
      ["details", "Dados"],
      ["media", "Midia"],
      ["attributes", "Atributos"],
      ["variations", "Variacoes"],
      ["operations", "Logistica e fiscal"],
    ];
    return `
      <nav class="listing-clone-editor-nav" aria-label="Secoes do editor">
        ${sections.map(([key, label]) => `<button type="button" data-editor-section="${key}" class="${this.activeEditorSection === key ? "is-active" : ""}">${label}</button>`).join("")}
      </nav>
    `;
  }

  applyEditorSectionVisibility() {
    const groups = ["media", "media", "attributes", "attributes", "variations", "operations", "operations"];
    const detailsPanel = this.getRoot()?.querySelector(".listing-clone-details-panel");
    if (detailsPanel) detailsPanel.hidden = this.activeEditorSection !== "details";
    const sections = Array.from(this.getRoot()?.querySelectorAll(".listing-clone-section") || []);
    sections.forEach((section, index) => {
      section.hidden = this.activeEditorSection === "details" || groups[index] !== this.activeEditorSection;
    });
  }

   renderEditor({ preserveDomDraft = true } = {}) {
    const root = this.getRoot();
    if (!root || !this.draft) return;

    const draft = preserveDomDraft
      ? this.captureDraftFromDom({ preserveCurrent: true }) || this.deepClone(this.draft)
      : this.deepClone(this.draft);
    this.draft = draft;
    const selectedCategory = this.resolveCategoryEntryById(draft?.categoryId);
    const categoryPickerValue = selectedCategory
      ? this.buildCategoryDisplayValue(selectedCategory)
      : "";
    const clipPreviewUrl = this.normalizeText(
      draft?.clip?.previewUrl || draft?.clip?.sourceUrl || "",
    );

    root.innerHTML = `
      <div class="listing-clone-editor">
        <div class="section-card listing-clone-shell">
          <div class="section-card__header">
            <div>
              <div class="section-title">Clonar anuncio</div>
              <div class="muted">
                Origem: ${this.escapeHtml(draft?.sourcePlatform || "desconhecida")} • ID origem: ${this.escapeHtml(draft?.sourceItemId || "—")}
              </div>
            </div>
            <div class="section-actions">
              <button id="btnListingCloneCancel" class="btn btn-ghost" type="button">Cancelar clonagem</button>
              <button id="btnListingCloneSaveDraft" class="btn btn-ghost" type="button">Salvar como rascunho</button>
              <button id="btnListingClonePublish" class="btn btn-primary" type="button">Confirmar lancamento</button>
            </div>
          </div>
          <div class="section-card__body">
            ${this.renderSubtabs()}
            ${this.renderExtractionSummary(draft)}
            ${this.renderEditorNavigation()}
            ${this.renderChecklist(draft)}
            ${this.renderNotes(draft)}

            <div class="listing-clone-details-panel">
            <div class="listing-clone-summary">
              <div class="listing-clone-summary__media">
                ${
                  draft?.images?.[0]?.url
                    ? `<img src="${this.escapeHtml(draft.images[0].url)}" alt="">`
                    : '<div class="listing-clone-summary__media listing-clone-summary__media--empty"></div>'
                }
              </div>
              <div class="listing-clone-summary__meta">
                <div class="listing-clone-pill-row">
                  <span class="listing-clone-pill">${this.escapeHtml(draft?.sourcePlatform || "origem")}</span>
                  ${
                    draft?.sourceCategoryName
                      ? `<span class="listing-clone-pill">${this.escapeHtml(draft.sourceCategoryName)}</span>`
                      : ""
                  }
                </div>
                <label class="field">
                  <span class="muted">Link da origem</span>
                  <input id="listingCloneSourceUrlReadonly" class="input" type="text" value="${this.escapeHtml(draft?.sourceUrl || "")}" readonly>
                </label>
              </div>
            </div>

            <div id="listingCloneStatus" class="${
              this.statusState?.type
                ? `muted ui-state ui-state--${this.escapeHtml(this.statusState.type)}`
                : "muted"
            }">${this.escapeHtml(this.statusState?.text || "")}</div>

            <div class="listing-clone-form-grid">
              <label class="field listing-clone-form-grid__full">
                <span class="muted">Titulo</span>
                <input id="listingCloneItemName" class="input" type="text" value="${this.escapeHtml(draft?.itemName || "")}">
              </label>
              <label class="field listing-clone-form-grid__full">
                <span class="muted">Categoria Shopee (arvore completa)</span>
                <input
                  id="listingCloneCategoryPicker"
                  class="input"
                  type="text"
                  list="listingCloneCategoryTreeList"
                  value="${this.escapeHtml(categoryPickerValue)}"
                  placeholder="Digite para buscar e selecione uma categoria da Shopee"
                >
              </label>
              <label class="field listing-clone-form-grid__full">
                <span class="muted">Buscar na arvore de categorias</span>
                <input
                  id="listingCloneCategoryTreeSearch"
                  class="input"
                  type="text"
                  value="${this.escapeHtml(this.categoryTreeQuery || "")}"
                  placeholder="Ex.: Cadeira, Mesa, Sofa..."
                >
              </label>
              <div class="listing-clone-form-grid__full listing-clone-category-tree">
                ${this.renderCategoryTreeSelect(draft?.categoryId)}
              </div>
              ${this.renderCategorySuggestions(draft)}
              ${this.renderCategoryDatalist()}
              <label class="field">
                <span class="muted">Categoria Shopee (ID)</span>
                <input id="listingCloneCategoryId" class="input" type="text" value="${this.escapeHtml(draft?.categoryId || "")}" placeholder="Ex.: 100123">
              </label>
              <label class="field">
                <span class="muted">Categoria origem</span>
                <input id="listingCloneCategoryName" class="input" type="text" value="${this.escapeHtml(draft?.categoryName || draft?.sourceCategoryName || "")}">
              </label>
              <label class="field">
                <span class="muted">Preco</span>
                <input id="listingCloneOriginalPrice" class="input" type="number" step="0.01" value="${this.escapeHtml(draft?.originalPrice ?? "")}">
              </label>
              <label class="field">
                <span class="muted">Estoque base</span>
                <input id="listingCloneStock" class="input" type="number" step="1" value="${this.escapeHtml(draft?.stock ?? 0)}">
              </label>
              <label class="field">
                <span class="muted">Peso (kg)</span>
                <input id="listingCloneWeight" class="input" type="number" step="0.001" value="${this.escapeHtml(draft?.weight ?? "")}">
              </label>
              <label class="field">
                <span class="muted">SKU</span>
                <input id="listingCloneItemSku" class="input" type="text" value="${this.escapeHtml(draft?.itemSku || "")}">
              </label>
              <label class="field">
                <span class="muted">Marca</span>
                <input id="listingCloneBrandName" class="input" type="text" value="${this.escapeHtml(draft?.brandName || "Sem marca")}">
              </label>
              <label class="field">
                <span class="muted">Condicao</span>
                <select id="listingCloneCondition" class="select">
                  <option value="NEW" ${draft?.condition === "NEW" ? "selected" : ""}>NEW</option>
                  <option value="USED" ${draft?.condition === "USED" ? "selected" : ""}>USED</option>
                </select>
              </label>
              <label class="field">
                <span class="muted">Status</span>
                <select id="listingCloneItemStatus" class="select">
                  <option value="NORMAL" ${draft?.itemStatus === "NORMAL" ? "selected" : ""}>NORMAL</option>
                  <option value="UNLIST" ${draft?.itemStatus === "UNLIST" ? "selected" : ""}>UNLIST</option>
                </select>
              </label>
              <label class="field">
                <span class="muted">Dias para envio</span>
                <input id="listingCloneDaysToShip" class="input" type="number" step="1" value="${this.escapeHtml(draft?.preOrder?.daysToShip ?? "")}">
              </label>
            </div>

            <div class="listing-clone-dimensions">
              <label class="field">
                <span class="muted">Largura (cm)</span>
                <input id="listingClonePackageWidth" class="input" type="number" step="1" value="${this.escapeHtml(draft?.dimension?.package_width ?? "")}">
              </label>
              <label class="field">
                <span class="muted">Comprimento (cm)</span>
                <input id="listingClonePackageLength" class="input" type="number" step="1" value="${this.escapeHtml(draft?.dimension?.package_length ?? "")}">
              </label>
              <label class="field">
                <span class="muted">Altura (cm)</span>
                <input id="listingClonePackageHeight" class="input" type="number" step="1" value="${this.escapeHtml(draft?.dimension?.package_height ?? "")}">
              </label>
            </div>

            <label class="field">
              <span class="muted">Descricao</span>
              <textarea id="listingCloneDescription" class="input" rows="10">${this.escapeHtml(draft?.description || "")}</textarea>
            </label>
            </div>

            <div class="listing-clone-section">
              <div class="section-title">Imagens</div>
              <div class="muted">Use os 9 blocos para adicionar/substituir imagens e arraste para reordenar.</div>
              <div id="listingCloneImages" class="listing-clone-image-grid">
                ${this.renderImageCards(draft?.images)}
              </div>
            </div>

            <div class="listing-clone-section">
              <div class="section-title">Clip</div>
              <div class="listing-clone-clip">
                <div class="listing-clone-clip__meta">
                  <strong>Origem do clip</strong>
                  ${
                    draft?.clip?.sourceUrl
                      ? `<a href="${this.escapeHtml(draft.clip.sourceUrl)}" target="_blank" rel="noopener noreferrer">Abrir video detectado</a>`
                      : '<span class="muted">A origem nao trouxe video publico.</span>'
                  }
                </div>
                ${
                  clipPreviewUrl
                    ? `<video class="listing-clone-clip__preview" controls preload="metadata" src="${this.escapeHtml(clipPreviewUrl)}"></video>`
                    : '<div class="muted">Nenhum clip pronto para preview.</div>'
                }
                <div class="listing-clone-upload-row">
                  <label class="field listing-clone-upload-row__field">
                    <span class="muted">Enviar clip MP4 (10s-60s, max 30MB)</span>
                    <input id="listingCloneUploadVideo" class="input" type="file" accept="video/mp4,.mp4">
                  </label>
                  <button id="btnListingCloneUploadVideo" class="btn btn-ghost" type="button">Enviar clip</button>
                </div>
                <label class="field">
                  <span class="muted">video_upload_id (gerado automaticamente)</span>
                  <input id="listingCloneVideoUploadId" class="input" type="text" readonly value="${this.escapeHtml(draft?.clip?.videoUploadId || "")}">
                </label>
                <div class="muted">
                  Requisitos Shopee: MP4, duracao entre 10s e 60s, resolucao minima 1x1 px e tamanho maximo de 30MB.
                </div>
              </div>
            </div>

            <div class="listing-clone-section">
              <div class="section-title">Caracteristicas clonadas</div>
              <div class="muted">Leitura direta do anuncio de origem para consulta rapida durante a edicao.</div>
              ${this.renderSourceSpecs(draft)}
            </div>

            <div class="listing-clone-section">
              <div class="listing-clone-section__head">
                <div>
                  <div class="section-title">Atributos Shopee</div>
                  <div class="muted">Carregue a categoria para mapear as caracteristicas clonadas para os atributos de publicacao.</div>
                </div>
                <div class="listing-clone-pill-row">
                  <button id="btnListingCloneReloadCategories" class="btn btn-ghost" type="button">Atualizar arvore de categorias</button>
                  <button id="btnListingCloneLoadAttributes" class="btn btn-ghost" type="button">Carregar atributos da categoria</button>
                </div>
              </div>
              <div id="listingCloneAttributes" class="listing-clone-attribute-grid">
                ${this.renderAttributes(draft)}
              </div>
            </div>

            <div class="listing-clone-section">
              <div class="section-title">Variacoes</div>
              ${this.renderVariationEditor(draft)}
            </div>

            <div class="listing-clone-section">
              <div class="section-title">Logistica</div>
              <div class="muted">Os canais abaixo usam como ponto de partida a loja ativa. Revise antes de publicar.</div>
              ${this.renderLogisticsValidation()}
              <div class="listing-clone-logistics-actions">
                <button id="btnListingCloneValidateLogistics" class="btn btn-ghost" type="button">Validar logistica SPX</button>
              </div>
              ${this.renderLogistics(draft)}
            </div>

            <div class="listing-clone-section">
              <div class="section-title">Fiscal (opcional)</div>
              <div class="listing-clone-tax-grid">
                <label class="field"><span class="muted">NCM</span><input id="listingCloneTaxNcm" class="input" type="text" value="${this.escapeHtml(draft?.taxInfo?.ncm || "")}"></label>
                <label class="field"><span class="muted">CFOP mesmo estado</span><input id="listingCloneTaxCfopSame" class="input" type="text" value="${this.escapeHtml(draft?.taxInfo?.same_state_cfop || "")}"></label>
                <label class="field"><span class="muted">CFOP outro estado</span><input id="listingCloneTaxCfopDiff" class="input" type="text" value="${this.escapeHtml(draft?.taxInfo?.diff_state_cfop || "")}"></label>
                <label class="field"><span class="muted">CSOSN</span><input id="listingCloneTaxCsosn" class="input" type="text" value="${this.escapeHtml(draft?.taxInfo?.csosn || "")}"></label>
                <label class="field"><span class="muted">Origem</span><input id="listingCloneTaxOrigin" class="input" type="text" value="${this.escapeHtml(draft?.taxInfo?.origin || "")}"></label>
                <label class="field"><span class="muted">CEST</span><input id="listingCloneTaxCest" class="input" type="text" value="${this.escapeHtml(draft?.taxInfo?.cest || "")}"></label>
                <label class="field"><span class="muted">Unidade de medida</span><input id="listingCloneTaxMeasureUnit" class="input" type="text" value="${this.escapeHtml(draft?.taxInfo?.measure_unit || "")}"></label>
                <label class="field"><span class="muted">Opcao de nota</span><input id="listingCloneTaxInvoiceOption" class="input" type="text" value="${this.escapeHtml(draft?.taxInfo?.invoice_option || "")}"></label>
                <label class="field"><span class="muted">Aliquota VAT</span><input id="listingCloneTaxVatRate" class="input" type="text" value="${this.escapeHtml(draft?.taxInfo?.vat_rate || "")}"></label>
              </div>
            </div>

            <div id="listingClonePublishStatus" class="${
              this.publishStatusState?.type
                ? `muted ui-state ui-state--${this.escapeHtml(this.publishStatusState.type)}`
                : "muted"
            }">${
              this.escapeHtml(
                this.publishStatusState?.text ||
                  (this.lastPublishResult?.itemId
                    ? `Ultimo anuncio criado: ID ${this.lastPublishResult.itemId}`
                    : ""),
              )
            }</div>
          </div>
        </div>
      </div>
    `;

    this.applyEditorSectionVisibility();
    this.bindEditorActions();
    this.ensureCategoriesLoaded({ silent: true });
  }

  bindEditorActions() {
    this.getRoot()
      ?.querySelectorAll("[data-editor-section]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          const nextSection = button.getAttribute("data-editor-section") || "details";
          if (nextSection === this.activeEditorSection) return;
          this.captureDraftFromDom();
          this.activeEditorSection = nextSection;
          this.renderEditor({ preserveDomDraft: false });
        });
      });

    document
      .getElementById("btnListingCloneCancel")
      ?.addEventListener("click", () => this.handleCancelClone());

    document
      .getElementById("btnListingClonePublish")
      ?.addEventListener("click", () => this.handlePublish());

    document
      .getElementById("btnListingCloneSaveDraft")
      ?.addEventListener("click", () => this.handleSaveDraft());

    document
      .getElementById("btnListingCloneLoadAttributes")
      ?.addEventListener("click", () => this.handleLoadAttributes());

    document
      .getElementById("btnListingCloneReloadCategories")
      ?.addEventListener("click", () => this.ensureCategoriesLoaded({ force: true, silent: false }));

    document
      .getElementById("btnListingCloneUploadVideo")
      ?.addEventListener("click", () => this.handleUploadVideo());

    document
      .getElementById("btnListingCloneValidateLogistics")
      ?.addEventListener("click", () => this.handleValidateLogistics());

    document
      .getElementById("listingCloneCategoryPicker")
      ?.addEventListener("change", () => this.handleCategoryPickerSelection());

    document
      .getElementById("listingCloneCategoryPicker")
      ?.addEventListener("blur", () => this.handleCategoryPickerSelection());

    document
      .getElementById("listingCloneCategoryTreeSelect")
      ?.addEventListener("change", () => this.handleCategoryTreeSelection());

    document
      .getElementById("listingCloneCategoryTreeSearch")
      ?.addEventListener("input", () => this.handleCategoryTreeSearchInput());

    this.getRoot()
      ?.querySelectorAll("[data-clone-category-suggestion]")
      .forEach((button) => {
        button.addEventListener("click", () =>
          this.applyRecommendedCategory(button.getAttribute("data-clone-category-suggestion")),
        );
      });

    this.bindSubtabs();

    this.getRoot()
      ?.querySelectorAll("[data-image-remove]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          const row = button.closest("[data-clone-image-row]");
          if (!row) return;
          this.removeImage(Number(row.getAttribute("data-image-index")));
        });
      });

    this.getRoot()
      ?.querySelectorAll("[data-image-slot-upload]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          const row = button.closest("[data-clone-image-row]");
          if (!row) return;
          this.handleUploadImageSlot(Number(row.getAttribute("data-image-index")));
        });
      });

    this.getRoot()
      ?.querySelectorAll("[data-clone-image-row]")
      .forEach((row) => {
        row.addEventListener("dragstart", (event) => this.handleImageDragStart(event, row));
        row.addEventListener("dragenter", (event) => this.handleImageDragOver(event, row));
        row.addEventListener("dragover", (event) => this.handleImageDragOver(event, row));
        row.addEventListener("dragleave", () => row.classList.remove("is-drop-target"));
        row.addEventListener("drop", (event) => this.handleImageDrop(event, row));
        row.addEventListener("dragend", () => this.handleImageDragEnd(row));
      });

    this.getRoot()
      ?.querySelectorAll("[data-tier-option-upload]")
      .forEach((button) => {
        button.addEventListener("click", () => this.handleUploadVariationOptionImage(button));
      });
  }

  captureImagesFromDom(baseDraft) {
    const rows = Array.from(this.getRoot()?.querySelectorAll("[data-clone-image-row]") || []);
    if (!rows.length) return Array.isArray(baseDraft?.images) ? baseDraft.images : [];

    return rows
      .map((row, index) => ({
        key:
          row.querySelector("[data-clone-image-key]")?.value ||
          baseDraft?.images?.[index]?.key ||
          `image-${index}`,
        url: row.querySelector("[data-clone-image-url]")?.value || "",
        imageId: row.querySelector("[data-clone-image-id]")?.value || "",
      }))
      .filter((image) => image.url || image.imageId);
  }

  captureAttributesFromDom(baseDraft) {
    const rows = Array.from(this.getRoot()?.querySelectorAll("[data-clone-attribute-row]") || []);
    if (!rows.length) return Array.isArray(baseDraft?.attributes) ? baseDraft.attributes : [];

    return rows.map((row, index) => {
      const previous = baseDraft?.attributes?.[index] || {};
      return {
        attributeId: row.querySelector("[data-attribute-id]")?.value || "",
        name: row.querySelector("[data-attribute-name]")?.value || previous.name || "",
        isMandatory: row.querySelector("[data-attribute-required]")?.value === "1",
        complianceRequirement:
          row.querySelector("[data-attribute-compliance]")?.value ||
          previous.complianceRequirement ||
          null,
        requiredFrom:
          row.querySelector("[data-attribute-required-from]")?.value || previous.requiredFrom || null,
        values: String(row.querySelector("[data-attribute-values]")?.value || "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        sourceAttribute: previous.sourceAttribute || null,
      };
    });
  }

  captureLogisticsFromDom(baseDraft) {
    const rows = Array.from(this.getRoot()?.querySelectorAll("[data-clone-logistic-row]") || []);
    if (!rows.length) return Array.isArray(baseDraft?.logisticInfo) ? baseDraft.logisticInfo : [];

    return rows.map((row) => ({
      name: row.querySelector("[data-logistic-name]")?.value || "",
      logisticId: row.querySelector("[data-logistic-id]")?.value || "",
      enabled: Boolean(row.querySelector("[data-logistic-enabled]")?.checked),
      sizeId: row.querySelector("[data-logistic-size]")?.value || "",
      shippingFee: "",
      isFree: Boolean(row.querySelector("[data-logistic-free]")?.checked),
    }));
  }

  captureVariationsFromDom(baseDraft) {
    const enabled = Boolean(
      document.getElementById("listingCloneVariationsEnabled")?.checked,
    );

    const tiers = Array.from(this.getRoot()?.querySelectorAll("[data-clone-tier-row]") || []).map(
      (row, tierIndex) => {
        const previous = baseDraft?.variations?.tiers?.[tierIndex] || {};
        const options = Array.from(row.querySelectorAll("[data-clone-tier-option-row]")).map(
          (optionRow, optionIndex) => ({
            optionName: optionRow.querySelector("[data-tier-option-name]")?.value || "",
            imageUrl:
              optionRow.querySelector("[data-tier-option-image-url]")?.value ||
              previous?.options?.[optionIndex]?.imageUrl ||
              "",
            imageId:
              optionRow.querySelector("[data-tier-option-image-id]")?.value ||
              previous?.options?.[optionIndex]?.imageId ||
              "",
          }),
        );

        return {
          name: row.querySelector("[data-tier-name]")?.value || previous.name || "",
          options,
        };
      },
    );

    const models = Array.from(this.getRoot()?.querySelectorAll("[data-clone-model-row]") || []).map(
      (row, modelIndex) => {
        const previous = baseDraft?.variations?.models?.[modelIndex] || {};
        return {
          key: row.querySelector("[data-model-key]")?.value || previous.key || `${modelIndex}`,
          displayName:
            row.querySelector("[data-model-display-name]")?.value ||
            previous.displayName ||
            "",
          tierIndex: String(row.querySelector("[data-model-tier-index]")?.value || "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value)),
          modelSku: row.querySelector("[data-model-sku]")?.value || "",
          originalPrice: row.querySelector("[data-model-price]")?.value || "",
          stock: row.querySelector("[data-model-stock]")?.value || "0",
          weight: previous.weight ?? null,
          dimension: previous.dimension || {
            package_width: null,
            package_length: null,
            package_height: null,
          },
          gtinCode: previous.gtinCode || "",
        };
      },
    );

    return {
      enabled,
      tiers,
      models,
    };
  }

  captureDraftFromDom({ preserveCurrent = false } = {}) {
    if (!this.draft) return null;

    const root = this.getRoot();
    if (!root) return this.deepClone(this.draft);
    if (!preserveCurrent && !document.getElementById("listingCloneItemName")) {
      return this.deepClone(this.draft);
    }

    const draft = this.deepClone(this.draft);

    if (document.getElementById("listingCloneItemName")) {
      const selectedCategory = this.resolveCategoryEntryFromInput(
        document.getElementById("listingCloneCategoryPicker")?.value || "",
      );
      const fallbackCategoryId = document.getElementById("listingCloneCategoryId")?.value || "";

      draft.itemName = document.getElementById("listingCloneItemName")?.value || "";
      draft.categoryId = selectedCategory?.categoryId || fallbackCategoryId;
      draft.categoryName =
        selectedCategory?.displayName ||
        document.getElementById("listingCloneCategoryName")?.value ||
        "";
      draft.originalPrice = document.getElementById("listingCloneOriginalPrice")?.value || "";
      draft.stock = document.getElementById("listingCloneStock")?.value || "";
      draft.weight = document.getElementById("listingCloneWeight")?.value || "";
      draft.itemSku = document.getElementById("listingCloneItemSku")?.value || "";
      draft.brandName = document.getElementById("listingCloneBrandName")?.value || "";
      draft.condition = document.getElementById("listingCloneCondition")?.value || "NEW";
      draft.itemStatus = document.getElementById("listingCloneItemStatus")?.value || "NORMAL";
      draft.description = document.getElementById("listingCloneDescription")?.value || "";
      draft.dimension = {
        package_width: document.getElementById("listingClonePackageWidth")?.value || "",
        package_length: document.getElementById("listingClonePackageLength")?.value || "",
        package_height: document.getElementById("listingClonePackageHeight")?.value || "",
      };
      draft.preOrder = {
        isPreOrder: false,
        daysToShip: document.getElementById("listingCloneDaysToShip")?.value || "",
      };
      draft.clip = {
        ...(draft.clip || {}),
        videoUploadId: document.getElementById("listingCloneVideoUploadId")?.value || "",
        previewUrl: draft?.clip?.previewUrl || "",
      };
      draft.taxInfo = {
        ncm: document.getElementById("listingCloneTaxNcm")?.value || "",
        same_state_cfop: document.getElementById("listingCloneTaxCfopSame")?.value || "",
        diff_state_cfop: document.getElementById("listingCloneTaxCfopDiff")?.value || "",
        csosn: document.getElementById("listingCloneTaxCsosn")?.value || "",
        origin: document.getElementById("listingCloneTaxOrigin")?.value || "",
        cest: document.getElementById("listingCloneTaxCest")?.value || "",
        measure_unit: document.getElementById("listingCloneTaxMeasureUnit")?.value || "",
        invoice_option: document.getElementById("listingCloneTaxInvoiceOption")?.value || "",
        vat_rate: document.getElementById("listingCloneTaxVatRate")?.value || "",
      };
      draft.images = this.captureImagesFromDom(draft);
      draft.attributes = this.captureAttributesFromDom(draft);
      draft.logisticInfo = this.captureLogisticsFromDom(draft);
      draft.variations = this.captureVariationsFromDom(draft);
    }

    if (!preserveCurrent) {
      this.draft = draft;
    }

    return draft;
  }

  handleCategoryPickerSelection() {
    const picker = document.getElementById("listingCloneCategoryPicker");
    const categoryIdInput = document.getElementById("listingCloneCategoryId");
    const categoryNameInput = document.getElementById("listingCloneCategoryName");
    const treeSelect = document.getElementById("listingCloneCategoryTreeSelect");
    if (!picker || !categoryIdInput) return;

    const selected = this.resolveCategoryEntryFromInput(picker.value);
    if (!selected) return;

    categoryIdInput.value = selected.categoryId || "";
    if (categoryNameInput) categoryNameInput.value = selected.displayName || "";
    if (treeSelect) treeSelect.value = selected.categoryId || "";
    void this.handleLoadAttributes({ silent: true });
  }

  handleCategoryTreeSelection() {
    const treeSelect = document.getElementById("listingCloneCategoryTreeSelect");
    const categoryIdInput = document.getElementById("listingCloneCategoryId");
    const categoryNameInput = document.getElementById("listingCloneCategoryName");
    const picker = document.getElementById("listingCloneCategoryPicker");
    if (!treeSelect || !categoryIdInput) return;

    const selected = this.resolveCategoryEntryById(treeSelect.value);
    if (!selected) return;

    categoryIdInput.value = selected.categoryId || "";
    if (categoryNameInput) categoryNameInput.value = selected.displayName || "";
    if (picker) picker.value = this.buildCategoryDisplayValue(selected);
    void this.handleLoadAttributes({ silent: true });
  }

  handleCategoryTreeSearchInput() {
    const searchInput = document.getElementById("listingCloneCategoryTreeSearch");
    this.categoryTreeQuery = searchInput?.value || "";
    const treeWrapper = this.getRoot()?.querySelector(".listing-clone-category-tree");
    if (!treeWrapper) return;
    treeWrapper.innerHTML = this.renderCategoryTreeSelect(
      document.getElementById("listingCloneCategoryId")?.value || "",
    );
    document
      .getElementById("listingCloneCategoryTreeSelect")
      ?.addEventListener("change", () => this.handleCategoryTreeSelection());
  }

  applyRecommendedCategory(categoryId) {
    const selected =
      this.resolveCategoryEntryById(categoryId) ||
      [
        this.draft?.detectedCategory,
        ...(Array.isArray(this.draft?.recommendedCategories)
          ? this.draft.recommendedCategories
          : []),
      ].find(
        (entry) => this.normalizeText(entry?.categoryId) === this.normalizeText(categoryId),
      );
    if (!selected) {
      this.setStatus("Nao foi possivel aplicar a categoria sugerida.", "warning");
      return;
    }

    const categoryIdInput = document.getElementById("listingCloneCategoryId");
    const categoryNameInput = document.getElementById("listingCloneCategoryName");
    const picker = document.getElementById("listingCloneCategoryPicker");
    const treeSelect = document.getElementById("listingCloneCategoryTreeSelect");

    if (categoryIdInput) categoryIdInput.value = selected.categoryId || "";
    if (categoryNameInput) categoryNameInput.value = selected.displayName || "";
    if (picker) picker.value = this.buildCategoryDisplayValue(selected);
    if (treeSelect) treeSelect.value = selected.categoryId || "";

    this.setStatus(
      `Categoria sugerida aplicada: ${selected.categoryId} - ${selected.displayName}.`,
      "success",
    );
    void this.handleLoadAttributes({ silent: true });
  }

  handleImageDragStart(event, row) {
    if (!row?.getAttribute("draggable")) return;
    this.dragImageIndex = Number(row?.getAttribute("data-image-index"));
    row?.classList.add("is-dragging");
    if (event?.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(this.dragImageIndex));
    }
  }

  handleImageDragOver(event, row) {
    event.preventDefault();
    row?.classList.add("is-drop-target");
    if (event?.dataTransfer) event.dataTransfer.dropEffect = "move";
  }

  handleImageDrop(event, row) {
    event.preventDefault();
    row?.classList.remove("is-drop-target");

    const toIndex = Number(row?.getAttribute("data-image-index"));
    const fromIndex = Number.isFinite(this.dragImageIndex)
      ? this.dragImageIndex
      : Number(event?.dataTransfer?.getData("text/plain"));
    if (!Number.isFinite(fromIndex) || !Number.isFinite(toIndex) || fromIndex === toIndex) {
      return;
    }

    const draft = this.captureDraftFromDom();
    if (!draft?.images?.length) return;

    const images = [...draft.images];
    const [moved] = images.splice(fromIndex, 1);
    images.splice(toIndex, 0, moved);
    draft.images = images;
    this.draft = draft;
    this.renderEditor({ preserveDomDraft: false });
  }

  handleImageDragEnd(row) {
    this.dragImageIndex = null;
    row?.classList.remove("is-dragging");
    this.getRoot()
      ?.querySelectorAll("[data-clone-image-row].is-drop-target")
      .forEach((entry) => entry.classList.remove("is-drop-target"));
  }

  async readVideoMetadata(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const video = document.createElement("video");
      video.preload = "metadata";
      video.onloadedmetadata = () => {
        resolve({
          duration: Number(video.duration || 0),
          width: Number(video.videoWidth || 0),
          height: Number(video.videoHeight || 0),
          previewUrl: url,
        });
      };
      video.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      video.src = url;
    });
  }

  async validateClipFile(file) {
    if (!file) return "Selecione um arquivo MP4 para upload.";
    const mime = String(file.type || "").toLowerCase();
    const fileName = String(file.name || "").toLowerCase();
    if (!(fileName.endsWith(".mp4") || mime === "video/mp4" || mime === "application/mp4")) {
      return "Formato invalido. Use arquivo MP4.";
    }
    if (Number(file.size || 0) > 30 * 1024 * 1024) {
      return "Arquivo acima de 30MB.";
    }

    const metadata = await this.readVideoMetadata(file);
    if (!metadata) return "Nao foi possivel ler os metadados do video.";
    if (metadata.duration < 10 || metadata.duration > 60) {
      URL.revokeObjectURL(metadata.previewUrl);
      return "Duracao invalida. O clip deve ter entre 10s e 60s.";
    }
    if (metadata.width < 1 || metadata.height < 1) {
      URL.revokeObjectURL(metadata.previewUrl);
      return "Resolucao invalida. Minimo aceito: 1x1 px.";
    }

    return metadata;
  }

  async handleUploadVideo() {
    const draft = this.captureDraftFromDom();
    if (!draft) return;

    const input = document.getElementById("listingCloneUploadVideo");
    const file = input?.files?.[0] || null;
    const validation = await this.validateClipFile(file);
    if (typeof validation === "string") {
      this.setStatus(validation, "error");
      return;
    }

    const form = new FormData();
    form.append("video", file);
    form.append("business", "1");
    form.append("scene", "1");
    this.setStatus("Enviando clip para Shopee...", "loading");

    try {
      const response = await this.apiPost(
        "/shops/active/listing-clone/video/upload",
        form,
        { asFormData: true },
      );
      const previousPreview = String(draft?.clip?.previewUrl || "");
      if (
        previousPreview.startsWith("blob:") &&
        previousPreview !== validation.previewUrl
      ) {
        URL.revokeObjectURL(previousPreview);
      }
      draft.clip = {
        ...(draft.clip || {}),
        videoUploadId: response?.clip?.videoUploadId || "",
        sourceUrl: response?.clip?.sourceUrl || draft?.clip?.sourceUrl || "",
        thumbnailUrl: response?.clip?.thumbnailUrl || draft?.clip?.thumbnailUrl || "",
        previewUrl: validation.previewUrl || draft?.clip?.previewUrl || "",
      };
      this.draft = draft;
      this.renderEditor({ preserveDomDraft: false });
      this.setStatus("Clip enviado com sucesso. video_upload_id pronto para publicacao.");
    } catch (error) {
      URL.revokeObjectURL(validation.previewUrl);
      this.setStatus(`Falha ao enviar clip: ${error.message}`, "error");
    }
  }

  async handleUploadVariationOptionImage(button) {
    const optionRow = button?.closest("[data-clone-tier-option-row]");
    const tierRow = button?.closest("[data-clone-tier-row]");
    const file = optionRow?.querySelector("[data-tier-option-file]")?.files?.[0];
    if (!optionRow || !tierRow || !file) {
      this.setStatus("Selecione uma imagem para a opcao de variacao.", "error");
      return;
    }

    const form = new FormData();
    form.append("images", file);
    form.append("business", "1");
    form.append("scene", "1");
    this.setStatus("Enviando imagem da variacao...", "loading");

    try {
      const response = await this.apiPost(
        "/shops/active/listing-clone/images/upload",
        form,
        { asFormData: true },
      );
      const uploaded = Array.isArray(response?.images) ? response.images[0] : null;
      if (!uploaded?.imageId) {
        throw new Error("Shopee nao retornou image_id para a variacao.");
      }

      const draft = this.captureDraftFromDom();
      const tierIndex = Number(tierRow.getAttribute("data-tier-index"));
      const optionIndex = Number(optionRow.getAttribute("data-option-index"));
      if (!draft?.variations?.tiers?.[tierIndex]?.options?.[optionIndex]) {
        throw new Error("Opcao de variacao nao encontrada.");
      }

      draft.variations.tiers[tierIndex].options[optionIndex].imageId = uploaded.imageId;
      draft.variations.tiers[tierIndex].options[optionIndex].imageUrl = uploaded.url || "";
      this.draft = draft;
      this.renderEditor({ preserveDomDraft: false });
      this.setStatus("Imagem principal da variacao atualizada.");
    } catch (error) {
      this.setStatus(`Falha ao enviar imagem da variacao: ${error.message}`, "error");
    }
  }

  moveImage(index, delta) {
    const draft = this.captureDraftFromDom();
    if (!draft?.images?.length) return;

    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= draft.images.length) return;

    const copy = [...draft.images];
    const [item] = copy.splice(index, 1);
    copy.splice(nextIndex, 0, item);
    draft.images = copy;
    this.draft = draft;
    this.renderEditor({ preserveDomDraft: false });
  }

  removeImage(index) {
    const draft = this.captureDraftFromDom();
    if (!draft?.images?.length) return;
    draft.images = draft.images.filter((_entry, currentIndex) => currentIndex !== index);
    this.draft = draft;
    this.renderEditor({ preserveDomDraft: false });
  }

  async loadDrafts() {
    this.activeSubtab = "drafts";
    this.setDraftStatus("Carregando rascunhos...", "loading");

    try {
      const response = await this.apiGet("/shops/active/listing-clone/drafts");
      this.drafts = Array.isArray(response?.drafts) ? response.drafts : [];
      this.renderDraftsView();
      this.setDraftStatus(
        this.drafts.length
          ? `${this.drafts.length} rascunho(s) disponivel(is).`
          : "Nenhum rascunho salvo ainda.",
        this.drafts.length ? "" : "empty",
      );
    } catch (error) {
      this.renderDraftsView();
      this.setDraftStatus(`Falha ao carregar rascunhos: ${error.message}`, "error");
    }
  }

  async openDraft(draftId) {
    if (!draftId) return;
    this.setDraftStatus("Abrindo rascunho...", "loading");

    try {
      const response = await this.apiGet(`/shops/active/listing-clone/drafts/${draftId}`);
      this.draft = response?.draft || null;
      if (this.draft?.clip && String(this.draft.clip.previewUrl || "").startsWith("blob:")) {
        this.draft.clip.previewUrl = "";
      }
      this.logisticsValidation = null;
      this.lastPublishResult = null;
      this.activeSubtab = "editor";
      this.renderEditor({ preserveDomDraft: false });
      this.setStatus("Rascunho carregado. Revise os campos antes do lancamento.");
      await this.handleValidateLogistics({ silentSuccess: true });
    } catch (error) {
      this.setDraftStatus(`Falha ao abrir rascunho: ${error.message}`, "error");
    }
  }

  async deleteDraft(draftId) {
    if (!draftId) return;
    if (!(await this.requestConfirmation({ title: "Excluir rascunho", message: "Este rascunho sera removido definitivamente.", confirmLabel: "Excluir", danger: true }))) return;

    this.setDraftStatus("Excluindo rascunho...", "loading");

    try {
      await this.apiDelete(`/shops/active/listing-clone/drafts/${draftId}`);
      this.drafts = this.drafts.filter((draft) => String(draft?.id) !== String(draftId));
      this.renderDraftsView();
      this.setDraftStatus("Rascunho excluido com sucesso.");
    } catch (error) {
      this.setDraftStatus(`Falha ao excluir rascunho: ${error.message}`, "error");
    }
  }

  async handleSaveDraft() {
    const draft = this.captureDraftFromDom();
    if (!draft) return;
    if (String(draft?.clip?.previewUrl || "").startsWith("blob:")) {
      draft.clip.previewUrl = "";
    }

    this.setPublishStatus("");
    this.setStatus("Salvando rascunho...", "loading");

    try {
      const response = await this.apiPost("/shops/active/listing-clone/drafts/save", {
        draft,
      });

      this.draft = response?.draft || draft;
      this.renderEditor({ preserveDomDraft: false });
      this.setStatus("Rascunho salvo com sucesso.");
    } catch (error) {
      this.setStatus(`Falha ao salvar rascunho: ${error.message}`, "error");
    }
  }

  async handleCancelClone() {
    const confirmed = await this.requestConfirmation({
      title: "Cancelar clonagem",
      message: "As alteracoes nao salvas desta ficha serao descartadas.",
      confirmLabel: "Descartar",
      danger: true,
    });
    if (confirmed) this.reset();
  }

  async handleValidateLogistics({ silentSuccess = false } = {}) {
    const draft = this.captureDraftFromDom();
    if (!draft) return;

    this.setStatus("Validando logistica e regras SPX...", "loading");

    try {
      const response = await this.apiPost("/shops/active/listing-clone/logistics/validate", {
        draft,
      });
      this.logisticsValidation = response?.validation || null;
      this.draft = draft;
      this.renderEditor({ preserveDomDraft: false });
      if (!silentSuccess) {
        this.setStatus("Logistica validada com sucesso.");
      }
    } catch (error) {
      this.setStatus(`Falha ao validar logistica: ${error.message}`, "error");
    }
  }

  reset() {
    const previewUrl = String(this.draft?.clip?.previewUrl || "");
    if (previewUrl.startsWith("blob:")) {
      URL.revokeObjectURL(previewUrl);
    }
    this.setStatus("");
    this.setPublishStatus("");
    this.setDraftStatus("");
    this.draft = null;
    this.logisticsValidation = null;
    this.lastPublishResult = null;
    this.activeSubtab = "editor";
    this.categoryTreeQuery = "";
    this.renderHome();
  }

  async handlePreview(event) {
    event.preventDefault();
    const sourceUrl = this.normalizeText(
      document.getElementById("listingCloneSourceUrl")?.value || "",
    );

    if (!sourceUrl) {
      this.setStatus("Cole um link antes de iniciar a clonagem.", "error");
      return;
    }

    this.setStatus("Lendo titulo, descricao, midia, atributos e categoria...", "loading");
    this.setImportBusy(true);
    this.setPublishStatus("");

    try {
      const previousPreview = String(this.draft?.clip?.previewUrl || "");
      if (previousPreview.startsWith("blob:")) {
        URL.revokeObjectURL(previousPreview);
      }
      const response = await this.apiPost("/shops/active/listing-clone/preview", {
        sourceUrl,
      });

      this.draft = response?.draft || null;
      this.logisticsValidation = null;
      this.lastPublishResult = null;
      this.categoryTreeQuery = "";
      this.setPublishStatus("");
      this.activeSubtab = "editor";

      if (!this.draft) {
        throw new Error("O backend nao retornou o rascunho do anuncio.");
      }

      this.renderEditor({ preserveDomDraft: false });
      this.setStatus("Anuncio clonado com sucesso. Revise os campos antes de publicar.");
      await this.handleValidateLogistics({ silentSuccess: true });
    } catch (error) {
      this.setStatus(`Falha ao clonar anuncio: ${error.message}`, "error");
    } finally {
      this.setImportBusy(false);
    }
  }

  async handleLoadAttributes({ silent = false, force = false } = {}) {
    const draft = this.captureDraftFromDom();
    const treeCategoryId = this.normalizeText(
      document.getElementById("listingCloneCategoryTreeSelect")?.value || "",
    );
    const inputCategoryId = this.normalizeText(
      document.getElementById("listingCloneCategoryId")?.value || "",
    );
    const pickerCategory = this.resolveCategoryEntryFromInput(
      document.getElementById("listingCloneCategoryPicker")?.value || "",
    );
    const categoryId = this.normalizeText(
      draft?.categoryId || inputCategoryId || treeCategoryId || pickerCategory?.categoryId || "",
    );

    if (!categoryId) {
      if (!silent) this.setStatus("Informe a categoria Shopee para carregar os atributos.", "error");
      return;
    }

    draft.categoryId = categoryId;
    if (pickerCategory?.displayName) {
      draft.categoryName = pickerCategory.displayName;
      const categoryNameInput = document.getElementById("listingCloneCategoryName");
      if (categoryNameInput) categoryNameInput.value = pickerCategory.displayName;
    }

    const cacheKey = String(categoryId);
    if (!force && this.categoryAttributesCache.has(cacheKey)) {
      draft.attributes = this.deepClone(this.categoryAttributesCache.get(cacheKey) || []);
      this.draft = draft;
      this.renderEditor({ preserveDomDraft: false });
      if (!silent) this.setStatus("Atributos carregados do cache local.");
      return;
    }

    if (!silent) this.setStatus("Carregando atributos da categoria Shopee...", "loading");

    try {
      const response = await this.apiPost(
        "/shops/active/listing-clone/category-attributes",
        {
          categoryId,
          sourceAttributes: Array.isArray(draft?.sourceAttributes) ? draft.sourceAttributes : [],
          sourceSpecifications: Array.isArray(draft?.sourceSpecifications)
            ? draft.sourceSpecifications
            : [],
        },
      );

      draft.attributes = Array.isArray(response?.attributes) ? response.attributes : [];
      this.categoryAttributesCache.set(cacheKey, this.deepClone(draft.attributes));
      this.draft = draft;
      this.renderEditor({ preserveDomDraft: false });
      if (response?.warning && !silent) {
        this.setStatus(String(response.warning), "warning");
      } else if (!silent) {
        this.setStatus("Atributos carregados e prontos para revisao.");
      }
    } catch (error) {
      if (!silent) this.setStatus(`Falha ao carregar atributos: ${error.message}`, "error");
    }
  }

  async handleUploadImageSlot(index) {
    const draft = this.captureDraftFromDom();
    if (!draft) return;

    const row = this.getRoot()?.querySelector(`[data-clone-image-row][data-image-index="${index}"]`);
    const file = row?.querySelector("[data-image-slot-file]")?.files?.[0];
    if (!file) {
      this.setStatus("Selecione uma imagem para enviar.", "error");
      return;
    }

    const currentImages = Array.isArray(draft.images) ? draft.images.slice(0, this.maxImages) : [];
    const hasImageInSlot = Boolean(currentImages[index]?.url || currentImages[index]?.imageId);
    if (!hasImageInSlot && currentImages.length >= this.maxImages) {
      this.setStatus("Limite de 9 imagens atingido.", "error");
      return;
    }

    const form = new FormData();
    form.append("images", file);
    form.append("business", "1");
    form.append("scene", "1");

    this.setStatus("Enviando imagem para a Shopee...", "loading");

    try {
      const response = await this.apiPost(
        "/shops/active/listing-clone/images/upload",
        form,
        { asFormData: true },
      );
      const uploaded = Array.isArray(response?.images) ? response.images[0] : null;
      if (!uploaded?.imageId && !uploaded?.url) {
        throw new Error("Shopee nao retornou dados da imagem enviada.");
      }

      const normalized = {
        key: uploaded?.key || `uploaded-${Date.now()}-${index}`,
        imageId: uploaded?.imageId || "",
        url: uploaded?.url || "",
      };

      if (hasImageInSlot) {
        currentImages[index] = normalized;
      } else {
        const insertIndex = Math.min(index, currentImages.length);
        currentImages.splice(insertIndex, 0, normalized);
      }

      draft.images = currentImages.slice(0, this.maxImages);
      this.draft = draft;
      this.renderEditor({ preserveDomDraft: false });
      this.setStatus("Imagem atualizada com sucesso.");
    } catch (error) {
      this.setStatus(`Falha ao enviar imagens: ${error.message}`, "error");
    }
  }

  async handlePublish() {
    const draft = this.captureDraftFromDom();
    if (!draft) return;
    if (String(draft?.clip?.previewUrl || "").startsWith("blob:")) {
      draft.clip.previewUrl = "";
    }

    const issues = this.collectBasicValidation(draft);
    const confirmed = await this.requestConfirmation({
      title: issues.length ? "Revisao pendente" : "Publicar anuncio",
      message: issues.length
        ? `Revise antes de publicar: ${issues.join(", ")}.`
        : `O anuncio "${this.normalizeText(draft.itemName) || "sem titulo"}" sera criado na Shopee.`,
      confirmLabel: issues.length ? "Voltar e revisar" : "Publicar",
    });
    if (!confirmed || issues.length) return;

    this.setPublishStatus("Publicando anuncio na Shopee...", "loading");

    try {
      const response = await this.apiPost("/shops/active/listing-clone/publish", {
        draft,
      });

      this.lastPublishResult = response;
      this.setPublishStatus(
        `Anuncio publicado com sucesso. ID do produto: ${response?.itemId ?? "—"}`,
      );
      this.captureDraftFromDom();
      this.renderEditor({ preserveDomDraft: false });
    } catch (error) {
      this.setPublishStatus(`Falha ao publicar: ${error.message}`, "error");
    }
  }

  load() {
    const root = this.getRoot();
    if (!root) return;

    if (!this.bound) {
      this.bound = true;
    }

    if (this.activeSubtab === "drafts") {
      this.loadDrafts();
      return;
    }

    this.renderCurrentEditorView();
  }
}

window.listingCloneManager = new ListingCloneManager();
