(() => {
  "use strict";
  // Projeção mensal do Magalu: mesmas regras e blocos da tela do ML, com filtro pelos
  // status do pedido que a API trouxe para a conta e composição por status/entrega.
  const $ = (id) => document.getElementById(id);
  const shell = () => window.MagaluSellerShell;
  const account = () => Number(shell()?.getSelectedAccountId?.()) || null;
  const route = () => shell()?.route?.() || "";
  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (value) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value) || 0);
  const moneyShort = (value) => { const n = Number(value) || 0; return Math.abs(n) >= 1000 ? `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(n / 1000)}k` : new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(n); };
  const integer = (value) => new Intl.NumberFormat("pt-BR").format(Math.round(Number(value) || 0));
  const decimal = (value, digits = 2) => new Intl.NumberFormat("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number(value) || 0);
  const STATUS_LABELS = { new: "Novo", approved: "Aprovado", finished: "Finalizado", cancelled: "Cancelado", canceled: "Cancelado", invoiced: "Faturado", shipped: "Enviado", delivered: "Entregue", frozen: "Congelado", "sem status": "Sem status" };
  const statusLabel = (status) => STATUS_LABELS[status] || String(status).charAt(0).toUpperCase() + String(status).slice(1);
  const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  const monthName = (key) => { const [y, m] = String(key || "").split("-").map(Number); return m ? `${MONTHS[m - 1]} de ${y}` : "—"; };
  const state = { requestId: 0, data: null, statuses: null, compare: true };
  const storageKey = (id) => `magalu:projection:statuses:${id}`;

  try { state.compare = localStorage.getItem("magalu:projection:compare") !== "0"; } catch (_error) {}

  // ---------- Comparativos (hover igual ao do Painel) ----------
  function comparison(id, { label, current, previous, format, currentLabel, previousLabel, deltaId, suffix = "vs mês anterior", extra = [] }) {
    const el = $(id); if (!el) return;
    const hasBase = Number(previous) !== 0 && previous !== null && previous !== undefined;
    const delta = hasBase ? ((Number(current) - Number(previous)) / Math.abs(Number(previous))) * 100 : null;
    const tone = delta === null ? "neutral" : delta >= 0 ? "positive" : "negative";
    const text = delta === null ? "Sem comparativo" : `${delta >= 0 ? "+" : "-"}${decimal(Math.abs(delta), 1)}% ${suffix}`;
    const row = (k, v) => `<span class="mg-cmp__row"><span>${esc(k)}</span><b>${esc(v)}</b></span>`;
    el.classList.add("mg-cmp"); el.setAttribute("tabindex", "0");
    el.innerHTML = `<span class="mg-cmp__value">${esc(format(current))}</span><span class="mg-cmp__box" role="tooltip"><span class="mg-cmp__title">Comparativo do período</span>${row(currentLabel, format(current))}${row(previousLabel, hasBase ? format(previous) : "—")}${extra.map(([k, v]) => row(k, v)).join("")}<span class="mg-cmp__row"><span>Variação</span><b data-tone="${tone}">${esc(delta === null ? "Sem comparativo" : `${delta >= 0 ? "+" : "-"}${decimal(Math.abs(delta), 1)}%`)}</b></span></span>`;
    const deltaEl = deltaId ? $(deltaId) : null;
    if (deltaEl) { deltaEl.textContent = text; deltaEl.dataset.tone = tone; }
  }

  // ---------- Filtro de status ----------
  function renderStatusFilter(filter) {
    const host = $("mg-proj-status-options"); if (!host) return;
    const selected = new Set(filter.statuses || []);
    host.innerHTML = (filter.available || []).map((row) => `<label class="mg-proj-status__option"><input type="checkbox" value="${esc(row.status)}" ${selected.has(row.status) ? "checked" : ""}><span>${esc(statusLabel(row.status))}</span><small>${integer(row.orders)} pedido(s) · ${esc(row.status)}</small></label>`).join("") || "<p>Nenhum pedido sincronizado ainda.</p>";
    const all = (filter.available || []).map((row) => row.status);
    const isDefault = all.filter((s) => s !== "cancelled" && s !== "canceled").sort().join() === [...selected].sort().join();
    $("mg-proj-status-label").textContent = isDefault ? "Todos menos cancelado" : selected.size === all.length ? "Todos" : [...selected].map(statusLabel).join(", ") || "Nenhum";
  }

  function selectedStatuses() { return [...document.querySelectorAll("#mg-proj-status-options input:checked")].map((input) => input.value); }

  // ---------- Gráfico (SVG, cores do tema) ----------
  function renderChart(data) {
    const host = $("mg-proj-chart"); if (!host) return;
    const daily = data.series?.daily || [], previous = data.series?.previous_daily || [];
    const day = Number(data.period?.day_of_month || 0), dim = Number(data.period?.days_in_month || daily.length || 30);
    const current = daily.slice(0, day);
    const prevVisible = state.compare ? previous.slice(0, dim) : [];
    if (!current.some((row) => row.revenue > 0) && !prevVisible.some((row) => row.revenue > 0)) { host.innerHTML = '<div class="mg-proj-chart__empty">Sem vendas no período para desenhar o gráfico.</div>'; return; }
    const W = 1000, H = 280, L = 56, R = 14, T = 18, B = 30;
    const maxValue = Math.max(1, ...current.map((r) => r.revenue), ...prevVisible.map((r) => r.revenue)) * 1.12;
    const x = (d) => L + ((d - 1) / Math.max(1, dim - 1)) * (W - L - R);
    const y = (v) => T + (1 - v / maxValue) * (H - T - B);
    const path = (rows) => rows.map((r, i) => `${i ? "L" : "M"}${x(r.day).toFixed(1)},${y(r.revenue).toFixed(1)}`).join(" ");
    const grid = Array.from({ length: 5 }, (_, i) => { const v = (maxValue / 4) * i; return `<line class="mg-proj-grid" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="mg-proj-axis" x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${moneyShort(v)}</text>`; }).join("");
    const labels = Array.from({ length: dim }, (_, i) => i + 1).filter((d) => d === 1 || d % 2 === 1).map((d) => `<text class="mg-proj-axis" x="${x(d).toFixed(1)}" y="${H - 8}" text-anchor="middle">${String(d).padStart(2, "0")}</text>`).join("");
    const area = current.length ? `<path class="mg-proj-area" d="${path(current)} L${x(current[current.length - 1].day).toFixed(1)},${y(0).toFixed(1)} L${x(current[0].day).toFixed(1)},${y(0).toFixed(1)} Z"/>` : "";
    const today = data.period?.is_current_month && day ? `<line class="mg-proj-today" x1="${x(day).toFixed(1)}" x2="${x(day).toFixed(1)}" y1="${T}" y2="${H - B}"/><text class="mg-proj-today-label" x="${x(day).toFixed(1)}" y="${T - 4}" text-anchor="middle">Hoje</text>` : "";
    const hits = Array.from({ length: dim }, (_, i) => i + 1).map((d) => `<rect class="mg-proj-hit" data-day="${d}" x="${(x(d) - (W - L - R) / dim / 2).toFixed(1)}" y="${T}" width="${((W - L - R) / dim).toFixed(1)}" height="${H - T - B}"/>`).join("");
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Receita diária do mês">${grid}${labels}${area}${prevVisible.length ? `<path class="mg-proj-line mg-proj-line--previous" d="${path(prevVisible)}"/>` : ""}${current.length ? `<path class="mg-proj-line" d="${path(current)}"/>` : ""}${today}${hits}</svg><div class="mg-proj-tip" id="mg-proj-tip" hidden></div>`;
    const tip = host.querySelector("#mg-proj-tip");
    host.querySelectorAll(".mg-proj-hit").forEach((rect) => {
      rect.addEventListener("mouseenter", () => {
        const d = Number(rect.dataset.day), cur = daily[d - 1], prev = previous[d - 1];
        tip.innerHTML = `<strong>Dia ${String(d).padStart(2, "0")}</strong>${d <= day ? `<span>Receita: <b>${money(cur?.revenue)}</b> · ${integer(cur?.orders)} pedido(s)</span>` : "<span>Dia ainda não chegou</span>"}${state.compare && prev ? `<span>Mês passado: <b>${money(prev.revenue)}</b> · ${integer(prev.orders)} pedido(s)</span>` : ""}`;
        tip.hidden = false;
        const box = host.getBoundingClientRect(), r = rect.getBoundingClientRect();
        tip.style.left = `${Math.min(box.width - 220, Math.max(0, r.left - box.left + r.width / 2 - 110))}px`;
      });
      rect.addEventListener("mouseleave", () => { tip.hidden = true; });
    });
    $("mg-proj-legend-previous").hidden = !state.compare;
  }

  // ---------- Composição ----------
  function renderComposition(data) {
    const rows = data.composition?.by_status || [];
    const total = rows.reduce((sum, row) => sum + row.revenue, 0) || 1;
    $("mg-proj-status-bars").innerHTML = rows.length ? `<h3>Por status do pedido</h3>${rows.map((row) => `<div class="mg-proj-bar" data-counted="${row.counted}"><div class="mg-proj-bar__head"><span>${esc(statusLabel(row.status))}${row.counted ? "" : " <em>fora do filtro</em>"}</span><b>${money(row.revenue)}</b></div><div class="mg-proj-bar__track"><i style="width:${Math.max(1, (row.revenue / total) * 100).toFixed(1)}%"></i></div><small>${integer(row.orders)} pedido(s) · ${decimal((row.revenue / total) * 100, 1)}% da receita bruta</small></div>`).join("")}` : "<h3>Por status do pedido</h3><p>Sem pedidos no período.</p>";
    const d = data.composition?.by_delivery || { full: { revenue: 0, orders: 0 }, other: { revenue: 0, orders: 0 } };
    const sum = (d.full.revenue + d.other.revenue) || 1;
    $("mg-proj-delivery").innerHTML = `<h3>Por entrega (pedidos do filtro)</h3><article><span>Full · Magalu Entregas</span><strong>${money(d.full.revenue)}</strong><small>${integer(d.full.orders)} pedido(s) · ${decimal((d.full.revenue / sum) * 100, 1)}%</small></article><article><span>Demais entregas</span><strong>${money(d.other.revenue)}</strong><small>${integer(d.other.orders)} pedido(s) · ${decimal((d.other.revenue / sum) * 100, 1)}%</small></article>`;
  }

  function render(data) {
    state.data = data;
    const p = data.period || {}, t = data.totals || {}, prev = data.previous || {};
    $("mg-proj-account").textContent = data.account?.name || "Conta Magalu";
    $("mg-proj-period").textContent = monthName(p.month_key);
    $("mg-proj-day").textContent = `${p.day_of_month || 0}/${p.days_in_month || "—"}`;
    $("mg-proj-updated").textContent = `Atualizado às ${new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date(data.meta?.generated_at || Date.now()))}`;
    if ($("mg-proj-month") && !$("mg-proj-month").value) $("mg-proj-month").value = p.month_key;
    const until = `até o dia ${p.day_of_month || 0}`;
    const prevUntil = `Mês anterior até o dia ${prev.comparable_days || 0}`;
    comparison("mg-proj-revenue", { label: "Faturamento", current: t.revenue, previous: prev.comparable_revenue, format: money, currentLabel: `Mês atual ${until}`, previousLabel: prevUntil, deltaId: "mg-proj-revenue-delta" });
    comparison("mg-proj-projected", { label: "Projeção", current: t.projected, previous: prev.revenue, format: money, currentLabel: p.is_current_month ? "Projeção de fechamento" : "Fechamento do mês", previousLabel: `Fechamento de ${monthName(prev.month_key)}`, deltaId: "mg-proj-projected-delta" });
    comparison("mg-proj-avg-revenue", { label: "Ritmo diário", current: t.avg_revenue_closed, previous: prev.avg_revenue, format: money, currentLabel: `Média de ${t.closed_days || 0} dia(s) fechado(s)`, previousLabel: `Média de ${prev.days_in_month || 0} dias do mês anterior`, deltaId: "mg-proj-avg-revenue-delta" });
    comparison("mg-proj-orders", { label: "Pedidos", current: t.orders, previous: prev.comparable_orders, format: integer, currentLabel: `Mês atual ${until}`, previousLabel: prevUntil, deltaId: "mg-proj-orders-delta" });
    comparison("mg-proj-avg-orders", { label: "Média de pedidos", current: t.avg_orders_closed, previous: prev.avg_orders, format: (v) => decimal(v, 2), currentLabel: `Por dia fechado (${t.closed_days || 0})`, previousLabel: "Por dia do mês anterior", deltaId: "mg-proj-avg-orders-delta" });
    comparison("mg-proj-ticket", { label: "Ticket médio", current: t.ticket, previous: prev.comparable_ticket, format: money, currentLabel: `Ticket ${until}`, previousLabel: `Ticket do mês anterior até o dia ${prev.comparable_days || 0}`, deltaId: "mg-proj-ticket-delta" });
    $("mg-proj-units").textContent = integer(t.units);
    $("mg-proj-progress-fill").style.width = `${p.days_in_month ? Math.min(100, (p.day_of_month / p.days_in_month) * 100) : 0}%`;
    $("mg-proj-formula-hint").textContent = p.is_current_month ? `Ex.: (${money(t.revenue)} ÷ ${p.day_of_month}) × ${p.days_in_month} = ${money(t.projected)}` : "Mês fechado: a projeção é o próprio faturamento do mês.";
    renderStatusFilter(data.filter || {});
    renderChart(data);
    renderComposition(data);
  }

  async function load({ fresh = false } = {}) {
    if (route() !== "/projecao") return;
    const id = account(); if (!id) return;
    if (state.statuses === null) { try { const saved = JSON.parse(localStorage.getItem(storageKey(id)) || "null"); state.statuses = Array.isArray(saved) ? saved : []; } catch (_error) { state.statuses = []; } }
    const query = new URLSearchParams({ account_id: String(id) });
    const month = $("mg-proj-month")?.value; if (month) query.set("period", month);
    if (state.statuses.length) query.set("statuses", state.statuses.join(","));
    if (fresh) query.set("fresh", "1");
    const requestId = ++state.requestId;
    const overlay = window.MagaluLoadingOverlay;
    overlay?.show({ label: "Projeção mensal", message: "Calculando ritmo e projeção do mês..." });
    try {
      const data = await shell().fetchJson(`/magalu/api/projection?${query}`, { loading: "none" });
      if (requestId !== state.requestId || route() !== "/projecao") return;
      render(data);
    } catch (error) {
      if (requestId === state.requestId) shell()?.showAlert?.(error.message || "Não foi possível calcular a projeção.", "danger");
    } finally { overlay?.hide(); }
  }

  function bind() {
    const compare = $("mg-proj-compare"); if (compare) compare.checked = state.compare;
    compare?.addEventListener("change", () => { state.compare = compare.checked; try { localStorage.setItem("magalu:projection:compare", state.compare ? "1" : "0"); } catch (_error) {} if (state.data) renderChart(state.data); });
    $("mg-proj-refresh")?.addEventListener("click", () => void load({ fresh: true }));
    $("mg-proj-month")?.addEventListener("change", () => void load());
    $("mg-proj-status-apply")?.addEventListener("click", () => {
      const chosen = selectedStatuses();
      if (!chosen.length) { shell()?.showAlert?.("Escolha pelo menos um status.", "warning"); return; }
      state.statuses = chosen;
      try { localStorage.setItem(storageKey(account()), JSON.stringify(chosen)); } catch (_error) {}
      $("mg-proj-status").open = false; void load();
    });
    $("mg-proj-status-default")?.addEventListener("click", () => {
      state.statuses = [];
      try { localStorage.removeItem(storageKey(account())); } catch (_error) {}
      $("mg-proj-status").open = false; void load();
    });
    document.addEventListener("click", (event) => { const box = $("mg-proj-status"); if (box?.open && !box.contains(event.target)) box.open = false; });
    window.addEventListener("magalu:routechange", (event) => { if (event.detail?.path === "/projecao") void load(); });
    window.addEventListener("magalu:accountchange", () => { state.statuses = null; if (route() === "/projecao") void load(); });
    window.addEventListener("magalu:shellready", () => { if (route() === "/projecao") void load(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind); else bind();
  window.MagaluProjection = { _test: { statusLabel, monthName } };
})();
