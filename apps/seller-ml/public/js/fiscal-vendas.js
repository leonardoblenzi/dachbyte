(() => {
  "use strict";

  const HOUR_MS = 60 * 60 * 1000;
  const RISK_WINDOW_MS = 48 * HOUR_MS;
  const ML_SALES_LOOKBACK_MONTHS = 12;

  const QUICK_FILTER_LABELS = {
    late: "Pedidos atrasados",
    risk: "Pedidos em risco",
    fabrication: "Fabricacao critica",
    dispatch_late: "Despacho atrasado",
    dispatch_today: "Despacha hoje",
    dispatch_risk: "Despacho em risco",
    logistics: "Aguardando coleta/transporte",
    action: "Precisa de acao agora",
    healthy: "Saude da operacao",
  };

  const els = {
    form: document.getElementById("fv-form"),
    status: document.getElementById("fv-status"),
    body: document.getElementById("fv-body"),
    subtitle: document.getElementById("fv-subtitle"),
    exportCsv: document.getElementById("fv-export-csv"),
    dateLimit: document.getElementById("fv-date-limit"),
    activeFilter: document.getElementById("fv-active-filter"),
    activeFilterLabel: document.getElementById("fv-active-filter-label"),
    clearFilter: document.getElementById("fv-clear-filter"),
    opCards: Array.from(document.querySelectorAll("[data-quick-filter]")),
    opLate: document.getElementById("fv-op-late"),
    opRisk: document.getElementById("fv-op-risk"),
    opFabrication: document.getElementById("fv-op-fabrication"),
    opDispatchLate: document.getElementById("fv-op-dispatch-late"),
    opDispatchToday: document.getElementById("fv-op-dispatch-today"),
    opDispatchRisk: document.getElementById("fv-op-dispatch-risk"),
    opLogistics: document.getElementById("fv-op-logistics"),
    opAction: document.getElementById("fv-op-action"),
    opHealth: document.getElementById("fv-op-health"),
    chipTotal: document.getElementById("fv-chip-total"),
    chipMe1: document.getElementById("fv-chip-me1"),
    chipMe2: document.getElementById("fv-chip-me2"),
    chipSem: document.getElementById("fv-chip-sem"),
    chipSemSla: document.getElementById("fv-chip-sem-sla"),
  };

  const state = {
    rows: [],
    displayRows: [],
    activeQuickFilter: "",
    lastSummary: {},
    hasLoaded: false,
  };

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function dateToBr(date) {
    return `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()}`;
  }

  function dateToIso(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function isoToDate(iso) {
    const raw = String(iso || "").trim();
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const dt = new Date(year, month - 1, day);
    if (dt.getFullYear() !== year || dt.getMonth() + 1 !== month || dt.getDate() !== day) return null;
    dt.setHours(0, 0, 0, 0);
    return dt;
  }

  function getMinSalesDate() {
    const minDate = new Date();
    minDate.setHours(0, 0, 0, 0);
    minDate.setMonth(minDate.getMonth() - ML_SALES_LOOKBACK_MONTHS);
    return minDate;
  }

  function getMinSalesDateIso() {
    return dateToIso(getMinSalesDate());
  }

  function maskDate(value) {
    const digits = String(value || "").replace(/\D/g, "").slice(0, 8);
    if (digits.length <= 2) return digits;
    if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
    return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
  }

  function parseBrDateToIso(value) {
    const raw = String(value || "").trim();
    const match = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!match) return null;
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    const dt = new Date(Date.UTC(year, month - 1, day));
    if (dt.getUTCFullYear() !== year || dt.getUTCMonth() + 1 !== month || dt.getUTCDate() !== day) return null;
    return `${year}-${pad2(month)}-${pad2(day)}`;
  }

  function parseOperationalDate(value) {
    const raw = String(value ?? "").trim();
    if (!raw || raw === "-") return null;

    const br = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (br) {
      const day = Number(br[1]);
      const month = Number(br[2]);
      const year = Number(br[3]);
      const hour = br[4] == null ? 23 : Number(br[4]);
      const minute = br[5] == null ? 59 : Number(br[5]);
      const second = br[6] == null ? 59 : Number(br[6]);
      const dt = new Date(year, month - 1, day, hour, minute, second);
      if (dt.getFullYear() === year && dt.getMonth() + 1 === month && dt.getDate() === day) return dt;
      return null;
    }

    const isoDateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoDateOnly) {
      const dt = new Date(Number(isoDateOnly[1]), Number(isoDateOnly[2]) - 1, Number(isoDateOnly[3]), 23, 59, 59);
      return Number.isNaN(dt.getTime()) ? null : dt;
    }

    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function normalizeText(value) {
    return String(value ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();
  }

  function onlyDigits(value) {
    return String(value ?? "").replace(/\D/g, "");
  }

  function safeText(value, fallback = "-") {
    const raw = String(value ?? "").trim();
    return raw ? escapeHtml(raw) : fallback;
  }

  function fmtDate(value) {
    const date = parseOperationalDate(value);
    if (!date) {
      const raw = String(value || "").trim();
      return raw && raw !== "-" ? safeText(raw) : "-";
    }
    return escapeHtml(
      date.toLocaleString("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
      }),
    );
  }

  function rowKey(row, index = 0) {
    return String(row?.numero_pedido || row?.order_id || `${row?.mlb || "row"}-${index}`);
  }

  function uniqueCount(rows, predicate = () => true) {
    const keys = new Set();
    rows.forEach((row, index) => {
      if (predicate(row)) keys.add(rowKey(row, index));
    });
    return keys.size;
  }

  function deadlineEntries(row) {
    return [
      { key: "promise", date: parseOperationalDate(row?.prazo_prometido_venda) },
      { key: "dispatch", date: parseOperationalDate(row?.prazo_despacho) },
      { key: "fabrication", date: parseOperationalDate(row?.prazo_fabricacao) },
      { key: "me1", date: parseOperationalDate(row?.prazo_transportadora_me1) },
      { key: "me2", date: parseOperationalDate(row?.prazo_coletas_me2) },
    ].filter((entry) => entry.date);
  }

  function hasNoOperationalDeadline(row) {
    return deadlineEntries(row).length === 0;
  }

  function isWithinRiskWindow(date, now = new Date()) {
    if (!date) return false;
    const diff = date.getTime() - now.getTime();
    return diff >= 0 && diff <= RISK_WINDOW_MS;
  }

  function isPedidoAtrasado(row) {
    const now = new Date();
    return deadlineEntries(row).some((entry) => entry.date.getTime() < now.getTime());
  }

  function isPedidoEmRisco(row) {
    if (isPedidoAtrasado(row)) return false;
    const now = new Date();
    return deadlineEntries(row).some((entry) => isWithinRiskWindow(entry.date, now));
  }

  function isFabricacaoCritica(row) {
    const date = parseOperationalDate(row?.prazo_fabricacao);
    if (!date) return false;
    const now = new Date();
    return date.getTime() < now.getTime() || isWithinRiskWindow(date, now);
  }

  function dispatchDeadline(row) {
    return parseOperationalDate(row?.prazo_despacho);
  }

  function isDespachoAtrasado(row) {
    const date = dispatchDeadline(row);
    return Boolean(date && date.getTime() < Date.now());
  }

  function isSameLocalDay(a, b) {
    return Boolean(a && b) &&
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();
  }

  function isDespachaHoje(row) {
    const date = dispatchDeadline(row);
    if (!date || isDespachoAtrasado(row)) return false;
    return isSameLocalDay(date, new Date());
  }

  function isDespachoEmRisco(row) {
    const date = dispatchDeadline(row);
    return Boolean(date && !isDespachoAtrasado(row) && isWithinRiskWindow(date, new Date()));
  }

  function isAguardandoColetaTransporte(row) {
    const model = normalizeText(row?.modelo_envio).toUpperCase();
    const me1Deadline = parseOperationalDate(row?.prazo_transportadora_me1);
    const me2Deadline = parseOperationalDate(row?.prazo_coletas_me2);
    if (model === "ME1" && !me1Deadline) return true;
    if (model === "ME2" && !me2Deadline) return true;

    const now = new Date();
    return [me1Deadline, me2Deadline].some(
      (date) => date && (date.getTime() < now.getTime() || isWithinRiskWindow(date, now)),
    );
  }

  function isPedidoSaudavel(row) {
    return !hasNoOperationalDeadline(row) &&
      !isPedidoAtrasado(row) &&
      !isPedidoEmRisco(row) &&
      !isFabricacaoCritica(row) &&
      !isAguardandoColetaTransporte(row);
  }

  function getStatusOperacional(row) {
    if (isPedidoAtrasado(row)) return { key: "late", label: "Atrasado" };
    if (isFabricacaoCritica(row)) return { key: "fabrication", label: "Fabricacao critica" };
    if (isAguardandoColetaTransporte(row)) return { key: "logistics", label: "Aguardando coleta/transporte" };
    if (isPedidoEmRisco(row)) return { key: "risk", label: "Em risco" };
    if (hasNoOperationalDeadline(row)) return { key: "no_deadline", label: "Sem prazo informado" };
    return { key: "healthy", label: "Dentro do prazo" };
  }

  function setStatus(message, tone = "info") {
    if (!els.status) return;
    els.status.textContent = message || "Pronto para consultar.";
    els.status.dataset.tone = tone;
  }

  function setDefaultDates() {
    if (!els.form) return;
    const fromInput = els.form.elements.namedItem("date_from");
    const toInput = els.form.elements.namedItem("date_to");
    if (!(fromInput instanceof HTMLInputElement) || !(toInput instanceof HTMLInputElement)) return;

    if (!toInput.value) toInput.value = dateToBr(new Date());
    if (!fromInput.value) {
      const start = new Date();
      start.setDate(start.getDate() - 29);
      fromInput.value = dateToBr(start);
    }
    enforceDateFromLimit();
  }

  function bindDateMasks() {
    if (!els.form) return;
    for (const name of ["date_from", "date_to"]) {
      const input = els.form.elements.namedItem(name);
      if (!(input instanceof HTMLInputElement)) continue;
      input.addEventListener("input", () => {
        input.value = maskDate(input.value);
      });
      input.addEventListener("blur", () => {
        input.value = maskDate(input.value);
      });
    }
  }

  function renderDateLimitHint() {
    if (!(els.dateLimit instanceof HTMLElement)) return;
    els.dateLimit.textContent = `Mercado Livre permite consulta dos ultimos ${ML_SALES_LOOKBACK_MONTHS} meses. Data inicial minima: ${dateToBr(getMinSalesDate())}.`;
  }

  function enforceDateFromLimit({ announce = false } = {}) {
    if (!els.form) return false;
    const fromInput = els.form.elements.namedItem("date_from");
    if (!(fromInput instanceof HTMLInputElement)) return false;
    const fromIso = parseBrDateToIso(fromInput.value);
    if (!fromIso) return false;
    const minIso = getMinSalesDateIso();
    if (fromIso >= minIso) return false;
    const minDate = isoToDate(minIso);
    fromInput.value = minDate ? dateToBr(minDate) : fromInput.value;
    if (announce) {
      setStatus(`Data inicial ajustada para ${fromInput.value} (limite de ${ML_SALES_LOOKBACK_MONTHS} meses).`, "info");
    }
    return true;
  }

  function bindDateLimitGuard() {
    const fromInput = els.form?.elements.namedItem("date_from");
    if (fromInput instanceof HTMLInputElement) {
      fromInput.addEventListener("blur", () => enforceDateFromLimit({ announce: true }));
    }
  }

  function setLoading(on) {
    const button = els.form?.querySelector("button[type='submit']");
    if (!(button instanceof HTMLButtonElement)) return;
    button.disabled = !!on;
    button.textContent = on ? "Consultando..." : "Consultar pedidos";
  }

  function setExportEnabled(enabled) {
    if (els.exportCsv) els.exportCsv.disabled = !enabled;
  }

  function getLocalFilters() {
    const form = els.form;
    return {
      shippingModel: String(form?.elements.namedItem("shipping_model")?.value || "all"),
      operationalStatus: String(form?.elements.namedItem("operational_status")?.value || "all"),
      cepOrigin: onlyDigits(form?.elements.namedItem("cep_origin")?.value),
      cepDestination: onlyDigits(form?.elements.namedItem("cep_destination")?.value),
      query: normalizeText(form?.elements.namedItem("q")?.value),
    };
  }

  function rowMatchesQuickFilter(row, filter) {
    if (!filter) return true;
    if (filter === "late") return isPedidoAtrasado(row);
    if (filter === "risk") return isPedidoEmRisco(row);
    if (filter === "fabrication") return isFabricacaoCritica(row);
    if (filter === "dispatch_late") return isDespachoAtrasado(row);
    if (filter === "dispatch_today") return isDespachaHoje(row);
    if (filter === "dispatch_risk") return isDespachoEmRisco(row);
    if (filter === "logistics") return isAguardandoColetaTransporte(row);
    if (filter === "action") return isPedidoAtrasado(row) || isPedidoEmRisco(row) || isDespachoAtrasado(row) || isDespachoEmRisco(row);
    if (filter === "healthy") return isPedidoSaudavel(row);
    return true;
  }

  function getFilteredRows({ includeQuickFilter = true } = {}) {
    const filters = getLocalFilters();
    return state.rows.filter((row) => {
      const model = normalizeText(row.modelo_envio).toUpperCase();
      if (filters.shippingModel === "me1" && model !== "ME1") return false;
      if (filters.shippingModel === "me2" && model !== "ME2") return false;
      if (filters.shippingModel === "empty" && model) return false;

      if (filters.operationalStatus !== "all") {
        if (filters.operationalStatus === "no_deadline" && !hasNoOperationalDeadline(row)) return false;
        if (filters.operationalStatus !== "no_deadline" && !rowMatchesQuickFilter(row, filters.operationalStatus)) return false;
      }
      if (filters.cepOrigin && !onlyDigits(row.cep_origem).includes(filters.cepOrigin)) return false;
      if (filters.cepDestination && !onlyDigits(row.cep_destino).includes(filters.cepDestination)) return false;

      if (filters.query) {
        const haystack = normalizeText([
          row.numero_pedido,
          row.nome_cliente,
          row.mlb,
          row.modelo_envio,
        ].join(" "));
        if (!haystack.includes(filters.query)) return false;
      }

      return includeQuickFilter ? rowMatchesQuickFilter(row, state.activeQuickFilter) : true;
    });
  }

  function setText(el, value) {
    if (el) el.textContent = String(value);
  }

  function updateOperationalCards(baseRows = []) {
    const total = uniqueCount(baseRows);
    const late = uniqueCount(baseRows, isPedidoAtrasado);
    const risk = uniqueCount(baseRows, isPedidoEmRisco);
    const fabrication = uniqueCount(baseRows, isFabricacaoCritica);
    const dispatchLate = uniqueCount(baseRows, isDespachoAtrasado);
    const dispatchToday = uniqueCount(baseRows, isDespachaHoje);
    const dispatchRisk = uniqueCount(baseRows, isDespachoEmRisco);
    const logistics = uniqueCount(baseRows, isAguardandoColetaTransporte);
    const actionKeys = new Set();
    baseRows.forEach((row, index) => {
      if (
        isPedidoAtrasado(row) ||
        isPedidoEmRisco(row) ||
        isDespachoAtrasado(row) ||
        isDespachoEmRisco(row)
      ) {
        actionKeys.add(rowKey(row, index));
      }
    });
    const action = actionKeys.size;
    const healthy = Math.max(0, total - action);
    const healthPct = total > 0 ? Math.round((healthy / total) * 100) : 0;

    setText(els.opLate, late);
    setText(els.opRisk, risk);
    setText(els.opFabrication, fabrication);
    setText(els.opDispatchLate, dispatchLate);
    setText(els.opDispatchToday, dispatchToday);
    setText(els.opDispatchRisk, dispatchRisk);
    setText(els.opLogistics, logistics);
    setText(els.opAction, action);
    setText(els.opHealth, `${healthPct}%`);

    const healthCard = document.querySelector('[data-quick-filter="healthy"]');
    healthCard?.classList.toggle("is-good", healthPct >= 85);
    healthCard?.classList.toggle("is-warn", healthPct >= 70 && healthPct < 85);
    healthCard?.classList.toggle("is-bad", healthPct < 70 && total > 0);

    els.opCards.forEach((card) => {
      card.classList.toggle("is-active", card.dataset.quickFilter === state.activeQuickFilter);
    });
  }

  function updateSecondaryChips(baseRows = []) {
    setText(els.chipTotal, uniqueCount(baseRows));
    setText(els.chipMe1, uniqueCount(baseRows, (row) => normalizeText(row.modelo_envio).toUpperCase() === "ME1"));
    setText(els.chipMe2, uniqueCount(baseRows, (row) => normalizeText(row.modelo_envio).toUpperCase() === "ME2"));
    setText(els.chipSem, uniqueCount(baseRows, (row) => !normalizeText(row.modelo_envio)));
    setText(els.chipSemSla, uniqueCount(baseRows, (row) => normalizeText(row.fonte_prazo_despacho) === "indisponivel"));
  }

  function statusBadge(row) {
    const status = getStatusOperacional(row);
    return `<span class="fv-status-badge fv-status-badge--${escapeHtml(status.key)}">${escapeHtml(status.label)}</span>`;
  }

  function dispatchBadge(row) {
    const date = dispatchDeadline(row);
    const source = normalizeText(row?.fonte_prazo_despacho);
    if (!date) {
      return '<span class="fv-deadline fv-deadline--none">Sem SLA</span>';
    }

    let key = "ok";
    let label = "No prazo";
    if (isDespachoAtrasado(row)) {
      key = "late";
      label = "Atrasado";
    } else if (isDespachaHoje(row)) {
      key = "today";
      label = "Hoje";
    } else if (isDespachoEmRisco(row)) {
      key = "risk";
      label = "Em risco";
    }

    const sourceLabel = source === "sla"
      ? "SLA ML"
      : source === "lead_time_fallback"
        ? "Lead time"
        : source === "pedido_fallback"
          ? "Fabricacao"
          : "Fallback";

    return `
      <div class="fv-deadline-wrap">
        <span class="fv-deadline fv-deadline--${key}">${label}</span>
        <small>${fmtDate(row.prazo_despacho)} - ${escapeHtml(sourceLabel)}</small>
      </div>
    `;
  }

  function renderRows(rows = []) {
    if (!els.body) return;

    if (!rows.length) {
      const message = state.hasLoaded
        ? "Nenhum pedido encontrado para os filtros atuais."
        : "Execute uma consulta para carregar os pedidos.";
      els.body.innerHTML =
        `<tr><td colspan="13" class="empty">${message}</td></tr>`;
      return;
    }

    els.body.innerHTML = rows
      .map(
        (row) => `
          <tr>
            <td>${fmtDate(row.data_hora_venda)}</td>
            <td>${safeText(row.nome_cliente)}</td>
            <td>${safeText(row.numero_pedido)}</td>
            <td>${safeText(row.mlb)}</td>
            <td>${safeText(String(row.modelo_envio || "").toUpperCase())}</td>
            <td>${statusBadge(row)}</td>
            <td>${dispatchBadge(row)}</td>
            <td>${safeText(row.cep_origem)}</td>
            <td>${safeText(row.cep_destino)}</td>
            <td>${fmtDate(row.prazo_prometido_venda)}</td>
            <td>${fmtDate(row.prazo_fabricacao)}</td>
            <td>${fmtDate(row.prazo_transportadora_me1)}</td>
            <td>${fmtDate(row.prazo_coletas_me2)}</td>
          </tr>
        `,
      )
      .join("");
  }

  function updateTableContext(baseRows, displayRows) {
    const shown = uniqueCount(displayRows);
    const total = uniqueCount(baseRows);
    if (els.subtitle) {
      els.subtitle.textContent = `Exibindo ${shown} pedidos de ${total} encontrados.`;
    }
    const hasQuick = Boolean(state.activeQuickFilter);
    els.activeFilter?.classList.toggle("fv-hidden", !hasQuick);
    if (els.activeFilterLabel) {
      els.activeFilterLabel.textContent = QUICK_FILTER_LABELS[state.activeQuickFilter] || "";
    }
  }

  function renderDashboard() {
    const baseRows = getFilteredRows({ includeQuickFilter: false });
    const displayRows = getFilteredRows({ includeQuickFilter: true });
    state.displayRows = displayRows;
    updateOperationalCards(baseRows);
    updateSecondaryChips(baseRows);
    renderRows(displayRows);
    updateTableContext(baseRows, displayRows);
    setExportEnabled(displayRows.length > 0);
  }

  function csvEscape(value) {
    const text = String(value ?? "");
    if (!text) return "";
    if (/[";\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  }

  function csvDate(value) {
    const date = parseOperationalDate(value);
    if (!date) return String(value || "").trim();
    return date.toLocaleString("pt-BR", {
      dateStyle: "short",
      timeStyle: "short",
    });
  }

  function buildCsvContent(rows = []) {
    const headers = [
      "Data/Hora da venda",
      "Nome Cliente",
      "Numero do Pedido",
      "MLB",
      "Modelo de Envio",
      "Status operacional",
      "Despachar ate",
      "Status despacho",
      "Fonte despacho",
      "CEP Origem",
      "CEP Destino",
      "Prazo Prometido na venda",
      "Prazo fabricacao",
      "Prazo transportadora (ME1)",
      "Prazo coletas (ME2)",
    ];

    const lines = [headers.join(";")];
    for (const row of rows) {
      lines.push(
        [
          csvDate(row.data_hora_venda),
          row.nome_cliente || "",
          row.numero_pedido || "",
          row.mlb || "",
          String(row.modelo_envio || "").toUpperCase(),
          getStatusOperacional(row).label,
          csvDate(row.prazo_despacho),
          row.status_sla_despacho || "",
          row.fonte_prazo_despacho || "",
          row.cep_origem || "",
          row.cep_destino || "",
          csvDate(row.prazo_prometido_venda),
          csvDate(row.prazo_fabricacao),
          csvDate(row.prazo_transportadora_me1),
          csvDate(row.prazo_coletas_me2),
        ]
          .map(csvEscape)
          .join(";"),
      );
    }

    return `\uFEFF${lines.join("\r\n")}`;
  }

  function downloadTextFile(content, filename, mime = "text/plain;charset=utf-8") {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function buildCsvFilename() {
    const fromRaw = els.form?.querySelector('input[name="date_from"]')?.value || "";
    const toRaw = els.form?.querySelector('input[name="date_to"]')?.value || "";
    return `acompanhamento-pedidos-${parseBrDateToIso(fromRaw) || "inicio"}_a_${parseBrDateToIso(toRaw) || "fim"}.csv`;
  }

  function exportRowsToCsv() {
    const rows = Array.isArray(state.displayRows) ? state.displayRows : [];
    if (!rows.length) {
      setStatus("Sem pedidos para exportar no momento.", "error");
      return;
    }
    downloadTextFile(buildCsvContent(rows), buildCsvFilename(), "text/csv;charset=utf-8");
    setStatus(`CSV exportado com ${uniqueCount(rows)} pedido(s).`, "ok");
  }

  async function fetchSales() {
    if (!els.form) return null;
    enforceDateFromLimit({ announce: true });
    const formData = new FormData(els.form);
    const params = new URLSearchParams();
    const apiFields = new Set(["date_from", "date_to", "max_orders", "date_field"]);

    for (const [key, value] of formData.entries()) {
      if (!apiFields.has(key)) continue;
      const normalized = String(value || "").trim();
      if (!normalized) continue;
      if (key === "date_from" || key === "date_to") {
        const iso = parseBrDateToIso(normalized);
        if (!iso) {
          throw new Error(key === "date_from" ? "Data inicial invalida. Use dd/mm/aaaa." : "Data final invalida. Use dd/mm/aaaa.");
        }
        params.set(key, iso);
        continue;
      }
      params.set(key, normalized);
    }

    const response = await fetch(mlUrl(`/api/fiscal/sales?${params.toString()}`), {
      credentials: "include",
      headers: { accept: "application/json" },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success === false) {
      throw new Error(payload?.error || "Falha ao consultar pedidos.");
    }
    return payload;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    state.activeQuickFilter = "";
    setLoading(true);
    setStatus("Consultando pedidos e prazos operacionais...", "info");
    window.MLLoadingOverlay?.show({
      context: "Logistica",
      label: "Pedidos",
      message: "Consultando pedidos e consolidando prazos logisticos...",
      initialProgress: 12,
      maxProgress: 92,
    });

    try {
      const payload = await fetchSales();
      state.rows = Array.isArray(payload?.rows) ? payload.rows : [];
      state.lastSummary = payload?.summary || {};
      state.hasLoaded = true;
      renderDashboard();
      setStatus(`Consulta finalizada: ${uniqueCount(state.rows)} pedido(s) carregado(s).`, "ok");
    } catch (error) {
      state.rows = [];
      state.displayRows = [];
      state.hasLoaded = true;
      renderDashboard();
      setExportEnabled(false);
      setStatus(error?.message || "Falha ao consultar pedidos.", "error");
    } finally {
      setLoading(false);
      window.MLLoadingOverlay?.hide();
    }
  }

  function bindLocalFilters() {
    const names = ["shipping_model", "operational_status", "cep_origin", "cep_destination", "q"];
    for (const name of names) {
      const input = els.form?.elements.namedItem(name);
      if (!input) continue;
      input.addEventListener("input", renderDashboard);
      input.addEventListener("change", renderDashboard);
    }
  }

  function bindQuickFilters() {
    els.opCards.forEach((card) => {
      card.addEventListener("click", () => {
        const next = card.dataset.quickFilter || "";
        state.activeQuickFilter = state.activeQuickFilter === next ? "" : next;
        renderDashboard();
      });
    });
    els.clearFilter?.addEventListener("click", () => {
      state.activeQuickFilter = "";
      renderDashboard();
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    renderDateLimitHint();
    setDefaultDates();
    bindDateMasks();
    bindDateLimitGuard();
    bindLocalFilters();
    bindQuickFilters();
    setExportEnabled(false);
    renderDashboard();
    els.form?.addEventListener("submit", handleSubmit);
    els.exportCsv?.addEventListener("click", exportRowsToCsv);
  });

  window.MLFiscalPedidos = {
    isPedidoAtrasado,
    isPedidoEmRisco,
    isFabricacaoCritica,
    isDespachoAtrasado,
    isDespachaHoje,
    isDespachoEmRisco,
    isAguardandoColetaTransporte,
    getStatusOperacional,
  };
})();
