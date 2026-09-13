(function () {
  "use strict";

  const state = {
    categories: [],
    selectedCategory: null,
    validation: null,
    currentJobId: null,
    currentPanelJobId: null,
    jobsTimer: null,
  };

  const PANEL_JOB_PREFIX = "caracteristicas:";

  function toPanelJobId(jobId) {
    const raw = String(jobId || "").trim();
    if (!raw || raw.startsWith("local-")) return raw;
    return raw.startsWith(PANEL_JOB_PREFIX) ? raw : `${PANEL_JOB_PREFIX}${raw}`;
  }

  function fromPanelJobId(jobId) {
    const raw = String(jobId || "").trim();
    return raw.startsWith(PANEL_JOB_PREFIX)
      ? raw.slice(PANEL_JOB_PREFIX.length)
      : raw;
  }

  const $ = (selector) => document.querySelector(selector);

  function mlUrl(path) {
    return window.ML?.url ? window.ML.url(path) : path;
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

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();
  }

  async function apiJson(path, options = {}) {
    const response = await fetch(mlUrl(path), {
      credentials: "same-origin",
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        ...(options.headers || {}),
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.success === false) {
      throw new Error(payload?.error || payload?.message || `Falha HTTP ${response.status}`);
    }
    return payload;
  }

  function accountLabel() {
    const raw = String(document.getElementById("account-current")?.textContent || "").trim();
    if (!raw || /carregando|indispon|nenhuma|nao selecionada/i.test(raw)) return null;
    return raw;
  }

  function setStatus(message) {
    $("#categoriesStatus").textContent = message;
  }

  function selectedCategoryId() {
    return state.selectedCategory?.category_id || "";
  }

  function updateImportState() {
    const hasCategory = Boolean(selectedCategoryId());
    const hasFile = Boolean($("#excelFile")?.files?.[0]);
    $("#btnDownloadModel").disabled = !hasCategory;
    $("#btnDownloadFilled").disabled = !hasCategory;
    $("#btnValidateImport").disabled = !hasCategory || !hasFile;
    $("#importCategoryBadge").textContent = hasCategory
      ? selectedCategoryId()
      : "Sem categoria";
  }

  function filteredCategories() {
    const filter = normalizeText($("#categoryFilter")?.value || "");
    if (!filter) return state.categories;
    return state.categories.filter((category) => (
      normalizeText(category.category_id).includes(filter) ||
      normalizeText(category.category_name).includes(filter) ||
      normalizeText((category.path || []).join(" ")).includes(filter)
    ));
  }

  function renderCategories() {
    const rows = filteredCategories();
    const tbody = $("#categoriesBody");
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-row">Nenhuma categoria encontrada.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map((category) => {
      const active = selectedCategoryId() === category.category_id ? " active" : "";
      return `
        <tr class="category-row${active}" data-category-id="${escapeHtml(category.category_id)}">
          <td>
            <strong>${escapeHtml(category.category_name || category.category_id)}</strong>
            <span>${escapeHtml(category.category_id)}${category.path?.length ? " - " + escapeHtml(category.path.join(" > ")) : ""}</span>
          </td>
          <td>${Number(category.total || 0)}</td>
          <td>${Number(category.catalog || 0)}</td>
          <td>
            <button class="mini-action" type="button" data-action="select" data-category-id="${escapeHtml(category.category_id)}">Selecionar</button>
          </td>
        </tr>
      `;
    }).join("");
  }

  function renderSelectedCategory() {
    const category = state.selectedCategory;
    $("#selectedCategoryTitle").textContent = category
      ? `${category.category_name || category.category_id} (${category.category_id})`
      : "Nenhuma categoria";
    $("#selectedCategoryPath").textContent = category?.path?.length
      ? category.path.join(" > ")
      : "Selecione uma linha para baixar ou importar Excel.";
    $("#selectedCategoryTotal").textContent = String(category?.total || 0);
    $("#selectedCategoryCatalog").textContent = String(category?.catalog || 0);
    $("#validationSummary").textContent = category
      ? "Categoria pronta para baixar modelo ou validar Excel."
      : "Aguardando arquivo.";
    updateImportState();
    renderCategories();
  }

  function selectCategory(categoryId) {
    state.selectedCategory = state.categories.find((item) => item.category_id === categoryId) || null;
    state.validation = null;
    $("#validationPanel").hidden = true;
    $("#resultPanel").hidden = true;
    renderSelectedCategory();
  }

  async function loadCategories() {
    $("#btnLoadCategories").disabled = true;
    setStatus("Carregando anuncios ativos e agrupando por categoria...");
    try {
      const payload = await apiJson("/api/caracteristicas/categorias-conta");
      state.categories = Array.isArray(payload.categories) ? payload.categories : [];
      setStatus(
        `${state.categories.length} categoria(s) encontrada(s) em ${payload.scanned_items || 0} anuncio(s) ativo(s).`,
      );
      renderCategories();
    } catch (error) {
      setStatus(error.message || "Erro ao carregar categorias.");
    } finally {
      $("#btnLoadCategories").disabled = false;
    }
  }

  async function downloadWorkbook(mode) {
    const categoryId = selectedCategoryId();
    if (!categoryId) return;
    const params = new URLSearchParams({ category_id: categoryId, mode });
    const isModel = String(mode || "") === "model";
    const title = `${isModel ? "Gerar modelo" : "Exportar preenchido"} Caracteristicas - ${categoryId}`;
    const button = isModel ? $("#btnDownloadModel") : $("#btnDownloadFilled");
    const localJobId = window.JobsPanel?.addLocalJob?.({
      title,
      accountKey: window.__ACCOUNT__?.key || null,
      accountLabel: accountLabel(),
    }) || null;
    window.JobsPanel?.show?.();
    if (button) button.disabled = true;

    try {
      const payload = await apiJson(`/api/caracteristicas/exportar?${params.toString()}`);
      const backendJobId = String(payload.job_id || payload.job?.id || "").trim();
      const panelJobId = toPanelJobId(backendJobId);
      if (localJobId && panelJobId) {
        window.JobsPanel?.replaceId?.(localJobId, panelJobId);
      }
      if (panelJobId) {
        window.JobsPanel?.updateLocalJob?.(panelJobId, {
          title,
          state: "na fila",
          progress: 0,
          processed: 0,
          total: 1,
          completed: false,
        });
      }
      state.currentJobId = backendJobId;
      state.currentPanelJobId = panelJobId;
      $("#resultPanel").hidden = false;
      $("#resultSummary").textContent = "Exportacao criada. Acompanhe e baixe pelo painel de processos.";
      $("#resultList").innerHTML = "";
      startJobsTimer();
      await syncJobsPanel();
    } catch (error) {
      if (localJobId) {
        window.JobsPanel?.updateLocalJob?.(localJobId, {
          progress: 100,
          state: error.message || "falha ao iniciar exportacao",
          completed: true,
          errors: 1,
        });
      }
      $("#validationSummary").textContent = error.message || "Erro ao exportar planilha.";
    } finally {
      updateImportState();
    }
  }

  function renderValidation(payload) {
    state.validation = payload;
    $("#validationPanel").hidden = false;
    $("#statRows").textContent = String(payload.total_rows || 0);
    $("#statReady").textContent = String(payload.ready_count || 0);
    $("#statErrors").textContent = String(payload.error_count || 0);
    $("#statWarnings").textContent = String(payload.warning_count || 0);
    const invalidRows = Array.isArray(payload.rows)
      ? payload.rows.filter((row) => row.status === "error").length
      : 0;
    $("#validationStatus").textContent = payload.error_count
      ? "Existem linhas com erro. Ao processar, elas serao registradas no job e no CSV sem serem enviadas ao Mercado Livre."
      : "Arquivo validado. Cada MLB sera processado individualmente pelo job.";
    $("#validationSummary").textContent =
      `${payload.ready_count || 0} pronta(s), ${invalidRows} linha(s) com erro e ${payload.warning_count || 0} alerta(s).`;
    $("#btnApplyImport").disabled = !payload.apply_rows?.length;

    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    $("#validationBody").innerHTML = rows.length
      ? rows.slice(0, 250).map((row) => {
          const messages = [...(row.errors || []), ...(row.warnings || [])];
          return `
            <tr>
              <td>${Number(row.line || 0)}</td>
              <td>${escapeHtml(row.id || "-")}</td>
              <td>${escapeHtml(row.title || "-")}</td>
              <td><span class="status-pill ${row.status === "ready" ? "ok" : "bad"}">${row.status === "ready" ? "Pronta" : "Erro"}</span></td>
              <td>${messages.map(escapeHtml).join("<br>") || "-"}</td>
            </tr>
          `;
        }).join("")
      : '<tr><td colspan="5" class="empty-row">Nenhuma linha lida.</td></tr>';
  }

  async function validateImport() {
    const categoryId = selectedCategoryId();
    const file = $("#excelFile")?.files?.[0];
    if (!categoryId || !file) return;

    const form = new FormData();
    form.set("category_id", categoryId);
    form.set("file", file);

    $("#btnValidateImport").disabled = true;
    $("#validationSummary").textContent = "Validando Excel...";
    try {
      const payload = await apiJson("/api/caracteristicas/importar/validar", {
        method: "POST",
        body: form,
      });
      renderValidation(payload);
    } catch (error) {
      $("#validationSummary").textContent = error.message || "Erro ao validar arquivo.";
    } finally {
      updateImportState();
    }
  }

  function looksLikeCaracteristicasJob(job) {
    const adapter = normalizeText(job?.adapter || job?.module || "");
    const id = normalizeText(job?.job_uid || job?.id || "");
    if (adapter === "caracteristicas" || id.startsWith("caracteristicas:")) return true;
    const title = normalizeText(job?.title || "");
    return title.includes("caracteristicas");
  }

  async function syncJobsPanel() {
    try {
      const payload = await apiJson("/api/caracteristicas/jobs");
      const jobs = Array.isArray(payload.jobs)
        ? payload.jobs.map((job) => ({
            ...job,
            id: toPanelJobId(job?.id || job?.job_id || job?.process_id),
          }))
        : [];
      window.JobsPanel?.mergeApiJobs?.(jobs);
      window.JobsPanel?.show?.();
      return jobs;
    } catch {
      return [];
    }
  }

  function stopJobsTimer() {
    if (state.jobsTimer) clearInterval(state.jobsTimer);
    state.jobsTimer = null;
  }

  function startJobsTimer() {
    if (state.jobsTimer) return;
    const tick = async () => {
      await syncJobsPanel();
      if (state.currentJobId) await pollCurrentJob();
    };
    tick();
    state.jobsTimer = setInterval(tick, 5000);
  }

  async function pollCurrentJob() {
    if (!state.currentJobId) return;
    try {
      const payload = await apiJson(`/api/caracteristicas/jobs/${encodeURIComponent(state.currentJobId)}`);
      const job = payload.job;
      if (!job) return;
      window.JobsPanel?.updateLocalJob?.(state.currentPanelJobId || toPanelJobId(state.currentJobId), {
        progress: Number(job.progress || 0),
        processed: Number(job.processed || 0),
        total: Number(job.total || 0),
        errors: Number(job.errors || 0),
        state: job.state || job.status || "",
        completed: Boolean(job.completed),
        reviewAction: job.review_action || null,
        downloadCsvUrl: job.download_csv_url || null,
      });
      if (job.completed) {
        $("#resultPanel").hidden = false;
        $("#resultSummary").textContent =
          `Total: ${job.total || 0} | Aplicados: ${job.applied || 0} | Erros: ${job.errors || 0} | Ignorados: ${job.skipped || 0}`;
        $("#resultList").innerHTML = (job.results || []).slice(0, 100).map((result) => `
          <div class="result-item ${escapeHtml(result.status || "skipped")}">
            <strong>${escapeHtml(result.id)}</strong>
            <span>${escapeHtml(result.reason || "-")}</span>
          </div>
        `).join("");
      }
    } catch {}
  }

  async function cancelJobFromPanel(job) {
    if (!job?.id) return false;
    const backendJobId = fromPanelJobId(job.id);
    const payload = await apiJson(`/api/caracteristicas/jobs/${encodeURIComponent(backendJobId)}/cancel`, {
      method: "POST",
    });
    window.JobsPanel?.updateLocalJob?.(job.id, {
      state: payload.status || "cancelado",
      completed: !/cancelando/i.test(payload.status || ""),
      progress: /cancelando/i.test(payload.status || "") ? job.progress || 0 : 100,
    });
    return true;
  }

  async function applyImport() {
    if (!state.validation?.apply_rows?.length) return;
    const dryRun = Boolean($("#dryRun")?.checked);
    const rows = state.validation.apply_rows;
    if (!window.confirm(`${dryRun ? "Simular" : "Aplicar"} caracteristicas em ${rows.length} MLB(s)?`)) return;

    const localJobId = window.JobsPanel?.addLocalJob?.({
      title: `${dryRun ? "Simular" : "Aplicar"} Caracteristicas - ${rows.length} item(ns)`,
      accountKey: window.__ACCOUNT__?.key || null,
      accountLabel: accountLabel(),
    }) || null;

    $("#btnApplyImport").disabled = true;
    try {
      const payload = await apiJson("/api/caracteristicas/aplicar-excel", {
        method: "POST",
        body: JSON.stringify({
          category_id: selectedCategoryId(),
          rows,
          dry_run: dryRun,
        }),
      });
      state.currentJobId = String(payload.job_id || "");
      state.currentPanelJobId = toPanelJobId(state.currentJobId);
      if (localJobId && state.currentJobId) {
        window.JobsPanel?.replaceId?.(localJobId, state.currentPanelJobId);
      }
      window.JobsPanel?.updateLocalJob?.(state.currentPanelJobId, {
        state: `na fila 0/${rows.length}`,
        progress: 0,
        processed: 0,
        total: rows.length,
      });
      $("#resultPanel").hidden = false;
      $("#resultSummary").textContent = "Job criado. Acompanhe o progresso no painel de processos.";
      $("#resultList").innerHTML = "";
      startJobsTimer();
    } catch (error) {
      if (localJobId) {
        window.JobsPanel?.updateLocalJob?.(localJobId, {
          progress: 100,
          state: "falha ao iniciar",
          completed: true,
        });
      }
      $("#resultPanel").hidden = false;
      $("#resultSummary").textContent = error.message || "Erro ao aplicar importacao.";
    } finally {
      $("#btnApplyImport").disabled = !state.validation?.apply_rows?.length;
    }
  }

  function bindEvents() {
    $("#btnLoadCategories").addEventListener("click", loadCategories);
    $("#btnRefreshJobs").addEventListener("click", syncJobsPanel);
    $("#categoryFilter").addEventListener("input", renderCategories);
    $("#categoriesBody").addEventListener("click", (event) => {
      const button = event.target.closest("[data-category-id]");
      const row = event.target.closest(".category-row");
      const id = button?.dataset?.categoryId || row?.dataset?.categoryId;
      if (id) selectCategory(id);
    });
    $("#btnDownloadModel").addEventListener("click", () => downloadWorkbook("model"));
    $("#btnDownloadFilled").addEventListener("click", () => downloadWorkbook("filled"));
    $("#excelFile").addEventListener("change", updateImportState);
    $("#btnValidateImport").addEventListener("click", validateImport);
    $("#btnApplyImport").addEventListener("click", applyImport);
  }

  document.addEventListener("DOMContentLoaded", () => {
    bindEvents();
    updateImportState();
    window.JobsPanel?.setAdapter?.("caracteristicas");
    window.JobsPanel?.setVisibilityFilter?.(looksLikeCaracteristicasJob);
    window.JobsPanel?.setCancelHandler?.(cancelJobFromPanel);
    startJobsTimer();
  });

  window.addEventListener("beforeunload", stopJobsTimer);
})();
