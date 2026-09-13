(() => {
  "use strict";
  const AC = window.AnuncioCadastro = window.AnuncioCadastro || {};
  const Editor = AC.Editor = {};

  const state = {
    draft: null,
    category: null,
    categoryAttributes: [],
    categorySaleTerms: [],
    showAllAttributes: false,
    pictures: [],
    saveTimer: null,
    saving: false,
    dirty: false,
  };

  const form = () => document.getElementById("ac-editor-form");
  const el = (id) => document.getElementById(id);

  function setSaveState(text, cls = "") {
    const node = el("ac-save-state");
    node.textContent = text;
    node.className = `ac-save-state ${cls}`.trim();
  }

  function sourceLabel(type) { return AC.sourceLabel?.(type) || type; }

  function setDraftMeta(draft) {
    el("ac-editor-origin").textContent = sourceLabel(draft.source_type).toUpperCase();
    el("ac-editor-name").textContent = draft.draft_data?.family_name || draft.draft_data?.title || "Novo anúncio";
    el("ac-meta-origin").textContent = sourceLabel(draft.source_type);
    el("ac-meta-source-item").textContent = draft.source_item_id || "—";
    el("ac-meta-model").textContent = draft.publication_model === "user_products" ? "User Products" : "Legacy";
    el("ac-meta-validation").textContent = ({ valid: "Validado", invalid: "Com erros", pending: "Pendente", error: "Falha" })[draft.validation_status] || "Pendente";
    el("ac-meta-group").textContent = draft.group?.name || "—";
    el("ac-draft-status").textContent = AC.statusLabel?.(draft.status) || draft.status;
    el("ac-draft-status-dot").dataset.tone = AC.statusTone?.(draft.status) || "warn";
    const isUp = draft.publication_model === "user_products";
    const saleCondition = draft.publication_target === "sale_condition";
    el("ac-model-chip").textContent = saleCondition ? "CONDIÇÃO DE VENDA" : (isUp ? "USER PRODUCTS" : "LEGACY");
    const locked = draft.status === "published" || draft.status === "publishing";
    el("ac-sale-condition-note").hidden = !saleCondition;
    el("ac-field-title").hidden = isUp;
    el("ac-field-family").hidden = !isUp;
    form()?.querySelectorAll("input, select, textarea, button").forEach((node) => { node.disabled = locked; });
    if (saleCondition && !locked) {
      for (const name of ["title", "family_name", "sku", "gtin", "condition", "available_quantity"]) {
        const node = form()?.elements.namedItem(name);
        if (node) node.disabled = true;
      }
    }
    const pictureActions = el("ac-picture-actions");
    if (pictureActions) pictureActions.hidden = saleCondition;
    el("ac-batch-copy-editor").hidden = locked;
    el("ac-validate").disabled = locked;
    el("ac-publish").disabled = locked || !(draft.validation_status === "valid" && draft.status === "ready");
  }

  function setField(name, value) {
    const node = form().elements.namedItem(name);
    if (!node) return;
    if (node.type === "checkbox") node.checked = Boolean(value);
    else node.value = value ?? "";
  }

  function fillForm(draft) {
    const data = draft.draft_data || {};
    for (const name of ["title","family_name","category_id","price","currency_id","available_quantity","listing_type_id","condition","sku","gtin","description"]) {
      setField(name, data[name]);
    }
    setField("free_shipping", data.shipping?.free_shipping);
    setField("local_pick_up", data.shipping?.local_pick_up);
    state.pictures = Array.isArray(data.pictures) ? data.pictures.map((p) => ({ ...p })) : [];
    renderPictures();
  }

  function referencePreview(draft) {
    const card = el("ac-reference-preview");
    const reference = draft.reference_data || {};
    if (draft.source_type !== "external_item") {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    el("ac-reference-title").textContent = reference.title || draft.source_snapshot?.title || "Referência";
    el("ac-reference-description").textContent = reference.description || "Sem descrição pública.";
    const pictures = Array.isArray(reference.pictures) ? reference.pictures : [];
    el("ac-reference-images").innerHTML = pictures.slice(0, 8).map((pic) => `<img src="${AC.escapeHtml(pic.secure_url || pic.url || "")}" alt="">`).join("") || '<span class="ac-empty">Sem imagens públicas.</span>';
  }

  function serializeAttributes() {
    const current = new Map((state.draft?.draft_data?.attributes || []).map((a) => [String(a.id || a.name || ""), { ...a }]));
    document.querySelectorAll("[data-ac-attr]").forEach((node) => {
      const id = node.dataset.acAttr;
      const name = node.dataset.acAttrName || "";
      const value = String(node.value || "").trim();
      const option = node.tagName === "SELECT" ? node.selectedOptions?.[0] : null;
      if (!value) { current.delete(id); return; }
      current.set(id, {
        id,
        name,
        ...(option?.dataset?.valueId ? { value_id: option.dataset.valueId } : {}),
        value_name: option?.textContent?.trim() || value,
      });
    });
    return [...current.values()].filter((a) => a.value_id || a.value_name);
  }

  function serializeSaleTerms() {
    const current = new Map((state.draft?.draft_data?.sale_terms || []).map((term) => [String(term.id || ""), { ...term }]));
    document.querySelectorAll("[data-ac-sale-term]").forEach((node) => {
      const id = node.dataset.acSaleTerm;
      const value = String(node.value || "").trim();
      const option = node.tagName === "SELECT" ? node.selectedOptions?.[0] : null;
      if (!value) { current.delete(id); return; }
      current.set(id, {
        id,
        ...(option?.dataset?.valueId ? { value_id: option.dataset.valueId } : {}),
        value_name: option?.textContent?.trim() || value,
      });
    });
    return [...current.values()].filter((term) => term.id && (term.value_id || term.value_name));
  }

  function serialize() {
    const f = form();
    const value = (name) => f.elements.namedItem(name)?.value ?? "";
    return {
      title: value("title").trim(),
      family_name: value("family_name").trim(),
      category_id: value("category_id").trim().toUpperCase(),
      price: value("price"),
      currency_id: value("currency_id").trim().toUpperCase() || "BRL",
      available_quantity: value("available_quantity"),
      buying_mode: state.draft?.draft_data?.buying_mode || "buy_it_now",
      listing_type_id: value("listing_type_id"),
      condition: value("condition") || "new",
      sku: value("sku").trim(),
      gtin: value("gtin").trim(),
      attributes: serializeAttributes(),
      sale_terms: serializeSaleTerms(),
      pictures: state.pictures,
      description: value("description"),
      shipping: {
        ...(state.draft?.draft_data?.shipping || {}),
        free_shipping: Boolean(f.elements.namedItem("free_shipping")?.checked),
        local_pick_up: Boolean(f.elements.namedItem("local_pick_up")?.checked),
      },
      channels: state.draft?.draft_data?.channels || ["marketplace"],
    };
  }

  function normalized(value) { return String(value ?? "").trim(); }

  function attributeValueKey(attr = {}) {
    return attr.value_id ? `id:${attr.value_id}` : `name:${normalized(attr.value_name).toLowerCase()}`;
  }

  function familyIntegrityIssues(data = null) {
    const blueprint = state.draft?.group?.type === "family_clone" ? state.draft.group.family_blueprint : null;
    if (!blueprint) return [];
    const current = data || serialize();
    const issues = [];
    if (normalized(current.family_name) !== normalized(blueprint.family_name)) issues.push("nome da família");
    if (normalized(current.category_id).toUpperCase() !== normalized(blueprint.category_id).toUpperCase()) issues.push("categoria/domínio");

    const attrs = new Map((current.attributes || []).map((attr) => [String(attr.id || ""), attr]));
    for (const parent of blueprint.parent_pk || []) {
      const actual = attrs.get(String(parent.id || ""));
      if (!actual || attributeValueKey(actual) !== attributeValueKey(parent)) {
        issues.push(`atributo de família ${parent.name || parent.id}`);
      }
    }

    const expectedChild = new Set((blueprint.child_pk || []).map((attr) => String(attr.id || "")).filter(Boolean));
    const hierarchy = new Map((state.categoryAttributes || []).map((attr) => [String(attr.id || ""), String(attr.hierarchy || "").toUpperCase()]));
    const actualChild = new Set((current.attributes || [])
      .filter((attr) => expectedChild.has(String(attr.id || "")) || hierarchy.get(String(attr.id || "")) === "CHILD_PK")
      .map((attr) => String(attr.id || "")));
    const sameChildStructure = expectedChild.size === actualChild.size && [...expectedChild].every((id) => actualChild.has(id));
    if (!sameChildStructure) issues.push("estrutura dos atributos de variação (CHILD_PK)");
    return [...new Set(issues)];
  }

  function renderFamilyIntegrityWarning(data = null) {
    const note = el("ac-family-integrity-note");
    if (!note) return;
    const issues = familyIntegrityIssues(data);
    note.hidden = !issues.length;
    if (issues.length) {
      el("ac-family-integrity-message").textContent = `Você alterou ${issues.join(", ")}. Alterar este campo pode fazer esta variação sair do agrupamento da família quando for publicada.`;
    }
  }

  async function saveNow() {
    if (!state.draft || !state.dirty || state.saving) return;
    state.saving = true;
    state.dirty = false;
    setSaveState("Salvando...", "is-saving");
    try {
      const payload = await AC.api(`/drafts/${state.draft.id}`, { method: "PATCH", body: { draft_data: serialize() } });
      state.draft = payload.draft;
      AC.state.activeDraft = payload.draft;
      setDraftMeta(payload.draft);
      renderFamilyIntegrityWarning(payload.draft.draft_data || {});
      setSaveState("Salvo agora");
    } catch (error) {
      state.dirty = true;
      setSaveState("Erro ao salvar", "is-error");
      AC.setStatus(error.message, "error");
    } finally {
      state.saving = false;
    }
  }

  function scheduleSave() {
    if (!state.draft || state.draft.status === "published") return;
    renderFamilyIntegrityWarning();
    state.dirty = true;
    setSaveState("Alterações pendentes", "is-saving");
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveNow, 700);
  }

  async function flushSave() {
    clearTimeout(state.saveTimer);
    while (state.saving) {
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
    if (state.dirty) await saveNow();
    while (state.saving) {
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
  }

  Editor.flushSave = flushSave;

  function attributeCurrentMap() {
    return new Map((state.draft?.draft_data?.attributes || []).map((a) => [String(a.id || ""), a]));
  }

  function renderAttributes() {
    const host = el("ac-attributes");
    const current = attributeCurrentMap();
    if (!state.categoryAttributes.length) {
      host.innerHTML = '<div class="ac-empty">Selecione uma categoria para carregar a ficha técnica.</div>';
      el("ac-toggle-all-attrs").hidden = true;
      return;
    }
    const attrs = state.categoryAttributes.filter((attr) => state.showAllAttributes || attr.tags?.required || current.has(String(attr.id)) || ["BRAND","MODEL","COLOR","WIDTH","HEIGHT","DEPTH","MATERIAL"].includes(String(attr.id)));
    el("ac-toggle-all-attrs").hidden = attrs.length === state.categoryAttributes.length;
    el("ac-toggle-all-attrs").textContent = state.showAllAttributes ? "Mostrar principais" : `Mostrar todos (${state.categoryAttributes.length})`;
    host.innerHTML = attrs.map((attr) => {
      const selected = current.get(String(attr.id));
      const labelCls = attr.tags?.required ? "ac-attr-required" : "";
      if (Array.isArray(attr.values) && attr.values.length && attr.values.length <= 300) {
        const options = ['<option value="">Selecione</option>', ...attr.values.map((v) => {
          const active = String(selected?.value_id || "") === String(v.id || "") || (!selected?.value_id && String(selected?.value_name || "") === String(v.name || ""));
          return `<option value="${AC.escapeHtml(v.name || "")}" data-value-id="${AC.escapeHtml(v.id || "")}" ${active ? "selected" : ""}>${AC.escapeHtml(v.name || "")}</option>`;
        })].join("");
        return `<label class="ac-field"><span class="${labelCls}">${AC.escapeHtml(attr.name || attr.id)}</span><select class="ac-input" data-ac-attr="${AC.escapeHtml(attr.id)}" data-ac-attr-name="${AC.escapeHtml(attr.name || "")}">${options}</select></label>`;
      }
      return `<label class="ac-field"><span class="${labelCls}">${AC.escapeHtml(attr.name || attr.id)}</span><input class="ac-input" data-ac-attr="${AC.escapeHtml(attr.id)}" data-ac-attr-name="${AC.escapeHtml(attr.name || "")}" type="text" value="${AC.escapeHtml(selected?.value_name || "")}" /></label>`;
    }).join("");
    host.querySelectorAll("[data-ac-attr]").forEach((node) => {
      if (state.draft?.publication_target === "sale_condition") node.disabled = true;
      node.addEventListener("change", scheduleSave);
      node.addEventListener("input", scheduleSave);
    });
  }

  function renderSaleTerms() {
    const host = el("ac-sale-terms");
    const meta = el("ac-sale-terms-meta");
    if (!host) return;
    const current = new Map((state.draft?.draft_data?.sale_terms || []).map((term) => [String(term.id || ""), term]));
    const visible = state.categorySaleTerms.filter((term) => !term.tags?.hidden || current.has(String(term.id)));
    if (!visible.length) {
      host.innerHTML = '<div class="ac-empty">Nenhum termo adicional disponível para esta categoria.</div>';
      if (meta) meta.textContent = "Nenhum termo adicional disponível para esta categoria.";
      return;
    }
    if (meta) meta.textContent = `${visible.length} termo(s) disponível(is). Garantia e prazo de fabricação aparecem aqui quando suportados.`;
    host.innerHTML = visible.map((term) => {
      const selected = current.get(String(term.id));
      const required = term.tags?.required ? "ac-attr-required" : "";
      if (Array.isArray(term.values) && term.values.length) {
        const options = ['<option value="">Selecione</option>', ...term.values.map((value) => {
          const active = String(selected?.value_id || "") === String(value.id || "") || (!selected?.value_id && String(selected?.value_name || "") === String(value.name || ""));
          return `<option value="${AC.escapeHtml(value.name || "")}" data-value-id="${AC.escapeHtml(value.id || "")}" ${active ? "selected" : ""}>${AC.escapeHtml(value.name || "")}</option>`;
        })].join("");
        return `<label class="ac-field"><span class="${required}">${AC.escapeHtml(term.name || term.id)}</span><select class="ac-input" data-ac-sale-term="${AC.escapeHtml(term.id)}">${options}</select></label>`;
      }
      const unitHint = term.allowed_units?.length ? `Ex.: 12 ${term.default_unit || term.allowed_units[0]?.name || "meses"}` : "";
      return `<label class="ac-field"><span class="${required}">${AC.escapeHtml(term.name || term.id)}</span><input class="ac-input" data-ac-sale-term="${AC.escapeHtml(term.id)}" type="text" maxlength="${Number(term.value_max_length) || 255}" value="${AC.escapeHtml(selected?.value_name || "")}" placeholder="${AC.escapeHtml(unitHint)}" /></label>`;
    }).join("");
    host.querySelectorAll("[data-ac-sale-term]").forEach((node) => {
      node.addEventListener("change", scheduleSave);
      node.addEventListener("input", scheduleSave);
    });
  }

  async function loadAttributes(categoryId, { quiet = false } = {}) {
    const id = String(categoryId || "").trim().toUpperCase();
    if (!id) return;
    if (!quiet) AC.setStatus("Carregando atributos da categoria...", "info");
    try {
      const payload = await AC.api(`/categories/${encodeURIComponent(id)}/attributes`);
      state.category = payload.category;
      state.categoryAttributes = payload.attributes || [];
      state.categorySaleTerms = payload.sale_terms || [];
      state.showAllAttributes = false;
      el("ac-category-name").textContent = payload.category?.name ? `${payload.category.name} · ${id}` : id;
      const required = state.categoryAttributes.filter((a) => a.tags?.required).length;
      el("ac-attributes-meta").textContent = `${state.categoryAttributes.length} atributos · ${required} obrigatórios.`;
      renderAttributes();
      renderSaleTerms();
      renderFamilyIntegrityWarning();
      if (!quiet) AC.setStatus("Ficha técnica e termos de venda carregados.", "ok");
    } catch (error) {
      state.categoryAttributes = [];
      state.categorySaleTerms = [];
      renderAttributes();
      renderSaleTerms();
      AC.setStatus(error.message, "error");
    }
  }

  async function suggestCategory() {
    const q = el("ac-category-query").value.trim() || form().elements.namedItem(state.draft?.publication_model === "user_products" ? "family_name" : "title")?.value.trim();
    if (q.length < 3) return AC.setStatus("Informe um nome com pelo menos 3 caracteres.", "error");
    const host = el("ac-category-suggestions");
    host.hidden = false;
    host.innerHTML = '<div class="ac-empty">Buscando categorias...</div>';
    try {
      const payload = await AC.api(`/categories/suggest?q=${encodeURIComponent(q)}`);
      if (!payload.items?.length) return host.innerHTML = '<div class="ac-empty">Nenhuma categoria sugerida.</div>';
      host.innerHTML = payload.items.map((item) => `<button class="ac-category-choice" type="button" data-category-id="${AC.escapeHtml(item.category_id)}"><span>${AC.escapeHtml(item.category_name || item.category_id)}</span><small>${AC.escapeHtml(item.category_id)}${item.domain_name ? ` · ${AC.escapeHtml(item.domain_name)}` : ""}</small></button>`).join("");
      host.querySelectorAll("[data-category-id]").forEach((button) => button.addEventListener("click", async () => {
        form().elements.namedItem("category_id").value = button.dataset.categoryId;
        host.hidden = true;
        scheduleSave();
        await loadAttributes(button.dataset.categoryId);
      }));
    } catch (error) {
      host.innerHTML = `<div class="ac-empty">${AC.escapeHtml(error.message)}</div>`;
    }
  }

  function renderPictures() {
    const host = el("ac-picture-gallery");
    if (!state.pictures.length) {
      host.innerHTML = '<div class="ac-empty">Nenhuma foto adicionada.</div>';
      return;
    }
    host.innerHTML = state.pictures.map((picture, index) => {
      const url = picture.url || picture.secure_url || picture.source || "";
      const remove = state.draft?.publication_target === "sale_condition" ? "" : `<button type="button" data-remove-picture="${index}" title="Remover">×</button>`;
      return `<div class="ac-picture"><img src="${AC.escapeHtml(url)}" alt="Foto ${index + 1}">${remove}</div>`;
    }).join("");
    host.querySelectorAll("[data-remove-picture]").forEach((button) => button.addEventListener("click", () => {
      state.pictures.splice(Number(button.dataset.removePicture), 1);
      renderPictures();
      scheduleSave();
    }));
  }

  async function uploadFiles(files) {
    const list = [...(files || [])];
    if (!list.length) return;
    AC.setStatus(`Enviando ${list.length} foto(s) para o Mercado Livre...`, "info");
    for (const file of list) {
      const body = new FormData();
      body.append("file", file);
      try {
        const payload = await AC.api("/pictures", { method: "POST", body });
        state.pictures.push(payload.picture);
        renderPictures();
        scheduleSave();
      } catch (error) {
        AC.setStatus(`${file.name}: ${error.message}`, "error");
        return;
      }
    }
    AC.setStatus("Fotos enviadas.", "ok");
    el("ac-picture-files").value = "";
  }

  function addPictureUrl() {
    const input = el("ac-picture-url");
    const url = input.value.trim();
    if (!/^https?:\/\//i.test(url)) return AC.setStatus("Informe uma URL de imagem válida.", "error");
    state.pictures.push({ source: url, url });
    input.value = "";
    renderPictures();
    scheduleSave();
  }

  function renderValidationErrors(errors = []) {
    const card = el("ac-validation-card");
    const host = el("ac-validation-errors");
    if (!errors.length) { card.hidden = true; host.innerHTML = ""; return; }
    card.hidden = false;
    host.innerHTML = errors.map((error) => `<div class="ac-validation-error"><strong>${AC.escapeHtml(error.field || error.code || "Pendência")}</strong>${AC.escapeHtml(error.message || "Campo inválido.")}</div>`).join("");
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function validate() {
    await flushSave();
    AC.setStatus("Validando rascunho no Mercado Livre...", "info");
    el("ac-validate").disabled = true;
    try {
      const payload = await AC.api(`/drafts/${state.draft.id}/validate`, { method: "POST" });
      state.draft = payload.draft;
      AC.state.activeDraft = state.draft;
      setDraftMeta(state.draft);
      renderValidationErrors(payload.errors || []);
      AC.setStatus("Rascunho validado e pronto para publicar.", "ok");
    } catch (error) {
      const payload = error.payload || {};
      if (payload.draft) { state.draft = payload.draft; setDraftMeta(state.draft); }
      const errors = payload.errors || payload.details?.errors || payload.details?.cause || [{ message: error.message }];
      renderValidationErrors(errors);
      AC.setStatus("O rascunho precisa de correções.", "error");
    } finally {
      setDraftMeta(state.draft);
    }
  }

  async function publish() {
    await flushSave();
    if (!state.draft || state.draft.validation_status !== "valid" || state.draft.status !== "ready") return;
    if (!window.confirm("Publicar este rascunho no Mercado Livre agora?")) return;
    el("ac-publish").disabled = true;
    el("ac-validate").disabled = true;
    AC.setStatus("Publicando anúncio...", "info");
    try {
      const payload = await AC.api(`/drafts/${state.draft.id}/publish`, { method: "POST" });
      state.draft = payload.draft;
      AC.state.activeDraft = state.draft;
      setDraftMeta(state.draft);
      renderValidationErrors([]);
      const warning = payload.description?.ok === false ? " O item foi criado, mas a descrição precisa ser revisada." : "";
      AC.setStatus(`Publicado com sucesso: ${payload.item_id}.${warning}`, payload.description?.ok === false ? "info" : "ok");
    } catch (error) {
      try {
        const fresh = await AC.api(`/drafts/${state.draft.id}`);
        state.draft = fresh.draft;
        setDraftMeta(state.draft);
      } catch (_) {}
      AC.setStatus(error.message, "error");
    } finally {
      setDraftMeta(state.draft);
    }
  }

  async function openBatchCopies() {
    await flushSave();
    if (!state.draft || state.draft.status === "published" || state.draft.status === "publishing") return;
    AC.Groups?.openBatchCopy?.({
      sourceType: "draft",
      sourceId: state.draft.id,
      label: state.draft.draft_data?.family_name || state.draft.draft_data?.title || `Rascunho #${state.draft.id}`,
      publicationTarget: state.draft.publication_target || "new_item",
    });
  }

  Editor.setListingTypes = (items = []) => {
    const select = el("ac-listing-type");
    if (!select || !items.length) return;
    const current = select.value;
    select.innerHTML = items.map((item) => `<option value="${AC.escapeHtml(item.id)}">${AC.escapeHtml(item.name || item.id)}</option>`).join("");
    if ([...select.options].some((o) => o.value === current)) select.value = current;
  };

  Editor.open = async (draft) => {
    clearTimeout(state.saveTimer);
    state.draft = draft;
    state.dirty = false;
    state.category = null;
    state.categoryAttributes = [];
    state.categorySaleTerms = [];
    state.showAllAttributes = false;
    setDraftMeta(draft);
    fillForm(draft);
    referencePreview(draft);
    renderValidationErrors(draft.validation_data?.errors || []);
    setSaveState("Salvo");
    Editor.setListingTypes(AC.state.listingTypes || []);
    const categoryId = draft.draft_data?.category_id || draft.category_id;
    if (categoryId) await loadAttributes(categoryId, { quiet: true });
    else { renderAttributes(); renderSaleTerms(); renderFamilyIntegrityWarning(draft.draft_data || {}); }
  };

  document.addEventListener("DOMContentLoaded", () => {
    form().addEventListener("input", (event) => { if (!event.target.matches("[data-ac-attr]") && event.target.id !== "ac-category-query") scheduleSave(); });
    form().addEventListener("change", (event) => { if (!event.target.matches("[data-ac-attr]") && event.target.id !== "ac-picture-files") scheduleSave(); });
    el("ac-load-attributes").addEventListener("click", () => loadAttributes(el("ac-category-id").value));
    el("ac-category-suggest").addEventListener("click", suggestCategory);
    el("ac-toggle-all-attrs").addEventListener("click", () => { state.showAllAttributes = !state.showAllAttributes; renderAttributes(); });
    el("ac-picture-files").addEventListener("change", (event) => uploadFiles(event.target.files));
    el("ac-picture-url-add").addEventListener("click", addPictureUrl);
    el("ac-batch-copy-editor").addEventListener("click", openBatchCopies);
    el("ac-validate").addEventListener("click", validate);
    el("ac-publish").addEventListener("click", publish);
  });
})();
