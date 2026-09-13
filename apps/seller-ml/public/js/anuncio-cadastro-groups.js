(() => {
  "use strict";
  const AC = window.AnuncioCadastro = window.AnuncioCadastro || {};
  const Groups = AC.Groups = {};
  const state = { batch: null, family: null, familySourceItemId: null };
  const el = (id) => document.getElementById(id);

  function stamp() {
    return new Date().toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  function showModal(id) {
    const node = el(id);
    if (!node) return;
    node.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function hideModal(id) {
    const node = el(id);
    if (!node) return;
    node.hidden = true;
    if (el("ac-batch-modal")?.hidden && el("ac-family-modal")?.hidden) document.body.style.overflow = "";
  }

  Groups.openBatchCopy = ({ sourceType, sourceId, label, publicationTarget } = {}) => {
    if (!sourceType || !sourceId) return AC.setStatus("Origem inválida para criar cópias em lote.", "error");
    state.batch = { sourceType, sourceId, label: label || "anúncio", publicationTarget: publicationTarget || "new_item" };
    el("ac-batch-source-label").textContent = `${sourceType === "draft" ? "Rascunho" : "Anúncio publicado"} · ${state.batch.label}`;
    el("ac-batch-quantity").value = "1";
    el("ac-batch-name").value = `Cópias de ${state.batch.label} · ${stamp()}`.slice(0, 240);
    el("ac-batch-sale-condition-warning").hidden = state.batch.publicationTarget !== "sale_condition";
    showModal("ac-batch-modal");
    setTimeout(() => el("ac-batch-quantity")?.focus(), 30);
  };

  async function createBatch() {
    if (!state.batch) return;
    const quantity = Number(el("ac-batch-quantity").value);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
      return AC.setStatus("Informe uma quantidade entre 1 e 10.", "error");
    }
    const button = el("ac-batch-create");
    button.disabled = true;
    AC.setStatus("Criando grupo e rascunhos...", "info");
    try {
      const payload = await AC.api("/groups/batch-copy", {
        method: "POST",
        body: {
          source_type: state.batch.sourceType,
          source_id: state.batch.sourceId,
          quantity,
          name: el("ac-batch-name").value.trim(),
        },
      });
      hideModal("ac-batch-modal");
      AC.setStatus(`${payload.drafts?.length || quantity} cópia(s) criada(s) como rascunhos independentes.`, "ok");
      AC.switchTab("drafts");
      await AC.Drafts?.showGroup?.(payload.group?.id);
    } catch (error) {
      AC.setStatus(error.message, "error");
    } finally {
      button.disabled = false;
    }
  }

  function money(value, currency = "BRL") {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    try { return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(number); }
    catch (_) { return String(number); }
  }

  function conditionOptions(variation) {
    const conditions = variation.conditions || [];
    if (!conditions.length) return '<option value="">Nenhuma condição encontrada</option>';
    const requireChoice = Boolean(variation.requires_condition_choice);
    const first = requireChoice ? '<option value="">Escolha uma condição ativa</option>' : "";
    return first + conditions.map((condition) => {
      const selected = !requireChoice && variation.selected_condition_item_id === condition.item_id ? "selected" : "";
      const status = condition.status === "active" ? "ativa" : (condition.status || "status desconhecido");
      return `<option value="${AC.escapeHtml(condition.item_id)}" ${selected}>${AC.escapeHtml(condition.item_id)} · ${AC.escapeHtml(status)} · ${AC.escapeHtml(money(condition.price, condition.currency_id || variation.currency_id))}</option>`;
    }).join("");
  }

  function selectedFamilyRows() {
    if (!state.family) return [];
    return [...document.querySelectorAll("[data-ac-family-select]:checked")].map((checkbox) => {
      const upId = checkbox.dataset.acFamilySelect;
      const variation = state.family.variations.find((row) => row.user_product_id === upId);
      const select = document.querySelector(`[data-ac-family-condition="${CSS.escape(upId)}"]`);
      return { variation, user_product_id: upId, source_item_id: select?.value || variation?.selected_condition_item_id || "" };
    });
  }

  function refreshFamilySelection() {
    const selected = selectedFamilyRows();
    const count = selected.length;
    el("ac-family-count").textContent = `${count} selecionada(s) · máximo 10 nesta ação`;
    document.querySelectorAll("[data-ac-family-select]").forEach((checkbox) => {
      checkbox.disabled = count >= 10 && !checkbox.checked;
    });
    const hasMissingCondition = selected.some((row) => !row.source_item_id);
    el("ac-family-clone-create").disabled = count < 1 || count > 10 || hasMissingCondition;
  }

  function renderFamily(family) {
    state.family = family;
    el("ac-family-modal-subtitle").textContent = `${family.family_name || "Família"} · ${family.total_variations} variação(ões) encontrada(s)`;
    el("ac-family-group-name").value = `Clonagem de ${family.family_name || family.source_family_id} · ${stamp()}`.slice(0, 240);
    const body = el("ac-family-body");
    body.innerHTML = (family.variations || []).map((variation) => {
      const img = variation.image ? `<img src="${AC.escapeHtml(variation.image)}" alt="">` : '<span class="ac-thumb-fallback">ML</span>';
      const childSummary = (variation.dimensions || []).map((attr) => `${attr.name || attr.id}: ${attr.value_name || "—"}`).join(" · ");
      return `<tr>
        <td><input type="checkbox" data-ac-family-select="${AC.escapeHtml(variation.user_product_id)}"></td>
        <td><div class="ac-family-variant">${img}<div><strong>${AC.escapeHtml(variation.name || variation.user_product_id)}</strong><small>${AC.escapeHtml(variation.user_product_id)}${childSummary ? ` · ${AC.escapeHtml(childSummary)}` : ""}</small></div></div></td>
        <td>${AC.escapeHtml(variation.color || "—")}</td>
        <td>${AC.escapeHtml(variation.measure || "—")}</td>
        <td>${AC.escapeHtml(variation.sku || "—")}</td>
        <td>${AC.escapeHtml(money(variation.price, variation.currency_id))}</td>
        <td><select class="ac-input ac-condition-select" data-ac-family-condition="${AC.escapeHtml(variation.user_product_id)}">${conditionOptions(variation)}</select>${variation.requires_condition_choice ? '<span class="ac-condition-required">Há mais de uma condição ativa. Escolha a origem.</span>' : ""}</td>
      </tr>`;
    }).join("") || '<tr><td colspan="7" class="ac-empty">Nenhuma variação disponível.</td></tr>';
    body.querySelectorAll("[data-ac-family-select]").forEach((node) => node.addEventListener("change", refreshFamilySelection));
    body.querySelectorAll("[data-ac-family-condition]").forEach((node) => node.addEventListener("change", refreshFamilySelection));
    el("ac-family-loading").hidden = true;
    el("ac-family-content").hidden = false;
    refreshFamilySelection();
  }

  Groups.openFamilyClone = async (itemId) => {
    if (!itemId) return AC.setStatus("Informe um MLB próprio para clonar a família.", "error");
    state.family = null;
    state.familySourceItemId = itemId;
    el("ac-family-loading").hidden = false;
    el("ac-family-loading").textContent = "Consultando User Products e condições de venda...";
    el("ac-family-content").hidden = true;
    el("ac-family-clone-create").disabled = true;
    showModal("ac-family-modal");
    AC.setStatus("Descobrindo família pelo MLB...", "info");
    try {
      const payload = await AC.api("/family-clone/preview", { method: "POST", body: { input: itemId } });
      renderFamily(payload.family);
      AC.setStatus("Família encontrada. Selecione até 10 variações para criar novos rascunhos.", "ok");
    } catch (error) {
      el("ac-family-loading").textContent = error.message;
      AC.setStatus(error.message, "error");
    }
  };

  async function createFamilyClone() {
    const selected = selectedFamilyRows();
    if (!selected.length || selected.length > 10) return AC.setStatus("Selecione entre 1 e 10 variações.", "error");
    const missing = selected.find((row) => !row.source_item_id);
    if (missing) return AC.setStatus("Escolha a condição de venda de origem das variações marcadas.", "error");
    const button = el("ac-family-clone-create");
    button.disabled = true;
    AC.setStatus("Criando grupo e rascunhos da família...", "info");
    try {
      const payload = await AC.api("/family-clone", {
        method: "POST",
        body: {
          source_item_id: state.familySourceItemId,
          name: el("ac-family-group-name").value.trim(),
          selected: selected.map((row) => ({ user_product_id: row.user_product_id, source_item_id: row.source_item_id })),
        },
      });
      hideModal("ac-family-modal");
      AC.setStatus(`${payload.drafts?.length || selected.length} rascunho(s) new_item criado(s) para a clonagem da família.`, "ok");
      AC.switchTab("drafts");
      await AC.Drafts?.showGroup?.(payload.group?.id);
    } catch (error) {
      AC.setStatus(error.message, "error");
      refreshFamilySelection();
    } finally {
      button.disabled = false;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll('[data-ac-modal-close="batch"]').forEach((button) => button.addEventListener("click", () => hideModal("ac-batch-modal")));
    document.querySelectorAll('[data-ac-modal-close="family"]').forEach((button) => button.addEventListener("click", () => hideModal("ac-family-modal")));
    el("ac-batch-create")?.addEventListener("click", createBatch);
    el("ac-family-clone-create")?.addEventListener("click", createFamilyClone);
    for (const id of ["ac-batch-modal", "ac-family-modal"]) {
      el(id)?.addEventListener("click", (event) => { if (event.target === el(id)) hideModal(id); });
    }
  });
})();
