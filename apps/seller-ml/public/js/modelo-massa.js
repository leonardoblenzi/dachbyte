(function () {
  "use strict";

  const state = {
    rows: [],
    filtered: [],
    selected: new Set(),
    page: 1,
    pageSize: 20,
    loading: false,
    currentJobId: null,
    jobsTimer: null,
    jobsPanelTimer: null,
    defaultModels: [],
    defaultModelsLoading: false,
    editingDefaultModelId: null,
    editingDefaultValue: null,
  };

  const $ = (selector) => document.querySelector(selector);
  const tableBody = () => $("#tableBody");
  const pagination = () => $("#pagination");

  function normalizePanelJobText(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function readShellAccountLabel() {
    const raw = String(document.getElementById("account-current")?.textContent || "").trim();
    if (!raw) return "";
    if (/carregando|indispon|nao selecionada|nenhuma selecionada/i.test(raw)) return "";
    return raw;
  }

  function isTerminalJobStateText(value) {
    const status = normalizePanelJobText(value);
    return (
      /^conclu/.test(status) ||
      /^finaliz/.test(status) ||
      /^completed$/.test(status) ||
      /^done$/.test(status) ||
      /^success/.test(status) ||
      /^sucesso/.test(status) ||
      /^cancel/.test(status) ||
      /^abort/.test(status) ||
      /^falh/.test(status) ||
      /^failed/.test(status) ||
      /^error$/.test(status) ||
      /^erro$/.test(status) ||
      /^erro ao iniciar/.test(status)
    );
  }

  function looksLikeModeloMassaJob(job) {
    const adapter = normalizePanelJobText(job?.adapter || job?.module || "");
    const id = normalizePanelJobText(job?.job_uid || job?.id || "");
    if (adapter === "modelo-massa" || id.startsWith("modelo-massa:")) return true;
    const title = normalizePanelJobText(job?.title || "");
    return title.includes("modelo");
  }

  function applyModeloMassaPanelVisibilityFilter() {
    window.JobsPanel?.setAdapter?.("modelo-massa");
    window.JobsPanel?.setVisibilityFilter?.((job) => looksLikeModeloMassaJob(job));
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[char]);
  }

  function normalizeIds(text) {
    return Array.from(
      new Set(
        String(text || "")
          .split(/[\s,;]+/)
          .map((value) => value.trim().toUpperCase())
          .filter((value) => /^MLB\d{6,}$/.test(value)),
      ),
    );
  }

  function currentTargetModel() {
    return String($("#targetModel")?.value || "").trim();
  }

  function normalizeDefaultModelKey(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function updateTargetModelHint() {
    const host = $("#targetModelHint");
    if (!host) return;

    const rawValue = String($("#targetModel")?.value || "");
    const length = rawValue.trim().length;

    host.textContent = length
      ? `${length} caractere(s) digitado(s). O limite oficial varia por categoria e sera validado na analise.`
      : "O limite real depende da categoria de cada anuncio no Mercado Livre.";
  }

  function currentDryRun() {
    return Boolean($("#dryRun")?.checked);
  }

  function setTargetModel(value) {
    const input = $("#targetModel");
    if (!input) return;
    input.value = String(value || "").trim();
    updateTargetModelHint();
    input.focus();
  }

  function currentFilterType() {
    return String($("#filterType")?.value || "all");
  }

  function renderSummary(type = "info", message = "Aguardando analise do lote.") {
    $("#applySummary").className = `apply-summary apply-summary--${type}`;
    $("#applySummary").textContent = message;
  }

  function summarizeResultReason(result) {
    const details = result?.details || {};
    const causes = Array.isArray(details?.cause) ? details.cause : [];
    const firstCause = causes[0] || null;

    if (result?.user_product_conflict_id || result?.status === "manual") {
      return result?.reason || firstCause?.message || details?.message || "-";
    }
    if (firstCause?.message) return firstCause.message;
    if (details?.message) return details.message;
    if (result?.reason) return result.reason;
    return "-";
  }

  function renderResults(results) {
    const host = $("#applyResults");
    host.innerHTML = "";

    for (const result of results || []) {
      const item = document.createElement("div");
      item.className = `result-item result-item--${result.status || "skipped"}`;
      item.innerHTML = `
        <strong>${escapeHtml(result.id)}</strong>
        <span>${escapeHtml(summarizeResultReason(result))}</span>
      `;
      host.appendChild(item);
    }
  }

  function updateStats() {
    const eligible = state.rows.filter((row) => row.can_apply).length;
    const catalog = state.rows.filter((row) => row.listing_type === "catalogo").length;
    const blocked = state.rows.filter((row) => !row.can_apply && row.listing_type !== "catalogo").length;
    const selectedEligible = state.filtered.filter(
      (row) => row.can_apply && state.selected.has(row.id),
    ).length;

    $("#statTotal").textContent = String(state.rows.length);
    $("#statEligible").textContent = String(eligible);
    $("#statCatalog").textContent = String(catalog);
    $("#statBlocked").textContent = String(blocked);

    $("#btnApplyEligible").disabled = eligible === 0 || state.loading;
    $("#btnSelectEligible").disabled = eligible === 0 || state.loading;
    $("#btnApplySelected").disabled = selectedEligible === 0 || state.loading;
    $("#checkPage").checked = false;
  }

  function currentPageRows() {
    const start = (state.page - 1) * state.pageSize;
    return state.filtered.slice(start, start + state.pageSize);
  }

  function renderPagination() {
    const host = pagination();
    host.innerHTML = "";

    const totalPages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
    for (let page = 1; page <= totalPages; page += 1) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `page-btn${page === state.page ? " active" : ""}`;
      button.textContent = String(page);
      button.addEventListener("click", () => {
        state.page = page;
        renderTable();
      });
      host.appendChild(button);
    }
  }

  function pillForAction(row) {
    if (row.can_apply) return '<span class="pill-status ready">Aplicar</span>';
    if (row.listing_type === "catalogo") {
      return '<span class="pill-status manual">Manual</span>';
    }
    if (row.status === "nao_encontrado") {
      return '<span class="pill-status blocked">Nao encontrado</span>';
    }
    return '<span class="pill-status warning">Revisar</span>';
  }

  function renderTable() {
    const rows = currentPageRows();
    const tbody = tableBody();
    tbody.innerHTML = "";

    if (!rows.length) {
      tbody.innerHTML =
        '<tr><td colspan="9" class="empty-row">Nenhum anúncio corresponde aos filtros atuais.</td></tr>';
      $("#tableInfo").textContent = "0 resultados";
      renderPagination();
      updateStats();
      return;
    }

    for (const row of rows) {
      const tr = document.createElement("tr");
      const disabled = row.can_apply ? "" : "disabled";
      tr.innerHTML = `
        <td><input type="checkbox" data-id="${escapeHtml(row.id)}" ${state.selected.has(row.id) ? "checked" : ""} ${disabled}></td>
        <td><a href="${escapeHtml(row.permalink || "#")}" target="_blank" rel="noreferrer">${escapeHtml(row.id)}</a></td>
        <td>${escapeHtml(row.title || "-")}</td>
        <td><span class="pill-type ${escapeHtml(row.listing_type || "normal")}">${escapeHtml(row.listing_type || "normal")}</span></td>
        <td>${escapeHtml(row.status || "-")}</td>
        <td>${escapeHtml(row.current_model || "-")}</td>
        <td>${escapeHtml(row.target_model || "-")}</td>
        <td>${pillForAction(row)}</td>
        <td><div class="reason">${escapeHtml(row.reason || "-")}</div></td>
      `;

      const checkbox = tr.querySelector('input[type="checkbox"]');
      checkbox?.addEventListener("change", () => {
        if (checkbox.checked) state.selected.add(row.id);
        else state.selected.delete(row.id);
        updateStats();
      });

      tbody.appendChild(tr);
    }

    $("#tableInfo").textContent = `${state.filtered.length} resultado(s) • pagina ${state.page}`;
    renderPagination();
    updateStats();
  }

  function applyFilters() {
    const search = String($("#searchInput")?.value || "").trim().toLowerCase();
    const filterType = currentFilterType();

    state.filtered = state.rows.filter((row) => {
      if (filterType === "eligible" && !row.can_apply) return false;
      if (filterType === "catalog" && row.listing_type !== "catalogo") return false;
      if (filterType === "blocked" && (row.can_apply || row.listing_type === "catalogo")) return false;

      if (!search) return true;

      return [
        row.id,
        row.title,
        row.seller_custom_field,
        row.reason,
        row.current_model,
        row.target_model,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(search));
    });

    const totalPages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
    if (state.page > totalPages) state.page = totalPages;

    renderTable();
  }

  async function fetchJson(url, init) {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.headers || {}),
      },
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.success === false) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    return payload;
  }

  function filteredDefaultModels(searchValue) {
    const term = normalizeDefaultModelKey(searchValue);
    if (!term) return state.defaultModels;
    return state.defaultModels.filter((item) => {
      if (normalizeDefaultModelKey(item?.modelo).includes(term)) return true;
      return (Array.isArray(item?.valores) ? item.valores : []).some((value) =>
        normalizeDefaultModelKey(value?.valor).includes(term),
      );
    });
  }

  function renderDefaultModelsList() {
    const host = $("#defaultModelsList");
    if (!host) return;

    if (state.defaultModelsLoading) {
      host.innerHTML = '<span class="small-muted">Carregando modelos padrao...</span>';
      return;
    }

    const rows = filteredDefaultModels($("#defaultModelSearch")?.value || "").slice(0, 16);
    if (!rows.length) {
      host.innerHTML = '<span class="small-muted">Nenhum modelo padrao encontrado.</span>';
      return;
    }

    host.innerHTML = "";
    for (const item of rows) {
      const group = document.createElement("div");
      group.className = "modelo-padrao-group";
      const values = Array.isArray(item.valores) ? item.valores : [];
      group.innerHTML = `<strong>${escapeHtml(item.modelo)}</strong>`;

      const chips = document.createElement("div");
      chips.className = "modelo-padrao-group__chips";

      if (!values.length) {
        chips.innerHTML = '<span class="small-muted">Sem valores cadastrados.</span>';
      } else {
        for (const value of values) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "modelo-padrao-chip";
          button.textContent = value.valor;
          button.title = "Usar este valor no campo modelo";
          button.addEventListener("click", () => setTargetModel(value.valor));
          chips.appendChild(button);
        }
      }

      group.appendChild(chips);
      host.appendChild(group);
    }
  }

  function renderDefaultModelManager() {
    const host = $("#defaultModelManagerList");
    if (!host) return;

    const rows = filteredDefaultModels($("#defaultModelManagerSearch")?.value || "");
    if (!rows.length) {
      host.innerHTML = '<div class="empty-row">Nenhum modelo padrao cadastrado.</div>';
      return;
    }

    host.innerHTML = "";
    for (const item of rows) {
      const row = document.createElement("div");
      row.className = "modelo-manager-item";
      row.innerHTML = `
        <div class="modelo-manager-item__main">
          <div>
            <strong>${escapeHtml(item.modelo)}</strong>
            <span>${escapeHtml(item.criado_por_nome ? `Criado por ${item.criado_por_nome}` : "Grupo compartilhado")}</span>
          </div>
          <div class="modelo-manager-actions">
            <button class="btn-secondary btn-compact" type="button" data-action="edit">Editar grupo</button>
            <button class="btn-ghost btn-compact" type="button" data-action="delete">Remover grupo</button>
          </div>
        </div>
        <form class="modelo-value-form" data-group-id="${escapeHtml(item.id)}">
          <input type="text" maxlength="120" placeholder="Adicionar valor dentro de ${escapeHtml(item.modelo)}" />
          <button class="btn-primary btn-compact" type="submit">Adicionar valor</button>
        </form>
        <div class="modelo-value-list">
          ${(Array.isArray(item.valores) && item.valores.length)
            ? item.valores.map((value) => `
                <div class="modelo-value-item" data-value-id="${escapeHtml(value.id)}">
                  <button class="modelo-padrao-chip" type="button" data-action="use">${escapeHtml(value.valor)}</button>
                  <div class="modelo-manager-actions">
                    <button class="btn-secondary btn-compact" type="button" data-action="edit-value">Editar</button>
                    <button class="btn-ghost btn-compact" type="button" data-action="delete-value">Remover</button>
                  </div>
                </div>
              `).join("")
            : '<span class="small-muted">Nenhum valor cadastrado dentro deste grupo.</span>'}
        </div>
      `;

      row.querySelector('[data-action="edit"]')?.addEventListener("click", () => {
        state.editingDefaultModelId = item.id;
        $("#defaultModelInput").value = item.modelo;
        $("#btnSubmitDefaultModel").textContent = "Salvar grupo";
        $("#defaultModelInput").focus();
      });

      row.querySelector('[data-action="delete"]')?.addEventListener("click", async () => {
        if (!window.confirm(`Remover o grupo "${item.modelo}" e seus valores?`)) return;
        await deleteDefaultModel(item.id);
      });

      row.querySelector(".modelo-value-form")?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const input = event.currentTarget.querySelector("input");
        await saveDefaultValue(item.id, input?.value || "");
        if (input) input.value = "";
      });

      row.querySelectorAll(".modelo-value-item").forEach((valueRow) => {
        const valueId = valueRow.getAttribute("data-value-id");
        const value = (Array.isArray(item.valores) ? item.valores : []).find(
          (entry) => String(entry.id) === String(valueId),
        );
        if (!value) return;

        valueRow.querySelector('[data-action="use"]')?.addEventListener("click", () => setTargetModel(value.valor));
        valueRow.querySelector('[data-action="edit-value"]')?.addEventListener("click", async () => {
          const nextValue = window.prompt("Editar valor do modelo padrao:", value.valor);
          if (nextValue == null) return;
          await updateDefaultValue(item.id, value.id, nextValue);
        });
        valueRow.querySelector('[data-action="delete-value"]')?.addEventListener("click", async () => {
          if (!window.confirm(`Remover o valor "${value.valor}"?`)) return;
          await deleteDefaultValue(item.id, value.id);
        });
      });

      host.appendChild(row);
    }
  }

  function renderDefaultModels() {
    renderDefaultModelsList();
    renderDefaultModelManager();
  }

  function setDefaultModelStatus(message, type = "info") {
    const host = $("#defaultModelStatus");
    if (!host) return;
    host.className = `small-muted default-model-status default-model-status--${type}`;
    host.textContent = message || "";
  }

  async function loadDefaultModels() {
    state.defaultModelsLoading = true;
    renderDefaultModels();
    try {
      const payload = await fetchJson(mlUrl("/api/modelo-massa/padroes"));
      state.defaultModels = Array.isArray(payload?.modelos) ? payload.modelos : [];
      setDefaultModelStatus("");
    } catch (error) {
      setDefaultModelStatus(`Falha ao carregar modelos padrao: ${error.message}`, "error");
    } finally {
      state.defaultModelsLoading = false;
      renderDefaultModels();
    }
  }

  async function saveDefaultModel(modelValue, { updateTarget = false } = {}) {
    const modelo = String(modelValue || "").replace(/\s+/g, " ").trim();
    if (!modelo) {
      setDefaultModelStatus("Informe um modelo padrao para salvar.", "error");
      renderSummary("error", "Informe um modelo antes de salvar como padrao.");
      return;
    }

    const editingId = state.editingDefaultModelId;
    const url = editingId
      ? mlUrl(`/api/modelo-massa/padroes/${encodeURIComponent(editingId)}`)
      : mlUrl("/api/modelo-massa/padroes");

    try {
      const payload = await fetchJson(url, {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelo }),
      });

      const saved = payload?.modelo || null;
      if (saved) {
        if (!Array.isArray(saved.valores)) saved.valores = [];
        const index = state.defaultModels.findIndex((item) => String(item.id) === String(saved.id));
        if (index >= 0) state.defaultModels[index] = saved;
        else state.defaultModels.push(saved);
        state.defaultModels.sort((a, b) => String(a.modelo || "").localeCompare(String(b.modelo || ""), "pt-BR"));
      }

      if (updateTarget) setTargetModel(modelo);
      state.editingDefaultModelId = null;
      $("#defaultModelInput").value = "";
      $("#btnSubmitDefaultModel").textContent = "Adicionar grupo";
      setDefaultModelStatus("Modelo padrao salvo.", "success");
      renderDefaultModels();
    } catch (error) {
      setDefaultModelStatus(error.message, "error");
      renderSummary("error", error.message);
    }
  }

  function upsertDefaultValue(groupId, value) {
    const group = state.defaultModels.find((item) => String(item.id) === String(groupId));
    if (!group || !value) return;
    if (!Array.isArray(group.valores)) group.valores = [];
    const index = group.valores.findIndex((item) => String(item.id) === String(value.id));
    if (index >= 0) group.valores[index] = value;
    else group.valores.push(value);
    group.valores.sort((a, b) => String(a.valor || "").localeCompare(String(b.valor || ""), "pt-BR"));
  }

  async function saveDefaultValue(groupId, valueText) {
    const valor = String(valueText || "").replace(/\s+/g, " ").trim();
    if (!valor) {
      setDefaultModelStatus("Informe um valor para cadastrar dentro do grupo.", "error");
      return;
    }

    try {
      const payload = await fetchJson(mlUrl(`/api/modelo-massa/padroes/${encodeURIComponent(groupId)}/valores`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ valor }),
      });
      upsertDefaultValue(groupId, payload?.valor || null);
      setDefaultModelStatus("Valor cadastrado dentro do modelo padrao.", "success");
      renderDefaultModels();
    } catch (error) {
      setDefaultModelStatus(error.message, "error");
    }
  }

  async function updateDefaultValue(groupId, valueId, valueText) {
    const valor = String(valueText || "").replace(/\s+/g, " ").trim();
    if (!valor) {
      setDefaultModelStatus("Informe um valor valido.", "error");
      return;
    }

    try {
      const payload = await fetchJson(
        mlUrl(`/api/modelo-massa/padroes/${encodeURIComponent(groupId)}/valores/${encodeURIComponent(valueId)}`),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ valor }),
        },
      );
      upsertDefaultValue(groupId, payload?.valor || null);
      setDefaultModelStatus("Valor atualizado.", "success");
      renderDefaultModels();
    } catch (error) {
      setDefaultModelStatus(error.message, "error");
    }
  }

  async function deleteDefaultValue(groupId, valueId) {
    try {
      await fetchJson(
        mlUrl(`/api/modelo-massa/padroes/${encodeURIComponent(groupId)}/valores/${encodeURIComponent(valueId)}`),
        { method: "DELETE" },
      );
      const group = state.defaultModels.find((item) => String(item.id) === String(groupId));
      if (group && Array.isArray(group.valores)) {
        group.valores = group.valores.filter((item) => String(item.id) !== String(valueId));
      }
      setDefaultModelStatus("Valor removido.", "success");
      renderDefaultModels();
    } catch (error) {
      setDefaultModelStatus(error.message, "error");
    }
  }

  async function deleteDefaultModel(id) {
    try {
      await fetchJson(mlUrl(`/api/modelo-massa/padroes/${encodeURIComponent(id)}`), {
        method: "DELETE",
      });
      state.defaultModels = state.defaultModels.filter((item) => String(item.id) !== String(id));
      if (String(state.editingDefaultModelId) === String(id)) {
        state.editingDefaultModelId = null;
        $("#defaultModelInput").value = "";
        $("#btnSubmitDefaultModel").textContent = "Adicionar grupo";
      }
      setDefaultModelStatus("Modelo padrao removido.", "success");
      renderDefaultModels();
    } catch (error) {
      setDefaultModelStatus(error.message, "error");
    }
  }

  function openDefaultModelsModal() {
    const modal = $("#defaultModelsModal");
    if (!modal) return;
    modal.classList.add("active");
    modal.setAttribute("aria-hidden", "false");
    $("#defaultModelInput")?.focus();
    renderDefaultModelManager();
  }

  function closeDefaultModelsModal() {
    const modal = $("#defaultModelsModal");
    if (!modal) return;
    modal.classList.remove("active");
    modal.setAttribute("aria-hidden", "true");
    state.editingDefaultModelId = null;
    $("#defaultModelInput").value = "";
    $("#btnSubmitDefaultModel").textContent = "Adicionar grupo";
  }

  function setLoading(loading, message) {
    state.loading = loading;
    $("#btnAnalyze").disabled = loading;
    $("#btnApplyEligible").disabled = loading || state.rows.every((row) => !row.can_apply);
    $("#btnApplySelected").disabled = loading || !state.filtered.some((row) => row.can_apply && state.selected.has(row.id));
    $("#analysisStatus").textContent = message || (loading ? "Processando..." : "Pronto.");
    updateStats();
  }

  async function analyzeBatch() {
    const ids = normalizeIds($("#itemIds")?.value || "");
    const targetModel = currentTargetModel();

    if (!targetModel) {
      renderSummary("error", "Informe o valor do campo modelo antes de analisar.");
      return;
    }

    if (!ids.length) {
      renderSummary("error", "Cole pelo menos um MLB valido para analisar.");
      return;
    }

    state.rows = [];
    state.filtered = [];
    state.selected.clear();
    state.page = 1;
    renderResults([]);
    setLoading(true, `Analisando ${ids.length} anuncio(s)...`);

    try {
      const payload = await fetchJson(mlUrl("/api/modelo-massa/preview"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_ids: ids,
          target_model: targetModel,
        }),
      });

      state.rows = Array.isArray(payload?.items) ? payload.items : [];
      for (const row of state.rows) {
        if (row.can_apply) state.selected.add(row.id);
      }

      const eligible = state.rows.filter((row) => row.can_apply).length;
      const catalog = state.rows.filter((row) => row.listing_type === "catalogo").length;
      const blocked = state.rows.length - eligible - catalog;

      $("#analysisStatus").textContent =
        `Analise concluida. ${eligible} elegivel(is), ${catalog} catalogo/manual e ${blocked} bloqueado(s).`;

      renderSummary(
        "info",
        `Lote analisado. Revise a tabela e aplique apenas os ${eligible} item(ns) elegiveis.`,
      );
      applyFilters();
    } catch (error) {
      $("#analysisStatus").textContent = `Falha ao analisar lote: ${error.message}`;
      renderSummary("error", `Falha ao analisar o lote: ${error.message}`);
      updateStats();
    } finally {
      setLoading(false, $("#analysisStatus").textContent);
    }
  }

  function selectedEligibleIds() {
    return state.filtered
      .filter((row) => row.can_apply && state.selected.has(row.id))
      .map((row) => row.id);
  }

  function allEligibleIds() {
    return state.rows.filter((row) => row.can_apply).map((row) => row.id);
  }

  function jobIsCompleted(job) {
    if (!job) return false;
    if (job.completed === true) return true;
    return isTerminalJobStateText(job.state || job.status || "");
  }

  function modeloJobCsvUrl(jobId) {
    return `/api/modelo-massa/jobs/${encodeURIComponent(String(jobId || "").trim())}/download.csv`;
  }

  function resolveModeloReviewAction(job, jobId, completed) {
    const explicit =
      job?.review_action && job.review_action.url
        ? {
            label: job.review_action.label || "Baixar CSV",
            url: job.review_action.url,
          }
        : null;
    if (explicit) return explicit;
    const directUrl = String(job?.download_csv_url || "").trim();
    if (directUrl) {
      return {
        label: Number(job?.errors || 0) > 0 ? "Ver e corrigir" : "Baixar CSV",
        url: directUrl,
      };
    }
    if (!completed) return null;
    return {
      label: Number(job?.errors || 0) > 0 ? "Ver e corrigir" : "Baixar CSV",
      url: modeloJobCsvUrl(jobId),
    };
  }

  function summaryTypeForJob(job) {
    const errors = Number(job?.errors || 0);
    const applied = Number(job?.applied || 0);
    const manual = Number(job?.manual || 0);
    const skipped = Number(job?.skipped || 0);
    const processed = Number(job?.processed || 0);

    if (errors > 0 && applied === 0 && manual === 0 && skipped === 0) return "error";
    if (errors > 0) return "warning";
    if (processed > 0 && (applied > 0 || manual > 0 || skipped > 0)) return "success";
    return "info";
  }

  function isActiveJob(job) {
    if (!job) return false;
    if (job.completed === true) return false;
    return !isTerminalJobStateText(job.state || job.status || "");
  }

  async function syncJobsPanel() {
    try {
      const payload = await fetchJson(mlUrl("/api/modelo-massa/jobs"));
      if (Array.isArray(payload?.jobs)) {
        window.JobsPanel?.mergeApiJobs?.(payload.jobs);
        window.JobsPanel?.show?.();
        return payload.jobs;
      }
    } catch (error) {
      console.warn("Falha ao sincronizar jobs de modelo em massa:", error.message);
    }
    return [];
  }

  function stopJobsPanelSync() {
    if (state.jobsPanelTimer) clearInterval(state.jobsPanelTimer);
    state.jobsPanelTimer = null;
  }

  function startJobsPanelSync() {
    if (state.jobsPanelTimer) return;
    const tick = async () => {
      const list = await syncJobsPanel();
      const hasActive = (Array.isArray(list) && list.some(isActiveJob)) ||
        !!window.JobsPanel?.hasRunningJobs?.();
      if (!hasActive) stopJobsPanelSync();
    };
    tick();
    state.jobsPanelTimer = setInterval(tick, 3000);
  }

  async function cancelJobFromPanel(job) {
    if (!job?.id) return false;
    const payload = await fetchJson(
      mlUrl(`/api/modelo-massa/jobs/${encodeURIComponent(job.backendJobId || job.id)}/cancel`),
      { method: "POST" },
    );
    const status = String(payload?.status || "");
    window.JobsPanel?.updateLocalJob?.(job.id, {
      state: /cancelando/i.test(status) ? "cancelando" : "cancelado",
      completed: !/cancelando/i.test(status),
      progress: /cancelando/i.test(status) ? job.progress || 0 : 100,
    });
    return true;
  }

  async function pollCurrentJob() {
    if (!state.currentJobId) return;

    try {
      await syncJobsPanel();
      const payload = await fetchJson(
        mlUrl(`/api/modelo-massa/jobs/${encodeURIComponent(state.currentJobId)}`),
      );
      const job = payload?.job || null;
      if (!job) return;
      const completed = jobIsCompleted(job);
      const reviewAction = resolveModeloReviewAction(job, state.currentJobId, completed);
      window.JobsPanel?.updateLocalJob?.(state.currentJobId, {
        progress: Number(job.progress ?? 0),
        processed: Number(job.processed ?? 0),
        total: Number(job.total ?? 0),
        errors: Number(job.errors ?? 0),
        state:
          job.state ||
          (completed
            ? Number(job.errors || 0) > 0
              ? `concluido com ${Number(job.errors || 0)} erro(s)`
              : "concluido"
            : `processando ${Number(job.processed || 0)}/${Number(job.total || 0)}`),
        completed,
        reviewAction,
        downloadCsvUrl: reviewAction?.url || null,
      });

      if (completed) {
        const parts = [
          `Total: ${job.total || 0}`,
          `Aplicados: ${job.applied || 0}`,
          `Manuais: ${job.manual || 0}`,
          `Ignorados: ${job.skipped || 0}`,
          `Erros: ${job.errors || 0}`,
        ];
        if (job.dry_run) parts.push("Simulacao");

        renderSummary(summaryTypeForJob(job), parts.join(" • "));
        renderResults(Array.isArray(job.results) ? job.results : []);
        setLoading(false, "Job finalizado.");
        stopJobsPolling();
      }
    } catch (error) {
      console.warn("Falha ao consultar job atual:", error.message);
    }
  }

  function startJobsPolling() {
    stopJobsPolling();
    startJobsPanelSync();
    state.jobsTimer = setInterval(pollCurrentJob, 2500);
  }

  function stopJobsPolling() {
    if (state.jobsTimer) clearInterval(state.jobsTimer);
    state.jobsTimer = null;
  }

  async function enqueueApply(itemIds) {
    const ids = Array.from(new Set((itemIds || []).map((value) => String(value || "").trim().toUpperCase()).filter(Boolean)));
    const targetModel = currentTargetModel();

    if (!ids.length) {
      renderSummary("error", "Nenhum anuncio elegivel foi selecionado.");
      return;
    }

    if (!targetModel) {
      renderSummary("error", "Informe o valor do campo modelo.");
      return;
    }

    setLoading(true, "Enfileirando job de modelo em massa...");
    renderSummary(
      "info",
      currentDryRun()
        ? "Criando job de simulacao do modelo em massa..."
        : "Criando job de aplicacao do modelo em massa...",
    );
    renderResults([]);

    const account = window.__ACCOUNT__ || {};
    const accountLabel = readShellAccountLabel() || account.label || null;
    const localJobId =
      window.JobsPanel?.addLocalJob?.({
        title: `${currentDryRun() ? "Simular" : "Aplicar"} Modelo • ${ids.length} item(ns)`,
        accountKey: account.key || null,
        accountLabel,
      }) || null;

    try {
      const payload = await fetchJson(mlUrl("/api/modelo-massa/aplicar"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_ids: ids,
          target_model: targetModel,
          dry_run: currentDryRun(),
        }),
      });

      state.currentJobId = String(payload?.job_id || "");
      if (localJobId && state.currentJobId) {
        window.JobsPanel?.replaceId?.(localJobId, state.currentJobId);
        window.JobsPanel?.updateLocalJob?.(state.currentJobId, {
          state: `na fila 0/${ids.length}`,
          progress: 0,
          processed: 0,
          total: ids.length,
        });
      }

      renderSummary(
        "info",
        `Job criado para ${ids.length} item(ns). Acompanhe o progresso no painel de processos.`,
      );
      startJobsPolling();
    } catch (error) {
      if (localJobId) {
        window.JobsPanel?.updateLocalJob?.(localJobId, {
          progress: 100,
          state: "falha ao iniciar",
          completed: true,
        });
      }
      renderSummary("error", `Falha ao iniciar job: ${error.message}`);
      setLoading(false, "Falha ao criar job.");
    }
  }

  function clearAll() {
    state.rows = [];
    state.filtered = [];
    state.selected.clear();
    state.page = 1;
    state.currentJobId = null;
    stopJobsPolling();
    $("#targetModel").value = "";
    $("#itemIds").value = "";
    $("#searchInput").value = "";
    $("#filterType").value = "all";
    $("#dryRun").checked = false;
    tableBody().innerHTML =
      '<tr><td colspan="9" class="empty-row">Analise um lote para comecar.</td></tr>';
    pagination().innerHTML = "";
    $("#tableInfo").textContent = "0 resultados";
    $("#analysisStatus").textContent = "Nenhum lote analisado ainda.";
    renderSummary("info", "Aguardando analise do lote.");
    renderResults([]);
    updateTargetModelHint();
    updateStats();
  }

  function bindEvents() {
    $("#btnAnalyze").addEventListener("click", analyzeBatch);
    $("#btnApplyEligible").addEventListener("click", async () => {
      const ids = allEligibleIds();
      if (!ids.length) return;
      if (!window.confirm(`Aplicar o campo modelo em ${ids.length} anuncio(s) elegiveis?`)) return;
      await enqueueApply(ids);
    });
    $("#btnApplySelected").addEventListener("click", async () => {
      const ids = selectedEligibleIds();
      if (!ids.length) return;
      if (!window.confirm(`Aplicar o campo modelo em ${ids.length} anuncio(s) selecionados?`)) return;
      await enqueueApply(ids);
    });
    $("#btnSelectEligible").addEventListener("click", () => {
      for (const row of state.filtered) {
        if (row.can_apply) state.selected.add(row.id);
      }
      renderTable();
    });
    $("#btnClear").addEventListener("click", clearAll);
    $("#targetModel").addEventListener("input", updateTargetModelHint);
    $("#defaultModelSearch").addEventListener("input", renderDefaultModelsList);
    $("#btnSaveDefaultModel").addEventListener("click", async () => {
      await saveDefaultModel(currentTargetModel(), { updateTarget: false });
    });
    $("#btnManageDefaultModels").addEventListener("click", openDefaultModelsModal);
    $("#btnCloseDefaultModels").addEventListener("click", closeDefaultModelsModal);
    $("#defaultModelManagerSearch").addEventListener("input", renderDefaultModelManager);
    $("#defaultModelForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      await saveDefaultModel($("#defaultModelInput")?.value || "", { updateTarget: true });
    });
    $("#defaultModelsModal").addEventListener("click", (event) => {
      if (event.target === $("#defaultModelsModal")) closeDefaultModelsModal();
    });
    $("#searchInput").addEventListener("input", () => {
      state.page = 1;
      applyFilters();
    });
    $("#filterType").addEventListener("change", () => {
      state.page = 1;
      applyFilters();
    });
    $("#checkPage").addEventListener("change", (event) => {
      for (const row of currentPageRows()) {
        if (!row.can_apply) continue;
        if (event.target.checked) state.selected.add(row.id);
        else state.selected.delete(row.id);
      }
      renderTable();
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    bindEvents();
    updateTargetModelHint();
    updateStats();
    loadDefaultModels();
    applyModeloMassaPanelVisibilityFilter();
    startJobsPanelSync();
    window.JobsPanel?.setCancelHandler?.(cancelJobFromPanel);
  });

  window.addEventListener("beforeunload", () => {
    stopJobsPolling();
    stopJobsPanelSync();
  });
})();

