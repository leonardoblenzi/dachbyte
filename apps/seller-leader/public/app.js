(() => {
  "use strict";

  const state = {
    tab: "geral",
    period: "3d",
    compareMode: "previous_period",
    from: "",
    to: "",
    q: "",
    sku: "",
    impactWindow: "7",
    loading: false,
    payload: null,
    skuCandidates: { meli: [], shopee: [] },
    selectedMeli: null,
    selectedShopee: null,
    tableSearch: "",
    meliAccounts: [],
    selectedMeliAccountId: null,
  };

  const el = {
    body: document.body,
    sidebarToggle: document.getElementById("btn-sidebar-toggle"),
    period: document.getElementById("period"),
    compareMode: document.getElementById("compare-mode"),
    from: document.getElementById("from"),
    to: document.getElementById("to"),
    q: document.getElementById("q"),
    impactWindow: document.getElementById("impact-window"),
    accountCurrent: document.getElementById("account-current"),
    kpis: document.getElementById("kpis"),
    advancedKpis: document.getElementById("advanced-kpis"),
    alerts: document.getElementById("alerts"),
    tableBody: document.getElementById("sku-body"),
    tableMeta: document.getElementById("table-meta"),
    skuTableSearch: document.getElementById("sku-table-search"),
    timeline: document.getElementById("timeline"),
    timelineTitle: document.getElementById("timeline-title"),
    tabs: Array.from(document.querySelectorAll(".tab")),
    tabScopes: Array.from(document.querySelectorAll(".tab-scope")),
    btnApply: document.getElementById("btn-apply"),
    btnExport: document.getElementById("btn-export"),
    btnLogout: document.getElementById("btn-logout"),
    actionForm: document.getElementById("action-form"),
    actionTitle: document.getElementById("action-title"),
    actionChannel: document.getElementById("action-channel"),
    actionType: document.getElementById("action-type"),
    actionDue: document.getElementById("action-due"),
    actionRed: document.getElementById("action-red"),
    actions: document.getElementById("actions"),
    routineForm: document.getElementById("routine-form"),
    routineTitle: document.getElementById("routine-title"),
    routineChannel: document.getElementById("routine-channel"),
    routinePriority: document.getElementById("routine-priority"),
    routineDue: document.getElementById("routine-due"),
    routineWeekday: document.getElementById("routine-weekday"),
    routineAlert: document.getElementById("routine-alert"),
    routines: document.getElementById("routines"),
    topGains: document.getElementById("top-gains"),
    topLosses: document.getElementById("top-losses"),
    impactRanking: document.getElementById("impact-ranking"),
    impactMeta: document.getElementById("impact-meta"),
    adminCard: document.getElementById("admin-card"),
    adminUsers: document.getElementById("admin-users"),
    adminUserForm: document.getElementById("admin-user-form"),
    adminUserName: document.getElementById("admin-user-name"),
    adminUserEmail: document.getElementById("admin-user-email"),
    adminUserRole: document.getElementById("admin-user-role"),
    adminSettingsForm: document.getElementById("admin-settings-form"),
    settingsFocus: document.getElementById("settings-focus"),
    settingsRecovery: document.getElementById("settings-recovery"),
    settingsGrowth: document.getElementById("settings-growth"),
    settingsRoi: document.getElementById("settings-roi"),
    settingsConv: document.getElementById("settings-conv"),
    settingsAlerts: document.getElementById("settings-alerts"),
    skuLinkRef: document.getElementById("sku-link-ref"),
    skuLinkEanMeli: document.getElementById("sku-link-ean-meli"),
    skuLinkEanShopee: document.getElementById("sku-link-ean-shopee"),
    skuLinkSearch: document.getElementById("sku-link-search"),
    skuLinkSearchBtn: document.getElementById("sku-link-search-btn"),
    skuLinkSaveBtn: document.getElementById("sku-link-save-btn"),
    skuCandMeliMeta: document.getElementById("sku-cand-meli-meta"),
    skuCandShopeeMeta: document.getElementById("sku-cand-shopee-meta"),
    skuCandMeli: document.getElementById("sku-cand-meli"),
    skuCandShopee: document.getElementById("sku-cand-shopee"),
    skuLinksList: document.getElementById("sku-links-list"),
    controlledSkusList: document.getElementById("controlled-skus-list"),
    controlledSyncBtn: document.getElementById("controlled-sync-btn"),
    controlledSyncMeta: document.getElementById("controlled-sync-meta"),
    meliAccountSelect: document.getElementById("meli-account-select"),
    meliAccountApply: document.getElementById("meli-account-apply"),
    meliAccountMeta: document.getElementById("meli-account-meta"),
    meliAccountList: document.getElementById("meli-account-list"),
  };

  const money = new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  });

  const number = new Intl.NumberFormat("pt-BR", {
    maximumFractionDigits: 0,
  });

  function esc(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function pct(n) {
    const v = Number(n || 0);
    return `${v.toFixed(1)}%`;
  }

  function fmtDateTime(value) {
    const date = new Date(value || "");
    if (Number.isNaN(date.getTime())) return "-";
    return date.toLocaleString("pt-BR");
  }

  function tone(value) {
    return Number(value || 0) >= 0 ? "up" : "down";
  }

  function qs(params) {
    const out = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value == null) return;
      const raw = String(value).trim();
      if (!raw) return;
      out.set(key, raw);
    });
    return out.toString();
  }

  function isPaymentRequiredPayload(payload) {
    const code = String(payload?.code || payload?.reason || "").toUpperCase();
    return (
      code === "PAYMENT_REQUIRED" ||
      code === "SUBSCRIPTION_INACTIVE" ||
      /payment|required|assinatura|subscription/i.test(
        String(payload?.error || payload?.message || ""),
      )
    );
  }

  function redirectToSubscriptionRenewal() {
    const path = String(window.location.pathname || "");
    if (path.includes("selecao-plataforma") || path.includes("login")) return;

    const key = "davantti_payment_required_redirect_at";
    const now = Date.now();
    const last = Number(sessionStorage.getItem(key) || 0);
    if (Number.isFinite(last) && now - last < 1500) return;

    sessionStorage.setItem(key, String(now));
    window.location.assign("/selecao-plataforma?subscription=expired");
  }

  async function request(path, init = {}) {
    const response = await fetch(path, {
      credentials: "include",
      headers: {
        accept: "application/json",
        ...(init.method && init.method !== "GET"
          ? { "content-type": "application/json" }
          : {}),
      },
      ...init,
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      if (response.status === 402 && isPaymentRequiredPayload(data)) {
        redirectToSubscriptionRenewal();
      }
      if (response.status === 401) {
        window.location.href = data?.redirect || "/skuleader/login";
      }
      throw new Error(data?.error || "Falha na requisicao");
    }

    return data;
  }

  function applyTabVisibility() {
    const dash = ["geral", "meli", "shopee", "controlados"].includes(state.tab);
    el.tabScopes.forEach((node) => {
      const scope = node.getAttribute("data-scope");
      if (scope === "dash") node.hidden = !dash;
      if (scope === "controlados") node.hidden = state.tab !== "controlados";
      if (scope === "skus") node.hidden = state.tab !== "skus";
      if (scope === "config") node.hidden = state.tab !== "config";
    });
    if (el.btnExport) el.btnExport.style.display = dash ? "inline-flex" : "none";
  }

  function syncTabs() {
    el.tabs.forEach((node) => {
      node.classList.toggle(
        "is-active",
        (node.getAttribute("data-tab") || "") === state.tab,
      );
    });
  }

  function initSidebarCollapse() {
    const key = "skuleader.sidebar.collapsed";
    const stored = window.localStorage.getItem(key);
    if (stored === "1") el.body.classList.add("skuleader-sidebar-collapsed");
    if (!el.sidebarToggle) return;
    el.sidebarToggle.addEventListener("click", () => {
      el.body.classList.toggle("skuleader-sidebar-collapsed");
      window.localStorage.setItem(
        key,
        el.body.classList.contains("skuleader-sidebar-collapsed") ? "1" : "0",
      );
    });
  }

  function renderKpis(summary) {
    if (!el.kpis) return;
    const cards = [
      {
        label: "Faturamento",
        value: money.format(Number(summary?.revenue_current || 0)),
        growth: summary?.revenue_growth_pct,
      },
      {
        label: "Crescimento",
        value: pct(summary?.revenue_growth_pct || 0),
        growth: summary?.revenue_growth_pct,
      },
      {
        label: "Unidades",
        value: number.format(Number(summary?.units_current || 0)),
        growth: summary?.units_growth_pct,
      },
      {
        label: "SKUs em conflito",
        value: number.format(Number(summary?.conflicts || 0)),
        growth: -Number(summary?.conflicts || 0),
      },
      { label: "SKUs monitorados", value: number.format(Number(summary?.sku_total || 0)), growth: 0 },
    ];

    el.kpis.innerHTML = cards
      .map(
        (card) => `
        <article class="kpi">
          <span>${esc(card.label)}</span>
          <strong>${esc(card.value)}</strong>
          <small class="${tone(card.growth)}">${esc(pct(card.growth || 0))}</small>
        </article>
      `,
      )
      .join("");
  }

  function renderAdvanced(advanced = {}) {
    if (!el.advancedKpis) return;
    const cards = [
      { label: "Ticket medio", value: money.format(Number(advanced.ticket_medio || 0)) },
      { label: "Dependencia lider", value: pct(advanced.leader_dependency_pct || 0) },
      { label: "Pressao canal apoio", value: pct(advanced.support_pressure_pct || 0) },
      { label: "Acoes efetivas", value: pct(advanced.effective_actions_pct || 0) },
      { label: "Alertas abertos", value: number.format(Number(advanced.open_alerts || 0)) },
      {
        label: "Curva A/B/C",
        value: `${advanced.curve_a_count || 0}/${advanced.curve_b_count || 0}/${advanced.curve_c_count || 0}`,
      },
      {
        label: "SKUs foco/recup.",
        value: `${advanced.focus_sku_count || 0}/${advanced.recovery_sku_count || 0}`,
      },
      { label: "Meta cresc. mensal", value: pct(advanced.monthly_growth_target || 0) },
    ];
    el.advancedKpis.innerHTML = cards
      .map(
        (row) => `
      <article class="advanced-pill">
        <strong>${esc(row.value)}</strong>
        <span>${esc(row.label)}</span>
      </article>`,
      )
      .join("");
  }

  function bindRowSelection() {
    if (!el.tableBody) return;
    Array.from(el.tableBody.querySelectorAll("tr[data-sku]")).forEach((row) => {
      row.addEventListener("click", () => {
        state.sku = row.getAttribute("data-sku") || "";
        load();
      });
    });
  }

  function renderTable(items) {
    if (!el.tableBody || !el.tableMeta) return;
    if (!Array.isArray(items) || !items.length) {
      el.tableBody.innerHTML = `<tr><td colspan="8" class="empty">Nenhum SKU no periodo.</td></tr>`;
      el.tableMeta.textContent = "0 SKUs";
      return;
    }
    const needle = String(state.tableSearch || "").trim().toLowerCase();
    const filtered = needle
      ? items.filter((item) => {
          const skuRef = String(item.sku_ref || item.sku_key || "").toLowerCase();
          const title = String(item.title || "").toLowerCase();
          return skuRef.includes(needle) || title.includes(needle);
        })
      : items;

    el.tableMeta.textContent = `${filtered.length} SKUs cruzados`;
    el.tableBody.innerHTML = filtered
      .map((item) => {
        const totalRevenue = Number(item.total_revenue_current || 0);
        const meliRevenue = Number(item?.meli?.revenue_current || 0);
        const shopeeRevenue = Number(item?.shopee?.revenue_current || 0);
        const currentRevenue =
          state.tab === "meli"
            ? meliRevenue
            : state.tab === "shopee"
              ? shopeeRevenue
              : totalRevenue;
        const previousRevenue =
          state.tab === "meli"
            ? Number(item?.meli?.revenue_previous || 0)
            : state.tab === "shopee"
              ? Number(item?.shopee?.revenue_previous || 0)
              : Number(item.total_revenue_previous || 0);
        const growth = previousRevenue === 0 && currentRevenue === 0
          ? 0
          : previousRevenue === 0
            ? 100
            : ((currentRevenue - previousRevenue) / Math.abs(previousRevenue)) * 100;
        const selected = state.sku === item.sku_key ? "is-selected" : "";
        return `
          <tr class="sku-row ${selected}" data-sku="${esc(item.sku_key)}">
            <td><strong>${esc(item.sku_ref || item.sku_key)}</strong><div class="muted">${esc(item.title || "Produto")}</div></td>
            <td><span class="badge ${esc(item.leader_channel)}">${esc(item.leader_channel)}</span></td>
            <td>${esc(item.strategy || "-")}</td>
            <td>${esc(money.format(totalRevenue))}</td>
            <td>${esc(money.format(meliRevenue))}</td>
            <td>${esc(money.format(shopeeRevenue))}</td>
            <td><span class="growth ${tone(growth)}">${esc(pct(growth))}</span></td>
            <td>${esc(item.suggestion || "-")}</td>
          </tr>
        `;
      })
      .join("");
    if (!filtered.length) {
      el.tableBody.innerHTML = `<tr><td colspan="8" class="empty">Nenhum SKU encontrado na pesquisa da tabela.</td></tr>`;
    }
    bindRowSelection();
  }

  function bindActionStatus() {
    if (!el.actions) return;
    Array.from(el.actions.querySelectorAll("select[data-action-status]")).forEach((select) => {
      select.addEventListener("change", async () => {
        const id = select.getAttribute("data-action-status");
        try {
          await request(`/skuleader/api/actions/${id}`, {
            method: "PATCH",
            body: JSON.stringify({ status: select.value }),
          });
          await load();
        } catch (error) {
          alert(error.message);
        }
      });
    });
  }

  function renderActions(actions = [], windowDays = 7) {
    if (!el.actions) return;
    if (!Array.isArray(actions) || !actions.length) {
      el.actions.innerHTML = `<li><span class="muted">Sem acoes para este SKU.</span></li>`;
      return;
    }
    el.actions.innerHTML = actions
      .map((action) => {
        const impact = action?.impact;
        const impactText = impact
          ? `Antes (${windowDays}d) ${money.format(impact.before_revenue || 0)} / Depois (${windowDays}d) ${money.format(impact.after_revenue || 0)} (${pct(impact.growth_pct || 0)})`
          : "Impacto pendente";
        return `
          <li>
            <div class="head">
              <strong>${esc(action.title)}</strong>
              <select data-action-status="${esc(action.id)}">
                <option value="todo" ${action.status === "todo" ? "selected" : ""}>Todo</option>
                <option value="doing" ${action.status === "doing" ? "selected" : ""}>Doing</option>
                <option value="done" ${action.status === "done" ? "selected" : ""}>Done</option>
                <option value="archived" ${action.status === "archived" ? "selected" : ""}>Archived</option>
              </select>
            </div>
            <div class="meta">${esc(action.channel)} • ${esc(action.action_type)} • vencimento ${esc(action.due_date || "-")}</div>
            <div class="impact ${tone(impact?.growth_pct || 0)}">${esc(impactText)}</div>
          </li>
        `;
      })
      .join("");
    bindActionStatus();
  }

  function bindRoutineActions() {
    if (!el.routines) return;
    Array.from(el.routines.querySelectorAll("select[data-routine-status]")).forEach((select) => {
      select.addEventListener("change", async () => {
        const id = select.getAttribute("data-routine-status");
        try {
          await request(`/skuleader/api/routines/${id}`, {
            method: "PATCH",
            body: JSON.stringify({ status: select.value }),
          });
          await load();
        } catch (error) {
          alert(error.message);
        }
      });
    });
    Array.from(el.routines.querySelectorAll("button[data-routine-del]")).forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-routine-del");
        try {
          await request(`/skuleader/api/routines/${id}`, { method: "DELETE" });
          await load();
        } catch (error) {
          alert(error.message);
        }
      });
    });
  }

  function renderRoutines(routines = []) {
    if (!el.routines) return;
    if (!Array.isArray(routines) || !routines.length) {
      el.routines.innerHTML = `<li><span class="muted">Sem rotinas registradas.</span></li>`;
      return;
    }
    const week = { 1: "Seg", 2: "Ter", 3: "Qua", 4: "Qui", 5: "Sex", 6: "Sab", 7: "Dom" };
    el.routines.innerHTML = routines
      .map((routine) => {
        const due = routine.due_date ? ` • venc. ${routine.due_date}` : "";
        const weekday = routine.weekday ? ` • ${week[routine.weekday] || ""}` : "";
        const alertText = routine.is_alert ? " • aviso" : "";
        return `
          <li>
            <div class="head">
              <strong>${esc(routine.title)}</strong>
              <div style="display:flex;gap:8px;align-items:center;">
                <select data-routine-status="${esc(routine.id)}">
                  <option value="todo" ${routine.status === "todo" ? "selected" : ""}>Todo</option>
                  <option value="doing" ${routine.status === "doing" ? "selected" : ""}>Doing</option>
                  <option value="done" ${routine.status === "done" ? "selected" : ""}>Done</option>
                  <option value="archived" ${routine.status === "archived" ? "selected" : ""}>Archived</option>
                </select>
                <button class="btn btn--ghost" type="button" data-routine-del="${esc(routine.id)}">Excluir</button>
              </div>
            </div>
            <div class="meta">${esc(routine.channel)} • ${esc(routine.priority)}${esc(due)}${esc(weekday)}${esc(alertText)}</div>
            <div class="impact">${esc(routine.details || "Rotina ativa")}</div>
          </li>
        `;
      })
      .join("");
    bindRoutineActions();
  }

  function renderAlerts(alerts = []) {
    if (!el.alerts) return;
    if (!Array.isArray(alerts) || !alerts.length) {
      el.alerts.innerHTML = `<li><span class="muted">Sem avisos no momento.</span></li>`;
      return;
    }
    el.alerts.innerHTML = alerts
      .map((row) => {
        const severity = `severity-${row.severity || "baixa"}`;
        return `
          <li class="alert-item ${esc(severity)}">
            <div class="head"><strong>${esc(row.title || "Aviso")}</strong></div>
            <div class="meta">${esc(row.type || "regra")}</div>
            <div class="impact">${esc(row.detail || "-")}</div>
          </li>
        `;
      })
      .join("");
  }

  function renderImpactRanking(ranking = [], windowDays = 7) {
    if (!el.impactRanking || !el.impactMeta) return;
    el.impactMeta.textContent = `Janela comparativa: ${windowDays} dias antes/depois.`;
    if (!Array.isArray(ranking) || !ranking.length) {
      el.impactRanking.innerHTML = `<li><span class="muted">Sem acoes concluidas para ranking.</span></li>`;
      return;
    }
    el.impactRanking.innerHTML = ranking
      .map(
        (row) => `
        <li>
          <div class="head">
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="rank">${esc(row.rank)}</span>
              <strong>${esc(row.title)}</strong>
            </div>
            <span class="growth ${tone(row.growth_pct)}">${esc(pct(row.growth_pct))}</span>
          </div>
          <div class="meta">${esc(row.channel)} • ${esc(row.status)}</div>
          <div class="impact">Antes ${esc(money.format(row.before_revenue))} | Depois ${esc(money.format(row.after_revenue))}</div>
        </li>
      `,
      )
      .join("");
  }

  function renderMovements(movements = {}) {
    if (!el.topGains || !el.topLosses) return;
    const byChannel = movements?.by_channel || {};
    const channels =
      state.tab === "meli"
        ? [{ key: "meli", label: "MeLi" }]
        : state.tab === "shopee"
          ? [{ key: "shopee", label: "Shopee" }]
          : [{ key: "geral", label: "Geral" }, { key: "meli", label: "MeLi" }, { key: "shopee", label: "Shopee" }];

    function renderChannelRow(row, idx) {
      return `
        <li>
          <div class="head">
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="rank">${idx + 1}</span>
              <strong>${esc(row.sku_ref || row.sku_key)}</strong>
            </div>
            <span class="growth ${tone(row.growth_pct)}">${esc(pct(row.growth_pct))}</span>
          </div>
          <div class="meta">${esc(row.title || "-")}</div>
          <div class="impact">Antes ${esc(money.format(row.previous_revenue || 0))} | Agora ${esc(money.format(row.current_revenue || 0))}</div>
        </li>
      `;
    }

    function section(label, rows, emptyText) {
      const body = rows.length
        ? rows.map((row, idx) => renderChannelRow(row, idx)).join("")
        : `<li><span class="muted">${esc(emptyText)}</span></li>`;
      return `
        <li class="channel-block">
          <div class="channel-title">${esc(label)}</div>
          <ul class="actions actions--nested">${body}</ul>
        </li>
      `;
    }

    el.topGains.innerHTML = channels
      .map((channel) => {
        const rows = Array.isArray(byChannel?.[channel.key]?.top_gains)
          ? byChannel[channel.key].top_gains
          : [];
        return section(channel.label, rows, `Sem ganhos em ${channel.label}.`);
      })
      .join("");

    el.topLosses.innerHTML = channels
      .map((channel) => {
        const rows = Array.isArray(byChannel?.[channel.key]?.top_losses)
          ? byChannel[channel.key].top_losses
          : [];
        return section(channel.label, rows, `Sem quedas em ${channel.label}.`);
      })
      .join("");
  }

  function bindAdminActions() {
    if (!el.adminUsers) return;
    Array.from(el.adminUsers.querySelectorAll("select[data-admin-role]")).forEach((select) => {
      select.addEventListener("change", async () => {
        const id = select.getAttribute("data-admin-role");
        const statusSelect = el.adminUsers.querySelector(`select[data-admin-status='${id}']`);
        try {
          await request(`/skuleader/api/admin/users/${id}`, {
            method: "PATCH",
            body: JSON.stringify({
              role: select.value,
              status: statusSelect ? statusSelect.value : "active",
            }),
          });
          await load();
        } catch (error) {
          alert(error.message);
        }
      });
    });

    Array.from(el.adminUsers.querySelectorAll("select[data-admin-status]")).forEach((select) => {
      select.addEventListener("change", async () => {
        const id = select.getAttribute("data-admin-status");
        const roleSelect = el.adminUsers.querySelector(`select[data-admin-role='${id}']`);
        try {
          await request(`/skuleader/api/admin/users/${id}`, {
            method: "PATCH",
            body: JSON.stringify({
              role: roleSelect ? roleSelect.value : "viewer",
              status: select.value,
            }),
          });
          await load();
        } catch (error) {
          alert(error.message);
        }
      });
    });

    Array.from(el.adminUsers.querySelectorAll("button[data-admin-del]")).forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-admin-del");
        try {
          await request(`/skuleader/api/admin/users/${id}`, { method: "DELETE" });
          await load();
        } catch (error) {
          alert(error.message);
        }
      });
    });
  }

  function renderAdmin(admin) {
    if (!el.adminCard || !el.adminUsers) return;
    if (state.tab !== "admin") {
      el.adminCard.hidden = true;
      return;
    }
    el.adminCard.hidden = false;
    const moduleUsers = Array.isArray(admin?.module_users) ? admin.module_users : [];
    const rows = moduleUsers
      .map(
        (user) => `
          <tr>
            <td>${esc(user.nome || "-")}</td>
            <td>${esc(user.email || "-")}</td>
            <td>
              <select data-admin-role="${esc(user.id)}">
                <option value="admin" ${user.role === "admin" ? "selected" : ""}>Admin</option>
                <option value="analyst" ${user.role === "analyst" ? "selected" : ""}>Analyst</option>
                <option value="viewer" ${user.role === "viewer" ? "selected" : ""}>Viewer</option>
              </select>
            </td>
            <td>
              <select data-admin-status="${esc(user.id)}">
                <option value="active" ${user.status === "active" ? "selected" : ""}>Active</option>
                <option value="inactive" ${user.status === "inactive" ? "selected" : ""}>Inactive</option>
              </select>
            </td>
            <td><button class="btn btn--ghost" type="button" data-admin-del="${esc(user.id)}">Excluir</button></td>
          </tr>
        `,
      )
      .join("");

    el.adminUsers.innerHTML = rows
      ? `<table><thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Status</th><th>Acao</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="muted" style="padding:10px;">Sem usuarios do modulo cadastrados.</div>`;
    bindAdminActions();

    const settings = admin?.company_settings || {};
    if (el.settingsFocus) el.settingsFocus.value = settings.focus_sku_count ?? 5;
    if (el.settingsRecovery) el.settingsRecovery.value = settings.recovery_sku_count ?? 5;
    if (el.settingsGrowth) {
      el.settingsGrowth.value = Number(settings.monthly_growth_target ?? 12);
    }
    if (el.settingsRoi) el.settingsRoi.value = Number(settings.min_roi_target ?? 3);
    if (el.settingsConv) {
      el.settingsConv.value = Number(settings.min_conversion_target ?? 2.5);
    }
    if (el.settingsAlerts) {
      el.settingsAlerts.checked = Boolean(settings.alerts_enabled ?? true);
    }
  }

  function drawTimeline(points = []) {
    if (!el.timeline) return;
    const canvas = el.timeline;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const values = points.map((p) =>
      state.tab === "meli"
        ? Number(p.meli_revenue || 0)
        : state.tab === "shopee"
          ? Number(p.shopee_revenue || 0)
          : Number(p.total_revenue || 0),
    );
    const max = Math.max(1, ...values);
    const minX = 50;
    const maxX = canvas.width - 20;
    const minY = 24;
    const maxY = canvas.height - 28;
    ctx.strokeStyle = "#cbd5e1";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(minX, minY);
    ctx.lineTo(minX, maxY);
    ctx.lineTo(maxX, maxY);
    ctx.stroke();
    if (!points.length) return;
    const step = points.length > 1 ? (maxX - minX) / (points.length - 1) : 0;
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((point, idx) => {
      const x = minX + step * idx;
      const value =
        state.tab === "meli"
          ? Number(point.meli_revenue || 0)
          : state.tab === "shopee"
            ? Number(point.shopee_revenue || 0)
            : Number(point.total_revenue || 0);
      const y = maxY - (value / max) * (maxY - minY);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    points.forEach((point, idx) => {
      const flags = Array.isArray(point.flags) ? point.flags : [];
      if (!flags.some((f) => f.highlight_red)) return;
      const x = minX + step * idx;
      const value =
        state.tab === "meli"
          ? Number(point.meli_revenue || 0)
          : state.tab === "shopee"
            ? Number(point.shopee_revenue || 0)
            : Number(point.total_revenue || 0);
      const y = maxY - (value / max) * (maxY - minY);
      ctx.fillStyle = "#dc2626";
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = "#64748b";
    ctx.font = "11px Manrope, sans-serif";
    ctx.fillText(money.format(max), 6, minY + 4);
    ctx.fillText(money.format(0), 6, maxY + 4);
  }

  function renderSkuCandidates() {
    if (!el.skuCandMeli || !el.skuCandShopee) return;
    const meli = Array.isArray(state.skuCandidates.meli) ? state.skuCandidates.meli : [];
    const shopee = Array.isArray(state.skuCandidates.shopee) ? state.skuCandidates.shopee : [];
    if (el.skuCandMeliMeta) el.skuCandMeliMeta.textContent = `${meli.length} candidatos`;
    if (el.skuCandShopeeMeta) el.skuCandShopeeMeta.textContent = `${shopee.length} candidatos`;

    el.skuCandMeli.innerHTML = meli.length
      ? meli
          .map(
            (row, idx) => `
        <li>
          <label class="sku-option">
            <div class="head"><input type="radio" name="sel-meli" value="${esc(idx)}" ${state.selectedMeli === idx ? "checked" : ""} /> <strong>${esc(row.sku_ref || "-")}</strong></div>
            <div class="meta">${esc(row.title || "-")} ${row.mlb ? `| MLB: ${esc(row.mlb)}` : ""} ${row.ean ? `| EAN: ${esc(row.ean)}` : ""} ${row.item_id ? `| Item: ${esc(row.item_id)}` : ""} ${row.shop_id ? `| Shop: ${esc(row.shop_id)}` : ""} ${row.meli_conta_id ? `| Conta: ${esc(row.meli_conta_id)}` : ""}</div>
          </label>
        </li>
      `,
          )
          .join("")
      : `<li><span class="muted">Nenhum candidato MeLi.</span></li>`;

    el.skuCandShopee.innerHTML = shopee.length
      ? shopee
          .map(
            (row, idx) => `
        <li>
          <label class="sku-option">
            <div class="head"><input type="radio" name="sel-shopee" value="${esc(idx)}" ${state.selectedShopee === idx ? "checked" : ""} /> <strong>${esc(row.sku_ref || "-")}</strong></div>
            <div class="meta">${esc(row.title || "-")} ${row.ean ? `| EAN: ${esc(row.ean)}` : ""} ${row.item_id ? `| Item: ${esc(row.item_id)}` : ""} ${row.shop_id ? `| Shop: ${esc(row.shop_id)}` : ""}</div>
          </label>
        </li>
      `,
          )
          .join("")
      : `<li><span class="muted">Nenhum candidato Shopee.</span></li>`;

    Array.from(document.querySelectorAll("input[name='sel-meli']")).forEach((radio) => {
      radio.addEventListener("change", () => {
        state.selectedMeli = Number(radio.value);
        if (el.skuLinkEanMeli && state.selectedMeli != null) {
          el.skuLinkEanMeli.value = state.skuCandidates.meli[state.selectedMeli]?.ean || "";
        }
      });
    });
    Array.from(document.querySelectorAll("input[name='sel-shopee']")).forEach((radio) => {
      radio.addEventListener("change", () => {
        state.selectedShopee = Number(radio.value);
        if (el.skuLinkEanShopee && state.selectedShopee != null) {
          el.skuLinkEanShopee.value =
            state.skuCandidates.shopee[state.selectedShopee]?.ean || "";
        }
      });
    });
  }

  function renderSkuLinks(links = []) {
    if (!el.skuLinksList) return;
    if (!Array.isArray(links) || !links.length) {
      el.skuLinksList.innerHTML = `<li><span class="muted">Nenhum vinculo salvo.</span></li>`;
      return;
    }
    el.skuLinksList.innerHTML = links
      .map(
        (row) => `
      <li>
        <div class="head">
          <strong>${esc(row.sku_ref || row.sku_key)}</strong>
          <div style="display:flex;gap:8px;">
            <button class="btn" type="button" data-skulink-use="${esc(row.sku_key)}">Analisar</button>
            <button class="btn btn--ghost" type="button" data-skulink-del="${esc(row.id)}">Excluir</button>
          </div>
        </div>
        <div class="meta">MeLi: ${esc(row.meli_sku_ref || "-")} | Shopee: ${esc(row.shopee_sku_ref || "-")} | EAN MeLi: ${esc(row.meli_ean || "-")} | EAN Shopee: ${esc(row.shopee_ean || "-")} | MLB: ${esc(row.meli_mlb || "-")} | Item Shopee: ${esc(row.shopee_item_id || "-")}</div>
      </li>
    `,
      )
      .join("");

    Array.from(el.skuLinksList.querySelectorAll("button[data-skulink-use]")).forEach((btn) => {
      btn.addEventListener("click", () => {
        state.sku = btn.getAttribute("data-skulink-use") || "";
        state.tab = "controlados";
        syncTabs();
        applyTabVisibility();
        load();
      });
    });

    Array.from(el.skuLinksList.querySelectorAll("button[data-skulink-del]")).forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-skulink-del") || "";
        try {
          await request(`/skuleader/api/sku-links/${id}`, { method: "DELETE" });
          await load();
        } catch (error) {
          alert(error.message);
        }
      });
    });
  }

  function renderControlledSkus(items = [], links = []) {
    if (!el.controlledSkusList) return;
    const linkRows = Array.isArray(links) ? links.filter((row) => row?.is_active) : [];
    if (!linkRows.length) {
      el.controlledSkusList.innerHTML = `<li><span class="muted">Nenhum SKU em controle.</span></li>`;
      return;
    }

    const itemMap = new Map((Array.isArray(items) ? items : []).map((row) => [String(row.sku_key), row]));
    el.controlledSkusList.innerHTML = linkRows
      .map((row) => {
        const it = itemMap.get(String(row.sku_key || "")) || null;
        const growth = Number(it?.growth_pct || 0);
        const live = it?.live_metrics || null;
        const hasLive = Boolean(live);
        const revenue = hasLive
          ? Number(live?.meli_revenue || 0) + Number(live?.shopee_revenue || 0)
          : Number(it?.total_revenue_current || 0);
        const meliRevenue = hasLive
          ? Number(live?.meli_revenue || 0)
          : Number(it?.meli?.revenue_current || 0);
        const shopeeRevenue = hasLive
          ? Number(live?.shopee_revenue || 0)
          : Number(it?.shopee?.revenue_current || 0);
        const meliViews = Number(live?.meli_views || 0);
        const meliClicks = Number(live?.meli_clicks || 0);
        const meliUnits = Number(live?.meli_units || 0);
        const meliConv = Number(live?.meli_conversion_pct || 0);
        const shopeeViews = Number(live?.shopee_views || 0);
        const shopeeClicks = Number(live?.shopee_clicks || 0);
        const shopeeUnits = Number(live?.shopee_units || 0);
        const shopeeConv = Number(live?.shopee_conversion_pct || 0);
        const syncedAt = live?.synced_at ? fmtDateTime(live.synced_at) : "-";
        return `
          <li>
            <div class="head">
              <strong>${esc(row.sku_ref || row.sku_key)}</strong>
              <div style="display:flex;gap:8px;">
                <button class="btn" type="button" data-controlled-use="${esc(row.sku_key)}">Analisar</button>
                <button class="btn btn--ghost" type="button" data-controlled-del="${esc(row.id)}">Retirar</button>
              </div>
            </div>
            <div class="meta">Lider: ${esc(it?.leader_channel || "-")} | Crescimento: ${esc(pct(growth))} | Faturamento total: ${esc(money.format(revenue))} | MeLi: ${esc(money.format(meliRevenue))} | Shopee: ${esc(money.format(shopeeRevenue))}</div>
            <div class="impact">MeLi -> Views: ${esc(number.format(meliViews))}, Cliques: ${esc(number.format(meliClicks))}, Vendas: ${esc(number.format(meliUnits))}, Conversao: ${esc(pct(meliConv))} | Shopee -> Views: ${esc(number.format(shopeeViews))}, Cliques: ${esc(number.format(shopeeClicks))}, Vendas: ${esc(number.format(shopeeUnits))}, Conversao: ${esc(pct(shopeeConv))} | Ultimo sync: ${esc(syncedAt)}</div>
          </li>
        `;
      })
      .join("");

    Array.from(el.controlledSkusList.querySelectorAll("button[data-controlled-use]")).forEach((btn) => {
      btn.addEventListener("click", () => {
        state.sku = btn.getAttribute("data-controlled-use") || "";
        load();
      });
    });
    Array.from(el.controlledSkusList.querySelectorAll("button[data-controlled-del]")).forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-controlled-del") || "";
        try {
          await request(`/skuleader/api/sku-links/${id}`, { method: "DELETE" });
          await load();
        } catch (error) {
          alert(error.message);
        }
      });
    });
  }
