(function initBasePath() {
  if (typeof window === "undefined") return;
  if (window.__ML_BASE_PATH != null) return;
  const p = window.location && window.location.pathname ? window.location.pathname : "";
  window.__ML_BASE_PATH = p === "/ml" || p.startsWith("/ml/") ? "/ml" : "";
})();

function withBase(path) {
  const base =
    typeof window !== "undefined" && window.__ML_BASE_PATH
      ? window.__ML_BASE_PATH
      : "";
  if (!path || typeof path !== "string") return path;
  if (!base) return path;
  if (path === base || path.startsWith(base + "/")) return path;
  if (path.startsWith("/")) return base + path;
  return path;
}

(() => {
  const $ = (id) => document.getElementById(id);

  const tabEventos = $("tab-eventos");
  const tabRetencao = $("tab-retencao");
  const panelEventos = $("panel-eventos");
  const panelRetencao = $("panel-retencao");
  const auditTbody = $("audit-tbody");
  const auditCountPill = $("audit-count-pill");
  const auditRangeInfo = $("audit-range-info");
  const auditPageInfo = $("audit-page-info");
  const btnAuditPrev = $("btn-audit-prev");
  const btnAuditNext = $("btn-audit-next");
  const btnRefreshEvents = $("btn-refresh-events");
  const btnRunCleanup = $("btn-run-cleanup");
  const btnApplyFilters = $("btn-apply-filters");
  const btnExportAuditXlsx = $("btn-export-audit-xlsx");
  const btnClearFilters = $("btn-clear-filters");
  const btnReloadRules = $("btn-reload-rules");
  const btnSaveRules = $("btn-save-rules");
  const retentionTbody = $("retention-tbody");
  const cleanupTbody = $("cleanup-tbody");
  const cleanupSummary = $("cleanup-summary");
  const toast = $("toast");
  const fSearch = $("f-search");
  const fMlb = $("f-mlb");
  const fPromotionId = $("f-promotion-id");
  const fEvento = $("f-evento");
  const fStatus = $("f-status");
  const fDateFrom = $("f-date-from");
  const fTimeFrom = $("f-time-from");
  const fDateTo = $("f-date-to");
  const fTimeTo = $("f-time-to");

  let auditPage = 1;
  const auditLimit = 25;
  let auditTotal = 0;
  let lastRules = [];

  function showToast(message) {
    toast.textContent = message;
    toast.style.display = "block";
    setTimeout(() => {
      toast.style.display = "none";
    }, 3200);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatDate(value) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "-";
    return date.toLocaleString("pt-BR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function combineDateTime(dateValue, timeValue) {
    const date = String(dateValue || "").trim();
    if (!date) return "";
    const time = String(timeValue || "").trim();
    return time ? `${date}T${time}` : date;
  }

  function statusBadge(status) {
    const normalized = String(status || "info").toLowerCase();
    return `<span class="status-pill status-${escapeHtml(normalized)}">${escapeHtml(
      normalized,
    )}</span>`;
  }

  function formatPercent(value) {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(String(value).replace("%", "").replace(",", "."));
    if (!Number.isFinite(n)) return String(value);
    return `${n.toLocaleString("pt-BR", {
      minimumFractionDigits: n % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    })}%`;
  }

  function promotionSummaryLabel(metadata, promotionId) {
    const name =
      metadata.promotion_name ||
      metadata.campaign_name ||
      metadata.promotion_title ||
      metadata?.promotion?.name ||
      metadata?.campaign?.name ||
      null;
    if (!name) return promotionId;
    if (!promotionId) return name;
    return `${name} (${promotionId})`;
  }

  function auditDetailSummary(metadata) {
    if (!metadata || typeof metadata !== "object") return "";

    const mlb = metadata.mlb_id || metadata.item_id || metadata.mlb || null;
    const promotionId = metadata.promotion_id || null;
    const promotionLabel = promotionSummaryLabel(metadata, promotionId);
    const definedPercent = formatPercent(
      metadata.requested_percent ??
      metadata.defined_percent ??
        metadata.filter_percent ??
        metadata.percent_max ??
        metadata.seller_manual_percent ??
        metadata.deal_manual_percent,
    );
    const estimatedPercent = formatPercent(
      metadata.estimated_applied_percent ??
        metadata.estimated_percent ??
        metadata.pre_validation_percent,
    );
    const realAppliedPercent = formatPercent(
      metadata.real_applied_percent ?? metadata.applied_percent,
    );
    const fields = [
      ["MLB", mlb],
      ["Promocao", promotionLabel],
      ["Tipo", metadata.promotion_type],
      ["% solicitada", definedPercent],
      ["% estimada", estimatedPercent],
      ["% aplicada real", realAppliedPercent],
      ["Origem", metadata.application_source],
      ["Qtd. selecao", metadata.selection_count],
      ["Faixas atacado", metadata.wholesale_tier_count],
      ["% atacado min", formatPercent(metadata.wholesale_min_discount_percent)],
      ["% atacado max", formatPercent(metadata.wholesale_max_discount_percent)],
      ["Base atacado", metadata.wholesale_base_price],
      ["Campo", metadata.field],
      ["Valor anterior", metadata.previous_value ?? metadata.previous_days],
      ["Valor solicitado", metadata.requested_value ?? metadata.requested_days],
      ["Valor aplicado", metadata.applied_value ?? metadata.applied_days],
      ["Status item", metadata.item_status],
      ["Acao", metadata.action],
      ["Job", metadata.job_id],
      ["Rota", metadata.route],
      ["Metodo", metadata.method],
      ["Conta", metadata.accountLabel || metadata.accountKey],
      ["Resposta ML", metadata.ml_status],
    ].filter(([, value]) => value !== null && value !== undefined && value !== "");

    if (!fields.length) return "";
    return `<div class="audit-detail-summary">${fields
      .map(
        ([label, value]) =>
          `<span class="audit-detail-field"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</span>`,
      )
      .join("")}</div>`;
  }

  async function api(path, options = {}) {
    const res = await fetch(withBase(path), {
      credentials: "include",
      cache: "no-store",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data?.error || data?.message || `HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }

    return data;
  }

  async function loadMe() {
    try {
      const data = await api("/api/auth/me", { method: "GET" });
      const nivel = String(data?.user?.nivel || "").toLowerCase();
      const isMaster = data?.is_master === true || nivel === "admin_master";
      if (!isMaster) {
        window.location.href = withBase("/nao-autorizado");
        return false;
      }
      return true;
    } catch (_err) {
      window.location.href = withBase("/login");
      return false;
    }
  }

  function setActiveTab(mode) {
    const eventsMode = mode !== "retencao";
    tabEventos.classList.toggle("active", eventsMode);
    tabRetencao.classList.toggle("active", !eventsMode);
    tabEventos.setAttribute("aria-selected", eventsMode ? "true" : "false");
    tabRetencao.setAttribute("aria-selected", !eventsMode ? "true" : "false");
    panelEventos.hidden = !eventsMode;
    panelRetencao.hidden = eventsMode;
  }

  function populateEventFilter(rules) {
    const previous = fEvento.value;
    const specificRules = (rules || []).filter((rule) => rule.evento !== "*");
    fEvento.innerHTML =
      `<option value="">Todos</option>` +
      specificRules
        .map(
          (rule) =>
            `<option value="${escapeHtml(rule.evento)}">${escapeHtml(
              rule.evento,
            )}</option>`,
        )
        .join("");
    if ([...fEvento.options].some((option) => option.value === previous)) {
      fEvento.value = previous;
    }
  }

  function renderAuditRows(events) {
    if (!events.length) {
      auditTbody.innerHTML =
        `<tr><td colspan="6" class="table-empty">Nenhum evento encontrado.</td></tr>`;
      return;
    }

    auditTbody.innerHTML = events
      .map((event) => {
        const metadataObject =
          event?.metadata && typeof event.metadata === "object" ? event.metadata : null;
        const metadata =
          metadataObject
            ? JSON.stringify(metadataObject, null, 2)
            : event?.metadata
              ? String(event.metadata)
              : "-";
        const identity = event.email || event.user_nome || "-";
        return `
          <tr>
            <td>${escapeHtml(formatDate(event.created_at))}</td>
            <td>
              <div>${escapeHtml(identity)}</div>
              <div class="hint">${escapeHtml(event.user_nome || "")}</div>
            </td>
            <td><span class="event-badge">${escapeHtml(event.evento)}</span></td>
            <td>${statusBadge(event.status)}</td>
            <td>${escapeHtml(event.ip || "-")}</td>
            <td>
              ${auditDetailSummary(metadataObject)}
              <details class="audit-json">
                <summary>Ver detalhes completos</summary>
                <pre class="meta-block">${escapeHtml(metadata)}</pre>
              </details>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  function buildAuditFilterParams() {
    const params = new URLSearchParams();
    const generalSearch = fSearch.value.trim();
    if (/^MLB\d+$/i.test(generalSearch) && !fMlb.value.trim()) {
      params.set("mlb_ids", generalSearch);
    } else if (/^(?:[A-Z]+-)?MLB[A-Z0-9_-]+$/i.test(generalSearch) && !fPromotionId.value.trim()) {
      params.set("promotion_ids", generalSearch);
    } else if (generalSearch) {
      params.set("search", generalSearch);
    }
    if (fMlb.value.trim()) params.set("mlb_ids", fMlb.value.trim());
    if (fPromotionId.value.trim()) {
      params.set("promotion_ids", fPromotionId.value.trim());
    }
    if (fEvento.value) params.set("evento", fEvento.value);
    if (fStatus.value) params.set("status", fStatus.value);
    const dateFrom = combineDateTime(fDateFrom.value, fTimeFrom?.value || "");
    const dateTo = combineDateTime(fDateTo.value, fTimeTo?.value || "");
    if (dateFrom) params.set("date_from", dateFrom);
    if (dateTo) params.set("date_to", dateTo);
    return params;
  }

  async function loadEvents() {
    auditTbody.innerHTML =
      `<tr><td colspan="6" class="table-empty">Carregando eventos...</td></tr>`;

    const params = buildAuditFilterParams();
    params.set("page", String(auditPage));
    params.set("limit", String(auditLimit));

    try {
      const data = await api(`/api/admin/auditoria/eventos?${params.toString()}`, {
        method: "GET",
      });

      const total = Number(data.total || 0);
      auditTotal = total;
      const pages = Math.max(1, Math.ceil(total / auditLimit));
      auditPage = Math.min(Math.max(1, auditPage), pages);

      renderAuditRows(Array.isArray(data.events) ? data.events : []);
      auditCountPill.textContent = `${total} evento${total === 1 ? "" : "s"}`;
      auditPageInfo.textContent = `${auditPage} / ${pages}`;
      btnAuditPrev.disabled = auditPage <= 1;
      btnAuditNext.disabled = auditPage >= pages;

      if (!total) {
        auditRangeInfo.textContent = "Nenhum evento encontrado";
      } else {
        const start = (auditPage - 1) * auditLimit + 1;
        const end = Math.min(auditPage * auditLimit, total);
        auditRangeInfo.textContent = `Mostrando ${start}-${end} de ${total}`;
      }
    } catch (err) {
      auditTbody.innerHTML = `<tr><td colspan="6" class="table-empty">${escapeHtml(
        err.message,
      )}</td></tr>`;
    }
  }

  function exportAuditXlsx() {
    const params = buildAuditFilterParams();
    params.set("limit", "50000");
    window.location.href = withBase(
      `/api/admin/auditoria/eventos/export.xlsx?${params.toString()}`,
    );
  }

  function renderRetentionRules(rules) {
    if (!rules.length) {
      retentionTbody.innerHTML =
        `<tr><td colspan="3" class="table-empty">Nenhuma regra encontrada.</td></tr>`;
      return;
    }

    retentionTbody.innerHTML = rules
      .map(
        (rule) => `
          <tr>
            <td><span class="event-badge">${escapeHtml(rule.evento)}</span></td>
            <td>${escapeHtml(rule.descricao || "-")}</td>
            <td>
              <input
                class="retention-input"
                type="number"
                min="1"
                step="1"
                data-evento="${escapeHtml(rule.evento)}"
                value="${Number(rule.retention_days) || 1}"
              />
            </td>
          </tr>
        `,
      )
      .join("");
  }

  async function loadRetentionRules() {
    retentionTbody.innerHTML =
      `<tr><td colspan="3" class="table-empty">Carregando regras...</td></tr>`;

    try {
      const data = await api("/api/admin/auditoria/retencao", { method: "GET" });
      lastRules = Array.isArray(data.rules) ? data.rules : [];
      renderRetentionRules(lastRules);
      populateEventFilter(lastRules);
    } catch (err) {
      retentionTbody.innerHTML = `<tr><td colspan="3" class="table-empty">${escapeHtml(
        err.message,
      )}</td></tr>`;
    }
  }

  async function saveRules() {
    const inputs = [...retentionTbody.querySelectorAll("input[data-evento]")];
    const rules = inputs.map((input) => {
      const source = lastRules.find((rule) => rule.evento === input.dataset.evento);
      return {
        evento: input.dataset.evento,
        descricao: source?.descricao || null,
        retention_days: Number(input.value),
      };
    });

    btnSaveRules.disabled = true;
    btnSaveRules.textContent = "Salvando...";

    try {
      const data = await api("/api/admin/auditoria/retencao", {
        method: "PUT",
        body: JSON.stringify({ rules }),
      });
      lastRules = Array.isArray(data.rules) ? data.rules : [];
      renderRetentionRules(lastRules);
      populateEventFilter(lastRules);
      showToast("Prazos de retencao salvos.");
    } catch (err) {
      alert(`Erro ao salvar regras: ${err.message}`);
    } finally {
      btnSaveRules.disabled = false;
      btnSaveRules.textContent = "Salvar prazos";
    }
  }

  function renderCleanupResult(result) {
    const deletedTotal = Number(result?.deletedTotal || 0);
    cleanupSummary.textContent = `${deletedTotal.toLocaleString("pt-BR")} registros removidos nesta limpeza.`;

    const rows = Array.isArray(result?.deletedByEvent) ? result.deletedByEvent : [];
    if (!rows.length) {
      cleanupTbody.innerHTML =
        `<tr><td colspan="3" class="table-empty">Nenhum detalhe retornado.</td></tr>`;
      return;
    }

    cleanupTbody.innerHTML = rows
      .map(
        (row) => `
          <tr>
            <td><span class="event-badge">${escapeHtml(row.evento)}</span></td>
            <td>${Number(row.retention_days || 0).toLocaleString("pt-BR")}</td>
            <td>${Number(row.deleted || 0).toLocaleString("pt-BR")}</td>
          </tr>
        `,
      )
      .join("");
  }

  async function runCleanup() {
    const confirmed = window.confirm(
      "Executar a limpeza manual agora? Os registros vencidos serao removidos de forma permanente.",
    );
    if (!confirmed) return;

    btnRunCleanup.disabled = true;
    btnRunCleanup.textContent = "Limpando...";

    try {
      const data = await api("/api/admin/auditoria/cleanup", { method: "POST" });
      renderCleanupResult(data);
      await loadEvents();
      showToast(
        `${Number(data.deletedTotal || 0).toLocaleString("pt-BR")} registros removidos.`,
      );
    } catch (err) {
      alert(`Erro ao executar limpeza: ${err.message}`);
    } finally {
      btnRunCleanup.disabled = false;
      btnRunCleanup.textContent = "Rodar limpeza agora";
    }
  }

  function clearFilters() {
    fSearch.value = "";
    fMlb.value = "";
    fPromotionId.value = "";
    fEvento.value = "";
    fStatus.value = "";
    fDateFrom.value = "";
    if (fTimeFrom) fTimeFrom.value = "";
    fDateTo.value = "";
    if (fTimeTo) fTimeTo.value = "";
    auditPage = 1;
    loadEvents();
  }

  function bindEvents() {
    tabEventos.addEventListener("click", () => setActiveTab("eventos"));
    tabRetencao.addEventListener("click", () => setActiveTab("retencao"));
    btnRefreshEvents.addEventListener("click", () => loadEvents());
    btnApplyFilters.addEventListener("click", () => {
      auditPage = 1;
      loadEvents();
    });
    btnExportAuditXlsx?.addEventListener("click", exportAuditXlsx);
    btnClearFilters.addEventListener("click", clearFilters);
    btnAuditPrev.addEventListener("click", () => {
      if (auditPage <= 1) return;
      auditPage -= 1;
      loadEvents();
    });
    btnAuditNext.addEventListener("click", () => {
      const pages = Math.max(1, Math.ceil(auditTotal / auditLimit));
      if (auditPage >= pages) return;
      auditPage += 1;
      loadEvents();
    });
    btnReloadRules.addEventListener("click", loadRetentionRules);
    btnSaveRules.addEventListener("click", saveRules);
    btnRunCleanup.addEventListener("click", runCleanup);

    [fSearch, fMlb, fPromotionId].forEach((input) => {
      input?.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          auditPage = 1;
          loadEvents();
        }
      });
    });
    [fDateFrom, fTimeFrom, fDateTo, fTimeTo].forEach((input) => {
      input?.addEventListener("change", () => {
        auditPage = 1;
      });
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    bindEvents();
    const ok = await loadMe();
    if (!ok) return;
    await loadRetentionRules();
    await loadEvents();
  });
})();
