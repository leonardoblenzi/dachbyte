(() => {
  "use strict";
  const AC = window.AnuncioCadastro = window.AnuncioCadastro || {};
  const Drafts = AC.Drafts = {};
  const state = { page: 1, pageSize: 25, total: 0, loading: false, loadedOnce: false, view: "editing" };
  const el = (id) => document.getElementById(id);

  function fmtDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  function params() {
    const p = new URLSearchParams({ page: String(state.page), pageSize: String(state.pageSize), view: state.view });
    const q = el("ac-draft-search").value.trim();
    const status = el("ac-draft-status-filter").value;
    const source = el("ac-draft-source-filter").value;
    const group = el("ac-draft-group-filter").value;
    if (q) p.set("q", q);
    if (status !== "all" && state.view === "editing") p.set("status", status);
    if (source !== "all") p.set("source_type", source);
    if (group) p.set("group_id", group);
    return p;
  }

  function statusChip(item) {
    const tone = AC.statusTone?.(item.status) || "warn";
    return `<span class="ac-state-chip" data-tone="${tone}">${AC.escapeHtml(AC.statusLabel?.(item.status) || item.status)}</span>`;
  }

  function groupChip(item) {
    if (!item.group?.name) return "—";
    return `<span class="ac-group-chip" title="${AC.escapeHtml(item.group.name)}">${AC.escapeHtml(item.group.name)}</span>`;
  }

  function productCell(item) {
    const name = item.family_name || item.title || "Rascunho sem nome";
    const meta = [item.sku ? `SKU ${item.sku}` : null, item.source_item_id || null].filter(Boolean).join(" · ");
    const thumb = item.thumbnail ? `<img src="${AC.escapeHtml(item.thumbnail)}" alt="">` : '<span class="ac-thumb-fallback">ML</span>';
    return `<div class="ac-product-cell">${thumb}<div><strong>${AC.escapeHtml(name)}</strong><small>${AC.escapeHtml(meta || `Rascunho #${item.id}`)}</small></div></div>`;
  }

  function setHead() {
    if (state.view === "published") {
      el("ac-draft-head").innerHTML = "<tr><th>Produto</th><th>MLB</th><th>Publicado</th><th>Origem</th><th>Grupo / família</th><th></th></tr>";
    } else if (state.view === "trash") {
      el("ac-draft-head").innerHTML = "<tr><th>Produto</th><th>Origem</th><th>Grupo</th><th>Excluído</th><th>Situação</th><th></th></tr>";
    } else {
      el("ac-draft-head").innerHTML = "<tr><th>Produto</th><th>Origem</th><th>Grupo</th><th>Alterado</th><th>Situação</th><th></th></tr>";
    }
    el("ac-draft-status-filter").hidden = state.view !== "editing";
  }

  function editingRow(item) {
    return `<tr>
      <td>${productCell(item)}</td>
      <td>${AC.escapeHtml(AC.sourceLabel?.(item.source_type) || item.source_type)}</td>
      <td>${groupChip(item)}</td>
      <td>${fmtDate(item.updated_at)}</td>
      <td>${statusChip(item)}</td>
      <td><div class="ac-row-actions">
        <button class="ac-btn ac-btn--ghost" type="button" data-edit="${item.id}">Editar</button>
        ${item.validation_status === "valid" && item.status === "ready" ? `<button class="ac-btn ac-btn--primary" type="button" data-publish="${item.id}">Publicar</button>` : `<button class="ac-btn ac-btn--ghost" type="button" data-validate="${item.id}">Validar</button>`}
        <button class="ac-btn ac-btn--ghost" type="button" data-duplicate="${item.id}">Duplicar</button>
        <button class="ac-btn ac-btn--ghost" type="button" data-batch="${item.id}" data-batch-label="${AC.escapeHtml(item.family_name || item.title || `Rascunho #${item.id}`)}" data-publication-target="${AC.escapeHtml(item.publication_target || "new_item")}">Criar cópias em lote</button>
        <button class="ac-btn ac-btn--ghost" type="button" data-delete="${item.id}">Excluir</button>
      </div></td>
    </tr>`;
  }

  function publishedRow(item) {
    const family = item.published_family_id || "—";
    const divergence = item.group?.family_divergent
      ? '<span class="ac-family-divergence">Family ID divergente do restante do grupo.</span>' : "";
    return `<tr>
      <td>${productCell(item)}</td>
      <td>${AC.escapeHtml(item.published_item_id || "—")}</td>
      <td>${fmtDate(item.published_at)}</td>
      <td>${AC.escapeHtml(AC.sourceLabel?.(item.source_type) || item.source_type)}</td>
      <td>${groupChip(item)}<small class="ac-product-cell-small">family_id: ${AC.escapeHtml(family)}</small>${divergence}</td>
      <td><div class="ac-row-actions">${item.published_permalink ? `<a class="ac-btn ac-btn--ghost" href="${AC.escapeHtml(item.published_permalink)}" target="_blank" rel="noopener">Abrir no ML</a>` : ""}</div></td>
    </tr>`;
  }

  function trashRow(item) {
    return `<tr>
      <td>${productCell(item)}</td>
      <td>${AC.escapeHtml(AC.sourceLabel?.(item.source_type) || item.source_type)}</td>
      <td>${groupChip(item)}</td>
      <td>${fmtDate(item.deleted_at)}</td>
      <td>${statusChip(item)}</td>
      <td><div class="ac-row-actions"><button class="ac-btn ac-btn--ghost" type="button" data-restore="${item.id}">Restaurar</button></div></td>
    </tr>`;
  }

  function bindActions(body) {
    body.querySelectorAll("[data-edit]").forEach((button) => button.addEventListener("click", () => open(Number(button.dataset.edit))));
    body.querySelectorAll("[data-duplicate]").forEach((button) => button.addEventListener("click", () => duplicate(Number(button.dataset.duplicate))));
    body.querySelectorAll("[data-batch]").forEach((button) => button.addEventListener("click", () => AC.Groups?.openBatchCopy?.({
      sourceType: "draft", sourceId: Number(button.dataset.batch), label: button.dataset.batchLabel, publicationTarget: button.dataset.publicationTarget,
    })));
    body.querySelectorAll("[data-validate]").forEach((button) => button.addEventListener("click", () => validate(Number(button.dataset.validate))));
    body.querySelectorAll("[data-publish]").forEach((button) => button.addEventListener("click", () => publish(Number(button.dataset.publish))));
    body.querySelectorAll("[data-delete]").forEach((button) => button.addEventListener("click", () => remove(Number(button.dataset.delete))));
    body.querySelectorAll("[data-restore]").forEach((button) => button.addEventListener("click", () => restore(Number(button.dataset.restore))));
  }

  function render(items) {
    setHead();
    const body = el("ac-draft-body");
    if (!items.length) {
      const empty = state.view === "published" ? "Nenhum anúncio publicado nos últimos 30 dias." : state.view === "trash" ? "A lixeira está vazia." : "Nenhum rascunho em edição encontrado.";
      body.innerHTML = `<tr><td colspan="6" class="ac-empty">${empty}</td></tr>`;
      return;
    }
    body.innerHTML = items.map((item) => state.view === "published" ? publishedRow(item) : state.view === "trash" ? trashRow(item) : editingRow(item)).join("");
    bindActions(body);
  }

  async function open(id) {
    AC.setStatus("Abrindo rascunho...", "info");
    try {
      const payload = await AC.api(`/drafts/${id}`);
      await AC.openDraft(payload.draft);
      AC.setStatus("Rascunho carregado.", "ok");
    } catch (error) { AC.setStatus(error.message, "error"); }
  }

  async function duplicate(id) {
    AC.setStatus("Duplicando rascunho...", "info");
    try {
      const payload = await AC.api(`/drafts/${id}/duplicate`, { method: "POST" });
      AC.setStatus("Cópia criada como novo rascunho.", "ok");
      await AC.openDraft(payload.draft);
    } catch (error) { AC.setStatus(error.message, "error"); }
  }

  async function validate(id) {
    AC.setStatus("Validando rascunho no Mercado Livre...", "info");
    try {
      const payload = await AC.api(`/drafts/${id}/validate`, { method: "POST" });
      AC.setStatus(payload.valid ? "Rascunho validado e pronto para publicar." : "O rascunho possui pendências.", payload.valid ? "ok" : "error");
      await Drafts.load(true);
    } catch (error) {
      const count = error.payload?.errors?.length || 0;
      AC.setStatus(count ? `O rascunho possui ${count} pendência(s). Abra para corrigir.` : error.message, "error");
      await Drafts.load(true);
    }
  }

  async function publish(id) {
    if (!window.confirm("Publicar este rascunho no Mercado Livre agora?")) return;
    AC.setStatus("Publicando anúncio...", "info");
    try {
      const payload = await AC.api(`/drafts/${id}/publish`, { method: "POST" });
      const divergent = payload.group_integrity?.divergent ? " Atenção: o family_id ficou diferente do restante do grupo." : "";
      AC.setStatus(`Publicado com sucesso: ${payload.item_id}.${divergent}`, divergent ? "info" : "ok");
      await Drafts.load(true);
    } catch (error) {
      AC.setStatus(error.message, "error");
      await Drafts.load(true);
    }
  }

  async function remove(id) {
    if (!window.confirm("Enviar este rascunho para a lixeira? Ele poderá ser restaurado por até 30 dias.")) return;
    try {
      await AC.api(`/drafts/${id}`, { method: "DELETE" });
      AC.setStatus("Rascunho enviado para a lixeira.", "ok");
      await Drafts.load(true);
      await loadGroups();
    } catch (error) { AC.setStatus(error.message, "error"); }
  }

  async function restore(id) {
    try {
      await AC.api(`/drafts/${id}/restore`, { method: "POST" });
      AC.setStatus("Rascunho restaurado para Em edição.", "ok");
      await Drafts.load(true);
    } catch (error) { AC.setStatus(error.message, "error"); }
  }

  async function loadGroups() {
    const select = el("ac-draft-group-filter");
    const current = select.value;
    try {
      const payload = await AC.api("/groups");
      select.innerHTML = '<option value="">Todos os grupos</option>' + (payload.items || []).map((group) => `<option value="${group.id}">${AC.escapeHtml(group.name)} · ${group.draft_count} item(ns)</option>`).join("");
      if ([...select.options].some((option) => option.value === current)) select.value = current;
    } catch (_) {}
  }

  Drafts.setView = async (view) => {
    state.view = ["editing", "published", "trash"].includes(view) ? view : "editing";
    state.page = 1;
    document.querySelectorAll("[data-ac-draft-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.acDraftView === state.view));
    setHead();
    await Drafts.load(true);
  };

  Drafts.showGroup = async (groupId) => {
    await loadGroups();
    await Drafts.setView("editing");
    if (groupId && [...el("ac-draft-group-filter").options].some((option) => option.value === String(groupId))) {
      el("ac-draft-group-filter").value = String(groupId);
      state.page = 1;
      await Drafts.load(true);
    }
  };

  Drafts.load = async (force = false) => {
    if (state.loading || (!force && state.loadedOnce && AC.state.activeTab !== "drafts")) return;
    state.loading = true;
    setHead();
    el("ac-draft-body").innerHTML = '<tr><td colspan="6" class="ac-empty">Carregando...</td></tr>';
    try {
      const payload = await AC.api(`/drafts?${params().toString()}`);
      state.total = payload.paging?.total || 0;
      state.loadedOnce = true;
      render(payload.items || []);
      const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
      el("ac-draft-page-label").textContent = `Página ${state.page} de ${totalPages} · ${state.total} item(ns)`;
      el("ac-draft-prev").disabled = state.page <= 1;
      el("ac-draft-next").disabled = state.page >= totalPages;
    } catch (error) {
      el("ac-draft-body").innerHTML = `<tr><td colspan="6" class="ac-empty">${AC.escapeHtml(error.message)}</td></tr>`;
    } finally { state.loading = false; }
  };

  function filtersChanged() { state.page = 1; Drafts.load(true); }

  document.addEventListener("DOMContentLoaded", () => {
    let searchTimer;
    document.querySelectorAll("[data-ac-draft-view]").forEach((button) => button.addEventListener("click", () => Drafts.setView(button.dataset.acDraftView)));
    el("ac-draft-search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(filtersChanged, 350); });
    el("ac-draft-status-filter").addEventListener("change", filtersChanged);
    el("ac-draft-source-filter").addEventListener("change", filtersChanged);
    el("ac-draft-group-filter").addEventListener("change", filtersChanged);
    el("ac-draft-refresh").addEventListener("click", async () => { await loadGroups(); await Drafts.load(true); });
    el("ac-draft-prev").addEventListener("click", () => { if (state.page > 1) { state.page -= 1; Drafts.load(true); } });
    el("ac-draft-next").addEventListener("click", () => { if (state.page * state.pageSize < state.total) { state.page += 1; Drafts.load(true); } });
    loadGroups();
  });
})();
