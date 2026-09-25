"use strict";

(() => {
  const API = "/magalu/api/master";
  const state = {
    view: "overview",
    session: null,
    accounts: { page: 1, limit: 30, total: 0 },
    operations: { page: 1, limit: 30, total: 0 },
    unlinkAccountId: null,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (value) => String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  const fmtInt = (value) => new Intl.NumberFormat("pt-BR").format(Number(value || 0));
  const fmtDate = (value, withTime = true) => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("pt-BR", withTime
      ? { dateStyle: "short", timeStyle: "short" }
      : { day: "2-digit", month: "2-digit" }).format(date);
  };
  const relative = (value) => {
    if (!value) return "—";
    const ms = Date.now() - new Date(value).getTime();
    if (!Number.isFinite(ms)) return "—";
    if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s atrás`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}min atrás`;
    if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h atrás`;
    return `${Math.round(ms / 86_400_000)}d atrás`;
  };

  async function api(path, options = {}) {
    const response = await fetch(`${API}${path}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
      ...options,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      const error = new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.code = payload?.error || null;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function alert(message, kind = "error") {
    const box = $("#global-alert");
    if (!message) { box.hidden = true; box.textContent = ""; return; }
    box.hidden = false;
    box.textContent = message;
    box.dataset.kind = kind;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function badge(value, kind = "muted") {
    return `<span class="badge badge--${kind}">${esc(value)}</span>`;
  }
  function statusBadge(value) {
    const status = String(value || "unknown").toLowerCase();
    const good = ["active", "succeeded", "success", "synced", "processed", "online"];
    const bad = ["failed", "error", "revoked", "disabled", "uncertain", "divergent", "offline"];
    const warn = ["pending", "queued", "running", "dispatching", "accepted", "stale", "syncing", "partial"];
    return badge(status, good.includes(status) ? "ok" : bad.includes(status) ? "bad" : warn.includes(status) ? "warn" : "muted");
  }
  function short(value, n = 18) {
    const text = String(value || "");
    return text.length > n ? `${text.slice(0, n)}…` : text;
  }
  function qs(params) {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== "" && value != null) search.set(key, String(value));
    });
    return search.toString();
  }

  const viewMeta = {
    overview: ["Visão geral", "Saúde operacional, contas conectadas e execução assíncrona."],
    accounts: ["Contas", "Conexões Magalu, OAuth seguro, sincronização e vínculo com o Hub."],
    operations: ["Operações", "Central de lotes e operações protegidas com rastreabilidade por request-id."],
    audit: ["Auditoria", "Eventos operacionais sanitizados, filtros e exportações."],
    retention: ["Retenção", "Políticas, dry-run e manutenção automática da Auditoria V2."],
    workers: ["Workers e filas", "Heartbeat e métricas BullMQ lidas exclusivamente pelo backend."],
    integrations: ["Integrações", "Estado do Hub resource sync, webhooks e sincronizações."],
  };

  async function switchView(view, { force = false } = {}) {
    if (!viewMeta[view]) view = "overview";
    if (state.view === view && !force) return;
    state.view = view;
    $$("[data-view-panel]").forEach((panel) => panel.classList.toggle("is-visible", panel.dataset.viewPanel === view));
    $$(".master-nav__item").forEach((item) => item.classList.toggle("is-active", item.dataset.view === view));
    $("#page-title").textContent = viewMeta[view][0];
    $("#page-subtitle").textContent = viewMeta[view][1];
    history.replaceState(null, "", `#${view}`);
    await loadView(view);
  }

  async function loadSession() {
    const payload = await api("/session");
    state.session = payload.master;
    const role = $("#master-role");
    role.classList.add("is-ok");
    role.innerHTML = `<span class="dot"></span><div><strong>${esc(payload.master.role)}</strong><small>${esc(payload.master.email || payload.master.user_id)}</small></div>`;
  }

  function renderKpis(data) {
    const a = data.accounts || {};
    const o = data.operationsToday || {};
    const worker = data.worker || {};
    const items = [
      ["Tenants com Magalu", a.tenants, `${fmtInt(a.organizations)} organizações conectadas`],
      ["Contas ativas", a.active, `${fmtInt(a.problem)} com erro/revogadas`],
      ["SKUs sincronizados", data.skus, "SKUs presentes na réplica local"],
      ["Operações massivas hoje", data.massOperationsToday == null ? "—" : data.massOperationsToday, data.capabilities?.massSkuOperations ? "motor massivo disponível" : "Etapa 2 ainda não aplicada"],
      ["Falhas hoje", Number(o.failed || 0) + Number(data.syncToday?.failed || 0), `${fmtInt(o.failed)} writes · ${fmtInt(data.syncToday?.failed)} syncs`],
      ["Uncertain / divergent", Number(o.uncertain || 0) + Number(o.divergent || 0), `${fmtInt(o.uncertain)} uncertain · ${fmtInt(o.divergent)} divergent`],
      ["Worker", worker.online ? "Online" : "Offline", worker.lastHeartbeat ? `heartbeat ${relative(worker.lastHeartbeat)}` : "sem heartbeat"],
      ["Filas pendentes", worker.pending == null ? "—" : worker.pending, "waiting + active + delayed"],
    ];
    $("#overview-kpis").innerHTML = items.map(([label, value, note]) => `<article class="kpi"><span>${esc(label)}</span><strong>${esc(value == null ? 0 : value)}</strong><small>${esc(note)}</small></article>`).join("");
    setWorkerChip(worker);
  }

  function renderSeries(rows = []) {
    const box = $("#overview-series");
    if (!rows.length) { box.innerHTML = '<div class="empty">Sem dados no período.</div>'; return; }
    const max = Math.max(1, ...rows.flatMap((row) => [Number(row.operations || 0), Number(row.failures || 0), Number(row.syncs || 0)]));
    box.innerHTML = rows.map((row) => {
      const op = Math.max(2, Math.round(Number(row.operations || 0) / max * 145));
      const fail = Math.max(2, Math.round(Number(row.failures || 0) / max * 145));
      const sync = Math.max(2, Math.round(Number(row.syncs || 0) / max * 145));
      return `<div class="series-day" title="${fmtDate(row.day, false)} · ${fmtInt(row.operations)} operações · ${fmtInt(row.failures)} falhas · ${fmtInt(row.syncs)} syncs"><div class="series-day__bars"><i class="series-bar" style="height:${op}px"></i><i class="series-bar series-bar--fail" style="height:${fail}px"></i><i class="series-bar series-bar--sync" style="height:${sync}px"></i></div><small>${esc(fmtDate(row.day, false))}</small></div>`;
    }).join("");
  }

  function renderTenants(rows = []) {
    const box = $("#overview-tenants");
    if (!rows.length) { box.innerHTML = '<div class="empty">Nenhum tenant conectado.</div>'; return; }
    const max = Math.max(1, ...rows.map((r) => Number(r.operations_30d || 0) + Number(r.skus || 0) / 20));
    box.innerHTML = rows.map((row) => {
      const score = Number(row.operations_30d || 0) + Number(row.skus || 0) / 20;
      const width = Math.max(3, Math.round(score / max * 100));
      return `<div class="tenant-row"><div class="tenant-row__top"><strong title="${esc(row.dach_tenant_id)}">${esc(short(row.dach_tenant_id, 28))}</strong><span>${fmtInt(row.operations_30d)} ops</span></div><div class="tenant-row__meta"><span>${fmtInt(row.accounts)} contas</span><span>${fmtInt(row.skus)} SKUs</span><span>30 dias</span></div><div class="tenant-meter"><i style="width:${width}%"></i></div></div>`;
    }).join("");
  }

  function renderReadiness(data) {
    const caps = data.capabilities || {};
    const cards = [
      ["Auditoria V2 + retenção", caps.auditV2Retention, caps.auditV2Retention ? "006 detectada" : "006 ausente na main/base atual"],
      ["Gestão massiva de SKUs", caps.massSkuOperations, caps.massSkuOperations ? "007 detectada" : "007 ausente na main/base atual"],
      ["Protected writes", true, "write_operations + reverify disponíveis"],
    ];
    $("#readiness-grid").innerHTML = cards.map(([title, ready, note]) => `<div class="readiness-card"><strong>${esc(title)}</strong><p>${esc(note)}</p>${badge(ready ? "Disponível" : "Aguardando etapa", ready ? "ok" : "warn")}</div>`).join("");
  }

  async function loadOverview() {
    const data = await api("/overview");
    renderKpis(data); renderSeries(data.series); renderTenants(data.tenants); renderReadiness(data);
  }

  function accountFilters() {
    return { search: $("#accounts-search").value.trim(), status: $("#accounts-status").value, page: state.accounts.page, limit: state.accounts.limit };
  }
  async function loadAccounts() {
    const data = await api(`/accounts?${qs(accountFilters())}`);
    state.accounts.total = data.total; state.accounts.page = data.page;
    const body = $("#accounts-body");
    if (!data.rows.length) body.innerHTML = '<tr><td colspan="9" class="empty">Nenhuma conta encontrada.</td></tr>';
    else body.innerHTML = data.rows.map((row) => {
      const scopes = Array.isArray(row.scopes) ? row.scopes : [];
      const tokenStatus = row.access_expires_at && new Date(row.access_expires_at).getTime() > Date.now() ? "válido" : row.access_expires_at ? "expirado" : "ausente";
      return `<tr><td><span class="cell-title">${esc(row.dach_tenant_label || row.dach_tenant_id)}</span><span class="cell-sub">${esc(row.dach_tenant_id)}</span></td><td><span class="cell-title">${esc(row.magalu_tenant_name || "Sem nome")}</span><span class="cell-sub">${esc(row.magalu_tenant_id)}</span></td><td>${statusBadge(row.status)}</td><td><div class="scope-list">${scopes.slice(0,3).map((s)=>`<span title="${esc(s)}">${esc(short(s.replace("open:portfolio-", ""),22))}</span>`).join("")}${scopes.length>3?`<span>+${scopes.length-3}</span>`:""}</div></td><td>${statusBadge(tokenStatus)}<span class="cell-sub">${fmtDate(row.access_expires_at)}</span></td><td>${statusBadge(row.catalog_sync_status)}<span class="cell-sub">${fmtDate(row.catalog_last_synced_at)}</span></td><td>${fmtInt(row.total_skus)}</td><td>${statusBadge(row.hub_sync_status)}<span class="cell-sub">${esc(short(row.hub_resource_key || "—",24))}</span></td><td><button class="link-btn" data-account-detail="${row.id}" type="button">Detalhes</button></td></tr>`;
    }).join("");
    const start = data.total ? (data.page - 1) * data.limit + 1 : 0;
    const end = Math.min(data.total, data.page * data.limit);
    $("#accounts-range").textContent = `${fmtInt(start)}–${fmtInt(end)} de ${fmtInt(data.total)}`;
    $("#accounts-prev").disabled = data.page <= 1;
    $("#accounts-next").disabled = end >= data.total;
  }

  function detailItem(label, value) { return `<div class="detail-item"><span>${esc(label)}</span><strong>${esc(value == null || value === "" ? "—" : value)}</strong></div>`; }
  function scopesHtml(scopes) { return `<div class="scope-list">${(Array.isArray(scopes)?scopes:[]).map((s)=>`<span>${esc(s)}</span>`).join("") || '<span>nenhum</span>'}</div>`; }

  async function openAccount(id) {
    const data = await api(`/accounts/${encodeURIComponent(id)}`);
    const a = data.account; const c = data.counts || {}; const canDestroy = state.session?.can_destroy === true;
    $("#drawer-eyebrow").textContent = "CONTA MAGALU";
    $("#drawer-title").textContent = a.magalu_tenant_name || a.magalu_tenant_id;
    $("#drawer-body").innerHTML = `
      <div class="detail-actions"><button class="btn btn--primary" data-account-test="${a.id}" type="button">Testar conexão</button><button class="btn btn--ghost" data-account-sync="${a.id}" type="button">Forçar sincronização</button><button class="btn btn--ghost" data-account-reconcile="${a.id}" type="button">Reconciliar</button>${canDestroy?`<button class="btn btn--danger" data-account-unlink="${a.id}" type="button">Revogar / desvincular</button>`:""}</div>
      <section class="detail-section"><h3>Identificação</h3><div class="detail-grid">${detailItem("DACH tenant",a.dach_tenant_id)}${detailItem("Magalu tenant",a.magalu_tenant_id)}${detailItem("Organização",a.magalu_tenant_name)}${detailItem("Conectada em",fmtDate(a.connected_at))}</div></section>
      <section class="detail-section"><h3>OAuth</h3><div class="detail-grid">${detailItem("Status",a.status)}${detailItem("Access expiry",fmtDate(a.access_expires_at))}${detailItem("Último refresh",fmtDate(a.last_refresh_at))}${detailItem("Erro refresh",a.last_refresh_error || "—")}</div><div style="margin-top:8px">${scopesHtml(a.scopes)}</div></section>
      <section class="detail-section"><h3>Operação</h3><div class="detail-grid">${detailItem("SKUs",fmtInt(c.skus))}${detailItem("Preços",fmtInt(c.prices))}${detailItem("Estoque",fmtInt(c.stocks))}${detailItem("Última sync",fmtDate(a.catalog_last_synced_at))}</div>${a.catalog_last_error?`<div class="operation-error">${esc(a.catalog_last_error)}</div>`:""}</section>
      <section class="detail-section"><h3>Infra</h3><div class="detail-grid">${detailItem("Hub resource",a.hub_resource_key)}${detailItem("Hub sync",a.hub_sync_status)}${detailItem("Webhooks",(data.webhooks||[]).length)}${detailItem("Operações pendentes",(data.pendingWrites||[]).length)}</div></section>
      <section class="detail-section"><h3>Webhooks</h3>${(data.webhooks||[]).map(w=>`<div class="tenant-row"><div class="tenant-row__top"><strong>${esc(w.topic)}</strong>${statusBadge(w.status)}</div><div class="tenant-row__meta"><span>${fmtDate(w.last_synced_at)}</span></div></div>`).join("") || '<div class="empty">Nenhum webhook cadastrado.</div>'}</section>`;
    $("#drawer").showModal();
  }

  async function accountAction(id, action, success) {
    const btn = $(`[data-account-${action}="${id}"]`);
    if (btn) btn.disabled = true;
    try {
      const result = await api(`/accounts/${id}/${action === "reconcile" ? "reconcile" : action}`, { method: "POST", body: "{}" });
      alert(success, "success");
      if (action === "test") {
        const d = result.diagnostics || {};
        const probes = Object.values(d.probes || {});
        alert(`Teste concluído: ${probes.filter(p=>p?.ok===true).length}/${probes.length} probes acessíveis. Request-ids preservados no detalhe da resposta da API.`, "success");
      }
      await loadAccounts();
    } catch (error) { alert(error.message); }
    finally { if (btn) btn.disabled = false; }
  }

  function operationFilters() {
    return {
      tenant: $("#ops-tenant").value.trim(), account_id: $("#ops-account").value.trim(), user: $("#ops-user").value.trim(),
      status: $("#ops-status").value, sku: $("#ops-sku").value.trim(), batch_id: $("#ops-batch").value.trim(),
      from: $("#ops-from").value, to: $("#ops-to").value, page: state.operations.page, limit: state.operations.limit,
    };
  }
  async function loadOperations() {
    const data = await api(`/operations?${qs(operationFilters())}`);
    state.operations.total = data.total; state.operations.page = data.page;
    const notice = $("#ops-notice"); notice.hidden = !data.notice; notice.textContent = data.notice || "";
    const body = $("#ops-body");
    if (!data.rows.length) body.innerHTML = '<tr><td colspan="15" class="empty">Nenhuma operação encontrada.</td></tr>';
    else body.innerHTML = data.rows.map((row) => `<tr><td><span class="cell-title">${esc(short(row.batch_id,20))}</span><span class="cell-sub">${esc(row.source)}</span></td><td>${esc(short(row.dach_tenant_id,18))}</td><td><span class="cell-title">${esc(row.account_name||row.magalu_tenant_id||row.account_id)}</span><span class="cell-sub">#${esc(row.account_id)}</span></td><td>${esc(short(row.dach_user_id,16))}</td><td><span class="cell-title">${esc(row.operation_type)}</span><span class="cell-sub">${esc(row.action||"")}</span></td><td>${fmtDate(row.created_at)}</td><td>${statusBadge(row.status)}</td><td>${fmtInt(row.total)}</td><td>${fmtInt(row.success)}</td><td>${fmtInt(row.failed)}</td><td>${fmtInt(row.stale)}</td><td>${fmtInt(row.uncertain)}</td><td>${fmtInt(row.divergent)}</td><td>${fmtInt(row.pending)}</td><td><button class="link-btn" data-batch-detail="${esc(row.batch_id)}" type="button">Abrir</button></td></tr>`).join("");
    const start = data.total ? (data.page - 1) * data.limit + 1 : 0; const end = Math.min(data.total, data.page * data.limit);
    $("#ops-range").textContent = `${fmtInt(start)}–${fmtInt(end)} de ${fmtInt(data.total)} lotes`;
    $("#ops-prev").disabled = data.page <= 1; $("#ops-next").disabled = end >= data.total;
  }

  async function openBatch(batchId) {
    const data = await api(`/operations/${encodeURIComponent(batchId)}`);
    $("#drawer-eyebrow").textContent = "LOTE / OPERAÇÃO"; $("#drawer-title").textContent = short(data.batchId, 42);
    $("#drawer-body").innerHTML = `<section class="detail-section"><h3>Itens</h3>${data.items.map((item) => `
      <article class="operation-item"><div class="operation-item__head"><strong>#${item.id} · ${esc(item.sku)}</strong>${statusBadge(item.status)}</div>
      <div class="operation-meta"><span>${esc(item.resource_type)}</span><span>request-id: ${esc(item.request_id||"—")}</span><span>${fmtDate(item.created_at)}</span></div>
      ${item.error_message?`<div class="operation-error"><strong>${esc(item.error_code||"erro")}</strong> · ${esc(item.error_message)}</div>`:""}
      <details><summary>Antes / solicitado / depois</summary><pre class="json-box">${esc(JSON.stringify({before:item.before_payload,requested:item.requested_payload,after:item.after_payload},null,2))}</pre></details>
      ${["uncertain","divergent"].includes(item.status)?`<div style="margin-top:9px"><button class="btn btn--primary btn--small" data-reverify="${item.id}" data-reverify-source="${esc(data.source||"protected_write")}" type="button">Reverificar</button></div>`:""}
      </article>`).join("")}</section>`;
    $("#drawer").showModal();
  }

  async function reverify(id, source="protected_write") {
    const button = $(`[data-reverify="${id}"]`); if (button) button.disabled = true;
    try { const path = source === "mass_sku" ? `/operations/mass/${id}/reverify` : `/operations/write/${id}/reverify`; await api(path, { method:"POST", body:"{}" }); alert(`Reverificação da operação #${id} enfileirada em modo somente-verificação.`, "success"); await loadOperations(); }
    catch (error) { alert(error.message); }
    finally { if (button) button.disabled = false; }
  }

  function setWorkerChip(worker) {
    const chip = $("#worker-chip");
    chip.classList.toggle("is-online", worker?.online === true); chip.classList.toggle("is-offline", worker?.online === false);
    chip.innerHTML = `<i></i>Worker: ${worker?.online ? "online" : "offline"}`;
  }
  async function loadWorkers() {
    const data = await api("/workers"); setWorkerChip(data);
    $("#worker-hero").innerHTML = `<div class="worker-summary"><article class="worker-state"><div class="worker-state__status"><i class="pulse ${data.online?"is-online":""}"></i><div><p class="eyebrow">SELLER-MAGALU-WORKER</p><h2>${data.online?"Online":"Offline"}</h2></div></div><p>Último heartbeat: ${esc(fmtDate(data.lastHeartbeat))} (${esc(relative(data.lastHeartbeat))})</p></article><article class="worker-metric"><small>Filas instaladas</small><strong>${fmtInt(data.queues.filter(q=>q.installed).length)}</strong></article><article class="worker-metric"><small>Pendentes</small><strong>${fmtInt(data.pending)}</strong></article><article class="worker-metric"><small>Processors heartbeat</small><strong>${fmtInt(data.processors.length)}</strong></article></div>`;
    $("#queue-grid").innerHTML = data.queues.map((q) => `<article class="queue-card ${q.installed?"":"is-missing"}"><div class="queue-card__head"><strong>${esc(q.name)}</strong>${q.installed?badge(q.processor===false?"sem processor":"instalada",q.processor===false?"warn":"ok"):badge("não instalada","warn")}</div>${q.installed?`<div class="queue-counts"><div><b>${fmtInt(q.waiting)}</b><small>waiting</small></div><div><b>${fmtInt(q.active)}</b><small>active</small></div><div><b>${fmtInt(q.delayed)}</b><small>delayed</small></div><div><b>${fmtInt(q.failed)}</b><small>failed</small></div><div><b>${fmtInt(q.completed)}</b><small>done</small></div></div>`:`<p class="muted">Depende da etapa ainda não presente na main.</p>`}</article>`).join("");
  }

  function summaryCard(title, rows, note) {
    return `<article class="panel integration-card"><p class="eyebrow">INTEGRAÇÃO</p><h2>${esc(title)}</h2><div class="summary-list">${(rows||[]).map(row=>`<div><span>${esc(row.status||"unknown")}</span><strong>${fmtInt(row.total)}</strong></div>`).join("") || '<div><span>sem registros</span><strong>0</strong></div>'}</div>${note?`<p class="muted">${esc(note)}</p>`:""}</article>`;
  }
  async function loadIntegrations() {
    const data = await api("/integrations");
    $("#integration-grid").innerHTML = summaryCard("Hub resources",data.hubResources,"module_slug = magalu") + summaryCard("Webhooks",data.webhooks,"subscriptions locais Magalu") + summaryCard("Sincronizações · 7 dias",data.syncs7d,"sync_runs no schema magalu");
  }
  async function loadReadinessOnly() {
    const data = await api("/readiness");
    $("#audit-readiness").textContent = data.audit.implementation_ready ? "Migration 006 detectada; backend da Etapa 4 pode ser conectado." : "Indisponível agora: migration 006 não aplicada.";
    $("#retention-readiness").textContent = data.retention.implementation_ready ? "Migration 006 detectada." : "Indisponível agora: migration 006 não aplicada.";
  }

  async function loadView(view) {
    alert(null);
    try {
      if (view === "overview") return await loadOverview();
      if (view === "accounts") return await loadAccounts();
      if (view === "operations") return await loadOperations();
      if (view === "workers") return await loadWorkers();
      if (view === "integrations") return await loadIntegrations();
      if (view === "audit") return await window.MagaluMasterAudit?.loadAudit();
      if (view === "retention") return await window.MagaluMasterAudit?.loadRetention();
    } catch (error) { alert(error.message || "Falha ao carregar o Painel Master."); }
  }

  function bind() {
    $("#master-nav").addEventListener("click", (event) => { const button = event.target.closest("[data-view]"); if (button) void switchView(button.dataset.view); });
    $("#btn-refresh").addEventListener("click", () => void switchView(state.view, { force:true }));
    $("#accounts-filter").addEventListener("click", () => { state.accounts.page=1; void loadAccounts(); });
    $("#accounts-prev").addEventListener("click", () => { if(state.accounts.page>1){state.accounts.page--;void loadAccounts();} });
    $("#accounts-next").addEventListener("click", () => { if(state.accounts.page*state.accounts.limit<state.accounts.total){state.accounts.page++;void loadAccounts();} });
    $("#ops-filter").addEventListener("click", () => { state.operations.page=1; void loadOperations(); });
    $("#ops-prev").addEventListener("click", () => { if(state.operations.page>1){state.operations.page--;void loadOperations();} });
    $("#ops-next").addEventListener("click", () => { if(state.operations.page*state.operations.limit<state.operations.total){state.operations.page++;void loadOperations();} });
    $("#ops-export").addEventListener("click", () => { const params=operationFilters(); delete params.page; delete params.limit; window.location.href=`${API}/operations/export.csv?${qs(params)}`; });

    document.addEventListener("click", (event) => {
      const accountDetail = event.target.closest("[data-account-detail]"); if(accountDetail) return void openAccount(accountDetail.dataset.accountDetail).catch(e=>alert(e.message));
      const batchDetail = event.target.closest("[data-batch-detail]"); if(batchDetail) return void openBatch(batchDetail.dataset.batchDetail).catch(e=>alert(e.message));
      const test = event.target.closest("[data-account-test]"); if(test) return void accountAction(test.dataset.accountTest,"test","Teste concluído.");
      const sync = event.target.closest("[data-account-sync]"); if(sync) return void accountAction(sync.dataset.accountSync,"sync","Sincronização enfileirada.");
      const reconcile = event.target.closest("[data-account-reconcile]"); if(reconcile) return void accountAction(reconcile.dataset.accountReconcile,"reconcile","Reconciliação enfileirada.");
      const unlink = event.target.closest("[data-account-unlink]"); if(unlink){state.unlinkAccountId=unlink.dataset.accountUnlink;$("#unlink-reason").value="";$("#confirm-dialog").showModal();return;}
      const verify = event.target.closest("[data-reverify]"); if(verify) return void reverify(verify.dataset.reverify, verify.dataset.reverifySource || "protected_write");
    });
    $("#unlink-cancel").addEventListener("click",()=>{$("#confirm-dialog").close();state.unlinkAccountId=null;});
    $("#unlink-confirm").addEventListener("click", async () => {
      const id=state.unlinkAccountId;if(!id)return;const button=$("#unlink-confirm");button.disabled=true;
      try { await api(`/accounts/${id}/unlink`,{method:"POST",body:JSON.stringify({reason:$("#unlink-reason").value.trim()})});$("#confirm-dialog").close();$("#drawer").close();alert("Conta desvinculada. O resultado do unlink no Hub foi registrado sem expor credenciais.","success");await loadAccounts(); }
      catch(error){alert(error.message); if(error.payload?.blockers?.length) alert(`${error.message} Bloqueadores: ${error.payload.blockers.map(b=>`${b.source||"op"}#${b.id||"?"}:${b.status}`).join(", ")}`);}
      finally{button.disabled=false;state.unlinkAccountId=null;}
    });
  }

  async function init() {
    bind();
    try { await loadSession(); }
    catch (error) { alert(error.message || "Acesso Master negado pelo Hub."); return; }
    const hash = location.hash.replace(/^#/, "");
    state.view = "__boot__";
    await switchView(viewMeta[hash] ? hash : "overview", { force:true });
  }

  document.addEventListener("DOMContentLoaded", () => void init());
})();
