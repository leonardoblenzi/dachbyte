class CatalogQualityManager {
  constructor() {
    this.bound = false;
    this.hasLoadedOnce = false;
    this.page = 1;
    this.pageSize = 24;
    this.totalPages = 1;
    this.items = [];
    this.selectedItemId = null;
    this.scoreFilter = "all";
    this.listCache = new Map();
    this.listCacheTtlMs = 24 * 60 * 60 * 1000;
    this.currentDetailProduct = null;
  }

  escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async parseJsonResponse(response) {
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  async apiGet(path) {
    const response = await fetch(`/shopee${path}`, { credentials: "include" });
    const json = await this.parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(json?.message || json?.error || `HTTP ${response.status}`);
    }
    return json;
  }

  async apiPatch(path, body) {
    const response = await fetch(`/shopee${path}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const json = await this.parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(json?.message || json?.error || `HTTP ${response.status}`);
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
      throw new Error(json?.message || json?.error || `HTTP ${response.status}`);
    }
    return json;
  }

  scoreTone(score) {
    const n = Number(score || 0);
    if (n > 85) return "excellent";
    if (n >= 60) return "good";
    return "critical";
  }

  scoreMatches(score) {
    const n = Number(score || 0);
    if (this.scoreFilter === "excellent") return n > 85;
    if (this.scoreFilter === "good") return n >= 60 && n <= 85;
    if (this.scoreFilter === "critical") return n < 60;
    return true;
  }

  scoreFilterLabel() {
    if (this.scoreFilter === "excellent") return "Excelente (> 85)";
    if (this.scoreFilter === "good") return "Boa (60-85)";
    if (this.scoreFilter === "critical") return "Ruim (< 60)";
    return "Todos";
  }

  translateFeatureName(name) {
    const label = String(name || "").trim();
    if (!label) return label;
    const map = {
      Brand: "Marca",
      "Brand Name": "Nome da marca",
      "Item Name": "Nome do item",
      Description: "Descrição",
      Category: "Categoria",
      "Main Material": "Material principal",
      Material: "Material",
      Color: "Cor",
      Colors: "Cores",
      Size: "Tamanho",
      Sizes: "Tamanhos",
      Pattern: "Estampa",
      Style: "Estilo",
      Origin: "Origem",
      Model: "Modelo",
      Weight: "Peso",
      Height: "Altura",
      Width: "Largura",
      Length: "Comprimento",
      "Package Dimensions": "Dimensões da embalagem",
      "Product Dimensions": "Dimensões do produto",
      "Video Upload ID": "ID do vídeo",
      "Image Count": "Quantidade de imagens",
      "Mandatory Attributes": "Atributos obrigatórios",
      "Shipping Fee": "Frete",
    };
    return map[label] || label;
  }

  translateFeatureList(values) {
    return (Array.isArray(values) ? values : []).map((value) =>
      this.translateFeatureName(value),
    );
  }

  buildListCacheKey({ search = "", scoreFilter = "all", page = 1, pageSize = 24 } = {}) {
    return [
      String(search || "").trim().toLowerCase(),
      String(scoreFilter || "all"),
      Number(page || 1),
      Number(pageSize || 24),
    ].join("|");
  }

  getCachedList(cacheKey) {
    const entry = this.listCache.get(cacheKey);
    if (!entry) return null;
    if (Number(entry.expiresAt || 0) <= Date.now()) {
      this.listCache.delete(cacheKey);
      return null;
    }
    return entry.data || null;
  }

  setCachedList(cacheKey, data) {
    this.listCache.set(cacheKey, {
      expiresAt: Date.now() + this.listCacheTtlMs,
      data,
    });
  }

  clearListCache() {
    this.listCache.clear();
  }

  csvEscapeCell(value) {
    const raw = String(value ?? "");
    if (!raw) return "";
    if (/[;"\n\r]/.test(raw)) {
      return `"${raw.replace(/"/g, '""')}"`;
    }
    return raw;
  }

  downloadCsv(filename, headers = [], rows = []) {
    const lines = [headers.map((header) => this.csvEscapeCell(header)).join(";")];
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      const cols = Array.isArray(row) ? row : [];
      lines.push(cols.map((cell) => this.csvEscapeCell(cell)).join(";"));
    });
    const blob = new Blob(["\uFEFF", lines.join("\n")], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  renderLoadedVsVisibleMessage(totalLoaded, visibleCount) {
    const loaded = Number(totalLoaded || 0);
    const visible = Number(visibleCount || 0);
    if (loaded === visible) {
      this.clearMessage(
        `${loaded.toLocaleString("pt-BR")} itens carregados para analise nesta pagina.`,
      );
      return;
    }

    this.clearMessage(
      `${visible.toLocaleString("pt-BR")} de ${loaded.toLocaleString("pt-BR")} itens visiveis nesta pagina (filtro: ${this.scoreFilterLabel()}).`,
    );
  }

  setMessage(text, type = "loading") {
    const el = document.getElementById("catalogQualityMsg");
    if (!el) return;
    el.className = `muted ui-state ui-state--${type}`;
    el.textContent = text;
  }

  clearMessage(text = "") {
    const el = document.getElementById("catalogQualityMsg");
    if (!el) return;
    el.className = "muted";
    el.textContent = text;
  }

  setMediaMessage(text, type = "") {
    const el = document.getElementById("catalogQualityMediaMsg");
    if (!el) return;
    el.className = type ? `muted ui-state ui-state--${type}` : "muted";
    el.textContent = text || "";
  }

  updatePager(meta) {
    const info = document.getElementById("catalogQualityPageInfo");
    const prev = document.getElementById("btnCatalogQualityPrev");
    const next = document.getElementById("btnCatalogQualityNext");

    this.totalPages = Number(meta?.totalPages || 1);
    if (info) {
      info.textContent = `Pagina ${this.page} de ${this.totalPages} • ${Number(meta?.total || 0).toLocaleString("pt-BR")} itens`;
    }
    if (prev) prev.disabled = this.page <= 1;
    if (next) next.disabled = this.page >= this.totalPages;
  }

  renderSummary(meta, filteredItems) {
    const avg = document.getElementById("catalogQualityAverageScore");
    const low = document.getElementById("catalogQualityLowScoreCount");
    const count = document.getElementById("catalogQualityListedCount");

    const avgValue = filteredItems.length
      ? Math.round(
          filteredItems.reduce((sum, item) => sum + Number(item.quality?.score || 0), 0) /
            filteredItems.length,
        )
      : Number(meta?.averageScore || 0);

    if (avg) avg.textContent = `${avgValue}`;
    if (low) {
      low.textContent = `${filteredItems.filter((item) => Number(item.quality?.score || 0) < 60).length}`;
    }
    if (count) count.textContent = `${filteredItems.length}`;
  }

  renderList() {
    const root = document.getElementById("catalogQualityList");
    if (!root) return;

    const filteredItems = this.items.filter((item) => this.scoreMatches(item.quality?.score));
    this.renderLoadedVsVisibleMessage(this.items.length, filteredItems.length);
    this.renderSummary(this.meta, filteredItems);

    if (!filteredItems.length) {
      root.innerHTML =
        '<div class="muted ui-state ui-state--empty">Nenhum produto corresponde ao filtro atual.</div>';
      return;
    }

    root.innerHTML = filteredItems
      .map((item) => {
        const tone = this.scoreTone(item.quality?.score);
        const issues = Array.isArray(item.quality?.missing)
          ? this.translateFeatureList(item.quality.missing).slice(0, 2)
          : [];
        return `
          <button
            class="catalog-quality-item ${String(item.itemId) === String(this.selectedItemId) ? "is-active" : ""}"
            data-catalog-item-id="${this.escapeHtml(item.itemId)}"
            type="button"
          >
            ${
              item.imageUrl
                ? `<img class="catalog-quality-item__thumb" src="${this.escapeHtml(item.imageUrl)}" alt="">`
                : `<div class="catalog-quality-item__thumb"></div>`
            }
            <div>
              <div class="catalog-quality-item__title">${this.escapeHtml(item.title || `Item ${item.itemId}`)}</div>
              <div class="catalog-quality-item__meta">ID ${this.escapeHtml(item.itemId)} • ${this.escapeHtml(item.brand || "Sem marca")} • atualizado ${new Date(item.updatedAt).toLocaleDateString("pt-BR")}</div>
              <div class="catalog-quality-item__issues">${this.escapeHtml(issues.join(" • ") || "Sem pendencias destacadas nesta pagina.")}</div>
            </div>
            <div class="catalog-quality-score catalog-quality-score--${tone}">${Number(item.quality?.score || 0)}</div>
          </button>
        `;
      })
      .join("");

    root.querySelectorAll("[data-catalog-item-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const itemId = button.getAttribute("data-catalog-item-id");
        if (!itemId) return;
        this.loadDetail(itemId);
      });
    });
  }

  checkCard(label, ok, detail) {
    return `
      <div class="catalog-quality-check">
        <div class="catalog-quality-check__label">${this.escapeHtml(label)}</div>
        <div class="catalog-quality-check__value ${ok ? "is-ok" : "is-bad"}">${ok ? "OK" : "Pendente"}</div>
        <div class="catalog-quality-form__hint">${this.escapeHtml(detail)}</div>
      </div>
    `;
  }

  renderDetail(data) {
    const root = document.getElementById("catalogQualityDetail");
    if (!root) return;

    const product = data?.product || {};
    this.currentDetailProduct = product;

    const quality = data?.quality || {};
    const checks = quality.checks || {};
    const metrics = quality.metrics || {};
    const tone = this.scoreTone(quality.score);

    const attributes = Array.isArray(product.attributes) ? product.attributes : [];
    const missing = Array.isArray(quality.missing) ? quality.missing : [];
    const imageUrl = product.images?.[0]?.url || "";
    const images = Array.isArray(product.images) ? product.images : [];
    const clip = product.clip || {};

    root.innerHTML = `
      <div class="catalog-quality-detail__hero">
        ${
          imageUrl
            ? `<img class="catalog-quality-detail__thumb" src="${this.escapeHtml(imageUrl)}" alt="">`
            : `<div class="catalog-quality-detail__thumb"></div>`
        }
        <div>
          <div class="catalog-quality-detail__title">${this.escapeHtml(product.title || `Item ${product.itemId}`)}</div>
          <div class="catalog-quality-detail__meta">ID ${this.escapeHtml(product.itemId)} • ${this.escapeHtml(product.brand || "Sem marca")} • ${Number(metrics.imageCount || 0)} imagens • ${Number(metrics.filledAttributeCount || 0)} atributos preenchidos</div>
        </div>
        <div class="catalog-quality-score catalog-quality-score--${tone}">${Number(quality.score || 0)}</div>
      </div>

      <div class="catalog-quality-checks">
        ${this.checkCard("Clip ativo", Boolean(checks.hasClip), "Produtos sem clip perdem nota.")}
        ${this.checkCard("Marca preenchida", Boolean(checks.brandFilled), "A marca precisa estar preenchida na ficha tecnica.")}
        ${this.checkCard("Minimo de atributos", Boolean(checks.enoughAttrs), `${Number(metrics.filledAttributeCount || 0)} atributos com valor.`)}
        ${this.checkCard("Quantidade de imagens", Boolean(checks.enoughImages), `${Number(metrics.imageCount || 0)} imagens encontradas.`)}
        ${this.checkCard("Titulo ideal", Boolean(checks.titleOptimal), `${Number(metrics.titleLength || 0)} caracteres no titulo.`)}
        ${this.checkCard("Atributos obrigatorios", Number(checks.missingMandatoryCount || 0) === 0, `${Number(checks.missingMandatoryCount || 0)} campos obrigatorios pendentes.`)}
        ${this.checkCard(
          "Possui Desconto",
          Boolean(checks.hasDiscountCampaign),
          Array.isArray(checks.campaignStatuses) && checks.campaignStatuses.length
            ? `Status das campanhas: ${checks.campaignStatuses.join(", ")}`
            : "Item sem participacao em campanhas de desconto (draft/upcoming/ongoing).",
        )}
      </div>

      <div class="catalog-quality-missing">
        ${
          missing.length
            ? this.translateFeatureList(missing)
                .map((item) => `<span class="catalog-quality-tag">${this.escapeHtml(item)}</span>`)
                .join("")
            : '<span class="catalog-quality-tag" style="border-color:rgba(34,197,94,0.24);background:rgba(34,197,94,0.12);color:rgba(225,255,235,0.92)">Sem pendencias criticas na analise atual</span>'
        }
      </div>

      <form id="catalogQualityForm" class="catalog-quality-form">
        <div class="catalog-quality-form__grid">
          <div class="catalog-quality-form__field catalog-quality-form__field--full">
            <label for="catalogQualityItemName">Titulo do anuncio</label>
            <input id="catalogQualityItemName" class="input" type="text" value="${this.escapeHtml(product.title || "")}" />
            <div class="catalog-quality-form__hint">Ideal entre 80 e 100 caracteres.</div>
          </div>
          <div class="catalog-quality-form__field">
            <label for="catalogQualityBrand">Marca</label>
            <input id="catalogQualityBrand" class="input" type="text" value="${this.escapeHtml(product.brand || "")}" />
          </div>
          <div class="catalog-quality-form__field">
            <label for="catalogQualityCategoryId">Categoria (ID)</label>
            <input id="catalogQualityCategoryId" class="input" type="text" inputmode="numeric" value="${this.escapeHtml(product.categoryId || "")}" placeholder="Ex.: 100123" />
            <div class="catalog-quality-form__hint">Atual: ${this.escapeHtml(product.categoryName || "nao informado")}</div>
          </div>
          <div class="catalog-quality-form__field">
            <label for="catalogQualityVideoUploadId">Clip (video_upload_id)</label>
            <input id="catalogQualityVideoUploadId" class="input" type="text" value="${this.escapeHtml(clip.videoUploadId || "")}" placeholder="Cole o video_upload_id para inserir clip" />
            <div class="catalog-quality-form__hint">${clip.hasClip ? "Clip ativo atualmente." : "Sem clip ativo."}</div>
          </div>
          <div class="catalog-quality-form__field">
            <label for="catalogQualityItemId">Item ID</label>
            <input id="catalogQualityItemId" class="input" type="text" value="${this.escapeHtml(product.itemId || "")}" disabled />
          </div>
          <div class="catalog-quality-form__field catalog-quality-form__field--full">
            <label for="catalogQualityDescription">Descricao</label>
            <textarea id="catalogQualityDescription" class="input" rows="6">${this.escapeHtml(product.description || "")}</textarea>
          </div>
        </div>

        <div>
          <div class="section-title">Imagens</div>
          <div class="catalog-quality-form__hint" style="margin-top:6px">Envie ate 3 imagens por vez (JPEG/PNG). Tambem e possivel remover por image_id.</div>
          <div class="catalog-quality-attributes" style="margin-top:12px">
            ${
              images.length
                ? images
                    .map(
                      (img, index) => `
                        <div class="catalog-quality-attribute">
                          <div class="catalog-quality-attribute__header">
                            <div class="catalog-quality-attribute__title">Imagem ${index + 1}</div>
                            ${
                              img?.imageId
                                ? `<label class="catalog-quality-form__hint" style="display:flex;align-items:center;gap:6px"><input type="checkbox" data-image-remove-id="${this.escapeHtml(img.imageId)}"> Remover</label>`
                                : '<span class="catalog-quality-form__hint">Sem image_id salvo</span>'
                            }
                          </div>
                          ${
                            img?.url
                              ? `<img src="${this.escapeHtml(img.url)}" alt="" style="width:100%;max-width:220px;height:140px;object-fit:cover;border-radius:12px;border:1px solid rgba(255,255,255,0.1)">`
                              : '<div class="catalog-quality-form__hint">URL da imagem indisponivel</div>'
                          }
                          <div class="catalog-quality-form__hint" style="margin-top:8px">image_id: ${this.escapeHtml(img?.imageId || "nao informado")}</div>
                        </div>
                      `,
                    )
                    .join("")
                : '<div class="muted ui-state ui-state--empty">Nenhuma imagem registrada.</div>'
            }
          </div>
          <div class="catalog-quality-form__grid" style="margin-top:12px">
            <div class="catalog-quality-form__field catalog-quality-form__field--full">
              <label for="catalogQualityImageFiles">Adicionar imagens</label>
              <input id="catalogQualityImageFiles" class="input" type="file" accept="image/jpeg,image/png" multiple />
            </div>
            <div class="catalog-quality-form__field">
              <label for="catalogQualityImageBusiness">business</label>
              <input id="catalogQualityImageBusiness" class="input" type="number" min="1" step="1" value="1" />
            </div>
            <div class="catalog-quality-form__field">
              <label for="catalogQualityImageScene">scene</label>
              <input id="catalogQualityImageScene" class="input" type="number" min="1" step="1" value="1" />
            </div>
          </div>
          <div class="section-actions" style="margin-top:10px">
            <button id="btnCatalogQualityImagesAdd" class="btn btn-ghost" type="button">Inserir imagens</button>
            <button id="btnCatalogQualityImagesRemove" class="btn btn-ghost" type="button">Remover selecionadas</button>
            <button id="btnCatalogQualityImagesReplace" class="btn btn-ghost" type="button">Substituir por uploads</button>
          </div>
          <div id="catalogQualityMediaMsg" class="muted"></div>
        </div>

        <div>
          <div class="section-title">Atributos</div>
          <div class="catalog-quality-form__hint" style="margin-top:6px">Preencha valores separados por virgula. Atributos obrigatorios sem valor derrubam a nota.</div>
          <div id="catalogQualityAttributes" class="catalog-quality-attributes" style="margin-top:12px">
            ${
              attributes.length
                ? attributes
                    .map(
                      (attr, index) => `
                        <div class="catalog-quality-attribute">
                          <div class="catalog-quality-attribute__header">
                            <div class="catalog-quality-attribute__title">${this.escapeHtml(this.translateFeatureName(attr.name || `Atributo ${index + 1}`))}</div>
                            ${attr.isMandatory ? '<span class="catalog-quality-attribute__required">Obrigatorio</span>' : ""}
                          </div>
                          <input
                            class="input"
                            type="text"
                            data-attribute-index="${index}"
                            data-attribute-id="${this.escapeHtml(attr.attributeId || "")}"
                            data-attribute-name="${this.escapeHtml(attr.name || "")}" 
                            data-attribute-required="${attr.isMandatory ? "1" : "0"}"
                            value="${this.escapeHtml((attr.values || []).join(", "))}"
                            placeholder="Valor 1, Valor 2"
                          />
                        </div>
                      `,
                    )
                    .join("")
                : '<div class="muted ui-state ui-state--empty">Nenhum atributo disponivel para edicao local.</div>'
            }
          </div>
        </div>

        <div class="section-actions">
          <button id="btnCatalogQualitySave" class="btn btn-primary" type="submit">Salvar ajustes</button>
        </div>
        <div id="catalogQualitySaveMsg" class="muted"></div>
      </form>
    `;

    document
      .getElementById("catalogQualityForm")
      ?.addEventListener("submit", (event) => this.handleSave(event));

    this.bindDetailActions();
  }

  bindDetailActions() {
    document
      .getElementById("btnCatalogQualityImagesAdd")
      ?.addEventListener("click", () => this.handleAddImages());

    document
      .getElementById("btnCatalogQualityImagesRemove")
      ?.addEventListener("click", () => this.handleRemoveImages());

    document
      .getElementById("btnCatalogQualityImagesReplace")
      ?.addEventListener("click", () => this.handleReplaceImages());
  }

  buildImageUploadForm() {
    const input = document.getElementById("catalogQualityImageFiles");
    const files = Array.from(input?.files || []);
    if (!files.length) {
      throw new Error("Selecione pelo menos uma imagem para enviar.");
    }
    if (files.length > 3) {
      throw new Error("Envie no maximo 3 imagens por vez.");
    }

    const business = Number(document.getElementById("catalogQualityImageBusiness")?.value || 1);
    const scene = Number(document.getElementById("catalogQualityImageScene")?.value || 1);
    if (!Number.isFinite(business) || !Number.isFinite(scene)) {
      throw new Error("business e scene devem ser numeros validos.");
    }

    const form = new FormData();
    files.forEach((file) => form.append("images", file));
    form.append("business", String(business));
    form.append("scene", String(scene));
    return form;
  }

  async handleAddImages() {
    if (!this.selectedItemId) return;

    let form;
    try {
      form = this.buildImageUploadForm();
    } catch (error) {
      this.setMediaMessage(error.message, "error");
      return;
    }

    this.setMediaMessage("Enviando imagens...", "loading");

    try {
      await this.apiPost(
        `/shops/active/products/${encodeURIComponent(this.selectedItemId)}/images/add`,
        form,
        { asFormData: true },
      );
      this.setMediaMessage("Imagens inseridas com sucesso.");
      this.clearListCache();
      await this.loadList({ preserveSelection: true, forceRefresh: true });
      await this.loadDetail(this.selectedItemId, { silentList: true });
    } catch (error) {
      this.setMediaMessage(`Falha ao inserir imagens: ${error.message}`, "error");
    }
  }

  async handleReplaceImages() {
    if (!this.selectedItemId) return;

    let form;
    try {
      form = this.buildImageUploadForm();
    } catch (error) {
      this.setMediaMessage(error.message, "error");
      return;
    }

    this.setMediaMessage("Substituindo imagens do item...", "loading");

    try {
      await this.apiPost(
        `/shops/active/products/${encodeURIComponent(this.selectedItemId)}/images`,
        form,
        { asFormData: true },
      );
      this.setMediaMessage("Imagens substituidas com sucesso.");
      this.clearListCache();
      await this.loadList({ preserveSelection: true, forceRefresh: true });
      await this.loadDetail(this.selectedItemId, { silentList: true });
    } catch (error) {
      this.setMediaMessage(`Falha ao substituir imagens: ${error.message}`, "error");
    }
  }

  async handleRemoveImages() {
    if (!this.selectedItemId) return;

    const selected = Array.from(document.querySelectorAll("[data-image-remove-id]:checked"))
      .map((input) => input.getAttribute("data-image-remove-id"))
      .filter(Boolean);

    if (!selected.length) {
      this.setMediaMessage("Selecione ao menos uma imagem para remover.", "error");
      return;
    }

    this.setMediaMessage("Removendo imagens...", "loading");

    try {
      await this.apiPost(
        `/shops/active/products/${encodeURIComponent(this.selectedItemId)}/images/remove`,
        { removeImageIds: selected },
      );
      this.setMediaMessage("Imagens removidas com sucesso.");
      this.clearListCache();
      await this.loadList({ preserveSelection: true, forceRefresh: true });
      await this.loadDetail(this.selectedItemId, { silentList: true });
    } catch (error) {
      this.setMediaMessage(`Falha ao remover imagens: ${error.message}`, "error");
    }
  }

  async loadList({ preserveSelection = true, forceRefresh = false } = {}) {
    const search = String(document.getElementById("catalogQualitySearch")?.value || "").trim();

    try {
      const scoreFilter = String(this.scoreFilter || "all");
      const cacheKey = this.buildListCacheKey({
        search,
        scoreFilter,
        page: this.page,
        pageSize: this.pageSize,
      });

      let data = forceRefresh ? null : this.getCachedList(cacheKey);
      if (!data) {
        this.setMessage("Carregando analise de qualidade...", "loading");
        data = await this.apiGet(
          `/shops/active/catalog-quality?page=${this.page}&pageSize=${this.pageSize}&q=${encodeURIComponent(search)}&scoreFilter=${encodeURIComponent(scoreFilter)}`,
        );
        this.setCachedList(cacheKey, data);
      }

      this.items = Array.isArray(data?.items) ? data.items : [];
      this.meta = data?.meta || {};
      this.updatePager(this.meta);
      this.renderList();

      if (!preserveSelection) {
        this.selectedItemId = null;
      }

      if (
        this.selectedItemId &&
        this.items.some((item) => String(item.itemId) === String(this.selectedItemId))
      ) {
        await this.loadDetail(this.selectedItemId, { silentList: true });
      }
    } catch (error) {
      this.setMessage(`Erro ao carregar qualidade: ${error.message}`, "error");
      const root = document.getElementById("catalogQualityList");
      if (root) {
        root.innerHTML = `<div class="muted ui-state ui-state--error">Erro ao listar produtos: ${this.escapeHtml(error.message)}</div>`;
      }
    }
  }

  async loadDetail(itemId, { silentList = false } = {}) {
    this.selectedItemId = itemId;
    const root = document.getElementById("catalogQualityDetail");
    if (root) {
      root.innerHTML =
        '<div class="muted ui-state ui-state--loading">Carregando detalhe do item...</div>';
    }

    try {
      const data = await this.apiGet(`/shops/active/catalog-quality/${encodeURIComponent(itemId)}`);
      this.renderDetail(data);
      if (!silentList) this.renderList();
    } catch (error) {
      if (root) {
        root.innerHTML = `<div class="muted ui-state ui-state--error">Erro ao carregar detalhe: ${this.escapeHtml(error.message)}</div>`;
      }
    }
  }

  collectAttributes() {
    const sourceAttributes = Array.isArray(this.currentDetailProduct?.attributes)
      ? this.currentDetailProduct.attributes
      : [];

    return Array.from(document.querySelectorAll("#catalogQualityAttributes input[data-attribute-index]")).map(
      (input) => {
        const index = Number(input.getAttribute("data-attribute-index"));
        const source =
          Number.isFinite(index) && index >= 0
            ? sourceAttributes[index]?.sourceAttribute || null
            : null;

        return {
          attributeId: input.getAttribute("data-attribute-id") || null,
          name: input.getAttribute("data-attribute-name") || "",
          isMandatory: input.getAttribute("data-attribute-required") === "1",
          values: String(input.value || "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          sourceAttribute: source,
        };
      },
    );
  }

  async handleSave(event) {
    event.preventDefault();
    if (!this.selectedItemId) return;

    const msg = document.getElementById("catalogQualitySaveMsg");
    if (msg) {
      msg.className = "muted ui-state ui-state--loading";
      msg.textContent = "Salvando ajustes do item...";
    }

    const body = {
      itemName: document.getElementById("catalogQualityItemName")?.value || "",
      brand: document.getElementById("catalogQualityBrand")?.value || "",
      description: document.getElementById("catalogQualityDescription")?.value || "",
      categoryId: document.getElementById("catalogQualityCategoryId")?.value || "",
      videoUploadId: document.getElementById("catalogQualityVideoUploadId")?.value || "",
      attributes: this.collectAttributes(),
    };

    try {
      await this.apiPatch(
        `/shops/active/catalog-quality/${encodeURIComponent(this.selectedItemId)}`,
        body,
      );

      if (msg) {
        msg.className = "muted";
        msg.textContent = "Item atualizado. Recalculando nota...";
      }

      this.clearListCache();
      await this.loadList({ preserveSelection: true, forceRefresh: true });
      await this.loadDetail(this.selectedItemId, { silentList: true });
    } catch (error) {
      if (msg) {
        msg.className = "muted ui-state ui-state--error";
        msg.textContent = `Falha ao salvar: ${error.message}`;
      }
    }
  }

  async handleExportReport() {
    const exportButton = document.getElementById("btnCatalogQualityExport");
    const previousLabel = exportButton?.textContent || "Exportar relatório";
    if (exportButton) {
      exportButton.disabled = true;
      exportButton.textContent = "Exportando...";
    }

    this.setMessage("Gerando relatório completo de qualidade...", "loading");

    try {
      const data = await this.apiGet("/shops/active/catalog-quality/export");
      const items = Array.isArray(data?.items) ? data.items : [];
      if (!items.length) {
        this.setMessage("Nenhum item ativo disponível para exportação.", "error");
        return;
      }

      const headers = [
        "item_id",
        "nome",
        "marca",
        "indice_qualidade",
        "possui_clip",
        "possui_marca",
        "qtd_imagens",
        "qtd_atributos_preenchidos",
        "faltam_atributos_obrigatorios",
        "atributos_obrigatorios_pendentes",
        "pendencias",
        "atualizado_em",
      ];
      const rows = items.map((item) => [
        item?.item_id ?? "",
        item?.nome ?? "",
        item?.marca ?? "",
        item?.indice_qualidade ?? "",
        item?.possui_clip ?? "",
        item?.possui_marca ?? "",
        item?.qtd_imagens ?? "",
        item?.qtd_atributos_preenchidos ?? "",
        item?.faltam_atributos_obrigatorios ?? "",
        item?.atributos_obrigatorios_pendentes ?? "",
        item?.pendencias ?? "",
        item?.atualizado_em ?? "",
      ]);

      const fileDate = new Date().toISOString().slice(0, 10);
      this.downloadCsv(`catalogo-qualidade-${fileDate}.csv`, headers, rows);
      this.clearMessage(
        `${items.length.toLocaleString("pt-BR")} itens exportados com sucesso.`,
      );
    } catch (error) {
      this.setMessage(`Falha ao exportar relatório: ${error.message}`, "error");
    } finally {
      if (exportButton) {
        exportButton.disabled = false;
        exportButton.textContent = previousLabel;
      }
    }
  }

  bind() {
    if (this.bound) return;
    this.bound = true;

    document.getElementById("btnCatalogQualityReload")?.addEventListener("click", () => {
      this.page = 1;
      this.clearListCache();
      this.load({ forceRefresh: true });
    });

    document
      .getElementById("btnCatalogQualityExport")
      ?.addEventListener("click", () => {
        this.handleExportReport();
      });

    document
      .getElementById("catalogQualitySearch")
      ?.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        this.page = 1;
        this.clearListCache();
        this.loadList({ preserveSelection: false, forceRefresh: true });
      });

    document
      .getElementById("catalogQualityScoreFilter")
      ?.addEventListener("change", (event) => {
        this.scoreFilter = String(event.target.value || "all");
        this.page = 1;
        this.clearListCache();
        this.loadList({ preserveSelection: false, forceRefresh: true });
      });

    document.getElementById("btnCatalogQualityPrev")?.addEventListener("click", () => {
      if (this.page <= 1) return;
      this.page -= 1;
      this.loadList({ preserveSelection: false });
    });

    document.getElementById("btnCatalogQualityNext")?.addEventListener("click", () => {
      if (this.page >= this.totalPages) return;
      this.page += 1;
      this.loadList({ preserveSelection: false });
    });
  }

  async load({ forceRefresh = false } = {}) {
    this.bind();
    if (forceRefresh) {
      this.clearListCache();
      this.hasLoadedOnce = false;
    }

    if (this.hasLoadedOnce && !forceRefresh) {
      this.renderList();
      return;
    }

    await this.loadList({ preserveSelection: true, forceRefresh });
    this.hasLoadedOnce = true;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  window.catalogQualityManager = new CatalogQualityManager();
});

