"use strict";

(() => {
  const API = "/api/account/automations/reports";
  const state = {
    automations: [],
    filtered: [],
    editingId: null,
    selectedId: null,
    limits: { max_daily_reports: 2 },
  };
  const els = {};

  function $(id) {
    return document.getElementById(id);
  }

  function api(path, options = {}) {
    return fetch(path, {
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      ...options,
    }).then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }
      return payload;
    });
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function normalize(value) {
    return String(value || "").trim().toLowerCase();
  }

  function toast(message, type = "ok") {
    const node = document.createElement("div");
    node.className = `au-toast au-toast--${type}`;
    node.textContent = message;
    document.body.appendChild(node);
    window.setTimeout(() => node.remove(), 3800);
  }

  function formatDate(value) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  }

  function baseLabel(value) {
    return {
      active: "Ativos",
      paused: "Inativos/pausados",
      all: "Todos",
      mlb_list: "Lista de MLBs",
    }[normalize(value)] || "Ativos";
  }

  function enrichmentLabel(value) {
    return {
      none: "Nenhum",
      category: "Categoria",
      visits: "Visitas",
      ads: "Ads",
      promos: "Promocoes",
      variations: "Variacoes",
    }[normalize(value)] || "Nenhum";
  }

  function periodLabel(value) {
    return {
      none: "Sem periodo",
      last_7_days: "Ultimos 7 dias",
      last_30_days: "Ultimos 30 dias",
      current_month: "Mes atual",
      previous_month: "Mes anterior",
    }[normalize(value)] || "Sem periodo";
  }

  function frequencyLabel(item) {
    const time = item.time_of_day || "--:--";
    if (item.frequency === "weekdays") return `Dias uteis as ${time}`;
    if (item.frequency === "weekly") {
      const days = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"];
      return `${days[Number(item.weekday || 0)]} as ${time}`;
    }
    return `Diario as ${time}`;
  }

  function recipientsText(item) {
    return (Array.isArray(item.recipients) ? item.recipients : [])
      .map((recipient) => recipient.email || recipient)
      .filter(Boolean)
      .join(", ");
  }

  function searchBlob(item) {
    return [
      item.name,
      baseLabel(item.base_status),
      enrichmentLabel(item.enrichment),
      periodLabel(item.period_type),
      frequencyLabel(item),
      recipientsText(item),
      item.active ? "ativo" : "pausado",
    ].map(normalize).join(" ");
  }

  function applyFilter() {
    const term = normalize(els.search.value);
    state.filtered = term
      ? state.automations.filter((item) => searchBlob(item).includes(term))
      : [...state.automations];
    render();
  }

  function renderStats() {
    els.statTotal.textContent = String(state.automations.length);
    els.statActive.textContent = String(state.automations.filter((item) => item.active).length);
    els.statPaused.textContent = String(state.automations.filter((item) => !item.active).length);
    els.statLimit.textContent = String(state.limits.max_daily_reports || 2);
  }

  function renderTable() {
    els.counter.textContent = `Exibindo ${state.filtered.length} de ${state.automations.length} automacao(oes).`;
    if (!state.filtered.length) {
      els.body.innerHTML = `<tr><td colspan="7" class="au-empty">Nenhuma automacao encontrada.</td></tr>`;
      return;
    }

    els.body.innerHTML = state.filtered.map((item) => {
      const recipients = (Array.isArray(item.recipients) ? item.recipients : []).slice(0, 3);
      return `
        <tr data-id="${escapeHtml(item.id)}">
          <td>
            <div class="au-user">
              <strong>${escapeHtml(item.name)}</strong>
              <span>Proximo envio: ${escapeHtml(formatDate(item.next_run_at))}</span>
            </div>
          </td>
          <td>${escapeHtml(baseLabel(item.base_status))}</td>
          <td>
            <span class="au-pill au-pill--muted">${escapeHtml(enrichmentLabel(item.enrichment))}</span>
            <div><small>${escapeHtml(periodLabel(item.period_type))}</small></div>
          </td>
          <td>${escapeHtml(frequencyLabel(item))}</td>
          <td>
            <div class="automation-recipients">
              ${recipients.map((recipient) => `<span class="au-chip">${escapeHtml(recipient.email || recipient)}</span>`).join("")}
              ${(item.recipients || []).length > 3 ? `<span class="au-chip">+${(item.recipients || []).length - 3}</span>` : ""}
            </div>
          </td>
          <td>
            <span class="au-pill ${item.active ? "au-pill--ok" : "au-pill--muted"}">${item.active ? "Ativa" : "Pausada"}</span>
            ${item.last_status ? `<div><small>Ultimo: ${escapeHtml(item.last_status)}</small></div>` : ""}
          </td>
          <td>
            <div class="au-row-actions">
              <button class="au-btn au-btn-secondary" type="button" data-action="runs">Historico</button>
              <button class="au-btn au-btn-secondary" type="button" data-action="edit">Editar</button>
              <button class="au-btn au-btn-secondary" type="button" data-action="run">Enviar agora</button>
              <button class="au-btn ${item.active ? "au-btn-secondary" : "au-btn-primary"}" type="button" data-action="${item.active ? "pause" : "resume"}">${item.active ? "Pausar" : "Ativar"}</button>
              <button class="au-btn au-btn-danger" type="button" data-action="delete">Excluir</button>
            </div>
          </td>
        </tr>
      `;
    }).join("");
  }

  function render() {
    renderStats();
    renderTable();
  }

  function selectedEnrichment() {
    return document.querySelector("input[name='enrichment']:checked")?.value || "none";
  }

  function setSelectedEnrichment(value) {
    const input = document.querySelector(`input[name='enrichment'][value='${CSS.escape(value || "none")}']`);
    if (input) input.checked = true;
  }

  function collectEmails(value) {
    return String(value || "")
      .split(/[\s,;]+/)
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
      .map((email) => ({ email }));
  }

  function collectMlbs(value) {
    return String(value || "")
      .split(/[\s,;]+/)
      .map((mlb) => mlb.trim().toUpperCase())
      .filter(Boolean);
  }

  function syncConditionalFields() {
    const base = els.base.value;
    els.mlbs.hidden = base !== "mlb_list";
    const enrichment = selectedEnrichment();
    if ((enrichment === "visits" || enrichment === "ads") && els.period.value === "none") {
      els.period.value = "last_30_days";
    }
    els.weekday.hidden = els.frequency.value !== "weekly";
  }

  function resetForm() {
    state.editingId = null;
    els.dialogTitle.textContent = "Nova automacao";
    els.name.value = "";
    els.base.value = "active";
    els.mlbs.value = "";
    setSelectedEnrichment("none");
    els.period.value = "none";
    els.recipients.value = "";
    els.frequency.value = "daily";
    els.weekday.value = "1";
    els.time.value = "08:00";
    syncConditionalFields();
  }

  function openEditor(item = null) {
    resetForm();
    if (item) {
      state.editingId = item.id;
      els.dialogTitle.textContent = "Editar automacao";
      els.name.value = item.name || "";
      els.base.value = item.base_status || "active";
      els.mlbs.value = (item.mlb_ids || []).join("\n");
      setSelectedEnrichment(item.enrichment || "none");
      els.period.value = item.period_type || "none";
      els.recipients.value = recipientsText(item);
      els.frequency.value = item.frequency || "daily";
      els.weekday.value = item.weekday == null ? "1" : String(item.weekday);
      els.time.value = item.time_of_day || "08:00";
      syncConditionalFields();
    }
    els.dialog.showModal();
  }

  function collectPayload() {
    const current = state.automations.find((item) => String(item.id) === String(state.editingId));
    return {
      name: els.name.value,
      base_status: els.base.value,
      mlb_ids: collectMlbs(els.mlbs.value),
      enrichment: selectedEnrichment(),
      period_type: els.period.value,
      recipients: collectEmails(els.recipients.value),
      frequency: els.frequency.value,
      weekday: els.frequency.value === "weekly" ? Number(els.weekday.value) : null,
      time_of_day: els.time.value,
      timezone: "America/Sao_Paulo",
      active: current ? current.active !== false : true,
    };
  }

  async function saveAutomation() {
    els.save.disabled = true;
    els.save.textContent = "Salvando...";
    try {
      const id = state.editingId;
      await api(id ? `${API}/${encodeURIComponent(id)}` : API, {
        method: id ? "PUT" : "POST",
        body: JSON.stringify(collectPayload()),
      });
      els.dialog.close();
      await loadAutomations();
      toast("Automacao salva.");
    } catch (error) {
      toast(error.message || "Falha ao salvar automacao.", "error");
    } finally {
      els.save.disabled = false;
      els.save.textContent = "Salvar automacao";
    }
  }

  async function loadRuns(id) {
    state.selectedId = id;
    els.runsCounter.textContent = "Carregando execucoes...";
    els.runsList.innerHTML = `<div class="au-empty">Carregando...</div>`;
    try {
      const payload = await api(`${API}/${encodeURIComponent(id)}/runs`);
      const runs = Array.isArray(payload.runs) ? payload.runs : [];
      els.runsCounter.textContent = runs.length ? `${runs.length} execucao(oes) recente(s).` : "Nenhuma execucao ainda.";
      if (!runs.length) {
        els.runsList.innerHTML = `<div class="au-empty">Esta automacao ainda nao rodou.</div>`;
        return;
      }
      els.runsList.innerHTML = runs.map((run) => `
        <div class="automation-run">
          <div>
            <strong>${escapeHtml(run.status)}</strong>
            <span>${escapeHtml(formatDate(run.created_at))}</span>
          </div>
          <div>
            <small>Linhas: ${run.rows_count == null ? "-" : Number(run.rows_count).toLocaleString("pt-BR")}</small>
            ${run.error_message ? `<div class="au-inline-error">${escapeHtml(run.error_message)}</div>` : ""}
          </div>
          <div>
            ${run.csv_url ? `<a href="${escapeHtml(run.csv_url)}" target="_blank" rel="noopener">CSV</a>` : "-"}
          </div>
        </div>
      `).join("");
    } catch (error) {
      els.runsCounter.textContent = "Falha ao carregar historico.";
      els.runsList.innerHTML = `<div class="au-empty">${escapeHtml(error.message || "Erro")}</div>`;
    }
  }

  async function handleAction(id, action) {
    const item = state.automations.find((entry) => String(entry.id) === String(id));
    if (!item) return;
    try {
      if (action === "edit") return openEditor(item);
      if (action === "runs") return loadRuns(item.id);
      if (action === "pause" || action === "resume") {
        await api(`${API}/${encodeURIComponent(item.id)}/${action}`, { method: "POST" });
        await loadAutomations();
        toast(action === "pause" ? "Automacao pausada." : "Automacao ativada.");
        return;
      }
      if (action === "run") {
        await api(`${API}/${encodeURIComponent(item.id)}/run-now`, { method: "POST" });
        await loadRuns(item.id).catch(() => null);
        toast("Execucao enviada para a fila.");
        return;
      }
      if (action === "delete") {
        if (!confirm("Excluir esta automacao? O historico tambem sera removido.")) return;
        await api(`${API}/${encodeURIComponent(item.id)}`, { method: "DELETE" });
        await loadAutomations();
        els.runsList.innerHTML = `<div class="au-empty">Nenhuma automacao selecionada.</div>`;
        els.runsCounter.textContent = "Selecione uma automacao para ver as execucoes.";
        toast("Automacao excluida.");
      }
    } catch (error) {
      toast(error.message || "Falha na acao.", "error");
    }
  }

  async function loadAutomations() {
    els.body.innerHTML = `<tr><td colspan="7" class="au-empty">Carregando...</td></tr>`;
    const payload = await api(API);
    state.automations = Array.isArray(payload.automations) ? payload.automations : [];
    state.limits = payload.limits || state.limits;
    applyFilter();
    if (state.selectedId && state.automations.some((item) => String(item.id) === String(state.selectedId))) {
      loadRuns(state.selectedId).catch(() => null);
    }
  }

  function bindEvents() {
    els.search.addEventListener("input", applyFilter);
    els.refresh.addEventListener("click", async () => {
      els.refresh.disabled = true;
      try {
        await loadAutomations();
      } catch (error) {
        toast(error.message || "Falha ao atualizar.", "error");
      } finally {
        els.refresh.disabled = false;
      }
    });
    els.newAutomation.addEventListener("click", () => openEditor());
    els.save.addEventListener("click", saveAutomation);
    els.base.addEventListener("change", syncConditionalFields);
    els.frequency.addEventListener("change", syncConditionalFields);
    els.enrichmentOptions.addEventListener("change", syncConditionalFields);
    els.body.addEventListener("click", (event) => {
      const button = event.target.closest("[data-action]");
      const row = event.target.closest("tr[data-id]");
      if (!button || !row) return;
      handleAction(row.dataset.id, button.dataset.action);
    });
  }

  async function init() {
    Object.assign(els, {
      refresh: $("btn-refresh-automations"),
      newAutomation: $("btn-new-automation"),
      search: $("automation-search"),
      counter: $("automations-counter"),
      body: $("automations-body"),
      statTotal: $("stat-total"),
      statActive: $("stat-active"),
      statPaused: $("stat-paused"),
      statLimit: $("stat-limit"),
      runsCounter: $("runs-counter"),
      runsList: $("runs-list"),
      dialog: $("automation-dialog"),
      dialogTitle: $("dialog-title"),
      name: $("automation-name"),
      base: $("automation-base"),
      mlbs: $("automation-mlbs"),
      enrichmentOptions: $("enrichment-options"),
      period: $("automation-period"),
      recipients: $("automation-recipients"),
      frequency: $("automation-frequency"),
      weekday: $("automation-weekday"),
      time: $("automation-time"),
      save: $("btn-save-automation"),
    });
    bindEvents();
    syncConditionalFields();
    try {
      await loadAutomations();
    } catch (error) {
      els.body.innerHTML = `<tr><td colspan="7" class="au-empty">${escapeHtml(error.message || "Falha ao carregar automacoes.")}</td></tr>`;
      toast(error.message || "Falha ao carregar automacoes.", "error");
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
