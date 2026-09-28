(() => {
  "use strict";

  const API = "/magalu/api/sku-management";
  const state = { accountId: null, page: 1, limit: 50, total: 0, rows: [], selected: new Set(), allFiltered: false, preview: null, bound: false };
  const $ = (id) => document.getElementById(id);
  const shell = () => window.MagaluSellerShell || null;
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
  const fmt = (n) => new Intl.NumberFormat("pt-BR").format(Number(n) || 0);
  const dt = (v) => { if (!v) return "—"; const d = new Date(v); return Number.isNaN(d.getTime()) ? "—" : new Intl.DateTimeFormat("pt-BR", { dateStyle:"short", timeStyle:"short" }).format(d); };

  function isPage() { return location.pathname.replace(/\/$/, "") === "/magalu/gestao-skus"; }
  function alert(message, tone = "danger") {
    const box = $("mg-sku-message");
    if (!box) return shell()?.showAlert?.(message, tone);
    if (!message) { box.hidden = true; box.textContent = ""; return; }
    box.hidden = false; box.dataset.tone = tone; box.textContent = message;
    clearTimeout(alert.timer); alert.timer = setTimeout(() => { box.hidden = true; }, 7000);
  }
  async function api(path, options = {}) {
    const res = await fetch(`${API}${path}`, { credentials:"same-origin", headers:{ Accept:"application/json", ...(options.body ? {"Content-Type":"application/json"} : {}), ...(options.headers || {}) }, ...options });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) { const e = new Error(data?.message || data?.error || `HTTP ${res.status}`); e.payload = data; e.status = res.status; throw e; }
    return data;
  }
  function query(params) { const p = new URLSearchParams(); Object.entries(params).forEach(([k,v]) => { if (v !== "" && v != null) p.set(k, String(v)); }); return p.toString(); }
  function filters() { return { q: $("mg-sku-search")?.value?.trim() || "", status: $("mg-sku-status")?.value || "", active: $("mg-sku-active")?.value || "" }; }
  function selection() { return state.allFiltered ? { mode:"all_filtered", filters:filters() } : { mode:"explicit", skus:[...state.selected] }; }
  function badge(text, kind = "muted") { return `<span class="mg-sku-badge" data-tone="${esc(kind)}">${esc(text || "—")}</span>`; }

  function resetSelection() { state.selected.clear(); state.allFiltered = false; state.preview = null; updateSelection(); }
  function updateSelection() {
    const count = state.allFiltered ? state.total : state.selected.size;
    if ($("mg-sku-selection-count")) $("mg-sku-selection-count").textContent = count ? `${fmt(count)} selecionado${count === 1 ? "" : "s"}${state.allFiltered ? " no filtro" : ""}` : "0 selecionados";
    if ($("mg-sku-activate")) $("mg-sku-activate").disabled = !count;
    if ($("mg-sku-deactivate")) $("mg-sku-deactivate").disabled = !count;
    if ($("mg-sku-select-page")) $("mg-sku-select-page").checked = state.rows.length > 0 && !state.allFiltered && state.rows.every((r) => state.selected.has(r.sku));
  }

  async function loadStatus() {
    if (!state.accountId) return;
    const data = await api(`/status?account_id=${state.accountId}`);
    const badgeEl = $("mg-sku-write-state"), help = $("mg-sku-write-help");
    if (badgeEl) { badgeEl.textContent = !data.enabled ? "desativado" : data.account?.has_write_scope ? "pronto" : "scope ausente"; badgeEl.dataset.state = !data.enabled ? "disabled" : data.account?.has_write_scope ? "ready" : "missing"; }
    if (help) help.textContent = !data.enabled ? "Escrita remota desativada por configuração." : data.account?.has_write_scope ? `Preview protegido · até ${fmt(data.max_batch_size)} SKUs por lote · ${fmt(data.rate_limit_per_minute)}/min.` : `Reconecte a conta com ${data.scope}.`;
    return data;
  }

  async function loadSkus() {
    const body = $("mg-sku-management-body");
    if (!state.accountId) {
      state.rows = []; state.total = 0;
      if (body) body.innerHTML = '<tr><td colspan="8" class="mg-empty-cell">Selecione uma conta Magalu.</td></tr>';
      $("mg-sku-management-empty") && ($("mg-sku-management-empty").hidden = true);
      updateSelection(); return;
    }
    const data = await api(`/skus?${query({ account_id:state.accountId, ...filters(), page:state.page, limit:state.limit })}`);
    state.rows = data.rows || []; state.total = Number(data.total || 0);
    if (body) body.innerHTML = state.rows.map((r) => `<tr>
      <td><input class="mg-sku-row-check" type="checkbox" data-sku="${esc(r.sku)}" ${state.allFiltered || state.selected.has(r.sku) ? "checked" : ""} ${state.allFiltered ? "disabled" : ""}></td>
      <td><code>${esc(r.sku)}</code><span class="mg-sku-row-sub">${esc(r.title || "Sem título")}</span></td>
      <td>${badge(r.status, r.status === "PUBLISHED" ? "ok" : ["BLOCKED","DELETED"].includes(r.status) ? "bad" : "warn")}</td>
      <td>${badge(r.active ? "Ativo" : "Inativo", r.active ? "ok" : "muted")}</td>
      <td>${esc(r.price ?? "—")}</td><td>${esc(r.quantity ?? "—")}</td><td>${esc(dt(r.last_synced_at || r.updated_at))}</td>
      <td><button class="mg-secondary-btn mg-sku-table-action" data-sku-validation="${esc(r.sku)}" type="button">Validar</button></td>
    </tr>`).join("");
    if ($("mg-sku-management-empty")) $("mg-sku-management-empty").hidden = state.rows.length > 0;
    const start = state.total ? (state.page - 1) * state.limit + 1 : 0, end = Math.min(state.total, state.page * state.limit);
    if ($("mg-sku-page-meta")) $("mg-sku-page-meta").textContent = `${fmt(start)}–${fmt(end)} de ${fmt(state.total)} SKUs`;
    if ($("mg-sku-prev")) $("mg-sku-prev").disabled = state.page <= 1;
    if ($("mg-sku-next")) $("mg-sku-next").disabled = end >= state.total;
    updateSelection();
  }

  function batchTone(status) { return status === "completed" ? "ok" : ["failed","partial"].includes(status) ? "bad" : ["queued","running"].includes(status) ? "blue" : "warn"; }
  async function loadBatches() {
    const host = $("mg-sku-batch-list"); if (!host || !state.accountId) return;
    const data = await api(`/batches?${query({ account_id:state.accountId, page:1, limit:20 })}`);
    const rows = data.rows || [];
    host.innerHTML = rows.length ? rows.map((b) => `<article class="mg-sku-batch-card">
      <div class="mg-sku-batch-card__main"><div><strong>${esc(b.action === "activate" ? "Ativação" : "Desativação")}</strong><small>${esc(String(b.id))}</small></div>${badge(b.status, batchTone(b.status))}</div>
      <div class="mg-sku-batch-metrics"><span><b>${fmt(b.total_count)}</b>Total</span><span><b>${fmt(b.success_count)}</b>OK</span><span><b>${fmt(b.failed_count)}</b>Falhas</span><span><b>${fmt(b.stale_count)}</b>Stale</span><span><b>${fmt(b.uncertain_count)}</b>Uncertain</span><span><b>${fmt(b.divergent_count)}</b>Divergent</span></div>
      <div class="mg-sku-batch-card__foot"><small>${esc(dt(b.created_at))}</small><button class="mg-secondary-btn" data-sku-batch="${esc(b.id)}" type="button">Abrir lote</button></div>
    </article>`).join("") : '<div class="mg-empty-state"><strong>Nenhum lote recente</strong><p>As operações massivas aparecerão aqui após a confirmação de um preview.</p></div>';
  }

  function closeModal(id) { const el = $(id); if (el) el.hidden = true; }
  async function makePreview(action) {
    const count = state.allFiltered ? state.total : state.selected.size; if (!count) return;
    try {
      const data = await api("/preview", { method:"POST", body:JSON.stringify({ account_id:state.accountId, action, selection:selection() }) });
      state.preview = data.preview; const p = data.preview, rows = (p.rows || []).slice(0, 50);
      $("mg-sku-preview-title").textContent = action === "activate" ? "Ativar SKUs" : "Desativar SKUs";
      $("mg-sku-preview-summary").textContent = `${fmt(p.selected_count)} selecionados · ${fmt(p.change_count)} com alteração`;
      $("mg-sku-preview-expiry").textContent = `Expira em ${dt(p.expires_at)}`;
      $("mg-sku-preview-body").innerHTML = rows.map((r) => `<tr><td><code>${esc(r.sku)}</code></td><td>${r.before?.active ? "Ativo" : "Inativo"}</td><td>${r.requested?.active ? "Ativo" : "Inativo"}</td><td>${r.changed ? badge("Aplicar","warn") : badge("Sem mudança","ok")}</td></tr>`).join("");
      const trunc = $("mg-sku-preview-truncated"); if (trunc) { trunc.hidden = (p.rows || []).length <= rows.length; trunc.textContent = trunc.hidden ? "" : `Mostrando ${rows.length} de ${fmt(p.rows.length)} itens.`; }
      $("mg-sku-preview-confirm").checked = false; $("mg-sku-preview-apply").disabled = true; $("mg-sku-preview-apply").dataset.writeEnabled = data.write_enabled === true ? "true" : "false";
      $("mg-sku-preview").hidden = false;
      if (!data.write_enabled) alert("Preview criado, mas a escrita remota está desabilitada.", "warning");
    } catch (e) { alert(e.message); }
  }
  async function applyPreview() {
    if (!state.preview?.id) return;
    const button = $("mg-sku-preview-apply"); button.disabled = true;
    try {
      const data = await api("/apply", { method:"POST", body:JSON.stringify({ preview_id:state.preview.id }) });
      closeModal("mg-sku-preview"); alert(`Lote ${data.batch_id} enfileirado com ${fmt(data.total)} itens.`, "success"); resetSelection(); await Promise.all([loadSkus(), loadBatches()]);
    } catch (e) { alert(e.message); } finally { button.disabled = false; }
  }
  async function validation(sku) {
    try {
      const data = await api(`/skus/${encodeURIComponent(sku)}/validation-info?account_id=${state.accountId}`);
      $("mg-sku-validation-title").textContent = `Validação · ${sku}`; $("mg-sku-validation-meta").textContent = data.request_id ? `request-id: ${data.request_id}` : ""; $("mg-sku-validation-body").textContent = JSON.stringify(data.data, null, 2); $("mg-sku-validation").hidden = false;
    } catch (e) { alert(e.message); }
  }
  async function openBatch(id) {
    try {
      const data = await api(`/batches/${encodeURIComponent(id)}`); const b = data.batch;
      $("mg-sku-batch-detail-title").textContent = `Lote ${String(id).slice(0, 12)}`; $("mg-sku-batch-detail-note").textContent = `${b.action} · ${b.status} · ${dt(b.created_at)}`;
      $("mg-sku-batch-detail-body").innerHTML = (data.items || []).map((i) => `<article class="mg-sku-detail-item"><div><strong>#${i.id} · ${esc(i.sku)}</strong>${badge(i.status, ["succeeded"].includes(i.status) ? "ok" : ["failed","stale"].includes(i.status) ? "bad" : "warn")}</div><small>request-id: ${esc(i.request_id || "—")}</small>${i.error_message ? `<p>${esc(i.error_code || "erro")} · ${esc(i.error_message)}</p>` : ""}${["uncertain","divergent"].includes(i.status) ? `<button class="mg-secondary-btn" data-sku-reverify="${i.id}" type="button">Reverificar somente por GET</button>` : ""}</article>`).join("") || '<div class="mg-empty-state"><strong>Sem itens</strong></div>';
      $("mg-sku-batch-detail").hidden = false;
    } catch (e) { alert(e.message); }
  }
  async function reverify(id, button) { if (button) button.disabled = true; try { await api(`/items/${id}/reverify`, { method:"POST", body:"{}" }); alert(`Item #${id} enfileirado para reverificação.`, "success"); closeModal("mg-sku-batch-detail"); await loadBatches(); } catch (e) { alert(e.message); } finally { if (button) button.disabled = false; } }

  async function refreshForAccount(accountId) {
    state.accountId = Number(accountId) || null; state.page = 1; resetSelection();
    if (!isPage() || !state.accountId) { await loadSkus(); return; }
    try { await Promise.all([loadStatus(), loadSkus(), loadBatches()]); } catch (e) { alert(e.message); }
  }
  function bind() {
    if (state.bound) return; state.bound = true;
    $("mg-sku-filter")?.addEventListener("click", () => { state.page = 1; resetSelection(); void loadSkus().catch((e) => alert(e.message)); });
    $("mg-sku-refresh")?.addEventListener("click", () => void Promise.all([loadStatus(), loadSkus(), loadBatches()]).catch((e) => alert(e.message)));
    $("mg-sku-prev")?.addEventListener("click", () => { if (state.page > 1) { state.page -= 1; void loadSkus(); } });
    $("mg-sku-next")?.addEventListener("click", () => { if (state.page * state.limit < state.total) { state.page += 1; void loadSkus(); } });
    $("mg-sku-select-page")?.addEventListener("change", (e) => { state.allFiltered = false; state.rows.forEach((r) => e.target.checked ? state.selected.add(r.sku) : state.selected.delete(r.sku)); updateSelection(); void loadSkus(); });
    $("mg-sku-select-all")?.addEventListener("click", () => { state.selected.clear(); state.allFiltered = true; updateSelection(); void loadSkus(); });
    $("mg-sku-clear-selection")?.addEventListener("click", () => { resetSelection(); void loadSkus(); });
    $("mg-sku-activate")?.addEventListener("click", () => void makePreview("activate"));
    $("mg-sku-deactivate")?.addEventListener("click", () => void makePreview("deactivate"));
    $("mg-sku-preview-close")?.addEventListener("click", () => closeModal("mg-sku-preview"));
    $("mg-sku-validation-close")?.addEventListener("click", () => closeModal("mg-sku-validation"));
    $("mg-sku-batch-detail-close")?.addEventListener("click", () => closeModal("mg-sku-batch-detail"));
    $("mg-sku-preview-confirm")?.addEventListener("change", (e) => { const apply = $("mg-sku-preview-apply"); apply.disabled = !(e.target.checked && apply.dataset.writeEnabled === "true" && Number(state.preview?.change_count || 0) > 0); });
    $("mg-sku-preview-apply")?.addEventListener("click", () => void applyPreview());
    document.addEventListener("change", (e) => { const box = e.target.closest?.("[data-sku]"); if (!box || !isPage()) return; state.allFiltered = false; box.checked ? state.selected.add(box.dataset.sku) : state.selected.delete(box.dataset.sku); updateSelection(); });
    document.addEventListener("click", (e) => { if (!isPage()) return; const v=e.target.closest?.("[data-sku-validation]"); if (v) return void validation(v.dataset.skuValidation); const b=e.target.closest?.("[data-sku-batch]"); if (b) return void openBatch(b.dataset.skuBatch); const r=e.target.closest?.("[data-sku-reverify]"); if (r) return void reverify(r.dataset.skuReverify, r); });
    window.addEventListener("magalu:accountchange", (e) => void refreshForAccount(e.detail?.accountId));
    window.addEventListener("magalu:shellready", (e) => void refreshForAccount(e.detail?.accountId));
  }
  document.addEventListener("DOMContentLoaded", () => { bind(); if (shell()?.isReady?.()) void refreshForAccount(shell().getSelectedAccountId()); });
})();
