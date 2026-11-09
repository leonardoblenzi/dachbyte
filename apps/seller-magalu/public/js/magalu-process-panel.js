(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const shell = () => window.MagaluSellerShell;
  const activeRoutes = new Set(["/", "/pedidos", "/gestao-skus", "/estoque", "/precos", "/promocoes", "/margem", "/calculadora", "/integracoes", "/precificacao-promocional"]);
  const state = { accountId: null, rows: [], children: new Map(), open: false, minimized: false, hiddenIds: new Set(), detail: null, timer: null, request: 0 };
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
  const fmt = value => new Intl.NumberFormat("pt-BR").format(Number(value) || 0);
  const currentAccount = () => Number(shell()?.getSelectedAccountId?.()) || null;
  const key = row => `${row.kind}:${row.id}`;
  // Relatório do procedimento (XLSX, um SKU por linha com resultado e motivo), no padrão do painel de jobs do ML.
  const REPORT_KINDS = new Set(["group", "catalog", "write"]);
  function reportAction(row, t) {
    if (!REPORT_KINDS.has(row.kind)) return "";
    const done = t.total - t.pending;
    if (t.pending && done <= 0) return "";
    const href = `/magalu/api/processes/${encodeURIComponent(row.kind)}/${encodeURIComponent(row.id)}/report.xlsx?account_id=${encodeURIComponent(currentAccount() || "")}`;
    return `<a class="mg-process-card__report" href="${esc(href)}" download>${t.pending ? "Baixar relatório parcial" : "Baixar relatório"}</a>`;
  }
  function reportNotice(row, t) {
    if (!REPORT_KINDS.has(row.kind) || t.pending) return "";
    const problems = t.failed + t.stale + t.canceled, recheck = t.uncertain + t.divergent;
    const parts = [problems ? `${fmt(problems)} SKU(s) não alterados` : "", recheck ? `${fmt(recheck)} aguardando confirmação da Magalu` : ""].filter(Boolean);
    return parts.length ? `<p class="mg-process-card__notice">${esc(parts.join(" · "))}. O relatório traz o motivo de cada um.</p>` : "";
  }
  function detailAction(row, t) {
    if (!REPORT_KINDS.has(row.kind)) return `<button type="button" data-process-detail="${esc(key(row))}">Ver detalhes</button>`;
    const recheck = t.uncertain + t.divergent;
    return recheck && !t.pending ? `<button type="button" data-process-detail="${esc(key(row))}">Reverificar itens (${fmt(recheck)})</button>` : "";
  }
  const syncStages = { sku_list: "Iniciando leitura", "list:PUBLISHED": "Lendo SKUs publicados", "list:UNPUBLISHED": "Lendo SKUs não publicados", "list:BLOCKED": "Lendo SKUs bloqueados", known_sku_refresh: "Conferindo SKUs fora da listagem", complete: "Finalizada" };
  const syncStatus = { running: "Em andamento", success: "Concluído", partial: "Parcial", failed: "Falhou", canceled: "Interrompida" };
  const label = row => row.kind === "sync" ? "Sincronizar catálogo" : row.kind === "promo" ? (row.action === "promo-preview" ? "Calcular preços promocionais" : "Consultar preços Magalu") : ["catalog","group"].includes(row.kind) ? (row.action === "activate" ? "Publicar SKUs" : "Despublicar SKUs") : row.resource === "price" ? "Atualizar preços" : "Atualizar estoque";
  const totals = row => {
    const total = Number(row.total_count) || 0, success = Number(row.success_count) || 0, failed = Number(row.failed_count) || 0,
      stale = Number(row.stale_count) || 0, uncertain = Number(row.uncertain_count) || 0, divergent = Number(row.divergent_count) || 0,
      canceled = Number(row.canceled_count) || 0, pending = Number(row.pending_count) || 0;
    return { total, success, failed, stale, uncertain, divergent, canceled, pending, progress: total ? Math.round((total - pending) * 100 / total) : 0 };
  };
  const status = row => { if (row.kind === "sync") return syncStatus[row.status] || row.status; const t = totals(row); if(row.kind==="group"&&row.status==="failed")return "Falhou"; if (t.pending) return t.progress ? "Em andamento" : "Na fila"; if (t.uncertain || t.divergent) return "Reverificação necessária"; if (t.failed || t.stale || t.canceled) return t.success ? "Parcial" : "Falhou"; return "Concluído"; };
  function visibleRows() {
    const q = $("mg-process-search")?.value.trim().toLowerCase() || "";
    return state.rows.filter(row => !state.hiddenIds.has(key(row)) && (!q || `${label(row)} ${row.id} ${row.resource}`.toLowerCase().includes(q)));
  }
  function render() {
    const inRoute = activeRoutes.has(shell()?.route?.()), accountId = currentAccount();
    $("mg-process-toggle").hidden = !inRoute || !accountId;
    $("mg-process-panel").hidden = !inRoute || !accountId || !state.open;
    $("mg-process-panel").classList.toggle("is-minimized", state.minimized);
    $("mg-process-toggle").setAttribute("aria-expanded", String(state.open && !state.minimized));
    const rows = visibleRows();
    $("mg-process-count").textContent = fmt(state.rows.filter(row => totals(row).pending > 0).length);
    $("mg-process-panel-count").textContent = fmt(rows.length);
    const card = row => {
      const t = totals(row), stateText = status(row), tone = row.kind==="sync" ? (["Falhou","Interrompida"].includes(stateText) ? "error" : t.pending ? "processing" : "ok") : stateText==="Falhou"||t.uncertain||t.divergent||t.failed||t.stale ? "error" : t.pending ? "processing" : "ok";
      if (row.kind === "sync") {
        const meta = t.pending ? `${fmt(t.success)} de ~${fmt(t.total)} SKUs · ${esc(syncStages[row.stage] || "Processando")}` : `${fmt(t.success)} SKUs lidos`;
        const counts = [t.failed ? `${fmt(t.failed)} leituras com falha` : "", row.details_skipped ? `${fmt(row.details_skipped)} não publicados sem preço/estoque` : ""].filter(Boolean).join(" · ");
        return `<article class="mg-process-card" data-tone="${tone}"><span class="mg-process-card__icon" aria-hidden="true">${tone==="processing" ? "" : tone === "ok" ? "✓" : "!"}</span><div class="mg-process-card__content"><div class="mg-process-card__id">#${esc(row.id)}</div><strong class="mg-process-card__name">${esc(label(row))}</strong><div class="mg-process-card__meta">${meta}</div><div class="mg-process-card__state"><span>${esc(stateText)}</span></div>${t.pending ? `<div class="mg-process-card__progress"><div class="mg-process-card__bar" role="progressbar" aria-valuenow="${t.progress}" aria-valuemin="0" aria-valuemax="100"><i style="width:${t.progress}%"></i></div><b>${t.progress}%</b></div>` : ""}${counts ? `<div class="mg-process-card__counts">${counts}</div>` : ""}${row.error_message?`<p>${esc(row.error_message)}</p>`:""}<button type="button" data-process-detail="${esc(key(row))}">Ver detalhes</button></div></article>`;
      }
      return `<article class="mg-process-card" data-tone="${tone}"><span class="mg-process-card__icon" aria-hidden="true">${tone==="processing" ? "" : tone === "ok" ? "✓" : "!"}</span><div class="mg-process-card__content"><div class="mg-process-card__id">#${esc(String(row.id).slice(0, 18))}</div><strong class="mg-process-card__name">${esc(label(row))}</strong><div class="mg-process-card__meta">${fmt(t.total)} SKU(s) · ${esc(({sku:"catálogo",price:"preço",stock:"estoque",promotion:"promoção"})[row.resource]||row.resource||"")}</div><div class="mg-process-card__state"><span>${esc(stateText)}</span>${t.success ? `<small>${fmt(t.success)} concluídos</small>` : ""}</div><div class="mg-process-card__progress"><div class="mg-process-card__bar" role="progressbar" aria-valuenow="${t.progress}" aria-valuemin="0" aria-valuemax="100"><i style="width:${t.progress}%"></i></div><b>${t.progress}%</b></div><div class="mg-process-card__counts">${t.pending ? `${fmt(t.pending)} pendentes` : ""}${t.failed + t.stale ? ` · ${fmt(t.failed + t.stale)} falhas` : ""}${t.uncertain + t.divergent ? ` · ${fmt(t.uncertain + t.divergent)} para reverificar` : ""}</div>${row.error_message?`<p>${esc(row.error_message)}</p>`:""}${reportNotice(row,t)}<div class="mg-process-card__actions">${reportAction(row,t)}${detailAction(row,t)}</div></div></article>`;
    };
    const isRunning = row => row.kind === "sync" ? row.status === "running" : status(row)!=="Falhou"&&totals(row).pending && totals(row).progress;
    const queued = rows.filter(row => row.kind !== "sync" && status(row)!=="Falhou"&&totals(row).pending && !totals(row).progress), running = rows.filter(isRunning), completed = rows.filter(row => status(row)==="Falhou"||!totals(row).pending);
    const section = (title, list) => list.length ? `<div class="mg-process-panel__section">${title}</div>${list.map(card).join("")}` : "";
    $("mg-process-list").innerHTML = section("EM ANDAMENTO", running) + section("NA FILA", queued) + section("CONCLUÍDOS", completed) || '<p class="mg-process-empty">Sem processos recentes.</p>';
    if (state.detail && !rows.some(row => key(row) === state.detail) && !state.children.has(state.detail)) closeDetail();
  }
  async function refresh() {
    const accountId = currentAccount(), request = ++state.request;
    if (!accountId || !activeRoutes.has(shell()?.route?.())) return;
    try {
      const data = await shell().fetchJson(`/magalu/api/processes?account_id=${accountId}`, { loading: "none" });
      if (request !== state.request || accountId !== currentAccount()) return;
      state.rows = data.rows || [];
      $("mg-process-error").hidden = true;
      render();
    } catch(error) { if (request !== state.request) return; $("mg-process-error").textContent = error.message || "Não foi possível atualizar processos."; $("mg-process-error").hidden = false; }
  }
  function closeDetail() { state.detail = null; $("mg-process-detail").hidden = true; $("mg-process-list").hidden = false; }
  async function openDetail(id) {
    const row = state.rows.find(item => key(item) === id) || state.children.get(id), accountId = currentAccount();
    if (!row) return;
    state.detail = id;
    const host = $("mg-process-detail");host.hidden = false;$("mg-process-list").hidden = true;
    host.innerHTML = `<button type="button" data-process-back>← Processos</button><h3>${esc(label(row))}</h3><p>Carregando itens...</p>`;
    try {
      const data = await shell().fetchJson(`/magalu/api/processes/${encodeURIComponent(row.kind)}/${encodeURIComponent(row.id)}?account_id=${accountId}`, { loading: "none" });
      if (state.detail !== id || accountId !== currentAccount()) return;
      if(row.kind==="sync"){
        const run=(data.rows||[])[0]||row, fact=(name,value)=>`<article><strong>${esc(name)}</strong><span>${esc(value)}</span></article>`;
        const when=value=>value?new Date(value).toLocaleString("pt-BR"):"—", minutes=run.finished_at?Math.max(1,Math.round((new Date(run.finished_at)-new Date(run.created_at))/60000))+" min":"em andamento";
        host.innerHTML=`<button type="button" data-process-back>← Processos</button><h3>${esc(label(row))}</h3><small>#${esc(row.id)}</small><div class="mg-process-panel__items">${[
          fact("Situação",status(run)),fact("Etapa",syncStages[run.stage]||run.stage||"—"),fact("SKUs lidos",`${fmt(run.success_count)}${run.pending_count?` de ~${fmt(run.total_count)}`:""}`),
          fact("Leituras com falha",fmt(run.failed_count)),fact("Não publicados sem preço/estoque",fmt(run.details_skipped)),fact("Páginas da listagem",fmt(run.pages)),
          fact("Conferidos fora da listagem",fmt(run.known_processed)),fact("Início",when(run.created_at)),fact("Duração",minutes),
          run.error_message?fact("Observação",run.error_message):""].join("")}</div>`;
      }else if(row.kind==="group"){
        state.children.clear();
        host.innerHTML=`<button type="button" data-process-back>← Processos</button><h3>${esc(label(row))}</h3><small>${esc(row.id)}</small><div class="mg-process-panel__items">${(data.rows||[]).map((item,index)=>{const child={...item,kind:"catalog",resource:"sku"};state.children.set(key(child),child);return `<article><strong>Lote ${index+1} · ${fmt(item.total_count)} SKU(s)</strong><span>${esc(item.status)}</span><small>${fmt(item.success_count)} concluídos · ${fmt(item.failed_count)} falhas · ${fmt(item.pending_count)} pendentes</small><button type="button" data-process-detail="${esc(key(child))}">Ver SKUs</button></article>`;}).join("")||"Aguardando criação dos lotes pelo worker."}</div>`;
      }else host.innerHTML = `<button type="button" data-process-back>← Processos</button><h3>${esc(label(row))}</h3><small>${esc(row.id)}</small><div class="mg-process-panel__items">${(data.rows || []).map(item => `<article><strong>${esc(item.sku)}</strong><span>${esc(item.status)}</span>${item.error_message ? `<p>${esc(item.error_message)}</p>` : ""}${item.request_id ? `<small>request-id: ${esc(item.request_id)}</small>` : ""}${["uncertain","divergent"].includes(item.status) ? `<button type="button" data-process-reverify="${row.kind}:${item.id}">Reverificar</button>` : ""}</article>`).join("") || "Nenhum item encontrado."}</div>`;
    } catch(error) { if (state.detail === id) host.innerHTML = `<button type="button" data-process-back>← Processos</button><p>${esc(error.message)}</p>`; }
  }
  async function reverify(kind, id, button) {
    button.disabled = true;
    try {
      const url = kind === "catalog" ? `/magalu/api/sku-management/items/${encodeURIComponent(id)}/reverify` : `/magalu/api/writes/operations/${encodeURIComponent(id)}/reverify`;
      await shell().fetchJson(url, { method: "POST", body: JSON.stringify({}), loading: "none" });
      shell().showAlert("Reverificação enfileirada.", "success");
      await refresh();
      if (state.detail) await openDetail(state.detail);
    } catch(error) { shell().showAlert(error.message, "danger"); button.disabled = false; }
  }
  function routeChanged() {
    const accountId = currentAccount();
    if (accountId !== state.accountId) { state.accountId = accountId; state.rows = []; state.children.clear(); state.hiddenIds.clear(); closeDetail(); }
    render();
    if (activeRoutes.has(shell()?.route?.()) && accountId) void refresh();
  }
  document.addEventListener("DOMContentLoaded", () => {
    $("mg-process-toggle")?.addEventListener("click", () => { state.open = !state.open; state.minimized = false; render(); if (state.open) void refresh(); });
    $("mg-process-close")?.addEventListener("click", () => { state.open = false; render(); });
    $("mg-process-minimize")?.addEventListener("click", () => { state.minimized = !state.minimized; render(); });
    $("mg-process-refresh")?.addEventListener("click", () => void refresh());
    $("mg-process-search")?.addEventListener("input", render);
    $("mg-process-clear")?.addEventListener("click", () => { for (const row of state.rows) { const t = totals(row); if (!t.pending && !t.uncertain && !t.divergent) state.hiddenIds.add(key(row)); } render(); });
    $("mg-process-panel")?.addEventListener("click", event => { const detail = event.target.closest("[data-process-detail]"); if (detail) return void openDetail(detail.dataset.processDetail); if (event.target.closest("[data-process-back]")) return closeDetail(); const reverify = event.target.closest("[data-process-reverify]"); if (reverify) { const [kind,id] = reverify.dataset.processReverify.split(":"); void reverify(kind,id,reverify); } });
    window.addEventListener("magalu:shellready", routeChanged);
    window.addEventListener("magalu:routechange", routeChanged);
    window.addEventListener("magalu:accountchange", routeChanged);
    window.addEventListener("magalu:processqueued", () => { state.open = true; state.minimized = false; routeChanged(); });
    state.timer = setInterval(() => { if (activeRoutes.has(shell()?.route?.()) && currentAccount()) void refresh(); }, 5000);
    routeChanged();
  });
})();
