"use strict";

(() => {
  const API = "/magalu/api/master";
  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = (value) => String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  const fmtInt = (value) => new Intl.NumberFormat("pt-BR").format(Number(value || 0));
  const fmtDate = (value) => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(date);
  };
  const short = (value, max = 36) => {
    const text = String(value || "");
    return text.length > max ? `${text.slice(0, max)}…` : text;
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
      error.payload = payload;
      throw error;
    }
    return payload;
  }
  function badge(value, tone = "muted") { return `<span class="badge badge--${tone}">${esc(value)}</span>`; }
  function statusBadge(value) {
    const s = String(value || "unknown").toLowerCase();
    const good = ["ok","valid","active","synced","success","online","healthy"];
    const warn = ["warning","attention","expiring","pending","queued","syncing","unknown"];
    const bad = ["error","failed","expired","missing","revoked","disabled","offline","critical"];
    return badge(s, good.includes(s) ? "ok" : bad.includes(s) ? "bad" : warn.includes(s) ? "warn" : "muted");
  }
  function infraCard(title, data, note = "") {
    const ok = data?.ok === true;
    return `<article class="panel integration-health-card"><div class="integration-health-card__head"><div><p class="eyebrow">SAÚDE</p><h2>${esc(title)}</h2></div>${statusBadge(ok ? "ok" : "error")}</div><p class="integration-health-card__value">${data?.latency_ms != null ? `${fmtInt(data.latency_ms)} ms` : esc(data?.reason || data?.error || "—")}</p>${note ? `<p class="muted">${esc(note)}</p>` : ""}</article>`;
  }
  function scopeBadge(scope, ok, enabled = true) {
    const label = String(scope || "").replace("open:portfolio-", "");
    return `<span class="scope-pill ${ok ? "is-ok" : enabled ? "is-missing" : "is-optional"}" title="${esc(scope)}">${esc(short(label, 32))}</span>`;
  }
  function renderTop(data) {
    const worker = data.worker || {};
    const infra = data.infrastructure || {};
    const oauth = data.oauth || {};
    const s = data.summary || {};
    $("#integration-health-grid").innerHTML = [
      infraCard("PostgreSQL", infra.database, infra.database?.database_name || "schema magalu"),
      infraCard("Redis", infra.redis, "BullMQ + heartbeat"),
      infraCard("Hub DACHBYTE", infra.hub, infra.hub?.reason || "ACCESS magalu"),
      infraCard("Worker", { ok: worker.online === true }, worker.lastHeartbeat ? `heartbeat ${fmtDate(worker.lastHeartbeat)}` : "sem heartbeat"),
    ].join("");
    $("#integration-summary-grid").innerHTML = [
      ["Contas ativas", s.accounts?.active || 0, `${fmtInt(s.accounts?.problem)} com problema`],
      ["Reconexão OAuth", s.reconnect_required || 0, "faltam scopes configurados"],
      ["Tokens em atenção", s.token_attention || 0, `${fmtInt(s.tokens?.refresh_errors)} erros de refresh`],
      ["Webhooks", s.webhooks?.active || 0, `${fmtInt(s.webhook_events?.events_24h)} eventos / 24h`],
      ["Falhas webhook · 24h", s.webhook_events?.failed_24h || 0, `último ${fmtDate(s.webhook_events?.last_received_at)}`],
      ["Hub pendente/falhou", Number(s.accounts?.hub_pending || 0) + Number(s.accounts?.hub_failed || 0), `${fmtInt(s.accounts?.hub_failed)} falharam`],
    ].map(([label,value,note]) => `<article class="integration-mini-kpi"><span>${esc(label)}</span><strong>${fmtInt(value)}</strong><small>${esc(note)}</small></article>`).join("");
    $("#integration-oauth-config").innerHTML = `<div class="integration-config-row"><span>OAuth configurado</span>${statusBadge(oauth.configured ? "ok" : "error")}</div><div class="integration-config-row"><span>Writes preço/estoque</span>${statusBadge(oauth.write_enabled ? "active" : "disabled")}</div><div class="integration-config-row"><span>Write SKU massivo</span>${statusBadge(oauth.sku_write_enabled ? "active" : "disabled")}</div><div class="integration-config-row integration-config-row--stack"><span>Scopes solicitados</span><div class="scope-list">${(oauth.requested_scopes||[]).map(s=>`<span>${esc(s)}</span>`).join("") || "—"}</div></div><div class="integration-config-row integration-config-row--stack"><span>Redirect URI</span><code>${esc(oauth.redirect_uri || "—")}</code></div>`;
  }
  function renderAccounts(rows = []) {
    const body = $("#integration-accounts-body");
    if (!rows.length) { body.innerHTML = '<tr><td colspan="9" class="empty">Nenhuma conta Magalu encontrada.</td></tr>'; return; }
    body.innerHTML = rows.map((row) => {
      const scopes = row.scopes_health || {};
      const groups = scopes.groups || {};
      const token = row.token_health || {};
      return `<tr>
        <td><span class="cell-title">${esc(row.magalu_tenant_name || "Sem nome")}</span><span class="cell-sub">${esc(row.magalu_tenant_id)}</span></td>
        <td><span class="cell-title">${esc(short(row.dach_tenant_id,24))}</span><span class="cell-sub">#${row.id}</span></td>
        <td>${statusBadge(row.status)}</td>
        <td><div class="integration-scope-mini">${scopeBadge("read",groups.catalog_read?.ok,true)}${scopeBadge("price/stock write",groups.price_stock_write?.ok,groups.price_stock_write?.enabled)}${scopeBadge("sku write",groups.sku_write?.ok,groups.sku_write?.enabled)}</div>${scopes.reconnect_required?'<span class="cell-sub integration-attention">reconexão necessária</span>':'<span class="cell-sub">scopes atuais suficientes</span>'}</td>
        <td>${statusBadge(token.access)}<span class="cell-sub">refresh: ${esc(token.refresh || "—")}</span></td>
        <td>${statusBadge(row.hub_sync_status)}<span class="cell-sub">${esc(short(row.hub_resource_key || "—",24))}</span></td>
        <td><span class="cell-title">${fmtInt(row.webhook_active)}/${fmtInt(row.webhook_total)}</span><span class="cell-sub">falhas 24h: ${fmtInt(row.webhook_failed_24h)}</span></td>
        <td>${statusBadge(row.last_sync_status || row.catalog_sync_status)}<span class="cell-sub">${fmtDate(row.last_sync_at || row.catalog_last_synced_at)}</span></td>
        <td><button class="btn btn--primary btn--small" data-integration-diagnose="${row.id}" type="button">Diagnosticar</button></td>
      </tr>`;
    }).join("");
  }
  function probeLine(label, probe) {
    const status = probe?.ok === true ? "ok" : probe?.ok === false ? "error" : "unknown";
    return `<div class="integration-probe"><div><strong>${esc(label)}</strong><small>${esc(probe?.endpoint || probe?.message || probe?.error || "")}</small></div><div>${statusBadge(status)}${probe?.status ? `<span class="probe-code">HTTP ${esc(probe.status)}</span>` : ""}${probe?.request_id ? `<code>${esc(short(probe.request_id,28))}</code>` : ""}</div></div>`;
  }
  function renderComparison(cmp) {
    if (!cmp) return '<div class="notice">Não foi possível consultar as inscrições remotas.</div>';
    return `<div class="integration-compare-grid"><div><strong>${fmtInt(cmp.matched?.length)}</strong><span>correspondentes</span></div><div><strong>${fmtInt(cmp.local_only?.length)}</strong><span>somente local</span></div><div><strong>${fmtInt(cmp.remote_only?.length)}</strong><span>somente Magalu</span></div></div>${cmp.drift?'<div class="notice">Há divergência entre subscriptions locais e remotas. A ação “Reconciliar webhooks” apenas atualiza metadados locais; não cria, exclui nem rotaciona secret.</div>':'<div class="notice notice--ok">Subscriptions locais e remotas estão alinhadas.</div>'}`;
  }
  function renderDiagnostic(data) {
    const box = $("#integration-detail");
    const account = data.account || {};
    const scopes = data.scopes || {};
    const token = data.tokens || {};
    const hub = data.hub || {};
    const portfolio = data.portfolio || {};
    const probes = portfolio.probes || {};
    const cmp = data.webhooks?.comparison;
    box.hidden = false;
    box.innerHTML = `<div class="panel__head"><div><p class="eyebrow">DIAGNÓSTICO AO VIVO</p><h2>${esc(account.magalu_tenant_name || account.magalu_tenant_id || `Conta #${account.id}`)}</h2><p class="muted">${esc(account.magalu_tenant_id || "")} · conferido em ${esc(fmtDate(data.checked_at))}</p></div><button class="icon-btn" data-integration-close type="button" aria-label="Fechar">×</button></div>
      <div class="integration-actionbar"><button class="btn btn--ghost" data-integration-refresh-oauth="${account.id}" type="button">Renovar token</button><button class="btn btn--ghost" data-integration-reconcile-hub="${account.id}" type="button">Reconciliar Hub</button><button class="btn btn--ghost" data-integration-reconcile-webhooks="${account.id}" type="button">Reconciliar webhooks</button>${scopes.reconnect_required?`<a class="btn btn--primary" href="/magalu/api/master/integrations/accounts/${account.id}/oauth/reconnect">Reconectar OAuth</a>`:""}</div>
      <div class="integration-detail-grid">
        <section class="integration-detail-card"><h3>OAuth e scopes</h3><div class="integration-status-row"><span>Access token</span>${statusBadge(token.access)}</div><div class="integration-status-row"><span>Refresh token</span>${statusBadge(token.refresh)}</div><div class="integration-status-row"><span>Expira</span><strong>${esc(fmtDate(token.access_expires_at))}</strong></div><div class="scope-list integration-scope-list">${(scopes.granted||[]).map(s=>`<span>${esc(s)}</span>`).join("")||'<span>nenhum scope</span>'}</div>${scopes.missing_configured?.length?`<div class="operation-error"><strong>Scopes ausentes</strong><br>${scopes.missing_configured.map(esc).join("<br>")}</div>`:""}</section>
        <section class="integration-detail-card"><h3>Hub</h3><div class="integration-status-row"><span>READ magalu</span>${statusBadge(hub.read?.allow?"ok":"error")}</div><div class="integration-status-row"><span>WRITE magalu</span>${statusBadge(hub.write?.allow?"ok":"error")}</div><div class="integration-status-row"><span>Resource</span><code>${esc(hub.resource_key || "—")}</code></div><p class="muted">${esc(hub.note || "")}</p></section>
        <section class="integration-detail-card"><h3>Infraestrutura</h3><div class="integration-status-row"><span>PostgreSQL</span>${statusBadge(data.infrastructure?.database?.ok?"ok":"error")}</div><div class="integration-status-row"><span>Redis</span>${statusBadge(data.infrastructure?.redis?.ok?"ok":"error")}</div></section>
      </div>
      <section class="integration-detail-card integration-detail-card--wide"><h3>API Magalu</h3>${probeLine("SKUs",probes.sku)}${probeLine("Seller / me",probes.seller)}${probeLine("Preço",probes.price)}${probeLine("Estoque",probes.stock)}</section>
      <section class="integration-detail-card integration-detail-card--wide"><h3>Webhooks</h3>${renderComparison(cmp)}<div class="integration-probe-list">${(data.webhooks?.remote?.rows||[]).slice(0,20).map(w=>`<div class="integration-probe"><div><strong>${esc(w.topic||"—")}</strong><small>${esc(w.url||"—")}</small></div><div>${badge("remoto","muted")}</div></div>`).join("")||'<div class="empty">Nenhuma subscription remota retornada.</div>'}</div></section>`;
    box.scrollIntoView({ behavior:"smooth", block:"start" });
  }
  function toast(message, kind = "success") {
    const box = $("#global-alert"); if (!box) return;
    box.hidden = false; box.textContent = message; box.dataset.kind = kind;
  }
  async function diagnose(id) {
    const button = $(`[data-integration-diagnose="${id}"]`); if (button) button.disabled = true;
    try { renderDiagnostic(await api(`/integrations/accounts/${id}/diagnose`, { method:"POST", body:"{}" })); }
    catch (error) { toast(error.message, "error"); }
    finally { if (button) button.disabled = false; }
  }
  async function action(path, success, rerunId = null) {
    try { await api(path, { method:"POST", body:"{}" }); toast(success, "success"); if (rerunId) await diagnose(rerunId); await load(); }
    catch (error) { toast(error.message, "error"); }
  }
  async function load() {
    const data = await api("/integrations");
    renderTop(data); renderAccounts(data.accounts || []);
    return data;
  }
  document.addEventListener("click", (event) => {
    const diagnoseButton = event.target.closest("[data-integration-diagnose]"); if (diagnoseButton) return void diagnose(diagnoseButton.dataset.integrationDiagnose);
    const close = event.target.closest("[data-integration-close]"); if (close) { $("#integration-detail").hidden = true; return; }
    const refresh = event.target.closest("[data-integration-refresh-oauth]"); if (refresh) return void action(`/integrations/accounts/${refresh.dataset.integrationRefreshOauth}/oauth/refresh`, "Token OAuth renovado.", refresh.dataset.integrationRefreshOauth);
    const hub = event.target.closest("[data-integration-reconcile-hub]"); if (hub) return void action(`/integrations/accounts/${hub.dataset.integrationReconcileHub}/hub/reconcile`, "Reconciliação do Hub enfileirada.", hub.dataset.integrationReconcileHub);
    const webhooks = event.target.closest("[data-integration-reconcile-webhooks]"); if (webhooks) return void action(`/integrations/accounts/${webhooks.dataset.integrationReconcileWebhooks}/webhooks/reconcile`, "Webhooks conferidos com a Magalu sem alterar subscriptions remotas.", webhooks.dataset.integrationReconcileWebhooks);
  });
  window.MagaluMasterIntegrations = { load, diagnose };
})();
