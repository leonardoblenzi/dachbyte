"use strict";

(() => {
  const state = {
    token: "",
    items: [],
    user: null,
  };

  const els = {
    user: document.getElementById("user-pill"),
    metricGrid: document.getElementById("metric-grid"),
    alerts: document.getElementById("alert-list"),
    statusBars: document.getElementById("status-bars"),
    carrierBars: document.getElementById("carrier-bars"),
    channelBars: document.getElementById("channel-bars"),
    table: document.getElementById("items-table"),
    statusFilter: document.getElementById("filter-status"),
    queryFilter: document.getElementById("filter-q"),
    applyFilters: document.getElementById("apply-filters"),
    rules: document.getElementById("rule-list"),
    sourceList: document.getElementById("source-list"),
    intelipostForm: document.getElementById("intelipost-form"),
    tenantBox: document.getElementById("intelipost-tenant-box"),
    clientId: document.getElementById("intelipost-client-id"),
    apiKey: document.getElementById("intelipost-api-key"),
    restBaseUrl: document.getElementById("intelipost-rest-base-url"),
    trackingGraphqlUrl: document.getElementById("intelipost-tracking-graphql-url"),
    shipmentSearchPath: document.getElementById("intelipost-shipment-search-path"),
    syncEnabled: document.getElementById("intelipost-sync-enabled"),
    syncNow: document.getElementById("sync-now"),
    auditList: document.getElementById("audit-list"),
    drawer: document.getElementById("detail-drawer"),
    drawerClose: document.getElementById("drawer-close"),
    drawerContent: document.getElementById("drawer-content"),
    toast: document.getElementById("toast"),
  };

  const moneyFormatter = new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  });

  function money(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "sem dado";
    return moneyFormatter.format(Number(value));
  }

  function labelStatus(status) {
    const labels = {
      nao_sincronizado: "Nao sincronizado",
      dados_incompletos: "Dados incompletos",
      sem_divergencia: "Sem divergencia",
      dentro_tolerancia: "Dentro da tolerancia",
      aguardando_conciliacao: "Aguardando conciliacao",
      divergencia_aprovada: "Divergencia aprovada",
      divergencia_contestada: "Divergencia contestada",
      pre_fatura_gerada: "Pre-fatura gerada",
      fechado: "Fechado",
    };
    return labels[status] || status || "Nao informado";
  }

  function statusTone(status) {
    if (["sem_divergencia", "dentro_tolerancia", "fechado"].includes(status)) return "good";
    if (["dados_incompletos", "aguardando_conciliacao"].includes(status)) return "warn";
    if (["divergencia_contestada"].includes(status)) return "bad";
    return "neutral";
  }

  async function api(path, options = {}) {
    const headers = {
      ...(options.headers || {}),
    };
    if (state.token) headers.authorization = `Bearer ${state.token}`;
    if (options.body && !(options.body instanceof FormData)) {
      headers["content-type"] = "application/json";
    }

    const response = await fetch(`/davanttilog${path}`, {
      ...options,
      headers,
      body:
        options.body && !(options.body instanceof FormData)
          ? JSON.stringify(options.body)
          : options.body,
    });

    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json")
      ? await response.json().catch(() => ({}))
      : await response.text();

    if (!response.ok) {
      const message = payload?.error || payload?.message || "Falha na operacao.";
      throw new Error(message);
    }
    return payload;
  }

  function toast(message) {
    if (!els.toast) return;
    els.toast.textContent = message;
    els.toast.hidden = false;
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(() => {
      els.toast.hidden = true;
    }, 3600);
  }

  async function bootstrapSession() {
    try {
      const payload = await api("/api/auth/session", { method: "POST" });
      state.token = payload.token;
      state.user = payload.user;
      if (els.user) {
        els.user.textContent = `${payload.user.name || payload.user.email} - ${payload.user.role}`;
      }
    } catch (_error) {
      window.location.href = "/go/davanttilog";
    }
  }

  function renderMetrics(totals) {
    const metrics = [
      ["Pedidos no periodo", totals.total_orders, "base importada"],
      ["Conciliados", totals.reconciled_orders, "sem divergencia ou tolerancia"],
      ["Com divergencia", totals.divergent_orders, "fora da regra"],
      ["Aguardando analise", totals.pending_review, "fila operacional"],
      ["Cobrado transportadoras", money(totals.total_carrier_amount), "CT-e/fatura"],
      ["Previsto TMS", money(totals.total_tms_amount), "Intelipost"],
      ["Pago pelos clientes", money(totals.total_customer_amount), "marketplaces"],
      ["Esperado Davantti", money(totals.total_davantti_expected_amount), "regras aplicadas"],
      ["Dif. transportadora x TMS", money(totals.total_tms_difference), "formula auditavel"],
      ["Dif. transportadora x Davantti", money(totals.total_davantti_difference), "formula auditavel"],
      ["Margem total", money(totals.total_margin), "cliente - transportadora"],
      ["Valor contestavel", money(totals.contestable_amount), "acima da tolerancia"],
    ];
    els.metricGrid.innerHTML = metrics
      .map(
        ([label, value, hint]) => `
          <article class="metric">
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(String(value))}</strong>
            <small>${escapeHtml(hint)}</small>
          </article>
        `,
      )
      .join("");
  }

  function renderAlerts(alerts) {
    els.alerts.innerHTML = alerts
      .map(
        (alert) => `
          <article class="alert">
            <strong>${escapeHtml(alert.text)}</strong>
            <small>${escapeHtml(alert.source)}</small>
          </article>
        `,
      )
      .join("");
  }

  function renderBars(container, rows, currency = false) {
    const max = Math.max(1, ...rows.map((row) => Math.abs(Number(row.value) || 0)));
    container.innerHTML = rows
      .map((row) => {
        const value = Number(row.value) || 0;
        const width = Math.max(4, Math.round((Math.abs(value) / max) * 100));
        return `
          <div class="bar-row">
            <span>${escapeHtml(row.label)}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
            <strong>${currency ? money(value) : value}</strong>
          </div>
        `;
      })
      .join("");
  }

  function itemRow(item) {
    return `
      <tr>
        <td><span class="status" data-tone="${statusTone(item.status)}">${labelStatus(item.status)}</span></td>
        <td>${escapeHtml(item.order_id)}<br><small>${escapeHtml(item.marketplace_order_number || "")}</small></td>
        <td>${escapeHtml(item.sales_channel)}</td>
        <td>${escapeHtml(item.carrier_name)}<br><small>${escapeHtml(item.delivery_service || "")}</small></td>
        <td>${money(item.customer_paid_shipping_amount)}</td>
        <td>${money(item.tms_expected_amount)}</td>
        <td>${money(item.carrier_charged_amount)}</td>
        <td>${money(item.davantti_expected_amount)}</td>
        <td>${money(item.davantti_difference_amount)}</td>
        <td>${money(item.freight_margin_amount)}</td>
        <td>${escapeHtml(item.rule?.name || "")}<br><small>v${escapeHtml(item.rule?.version || "")}</small></td>
        <td>
          <div class="row-actions">
            <button data-action="details" data-id="${escapeHtml(item.id)}" type="button" title="Detalhes">i</button>
            <button data-action="approve" data-id="${escapeHtml(item.id)}" type="button" title="Aprovar">A</button>
            <button data-action="contest" data-id="${escapeHtml(item.id)}" type="button" title="Contestar">C</button>
          </div>
        </td>
      </tr>
    `;
  }

  function renderItems(items) {
    state.items = items;
    els.table.innerHTML = items.map(itemRow).join("");
  }

  async function loadDashboard() {
    const payload = await api("/api/dashboard");
    renderMetrics(payload.totals);
    renderAlerts(payload.alerts || []);
    renderBars(els.statusBars, payload.charts?.by_status || []);
    renderBars(els.carrierBars, payload.charts?.by_carrier || [], true);
    renderBars(els.channelBars, payload.charts?.by_channel || [], true);
  }

  async function loadItems() {
    const params = new URLSearchParams();
    if (els.statusFilter.value) params.set("status", els.statusFilter.value);
    if (els.queryFilter.value.trim()) params.set("q", els.queryFilter.value.trim());
    const payload = await api(`/api/reconciliation/items?${params.toString()}`);
    renderItems(payload.items || []);
  }

  async function loadRules() {
    const payload = await api("/api/rules");
    els.rules.innerHTML = (payload.rules || [])
      .map(
        (rule) => `
          <article class="rule">
            <strong>${escapeHtml(rule.name)} v${escapeHtml(rule.version)}</strong>
            <small>Prioridade ${escapeHtml(rule.priority)} - ${escapeHtml(rule.operation)} - tolerancia ${escapeHtml(JSON.stringify(rule.tolerance))}</small>
          </article>
        `,
      )
      .join("");
  }

  async function loadIntelipostConfig() {
    const payload = await api("/api/intelipost/config");
    const config = payload.config || {};
    const tenant = payload.tenant || {};
    if (els.tenantBox) {
      els.tenantBox.innerHTML = `
        <strong>Empresa:</strong> ${escapeHtml(tenant.id || config.tenant_id || "tenant atual")}
        <br><strong>Armazenamento:</strong> ${escapeHtml(config.storage || "memory")}
        ${config.updated_at ? `<br><strong>Atualizado em:</strong> ${escapeHtml(config.updated_at)}` : ""}
      `;
    }
    els.clientId.value = config.intelipost_client_id || "";
    els.restBaseUrl.value = config.rest_base_url || "";
    els.trackingGraphqlUrl.value = config.tracking_graphql_url || "";
    els.shipmentSearchPath.value = config.shipment_search_path || "";
    els.syncEnabled.checked = config.sync_enabled === true;
    els.apiKey.placeholder = config.api_key_configured
      ? "API Key ja configurada"
      : "Nao exibida apos salvar";
    els.sourceList.innerHTML = (config.supported_sources || [])
      .map((source) => `<div class="source">${escapeHtml(source)}</div>`)
      .join("");
  }

  async function loadAudit() {
    const payload = await api("/api/audit/actions");
    els.auditList.innerHTML = (payload.actions || [])
      .map(
        (entry) => `
          <article class="audit-row">
            <strong>${escapeHtml(entry.action_type)} ${entry.item_id ? `- ${escapeHtml(entry.item_id)}` : ""}</strong>
            <small>${escapeHtml(entry.created_at)} - ${escapeHtml(entry.created_by || "")}<br>${escapeHtml(entry.reason || "")}</small>
          </article>
        `,
      )
      .join("");
  }

  async function openDetails(id) {
    const payload = await api(`/api/reconciliation/items/${encodeURIComponent(id)}`);
    const item = payload.item;
    const formula = item.audit_formula || {};
    els.drawerContent.innerHTML = `
      <h2>${escapeHtml(item.order_id)}</h2>
      <p>${escapeHtml(item.sales_channel)} - ${escapeHtml(item.carrier_name)} - ${labelStatus(item.status)}</p>
      <div class="formula-grid">
        ${formulaCard("Frete cobrado", formula.carrier_charged_amount)}
        ${formulaCard("Frete TMS", formula.tms_expected_amount)}
        ${formulaCard("Frete cliente", formula.customer_paid_shipping_amount)}
        ${formulaCard("Frete Davantti", formula.davantti_expected_amount)}
        <div class="formula-card">
          <span>Divergencia Davantti</span>
          <strong>${money(item.davantti_difference_amount)}</strong>
        </div>
        <div class="formula-card">
          <span>Margem de frete</span>
          <strong>${money(item.freight_margin_amount)}</strong>
        </div>
      </div>
      <h3>Evidencias</h3>
      <div class="evidence-list">
        ${(item.evidence || [])
          .map(
            (entry) => `
              <div class="formula-card">
                <span>${escapeHtml(entry.type)}</span>
                <strong>${escapeHtml(entry.label)}</strong>
                <small>${escapeHtml(entry.captured_at || "")}</small>
              </div>
            `,
          )
          .join("")}
      </div>
      <h3>Historico</h3>
      <div class="evidence-list">
        ${(payload.actions || [])
          .map(
            (entry) => `
              <div class="formula-card">
                <span>${escapeHtml(entry.created_at)}</span>
                <strong>${escapeHtml(entry.action_type)}</strong>
                <small>${escapeHtml(entry.reason || "")}</small>
              </div>
            `,
          )
          .join("")}
      </div>
    `;
    els.drawer.classList.add("is-open");
    els.drawer.setAttribute("aria-hidden", "false");
  }

  function formulaCard(label, value) {
    return `
      <div class="formula-card">
        <span>${escapeHtml(label)}</span>
        <strong>${money(value?.value)}</strong>
        <small>${escapeHtml(value?.source || "sem fonte")} ${value?.captured_at ? `- ${escapeHtml(value.captured_at)}` : ""}</small>
      </div>
    `;
  }

  async function performItemAction(id, action) {
    const payload = await api(`/api/reconciliation/items/${encodeURIComponent(id)}/action`, {
      method: "POST",
      body: { action },
    });
    toast(`Status atualizado: ${labelStatus(payload.item.status)}`);
    await Promise.all([loadDashboard(), loadItems(), loadAudit()]);
  }

  function bindTabs() {
    document.querySelectorAll(".nav-tabs button[data-view]").forEach((button) => {
      button.addEventListener("click", () => {
        const view = button.dataset.view;
        document.querySelectorAll(".nav-tabs button").forEach((item) => {
          item.classList.toggle("is-active", item === button);
        });
        document.querySelectorAll(".view").forEach((panel) => {
          panel.classList.toggle("is-active", panel.id === `view-${view}`);
        });
      });
    });
  }

  function bindEvents() {
    els.applyFilters.addEventListener("click", () => loadItems().catch((error) => toast(error.message)));
    els.table.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const { id, action } = button.dataset;
      if (action === "details") {
        openDetails(id).catch((error) => toast(error.message));
        return;
      }
      performItemAction(id, action).catch((error) => toast(error.message));
    });
    els.drawerClose.addEventListener("click", () => {
      els.drawer.classList.remove("is-open");
      els.drawer.setAttribute("aria-hidden", "true");
    });
    els.intelipostForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await api("/api/intelipost/config", {
          method: "POST",
          body: {
            intelipost_client_id: els.clientId.value.trim(),
            api_key: els.apiKey.value.trim(),
            rest_base_url: els.restBaseUrl.value.trim(),
            tracking_graphql_url: els.trackingGraphqlUrl.value.trim(),
            shipment_search_path: els.shipmentSearchPath.value.trim(),
            sync_enabled: els.syncEnabled.checked,
          },
        });
        els.apiKey.value = "";
        toast("Integracao Intelipost salva.");
        await loadIntelipostConfig();
      } catch (error) {
        toast(error.message);
      }
    });
    els.syncNow.addEventListener("click", async () => {
      try {
        const payload = await api("/api/intelipost/sync", {
          method: "POST",
          body: { type: "period", period: "current" },
        });
        toast(`Sync ${payload.sync.status}`);
      } catch (error) {
        toast(error.message);
      }
    });
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  async function init() {
    bindTabs();
    bindEvents();
    await bootstrapSession();
    await Promise.all([
      loadDashboard(),
      loadItems(),
      loadRules(),
      loadIntelipostConfig(),
      loadAudit(),
    ]);
  }

  init().catch((error) => {
    toast(error.message);
  });
})();
