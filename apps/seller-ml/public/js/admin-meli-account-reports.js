"use strict";

(() => {
  const accountSelect = document.getElementById("account-select");
  const periodDays = document.getElementById("period-days");
  const customPeriodFields = document.getElementById("custom-period-fields");
  const periodFrom = document.getElementById("period-from");
  const periodTo = document.getElementById("period-to");
  const accountCard = document.getElementById("account-card");
  const btnRefresh = document.getElementById("btn-refresh");
  const btnGenerate = document.getElementById("btn-generate");
  const statusTitle = document.getElementById("status-title");
  const statusMeta = document.getElementById("status-meta");
  const statusBadge = document.getElementById("status-badge");
  const progressBar = document.getElementById("progress-bar");
  const logsEl = document.getElementById("logs");
  const historyBody = document.getElementById("history-body");
  const historyCount = document.getElementById("history-count");
  const toast = document.getElementById("toast");

  let accounts = [];
  let pollTimer = null;

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatDateTime(value) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "-";
    return date.toLocaleString("pt-BR");
  }

  function formatDateInput(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function setDefaultCustomPeriod() {
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - 29);
    const todayValue = formatDateInput(today);
    if (periodFrom && !periodFrom.value) periodFrom.value = formatDateInput(start);
    if (periodTo && !periodTo.value) periodTo.value = todayValue;
    if (periodFrom) periodFrom.max = todayValue;
    if (periodTo) periodTo.max = todayValue;
  }

  function syncCustomPeriodFields() {
    const isCustom = periodDays?.value === "custom";
    if (customPeriodFields) {
      customPeriodFields.hidden = !isCustom;
      customPeriodFields.style.display = isCustom ? "grid" : "none";
    }
    if (isCustom) setDefaultCustomPeriod();
  }

  function customPeriodPayload() {
    const from = String(periodFrom?.value || "").trim();
    const to = String(periodTo?.value || "").trim();
    if (!from || !to) throw new Error("Informe a data inicial e a data final.");
    if (from > to) throw new Error("A data inicial deve ser anterior ou igual a data final.");
    return { periodFrom: from, periodTo: to };
  }

  function showToast(message, tone = "ok") {
    if (!toast) return;
    toast.textContent = message;
    toast.style.display = "block";
    toast.style.borderColor = tone === "error" ? "#fecaca" : "#bfdbfe";
    setTimeout(() => { toast.style.display = "none"; }, 2600);
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
      const error = new Error(data?.error || data?.message || `HTTP ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  function selectedAccount() {
    const id = Number(accountSelect?.value || 0);
    return accounts.find((account) => Number(account.id) === id) || null;
  }

  function renderAccountCard() {
    const account = selectedAccount();
    if (!account) {
      accountCard.textContent = "Selecione uma conta para iniciar.";
      return;
    }
    accountCard.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;">
        <div><strong>${escapeHtml(account.apelido || `Conta ${account.id}`)}</strong><div class="muted">${escapeHtml(account.empresaNome || "-")}</div></div>
        <div><span class="muted">ML User</span><br><strong>${escapeHtml(account.meliUserId || "-")}</strong></div>
        <div><span class="muted">Status</span><br><strong>${escapeHtml(account.status || "-")}</strong></div>
        <div><span class="muted">Token</span><br><strong>${account.hasTokens ? "Disponivel" : "Sem token"}</strong></div>
      </div>
    `;
  }

  function badge(status) {
    const value = String(status || "").toUpperCase();
    if (value === "SUCCESS") return ["Concluido", "badge badge--success"];
    if (value === "FAILED") return ["Erro", "badge badge--danger"];
    if (value === "RUNNING") return ["Em andamento", "badge badge--info"];
    return ["Aguardando", "badge"];
  }

  function renderHistory(reports) {
    const rows = Array.isArray(reports) ? reports : [];
    historyCount.textContent = `${rows.length} relatorio${rows.length === 1 ? "" : "s"}`;
    if (!rows.length) {
      historyBody.innerHTML = `<tr><td colspan="8">Nenhum relatorio gerado para esta selecao.</td></tr>`;
      return;
    }
    historyBody.innerHTML = rows.map((report) => {
      const [label, klass] = badge(report.status);
      const canDownload = String(report.status || "").toUpperCase() === "SUCCESS";
      return `
        <tr>
          <td>${escapeHtml(report.id || "-")}</td>
          <td>${escapeHtml(report.accountLabel || report.meliUserId || "-")}</td>
          <td>${escapeHtml(formatDateTime(report.periodFrom))} ate ${escapeHtml(formatDateTime(report.periodTo))}</td>
          <td><span class="${klass}">${escapeHtml(label)}</span></td>
          <td>${escapeHtml(report.progress || 0)}%</td>
          <td>${escapeHtml(formatDateTime(report.createdAt))}</td>
          <td>${escapeHtml(formatDateTime(report.expiresAt))}</td>
          <td>
            <button class="btn-lite" type="button" data-watch="${escapeHtml(report.id)}">Logs</button>
            <button class="btn-primary" type="button" data-download="${escapeHtml(report.id)}" data-format="xlsx" ${canDownload ? "" : "disabled"}>XLSX</button>
            <button class="btn-primary" type="button" data-download="${escapeHtml(report.id)}" data-format="pdf" ${canDownload ? "" : "disabled"}>PDF</button>
          </td>
        </tr>
      `;
    }).join("");
  }

  async function loadHistory() {
    const account = selectedAccount();
    const qs = account ? `?meliContaId=${encodeURIComponent(String(account.id))}` : "";
    const data = await api(`/api/admin/meli-account-reports/history${qs}`, { method: "GET" });
    renderHistory(data.reports || []);
  }

  function renderStatus(report) {
    const [label, klass] = badge(report?.status);
    statusTitle.textContent = `Relatorio #${report?.id || "-"}`;
    statusMeta.textContent = report?.currentStep || "Processando...";
    statusBadge.className = klass;
    statusBadge.textContent = label;
    progressBar.style.width = `${Math.max(0, Math.min(100, Number(report?.progress || 0)))}%`;
    const logs = Array.isArray(report?.logs) ? report.logs : [];
    logsEl.textContent = logs.length
      ? logs.map((entry) => `[${formatDateTime(entry.at)}] ${entry.message}`).join("\n")
      : "Sem logs ainda.";
    logsEl.scrollTop = logsEl.scrollHeight;
  }

  async function pollReport(reportId) {
    const data = await api(`/api/admin/meli-account-reports/${encodeURIComponent(String(reportId))}/status`, { method: "GET" });
    const report = data.report;
    renderStatus(report);
    const status = String(report?.status || "").toUpperCase();
    if (status === "SUCCESS" || status === "FAILED") {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      await loadHistory().catch(() => {});
    }
  }

  function startPolling(reportId) {
    if (pollTimer) clearInterval(pollTimer);
    pollReport(reportId).catch((error) => showToast(error.message, "error"));
    pollTimer = setInterval(() => {
      pollReport(reportId).catch((error) => showToast(error.message, "error"));
    }, 2500);
  }

  async function loadAccounts() {
    const data = await api("/api/admin/meli-account-reports/accounts", { method: "GET" });
    accounts = Array.isArray(data.accounts) ? data.accounts : [];
    if (!accounts.length) {
      accountSelect.innerHTML = `<option value="">Nenhuma conta ML encontrada</option>`;
      renderAccountCard();
      renderHistory([]);
      return;
    }
    accountSelect.innerHTML = accounts.map((account) => {
      const label = `${account.empresaNome || "Empresa"} - ${account.apelido || account.meliUserId || account.id}`;
      return `<option value="${escapeHtml(account.id)}">${escapeHtml(label)}</option>`;
    }).join("");
    renderAccountCard();
    await loadHistory();
  }

  async function generate() {
    const account = selectedAccount();
    if (!account) {
      showToast("Selecione uma conta ML.", "error");
      return;
    }
    btnGenerate.disabled = true;
    btnGenerate.textContent = "Gerando...";
    try {
      const periodPayload = periodDays?.value === "custom"
        ? customPeriodPayload()
        : { periodDays: Number(periodDays?.value || 90) };
      const data = await api("/api/admin/meli-account-reports/generate", {
        method: "POST",
        body: JSON.stringify({
          meliContaId: account.id,
          ...periodPayload,
        }),
      });
      if (!data?.report?.id) throw new Error("API nao retornou o ID do relatorio.");
      showToast("Relatorio iniciado.");
      startPolling(data.report.id);
      await loadHistory();
    } catch (error) {
      showToast(error.message || "Falha ao iniciar relatorio.", "error");
    } finally {
      btnGenerate.disabled = false;
      btnGenerate.textContent = "Gerar relatorio";
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    btnRefresh?.addEventListener("click", () => loadAccounts().catch((error) => showToast(error.message, "error")));
    btnGenerate?.addEventListener("click", generate);
    accountSelect?.addEventListener("change", () => {
      renderAccountCard();
      loadHistory().catch((error) => showToast(error.message, "error"));
    });
    periodDays?.addEventListener("change", syncCustomPeriodFields);
    periodFrom?.addEventListener("change", () => {
      if (periodTo) periodTo.min = periodFrom.value || "";
    });
    periodTo?.addEventListener("change", () => {
      if (periodFrom) periodFrom.max = periodTo.value || formatDateInput(new Date());
    });
    historyBody?.addEventListener("click", (event) => {
      const watch = event.target.closest("[data-watch]");
      if (watch) {
        startPolling(watch.getAttribute("data-watch"));
        return;
      }
      const download = event.target.closest("[data-download]");
      if (download) {
        const id = download.getAttribute("data-download");
        const format = download.getAttribute("data-format");
        const url = `/api/admin/meli-account-reports/${encodeURIComponent(String(id))}/download/${encodeURIComponent(String(format))}`;
        window.open(typeof window.withBase === "function" ? window.withBase(url) : url, "_blank");
      }
    });
    syncCustomPeriodFields();
    await loadAccounts().catch((error) => {
      historyBody.innerHTML = `<tr><td colspan="8">Erro: ${escapeHtml(error.message)}</td></tr>`;
      showToast(error.message, "error");
    });
  });
})();
