(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const elJobKey = $("job-key");
  const elJobName = $("job-name");
  const elJobDescription = $("job-description");
  const elEnabled = $("enabled");
  const elIncludeInactive = $("include-inactive");
  const elFailOnPartial = $("fail-on-partial");
  const elConcurrency = $("concurrency");
  const elLimit = $("limit");
  const elAllowlist = $("allowlist");
  const elDenylist = $("denylist");
  const elSearch = $("search");
  const elAccountsBody = $("accounts-body");
  const elAccountsCount = $("accounts-count");
  const elMetaUpdated = $("meta-updated");
  const elMetaSource = $("meta-source");
  const elToast = $("toast");

  const btnRefresh = $("btn-refresh");
  const btnSave = $("btn-save");
  const btnClearAllow = $("btn-clear-allow");
  const btnClearDeny = $("btn-clear-deny");
  const btnModeAll = $("btn-mode-all");
  const btnSelectAllVisible = $("btn-select-all-visible");
  const btnUnselectAll = $("btn-unselect-all");
  const btnAddAllow = $("btn-add-allow");
  const btnAddDeny = $("btn-add-deny");

  const periodChecks = {
    "7d": $("period-7d"),
    "14d": $("period-14d"),
    "30d": $("period-30d"),
  };

  let accounts = [];
  let jobs = [];
  let selectedIds = new Set();
  let currentJobKey = "";

  function showToast(message, type = "ok") {
    if (!elToast) return;
    elToast.textContent = message || "";
    elToast.style.display = "block";
    elToast.style.background = type === "error" ? "#b91c1c" : "#0f172a";
    window.setTimeout(() => {
      elToast.style.display = "none";
    }, 2600);
  }

  function normalizeIds(list) {
    const arr = Array.isArray(list) ? list : [];
    const clean = [];
    const seen = new Set();
    for (const raw of arr) {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) continue;
      const id = Math.trunc(n);
      if (seen.has(id)) continue;
      seen.add(id);
      clean.push(id);
    }
    clean.sort((a, b) => a - b);
    return clean;
  }

  function parseIdsInput(text) {
    const raw = String(text || "");
    if (!raw.trim()) return [];
    return normalizeIds(
      raw
        .split(/[\s,;\n\r\t]+/g)
        .map((part) => part.trim())
        .filter(Boolean),
    );
  }

  function formatIds(ids) {
    return normalizeIds(ids).join(",");
  }

  function getSelectedPeriods() {
    return Object.entries(periodChecks)
      .filter(([, el]) => el && el.checked)
      .map(([period]) => period);
  }

  function setPeriods(periods) {
    const set = new Set(Array.isArray(periods) ? periods : []);
    Object.entries(periodChecks).forEach(([period, el]) => {
      if (!el) return;
      el.checked = set.has(period);
    });
  }

  function formatDateTime(value) {
    if (!value) return "n/a";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "n/a";
    return date.toLocaleString("pt-BR");
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      ...options,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error || data?.message || `HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  }

  function getCurrentJob() {
    return jobs.find((job) => job.job_key === currentJobKey) || null;
  }

  function updateJobSelector() {
    const previous = currentJobKey;
    elJobKey.innerHTML = jobs
      .map((job) => (
        `<option value="${escapeHtml(job.job_key)}">${escapeHtml(job.display_name || job.job_key)}</option>`
      ))
      .join("");

    const hasPrevious = jobs.some((job) => job.job_key === previous);
    currentJobKey = hasPrevious ? previous : (jobs[0]?.job_key || "");
    if (currentJobKey) {
      elJobKey.value = currentJobKey;
    }
  }

  function applyCurrentJobSettings() {
    const current = getCurrentJob();
    if (!current) {
      elJobName.textContent = "-";
      elJobDescription.textContent = "Nenhum job disponivel.";
      return;
    }

    const settings = current.settings || {};

    elJobName.textContent = current.display_name || current.job_key;
    elJobDescription.textContent = current.description || "Sem descricao.";

    elEnabled.checked = settings.enabled !== false;
    elIncludeInactive.checked = settings.include_inactive === true;
    elFailOnPartial.checked = settings.fail_on_partial === true;
    elConcurrency.value = Number(settings.concurrency || 1);
    elLimit.value = Number(settings.limit || 0);
    setPeriods(settings.periods || ["7d", "14d", "30d"]);
    elAllowlist.value = formatIds(settings.account_ids || []);
    elDenylist.value = formatIds(settings.exclude_account_ids || []);

    elMetaUpdated.textContent = settings.updated_at
      ? `Ultima atualizacao: ${formatDateTime(settings.updated_at)} por ${settings.updated_by || "admin"}`
      : "Sem atualizacoes ainda.";
    elMetaSource.textContent = settings.updated_at
      ? "Fonte: banco (persistido)"
      : "Fonte: padrao do sistema";
  }

  function statusBadge(status) {
    const value = String(status || "").trim().toLowerCase();
    if (value === "ativa" || value === "active" || value === "enabled") {
      return '<span class="job-badge ok">ativa</span>';
    }
    if (value === "revogada") {
      return '<span class="job-badge off">revogada</span>';
    }
    return `<span class="job-badge warn">${escapeHtml(value || "n/a")}</span>`;
  }

  function tokenBadge(hasRefreshToken) {
    if (hasRefreshToken === true) {
      return '<span class="job-badge ok">ok</span>';
    }
    return '<span class="job-badge off">sem token</span>';
  }

  function filterAccounts() {
    const q = String(elSearch.value || "").trim().toLowerCase();
    if (!q) return accounts.slice();

    return accounts.filter((row) => {
      const chunks = [
        row.id,
        row.empresa_id,
        row.empresa_nome,
        row.apelido,
        row.meli_user_id,
        row.status,
      ]
        .map((part) => String(part || "").toLowerCase())
        .join(" ");
      return chunks.includes(q);
    });
  }

  function renderTable() {
    const rows = filterAccounts();
    elAccountsCount.textContent = `${rows.length} conta${rows.length === 1 ? "" : "s"} visiveis`;

    if (!rows.length) {
      elAccountsBody.innerHTML = "<tr><td colspan='8'>Nenhuma conta encontrada.</td></tr>";
      return;
    }

    elAccountsBody.innerHTML = rows
      .map((row) => {
        const checked = selectedIds.has(Number(row.id)) ? "checked" : "";
        const apelido = row.apelido ? escapeHtml(String(row.apelido)) : "-";
        const empresa = row.empresa_nome ? escapeHtml(String(row.empresa_nome)) : "-";
        return `
          <tr>
            <td><input type="checkbox" data-role="pick" data-id="${row.id}" ${checked} /></td>
            <td>${escapeHtml(row.id)}</td>
            <td>${escapeHtml(row.empresa_id)}</td>
            <td>${empresa}</td>
            <td>${apelido}</td>
            <td>${escapeHtml(row.meli_user_id || "-")}</td>
            <td>${statusBadge(row.status)}</td>
            <td>${tokenBadge(row.has_refresh_token === true)}</td>
          </tr>
        `;
      })
      .join("");
  }

  function collectPayload() {
    const periods = getSelectedPeriods();
    return {
      enabled: elEnabled.checked,
      include_inactive: elIncludeInactive.checked,
      fail_on_partial: elFailOnPartial.checked,
      periods: periods.length ? periods : ["7d", "14d", "30d"],
      concurrency: Number(elConcurrency.value || 1),
      limit: Number(elLimit.value || 0),
      account_ids: parseIdsInput(elAllowlist.value),
      exclude_account_ids: parseIdsInput(elDenylist.value),
      params: {},
    };
  }

  function mergeIntoTextarea(target, idsToAdd) {
    const current = parseIdsInput(target.value);
    target.value = formatIds([...current, ...idsToAdd]);
  }

  async function load() {
    elAccountsBody.innerHTML = "<tr><td colspan='8'>Carregando...</td></tr>";
    try {
      const payload = await api("/api/admin/jobs", { method: "GET" });
      jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
      accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
      updateJobSelector();
      applyCurrentJobSettings();
      selectedIds = new Set();
      renderTable();
      showToast("Automacoes carregadas.");
    } catch (error) {
      console.error(error);
      elAccountsBody.innerHTML = `<tr><td colspan='8'>Erro: ${escapeHtml(error.message)}</td></tr>`;
      showToast(error.message || "Falha ao carregar.", "error");
    }
  }

  async function save() {
    const current = getCurrentJob();
    if (!current) {
      showToast("Nenhum job selecionado.", "error");
      return;
    }

    const payload = collectPayload();
    btnSave.disabled = true;
    btnSave.textContent = "Salvando...";

    try {
      const response = await api(`/api/admin/jobs/${current.job_key}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });

      const updated = response?.job || null;
      if (updated) {
        jobs = jobs.map((job) =>
          job.job_key === updated.job_key ? updated : job,
        );
        applyCurrentJobSettings();
      }
      showToast("Configuracao do job salva.");
    } catch (error) {
      console.error(error);
      showToast(error.message || "Falha ao salvar.", "error");
    } finally {
      btnSave.disabled = false;
      btnSave.textContent = "Salvar job";
    }
  }

  function bindEvents() {
    btnRefresh.addEventListener("click", load);
    btnSave.addEventListener("click", save);
    elSearch.addEventListener("input", renderTable);

    elJobKey.addEventListener("change", () => {
      currentJobKey = String(elJobKey.value || "");
      applyCurrentJobSettings();
      selectedIds = new Set();
      renderTable();
    });

    btnClearAllow.addEventListener("click", () => {
      elAllowlist.value = "";
    });

    btnClearDeny.addEventListener("click", () => {
      elDenylist.value = "";
    });

    btnModeAll.addEventListener("click", () => {
      elAllowlist.value = "";
      elDenylist.value = "";
      showToast("Modo todas ativas selecionado (sem filtros de conta).");
    });

    btnSelectAllVisible.addEventListener("click", () => {
      const rows = filterAccounts();
      rows.forEach((row) => selectedIds.add(Number(row.id)));
      renderTable();
    });

    btnUnselectAll.addEventListener("click", () => {
      selectedIds.clear();
      renderTable();
    });

    btnAddAllow.addEventListener("click", () => {
      if (!selectedIds.size) {
        showToast("Selecione pelo menos uma conta.", "error");
        return;
      }
      mergeIntoTextarea(elAllowlist, Array.from(selectedIds));
      showToast("Contas adicionadas na allowlist.");
    });

    btnAddDeny.addEventListener("click", () => {
      if (!selectedIds.size) {
        showToast("Selecione pelo menos uma conta.", "error");
        return;
      }
      mergeIntoTextarea(elDenylist, Array.from(selectedIds));
      showToast("Contas adicionadas na denylist.");
    });

    elAccountsBody.addEventListener("change", (event) => {
      const checkbox = event.target.closest('input[data-role="pick"]');
      if (!checkbox) return;

      const id = Number(checkbox.getAttribute("data-id"));
      if (!Number.isFinite(id) || id <= 0) return;

      if (checkbox.checked) selectedIds.add(id);
      else selectedIds.delete(id);
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    bindEvents();
    await load();
  });
})();

