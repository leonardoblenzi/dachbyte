(() => {
  "use strict";

  const AC = window.AnuncioCadastro = window.AnuncioCadastro || {};
  AC.state = {
    capabilities: null,
    listingTypes: [],
    activeTab: "create",
    sourceMode: null,
    activeDraft: null,
    resolvedOwnSource: null,
  };

  AC.escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);

  AC.api = async (path, options = {}) => {
    const response = await fetch(window.mlUrl(`/api/anuncio-cadastro${path}`), {
      credentials: "include",
      headers: { Accept: "application/json", ...(options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
      ...options,
      body: options.body && !(options.body instanceof FormData) && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok === false) {
      const error = new Error(payload?.error || `Falha na requisição (${response.status}).`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  };

  AC.setStatus = (text, tone = "info") => {
    const el = document.getElementById("ac-global-status");
    if (!el) return;
    el.textContent = text;
    el.dataset.tone = tone;
  };

  AC.sourceLabel = (type) => ({
    blank: "Criado do zero",
    own_item: "Meu anúncio",
    own_family: "Minha família",
    external_item: "Referência externa",
    draft_copy: "Cópia de rascunho",
  })[type] || type || "—";

  AC.statusLabel = (status) => ({
    incomplete: "Incompleto",
    review: "Em revisão",
    error: "Com erros",
    ready: "Pronto",
    publishing: "Publicando",
    published: "Publicado",
    publish_error: "Falha na publicação",
  })[status] || status || "—";

  AC.statusTone = (status) => {
    if (["ready", "published"].includes(status)) return "ok";
    if (["error", "publish_error"].includes(status)) return "error";
    return "warn";
  };

  AC.switchTab = (tab) => {
    const next = tab === "drafts" ? "drafts" : "create";
    AC.state.activeTab = next;
    document.querySelectorAll("[data-ac-tab]").forEach((button) => button.classList.toggle("is-active", button.dataset.acTab === next));
    document.getElementById("ac-panel-create").hidden = next !== "create";
    document.getElementById("ac-panel-drafts").hidden = next !== "drafts";
    if (next === "drafts") AC.Drafts?.load?.();
  };

  function showSource(mode) {
    clearOwnPreview();
    AC.state.sourceMode = mode;
    const box = document.getElementById("ac-source-box");
    box.hidden = false;
    document.getElementById("ac-own-source").hidden = mode !== "own";
    document.getElementById("ac-reference-source").hidden = mode !== "reference";
    document.getElementById("ac-source-title").textContent = mode === "reference" ? "Usar uma referência" : "Usar meu anúncio";
    document.getElementById("ac-source-subtitle").textContent = mode === "reference"
      ? "Cole um MLB ou link de outro vendedor."
      : "Importe pelo MLB/link, busque na conta ou informe uma família.";
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function clearOwnPreview() {
    AC.state.resolvedOwnSource = null;
    const preview = document.getElementById("ac-own-preview");
    if (preview) preview.hidden = true;
  }

  function closeSource() {
    document.getElementById("ac-source-box").hidden = true;
    document.getElementById("ac-own-results").hidden = true;
    clearOwnPreview();
    AC.state.sourceMode = null;
  }

  async function openDraft(draft) {
    AC.state.activeDraft = draft;
    AC.switchTab("create");
    document.getElementById("ac-create-home").hidden = true;
    document.getElementById("ac-editor").hidden = false;
    await AC.Editor?.open?.(draft);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  AC.openDraft = openDraft;

  AC.closeEditor = () => {
    AC.Editor?.flushSave?.();
    AC.state.activeDraft = null;
    document.getElementById("ac-editor").hidden = true;
    document.getElementById("ac-create-home").hidden = false;
    closeSource();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  async function createBlank() {
    AC.setStatus("Criando rascunho...", "info");
    try {
      const payload = await AC.api("/drafts", { method: "POST", body: { draft_data: {} } });
      AC.setStatus("Rascunho criado.", "ok");
      await openDraft(payload.draft);
    } catch (error) {
      AC.setStatus(error.message, "error");
    }
  }

  async function importItem(input, expected) {
    const value = String(input || "").trim();
    if (!value) return AC.setStatus("Informe um MLB ou link.", "error");
    AC.setStatus("Consultando anúncio no Mercado Livre...", "info");
    try {
      const payload = await AC.api("/drafts/from-source", { method: "POST", body: { type: "item", input: value, expected } });
      AC.setStatus("Rascunho criado a partir do anúncio.", "ok");
      await openDraft(payload.draft);
    } catch (error) {
      AC.setStatus(error.message, "error");
    }
  }

  async function resolveOwnItem(input) {
    const value = String(input || "").trim();
    if (!value) return AC.setStatus("Informe um MLB ou link.", "error");
    AC.setStatus("Consultando anúncio no Mercado Livre...", "info");
    clearOwnPreview();
    try {
      const payload = await AC.api("/source/resolve", { method: "POST", body: { type: "item", input: value } });
      const source = payload.source;
      if (source?.source_type !== "own_item") {
        throw new Error("Esse anúncio pertence a outro vendedor. Use a opção 'Usar uma referência'.");
      }
      AC.state.resolvedOwnSource = source;
      const snap = source.source_snapshot || {};
      const preview = document.getElementById("ac-own-preview");
      const thumb = document.getElementById("ac-own-preview-thumb");
      if (snap.thumbnail) {
        thumb.outerHTML = `<img id="ac-own-preview-thumb" src="${AC.escapeHtml(snap.thumbnail)}" alt="">`;
      } else {
        const current = document.getElementById("ac-own-preview-thumb");
        if (current.tagName !== "SPAN") current.outerHTML = '<span id="ac-own-preview-thumb" class="ac-thumb-fallback">ML</span>';
      }
      document.getElementById("ac-own-preview-title").textContent = snap.title || snap.family_name || snap.id || "Anúncio encontrado";
      document.getElementById("ac-own-preview-meta").textContent = [snap.id, snap.family_id ? `Família ${snap.family_id}` : null, snap.user_product_id || null].filter(Boolean).join(" · ");
      document.getElementById("ac-own-create-family").hidden = !(snap.family_id && source.capabilities?.user_product_seller);
      preview.hidden = false;
      AC.setStatus("Anúncio encontrado. Escolha como deseja aproveitá-lo.", "ok");
    } catch (error) {
      AC.setStatus(error.message, "error");
    }
  }

  async function createResolvedOwnItem() {
    const source = AC.state.resolvedOwnSource;
    if (!source?.item_id) return AC.setStatus("Consulte um anúncio da sua conta primeiro.", "error");
    await importItem(source.item_id, "own");
  }

  async function importFamilyById(input) {
    const value = String(input || "").trim();
    if (!value) return AC.setStatus("Informe o ID da família.", "error");
    AC.setStatus("Consultando família e gerando rascunhos...", "info");
    try {
      const payload = await AC.api("/drafts/from-source", { method: "POST", body: { type: "family", input: value } });
      const count = payload.drafts?.length || 0;
      const failed = payload.failures?.length || 0;
      AC.setStatus(failed ? `${count} rascunho(s) criado(s); ${failed} User Product(s) precisaram ser ignorados.` : `${count} rascunho(s) criado(s) para a família.`, failed ? "info" : "ok");
      AC.switchTab("drafts");
      return payload;
    } catch (error) {
      AC.setStatus(error.message, "error");
      throw error;
    }
  }
  AC.importFamilyById = importFamilyById;

  async function importFamily() {
    const input = document.getElementById("ac-family-input").value.trim();
    const button = document.getElementById("ac-family-import");
    button.disabled = true;
    try { await importFamilyById(input); } catch (_) {}
    finally { button.disabled = false; }
  }

  async function cloneResolvedFamily() {
    const itemId = AC.state.resolvedOwnSource?.item_id || AC.state.resolvedOwnSource?.source_snapshot?.id;
    if (!itemId) return AC.setStatus("Consulte um anúncio User Products da sua conta primeiro.", "error");
    AC.Groups?.openFamilyClone?.(itemId);
  }

  async function searchOwnItems() {
    const q = document.getElementById("ac-own-search").value.trim();
    const results = document.getElementById("ac-own-results");
    results.hidden = false;
    results.innerHTML = '<div class="ac-empty">Buscando anúncios...</div>';
    try {
      const payload = await AC.api(`/own-items?q=${encodeURIComponent(q)}&limit=20`);
      const items = payload.items || [];
      if (!items.length) {
        results.innerHTML = '<div class="ac-empty">Nenhum anúncio encontrado.</div>';
        return;
      }
      results.innerHTML = items.map((item) => `
        <div class="ac-search-item">
          ${item.thumbnail ? `<img src="${AC.escapeHtml(item.thumbnail)}" alt="">` : '<span class="ac-thumb-fallback">ML</span>'}
          <div>
            <strong>${AC.escapeHtml(item.title || item.family_name || item.id)}</strong>
            <small>${AC.escapeHtml(item.id)}${item.sku ? ` · SKU ${AC.escapeHtml(item.sku)}` : ""}${item.family_id ? ` · Família ${AC.escapeHtml(item.family_id)}` : ""}</small>
          </div>
          <div class="ac-search-actions">
            <button class="ac-btn ac-btn--ghost" type="button" data-own-item="${AC.escapeHtml(item.id)}">Usar</button>
            <button class="ac-btn ac-btn--ghost" type="button" data-own-batch="${AC.escapeHtml(item.id)}" data-own-label="${AC.escapeHtml(item.family_name || item.title || item.id)}">Criar cópias em lote</button>
            ${item.user_product_id ? `<button class="ac-btn ac-btn--ghost" type="button" data-own-family-clone="${AC.escapeHtml(item.id)}">Clonar família</button>` : ""}
          </div>
        </div>
      `).join("");
      results.querySelectorAll("[data-own-item]").forEach((button) => button.addEventListener("click", () => resolveOwnItem(button.dataset.ownItem)));
      results.querySelectorAll("[data-own-batch]").forEach((button) => button.addEventListener("click", () => AC.Groups?.openBatchCopy?.({ sourceType: "item", sourceId: button.dataset.ownBatch, label: button.dataset.ownLabel, publicationTarget: "new_item" })));
      results.querySelectorAll("[data-own-family-clone]").forEach((button) => button.addEventListener("click", () => AC.Groups?.openFamilyClone?.(button.dataset.ownFamilyClone)));
    } catch (error) {
      results.innerHTML = `<div class="ac-empty">${AC.escapeHtml(error.message)}</div>`;
    }
  }

  async function bootstrap() {
    try {
      const [caps, listings] = await Promise.all([
        AC.api("/capabilities"),
        AC.api("/listing-types").catch(() => ({ items: [] })),
      ]);
      AC.state.capabilities = caps.capabilities;
      AC.state.listingTypes = listings.items || [];
      const model = caps.capabilities?.user_product_seller ? "User Products" : "Legacy";
      AC.setStatus(`Conta pronta · ${model}`, "ok");
      AC.Editor?.setListingTypes?.(AC.state.listingTypes);
    } catch (error) {
      AC.setStatus(error.message, "error");
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-ac-tab]").forEach((button) => button.addEventListener("click", () => AC.switchTab(button.dataset.acTab)));
    document.querySelectorAll("[data-ac-entry]").forEach((button) => button.addEventListener("click", () => {
      const mode = button.dataset.acEntry;
      if (mode === "blank") createBlank();
      else showSource(mode);
    }));
    document.getElementById("ac-source-close").addEventListener("click", closeSource);
    document.getElementById("ac-own-import").addEventListener("click", () => resolveOwnItem(document.getElementById("ac-own-input").value));
    document.getElementById("ac-own-create-item").addEventListener("click", createResolvedOwnItem);
    document.getElementById("ac-own-create-family").addEventListener("click", cloneResolvedFamily);
    document.getElementById("ac-reference-import").addEventListener("click", () => importItem(document.getElementById("ac-reference-input").value, "external"));
    document.getElementById("ac-own-search-btn").addEventListener("click", searchOwnItems);
    document.getElementById("ac-own-search").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); searchOwnItems(); } });
    document.getElementById("ac-family-import").addEventListener("click", importFamily);
    document.getElementById("ac-editor-back").addEventListener("click", AC.closeEditor);
    document.getElementById("ac-new-draft").addEventListener("click", () => { AC.switchTab("create"); AC.closeEditor(); });
    bootstrap();
  });
})();