function renderMeliAccounts() {
    if (!el.meliAccountSelect || !el.meliAccountList || !el.meliAccountMeta) return;
    const rows = Array.isArray(state.meliAccounts) ? state.meliAccounts : [];
    const selected = Number(state.selectedMeliAccountId || 0);

    if (!rows.length) {
      el.meliAccountSelect.innerHTML = `<option value="">Nenhuma conta encontrada</option>`;
      el.meliAccountList.innerHTML = `<li><span class="muted">Nenhuma conta MeLi vinculada encontrada para o acesso atual.</span></li>`;
      el.meliAccountMeta.textContent = "0 contas disponíveis.";
      return;
    }

    el.meliAccountSelect.innerHTML = rows
      .map((row) => {
        const isSel = Number(row.id) === selected ? "selected" : "";
        return `<option value="${esc(row.id)}" ${isSel}>${esc(row.apelido || `Conta ${row.id}`)} (${esc(row.status || "ativa")})</option>`;
      })
      .join("");

    el.meliAccountList.innerHTML = rows
      .map((row) => {
        const isSel = Number(row.id) === selected;
        return `
          <li>
            <div class="head">
              <strong>${esc(row.apelido || `Conta ${row.id}`)}</strong>
              ${isSel ? '<span class="badge meli">ativa no módulo</span>' : ""}
            </div>
            <div class="meta">ID ${esc(row.id)} • usuário MeLi ${esc(row.meli_user_id || "-")} • site ${esc(row.site_id || "MLB")} • status ${esc(row.status || "-")}</div>
            <div class="impact">${esc(row.empresa_nome || "")}</div>
          </li>
        `;
      })
      .join("");

    const selectedRow = rows.find((row) => Number(row.id) === selected) || null;
    el.meliAccountMeta.textContent = selectedRow
      ? `Conta ativa: ${selectedRow.apelido} (ID ${selectedRow.id}).`
      : `${rows.length} contas disponíveis. Selecione uma conta para ativar no módulo.`;
  }

  async function loadMeliAccounts() {
    try {
      const data = await request("/skuleader/api/meli-accounts");
      state.meliAccounts = Array.isArray(data.accounts) ? data.accounts : [];
      state.selectedMeliAccountId = Number(data.selected_id || 0) || null;
      renderMeliAccounts();
    } catch (error) {
      if (el.meliAccountMeta) el.meliAccountMeta.textContent = error.message;
      if (el.meliAccountList) {
        el.meliAccountList.innerHTML = `<li><span class="muted">${esc(error.message)}</span></li>`;
      }
    }
  }

  async function applyMeliAccount() {
    if (!el.meliAccountSelect) return;
    const selectedId = Number(el.meliAccountSelect.value || 0);
    if (!Number.isFinite(selectedId) || selectedId <= 0) {
      alert("Selecione uma conta MeLi válida.");
      return;
    }
    try {
      await request("/skuleader/api/meli-account/select", {
        method: "POST",
        body: JSON.stringify({ meli_account_id: selectedId }),
      });
      state.selectedMeliAccountId = selectedId;
      renderMeliAccounts();
      await load();
      alert("Conta MeLi aplicada com sucesso.");
    } catch (error) {
      alert(error.message);
    }
  }

  function render(payload) {
    state.payload = payload;
    if (el.accountCurrent) {
      const accountLabel = payload?.tenant?.empresa_nome || payload?.user?.name || "Conta";
      el.accountCurrent.textContent = accountLabel;
    }
    renderKpis(payload.summary || {});
    renderAdvanced(payload.advanced_metrics || {});
    renderTable(payload.items || []);
    renderActions(payload.actions || [], Number(payload.impact_window || 7));
    renderRoutines(payload.routines || []);
    renderImpactRanking(payload.impact_ranking || [], Number(payload.impact_window || 7));
    renderMovements(payload.movements || {});
    renderAlerts(payload.alerts || []);
    renderAdmin(payload.admin || {});
    renderSkuLinks(payload.sku_links || []);
    renderControlledSkus(payload.items || [], payload.sku_links || []);
    if (el.controlledSyncMeta) {
      const last = payload?.live_sync?.last_synced_at
        ? fmtDateTime(payload.live_sync.last_synced_at)
        : "nunca";
      el.controlledSyncMeta.textContent = `Sincronização automática a cada 4 horas. Último sync: ${last}.`;
    }
    const selected = (payload.items || []).find((it) => it.sku_key === payload.selected_sku);
    if (el.timelineTitle) {
      el.timelineTitle.textContent = selected
        ? `Evolucao do SKU: ${selected.sku_ref || selected.sku_key}`
        : "Evolucao do SKU";
    }
    drawTimeline(payload.timeline || []);
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    try {
      const query = qs({
        tab: state.tab,
        period: state.period,
        compare_mode: state.compareMode,
        from: state.from,
        to: state.to,
        q: state.q,
        sku: state.sku,
        impact_window: state.impactWindow,
      });
      const payload = await request(`/skuleader/api/overview?${query}`);
      if (!state.from && el.from) el.from.value = payload.range?.from || "";
      if (!state.to && el.to) el.to.value = payload.range?.to || "";
      state.from = payload.range?.from || state.from;
      state.to = payload.range?.to || state.to;
      state.period = payload.range?.period || state.period;
      state.compareMode = payload.compare_mode || state.compareMode;
      state.sku = payload.selected_sku || state.sku;
      state.impactWindow = String(payload.impact_window || state.impactWindow || "7");
      if (el.impactWindow) el.impactWindow.value = state.impactWindow;
      if (el.period) el.period.value = state.period;
      if (el.compareMode) el.compareMode.value = state.compareMode;
      if (el.from) {
        el.from.value = state.from;
        el.from.disabled = state.period !== "custom";
      }
      if (el.to) {
        el.to.value = state.to;
        el.to.disabled = state.period !== "custom";
      }
      render(payload);
    } catch (error) {
      if (el.tableBody) {
        el.tableBody.innerHTML = `<tr><td colspan="8" class="empty">${esc(error.message)}</td></tr>`;
      }
      if (el.kpis) el.kpis.innerHTML = "";
      if (el.actions) el.actions.innerHTML = `<li><span class="muted">${esc(error.message)}</span></li>`;
      if (el.impactRanking) {
        el.impactRanking.innerHTML = `<li><span class="muted">${esc(error.message)}</span></li>`;
      }
      if (el.routines) {
        el.routines.innerHTML = `<li><span class="muted">${esc(error.message)}</span></li>`;
      }
      if (el.alerts) {
        el.alerts.innerHTML = `<li><span class="muted">${esc(error.message)}</span></li>`;
      }
    } finally {
      state.loading = false;
    }
  }

  function applyFilters() {
    state.period = el.period ? el.period.value : state.period;
    state.compareMode = el.compareMode ? el.compareMode.value : state.compareMode;
    state.from = el.from ? el.from.value : state.from;
    state.to = el.to ? el.to.value : state.to;
    state.q = el.q ? el.q.value.trim() : state.q;
    state.impactWindow = el.impactWindow ? el.impactWindow.value : state.impactWindow;
    load();
  }

  async function searchSkuCandidates() {
    const q = (el.skuLinkSearch?.value || "").trim();
    if (q.length < 2) {
      alert("Digite ao menos 2 caracteres para buscar SKU.");
      return;
    }
    try {
      const data = await request(`/skuleader/api/sku-candidates?${qs({ q })}`);
      state.skuCandidates = {
        meli: Array.isArray(data.meli) ? data.meli : [],
        shopee: Array.isArray(data.shopee) ? data.shopee : [],
      };
      state.selectedMeli = state.skuCandidates.meli.length ? 0 : null;
      state.selectedShopee = state.skuCandidates.shopee.length ? 0 : null;
      if (el.skuLinkEanMeli && state.selectedMeli != null) {
        el.skuLinkEanMeli.value = state.skuCandidates.meli[state.selectedMeli]?.ean || "";
      }
      if (el.skuLinkEanShopee && state.selectedShopee != null) {
        el.skuLinkEanShopee.value =
          state.skuCandidates.shopee[state.selectedShopee]?.ean || "";
      }
      renderSkuCandidates();
    } catch (error) {
      alert(error.message);
    }
  }

  async function saveSkuLink() {
    const skuRef = (el.skuLinkRef?.value || "").trim();
    const meli =
      state.selectedMeli != null ? state.skuCandidates.meli[state.selectedMeli] || null : null;
    const shopee =
      state.selectedShopee != null
        ? state.skuCandidates.shopee[state.selectedShopee] || null
        : null;
    const meliEan = (el.skuLinkEanMeli?.value || "").trim();
    const shopeeEan = (el.skuLinkEanShopee?.value || "").trim();
    if (!meli && !shopee && !meliEan && !shopeeEan) {
      alert("Selecione ao menos um SKU de canal (MeLi ou Shopee) ou informe EAN.");
      return;
    }
    if (!skuRef && !meli?.sku_ref && !shopee?.sku_ref && !meliEan && !shopeeEan) {
      alert("Informe um SKU de referencia interno ou EAN para salvar o vinculo.");
      return;
    }
    try {
      await request("/skuleader/api/sku-links", {
        method: "POST",
        body: JSON.stringify({
          sku_ref: skuRef || meli?.sku_ref || shopee?.sku_ref || meliEan || shopeeEan || null,
          sku_key: skuRef || meli?.sku_ref || shopee?.sku_ref || meliEan || shopeeEan || null,
          meli_sku_ref: meli?.sku_ref || null,
          meli_conta_id: meli?.meli_conta_id || null,
          meli_ean: meli?.ean || meliEan || null,
          meli_title: meli?.title || null,
          meli_mlb: meli?.mlb || null,
          shopee_sku_ref: shopee?.sku_ref || null,
          shopee_item_id: shopee?.item_id || null,
          shopee_shop_id: shopee?.shop_id || null,
          shopee_ean: shopee?.ean || shopeeEan || null,
          shopee_title: shopee?.title || null,
          is_active: true,
        }),
      });
      await load();
      alert("Vinculo SKU salvo com sucesso.");
    } catch (error) {
      alert(error.message);
    }
  }

  async function syncControlledMetrics() {
    if (!el.controlledSyncBtn) return;
    const previous = el.controlledSyncBtn.textContent;
    el.controlledSyncBtn.disabled = true;
    el.controlledSyncBtn.textContent = "Atualizando...";
    try {
      const result = await request("/skuleader/api/metrics/sync", {
        method: "POST",
        body: JSON.stringify({ force: true }),
      });
      if (el.controlledSyncMeta) {
        const last = result?.synced_at ? fmtDateTime(result.synced_at) : fmtDateTime(new Date());
        el.controlledSyncMeta.textContent = `Métricas sincronizadas com sucesso às ${last}.`;
      }
      await load();
    } catch (error) {
      alert(error.message);
    } finally {
      el.controlledSyncBtn.disabled = false;
      el.controlledSyncBtn.textContent = previous || "Atualizar métricas";
    }
  }

  if (el.btnApply) el.btnApply.addEventListener("click", applyFilters);

  if (el.period) {
    el.period.addEventListener("change", () => {
      const isCustom = el.period.value === "custom";
      if (el.from) el.from.disabled = !isCustom;
      if (el.to) el.to.disabled = !isCustom;
      if (!isCustom) {
        state.from = "";
        state.to = "";
        if (el.from) el.from.value = "";
        if (el.to) el.to.value = "";
      }
    });
  }

  if (el.q) {
    el.q.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      applyFilters();
    });
  }

  if (el.skuTableSearch) {
    el.skuTableSearch.addEventListener("input", () => {
      state.tableSearch = String(el.skuTableSearch.value || "").trim();
      renderTable(state.payload?.items || []);
    });
  }

  el.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      state.tab = tab.getAttribute("data-tab") || "geral";
      syncTabs();
      applyTabVisibility();
      if (state.tab === "config") {
        loadMeliAccounts();
      }
      load();
    });
  });

  if (el.btnExport) {
    el.btnExport.addEventListener("click", () => {
      const query = qs({
        tab: state.tab,
        period: state.period,
        compare_mode: state.compareMode,
        from: state.from,
        to: state.to,
        q: state.q,
        impact_window: state.impactWindow,
      });
      window.location.href = `/skuleader/api/export.csv?${query}`;
    });
  }

  if (el.btnLogout) {
    el.btnLogout.addEventListener("click", async () => {
      try {
        const response = await fetch("/skuleader/api/auth/logout", {
          method: "POST",
          credentials: "include",
          headers: { accept: "application/json" },
        });
        const data = await response.json().catch(() => null);
        window.location.href = data?.redirect || "/selecao-plataforma";
      } catch (_error) {
        window.location.href = "/selecao-plataforma";
      }
    });
  }

  if (el.actionForm) {
    el.actionForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const selected = (state.payload?.items || []).find((item) => item.sku_key === state.sku);
      if (!selected) {
        alert("Selecione um SKU na tabela antes de adicionar a acao.");
        return;
      }
      try {
        await request("/skuleader/api/actions", {
          method: "POST",
          body: JSON.stringify({
            sku_key: selected.sku_key,
            sku_ref: selected.sku_ref,
            title: el.actionTitle.value.trim(),
            channel: el.actionChannel.value,
            action_type: el.actionType.value,
            due_date: el.actionDue.value || null,
            highlight_red: el.actionRed.checked,
          }),
        });
        el.actionForm.reset();
        await load();
      } catch (error) {
        alert(error.message);
      }
    });
  }

  if (el.routineForm) {
    el.routineForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const selected = (state.payload?.items || []).find((item) => item.sku_key === state.sku);
      try {
        await request("/skuleader/api/routines", {
          method: "POST",
          body: JSON.stringify({
            sku_key: selected ? selected.sku_key : null,
            title: el.routineTitle.value.trim(),
            channel: el.routineChannel.value,
            priority: el.routinePriority.value,
            due_date: el.routineDue.value || null,
            weekday: el.routineWeekday.value || null,
            is_alert: el.routineAlert.checked,
          }),
        });
        el.routineForm.reset();
        el.routineAlert.checked = true;
        await load();
      } catch (error) {
        alert(error.message);
      }
    });
  }

  if (el.adminUserForm) {
    el.adminUserForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await request("/skuleader/api/admin/users", {
          method: "POST",
          body: JSON.stringify({
            nome: el.adminUserName.value.trim() || null,
            email: el.adminUserEmail.value.trim(),
            role: el.adminUserRole.value,
            status: "active",
          }),
        });
        el.adminUserForm.reset();
        await load();
      } catch (error) {
        alert(error.message);
      }
    });
  }

  if (el.adminSettingsForm) {
    el.adminSettingsForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await request("/skuleader/api/admin/settings", {
          method: "PUT",
          body: JSON.stringify({
            focus_sku_count: el.settingsFocus.value,
            recovery_sku_count: el.settingsRecovery.value,
            monthly_growth_target: el.settingsGrowth.value,
            min_roi_target: el.settingsRoi.value,
            min_conversion_target: el.settingsConv.value,
            alerts_enabled: el.settingsAlerts.checked,
          }),
        });
        await load();
      } catch (error) {
        alert(error.message);
      }
    });
  }

  if (el.skuLinkSearchBtn) el.skuLinkSearchBtn.addEventListener("click", searchSkuCandidates);
  if (el.skuLinkSaveBtn) el.skuLinkSaveBtn.addEventListener("click", saveSkuLink);
  if (el.controlledSyncBtn) el.controlledSyncBtn.addEventListener("click", syncControlledMetrics);
  if (el.meliAccountApply) el.meliAccountApply.addEventListener("click", applyMeliAccount);

  if (el.skuLinkSearch) {
    el.skuLinkSearch.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      searchSkuCandidates();
    });
  }

  initSidebarCollapse();
  syncTabs();
  applyTabVisibility();
  renderSkuCandidates();
  loadMeliAccounts();
  load();
})();



