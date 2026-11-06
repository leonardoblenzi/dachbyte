(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
  const num = (value) => { const n = Number(value); return Number.isFinite(n) ? n : 0; };
  const has = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  const money = (value) => has(value) ? new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(Number(value)) : "—";
  const moneyShort = (value) => { const n = num(value); const abs = Math.abs(n); if (abs >= 1e6) return `R$ ${new Intl.NumberFormat("pt-BR",{maximumFractionDigits:1}).format(n/1e6)}M`; if (abs >= 1e4) return `R$ ${new Intl.NumberFormat("pt-BR",{maximumFractionDigits:1}).format(n/1e3)}k`; return money(n); };
  const integer = (value) => new Intl.NumberFormat("pt-BR").format(num(value));
  const decimal = (value, digits = 1) => new Intl.NumberFormat("pt-BR",{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(num(value));
  const pct = (value, digits = 1) => `${decimal(value, digits)}%`;
  const time = (value) => { const d = value ? new Date(value) : new Date(); return new Intl.DateTimeFormat("pt-BR",{hour:"2-digit",minute:"2-digit"}).format(Number.isNaN(d.getTime()) ? new Date() : d); };
  const shortDate = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "")); return m ? `${m[3]}/${m[2]}` : ""; };
  const setText = (id, value) => { const el = $(id); if (el) el.textContent = value; };

  const DELIVERY_LABELS = { new:"Novos", approved:"Aprovados", invoiced:"Faturados", shipped:"Enviados", delivered:"Entregues", cancelled:"Cancelados", canceled:"Cancelados", frozen:"Congelados", unknown:"Sem situação" };
  const PREVIOUS_LABELS = { today:"Ontem", "7d":"7 dias anteriores", "14d":"14 dias anteriores", "30d":"30 dias anteriores" };

  // ---------- Comparativo com o periodo anterior (valor + hover) ----------
  function variation(current, previous, { mode = "percent", inverse = false } = {}) {
    if (!has(current) || !has(previous)) return { text: "Sem base", tone: "neutral", raw: null };
    const c = Number(current), p = Number(previous);
    if (mode === "points") {
      const d = c - p;
      return { text: `${d >= 0 ? "+" : "-"}${decimal(Math.abs(d))} p.p.`, tone: d === 0 ? "neutral" : (d > 0) !== inverse ? "positive" : "negative", raw: d };
    }
    if (p === 0) return { text: c > 0 ? "Novo no período" : "Sem variação", tone: "neutral", raw: null };
    const d = ((c - p) / Math.abs(p)) * 100;
    return { text: `${d >= 0 ? "+" : "-"}${decimal(Math.abs(d))}%`, tone: Math.abs(d) < 0.05 ? "neutral" : (d > 0) !== inverse ? "positive" : "negative", raw: d };
  }

  function comparison(id, { label, current, previous, format, previousLabel, mode, inverse, extra = [] }) {
    const el = $(id); if (!el) return null;
    const v = variation(current, previous, { mode, inverse });
    const rows = [[`${label} atual`, has(current) ? format(current) : "—"], [previousLabel, has(previous) ? format(previous) : "—"], ...extra];
    el.classList.add("mg-cmp");
    el.setAttribute("tabindex", "0");
    el.setAttribute("aria-label", `${label}: ${has(current) ? format(current) : "sem dado"}. ${previousLabel}: ${has(previous) ? format(previous) : "sem dado"}. Variação: ${v.text}.`);
    el.innerHTML = `<span class="mg-cmp__value">${esc(has(current) ? format(current) : "—")}</span>`
      + `<span class="mg-cmp__box" role="tooltip"><span class="mg-cmp__title">Comparativo do período</span>`
      + rows.map(([k, val]) => `<span class="mg-cmp__row"><span>${esc(k)}</span><b>${esc(val)}</b></span>`).join("")
      + `<span class="mg-cmp__row"><span>Variação</span><b data-tone="${v.tone}">${esc(v.text)}</b></span></span>`;
    return v;
  }

  function delta(id, v, suffix = "vs. período anterior") {
    const el = $(id); if (!el || !v) return;
    el.textContent = v.raw === null ? v.text : `${v.text} ${suffix}`;
    el.dataset.tone = v.tone;
  }

  // ---------- Ritmo do mes ----------
  function paceModel(current, previous, day, daysInMonth) {
    const c = num(current), p = num(previous), dim = Math.max(1, num(daysInMonth)), d = Math.min(dim, Math.max(1, num(day)));
    const expected = p * (d / dim);
    const projection = (c / d) * dim;
    return { current: c, previous: p, expected, projection, gap: c - expected, progress: p > 0 ? (c / p) * 100 : 0, marker: (d / dim) * 100,
      status: p <= 0 ? "no_base" : c >= expected ? "ahead" : "behind", day: d, dim };
  }

  function renderPace(id, title, model, format) {
    const host = $(id); if (!host) return;
    host.dataset.status = model.status;
    const gapText = model.status === "no_base" ? "Sem mês anterior para comparar" : `${model.gap >= 0 ? "+ " : "- "}${format(Math.abs(model.gap))}`;
    const statusText = model.status === "ahead" ? "Acima do ritmo do mês passado" : model.status === "behind" ? "Abaixo do ritmo do mês passado" : "Primeiro mês com dados";
    const projectionDelta = model.previous > 0 ? model.projection - model.previous : null;
    host.innerHTML = `
      <div class="mg-dashboard-pace__head"><span class="mg-dashboard-tag">${esc(title)}</span><span class="mg-dashboard-status" data-tone="${model.status === "ahead" ? "success" : model.status === "behind" ? "danger" : "neutral"}">${esc(statusText)}</span></div>
      <strong class="mg-dashboard-pace__main">${esc(gapText)}</strong>
      <span class="mg-dashboard-pace__caption">${model.status === "no_base" ? "" : `contra o esperado até hoje (dia ${model.day} de ${model.dim})`}</span>
      <div class="mg-dashboard-pace__labels"><span>Realizado</span><span>Ritmo para igualar o mês passado</span></div>
      <div class="mg-dashboard-pace__track"><i style="width:${Math.min(100, model.progress).toFixed(1)}%"></i><b style="left:${model.marker.toFixed(1)}%"></b></div>
      <div class="mg-dashboard-pace__labels mg-dashboard-pace__labels--values"><span>${pct(model.progress)}</span><span>${pct(model.marker)}</span></div>
      <div class="mg-dashboard-pace__cells">
        <article><span>Realizado</span><strong>${esc(format(model.current))}</strong></article>
        <article><span>Esperado até hoje</span><strong>${esc(model.previous > 0 ? format(model.expected) : "—")}</strong></article>
        <article><span>Mês passado</span><strong>${esc(model.previous > 0 ? format(model.previous) : "—")}</strong></article>
      </div>
      <div class="mg-dashboard-pace__projection"><span>Projeção do mês (ritmo atual)</span><div><strong>${esc(format(model.projection))}</strong>${projectionDelta === null ? "" : `<small data-tone="${projectionDelta >= 0 ? "positive" : "negative"}">${projectionDelta >= 0 ? "+ " : "- "}${esc(format(Math.abs(projectionDelta)))} vs. mês passado</small>`}</div></div>`;
  }

  // ---------- Prioridades com impacto em R$ ----------
  function buildPriorities(data, ctx) {
    const list = [];
    const { paceGmv, risk, marginNow, cancelNow, cancelPrev } = ctx;
    if (paceGmv && paceGmv.status === "behind") {
      list.push({ tone: paceGmv.gap < -0.2 * paceGmv.expected ? "danger" : "warning", title: "Ritmo do mês abaixo do mês passado",
        detail: `Faltam ${money(Math.abs(paceGmv.gap))} para acompanhar, até hoje, o ritmo do mês passado. Projeção atual: ${moneyShort(paceGmv.projection)}.`,
        impact: Math.abs(paceGmv.gap), impactLabel: "abaixo do ritmo", href: "#mg-dashboard-pace", action: "Ver ritmo do mês" });
    }
    if (risk && risk.count > 0) {
      const parts = [risk.out_of_stock ? `${integer(risk.out_of_stock)} sem estoque` : "", risk.low_coverage ? `${integer(risk.low_coverage)} com menos de ${risk.coverage_limit_days} dias de estoque` : ""].filter(Boolean).join(" e ");
      list.push({ tone: risk.out_of_stock ? "danger" : "warning", title: "Produtos que vendem estão acabando",
        detail: `${integer(risk.count)} produto(s) vendidos nos últimos ${risk.window_days} dias: ${parts}.`,
        impact: risk.revenue_at_risk, impactLabel: `vendas em ${risk.window_days} dias`, href: "/magalu/estoque", action: "Revisar estoque" });
    }
    if (marginNow && num(marginNow.orders_with_missing_cost) > 0) {
      list.push({ tone: "warning", title: "Pedidos com item sem custo cadastrado",
        detail: `${integer(marginNow.orders_with_missing_cost)} pedido(s) do período ficam fora da margem porque algum item não tem custo.`,
        impact: null, href: "/magalu/margem?aba=costs", action: "Completar custos" });
    }
    if (marginNow && num(marginNow.negative_orders) > 0) {
      list.push({ tone: "danger", title: "Pedidos com prejuízo", detail: `${integer(marginNow.negative_orders)} pedido(s) do período fecharam com resultado negativo.`,
        impact: null, href: "/magalu/margem", action: "Ver pedidos" });
    } else if (marginNow && num(marginNow.low_margin_orders) > 0) {
      list.push({ tone: "warning", title: "Pedidos com margem baixa", detail: `${integer(marginNow.low_margin_orders)} pedido(s) do período ficaram com margem de até 10%.`,
        impact: null, href: "/magalu/margem", action: "Ver pedidos" });
    }
    if (cancelNow && num(cancelNow.total) >= 2 && num(cancelNow.total) > num(cancelPrev?.total)) {
      list.push({ tone: "warning", title: "Cancelamentos subiram", detail: `${integer(cancelNow.total)} pedido(s) cancelados no período, contra ${integer(cancelPrev?.total)} no período anterior.`,
        impact: cancelNow.value, impactLabel: "valor cancelado", href: "/magalu/pedidos", action: "Abrir pedidos" });
    }
    if (num(data?.orders?.total) === 0) {
      list.push({ tone: "neutral", title: "Sem pedidos no período", detail: "Nenhum pedido aprovado no recorte selecionado.", impact: null, href: "/magalu/pedidos", action: "Abrir pedidos" });
    }
    if (!list.length) list.push({ tone: "success", title: "Nenhuma prioridade no recorte atual", detail: "Ritmo, estoque dos produtos que vendem, custos e margem sem alerta.", impact: null, href: "/magalu/margem", action: "Ver margem" });
    return list;
  }

  function renderPriorities(list) {
    const host = $("mg-dashboard-priorities"); if (!host) return;
    host.innerHTML = list.slice(0, 4).map((item, index) => `<a class="mg-dashboard-priority" data-tone="${esc(item.tone)}" href="${esc(item.href)}"><span class="mg-dashboard-priority__index">${index + 1}</span><span class="mg-dashboard-priority__copy"><strong>${esc(item.title)}</strong><span>${esc(item.detail)}</span><em>${esc(item.action)} →</em></span>${item.impact ? `<span class="mg-dashboard-priority__impact"><strong>${esc(moneyShort(item.impact))}</strong><small>${esc(item.impactLabel || "impacto potencial")}</small></span>` : ""}</a>`).join("");
    const top = list[0]; const health = $("mg-dashboard-health");
    if (health && top) {
      health.hidden = false;
      health.dataset.tone = top.tone === "neutral" ? "neutral" : top.tone;
      setText("mg-dashboard-health-text", top.tone === "success" ? top.title : `${top.title}${top.impact ? ` · ${moneyShort(top.impact)}` : ""}`);
      const link = $("mg-dashboard-health-link"); if (link) { link.href = top.href; link.textContent = `${top.action} →`; }
    }
  }

  function renderTopProducts(rows) {
    const body = $("mg-dashboard-top-products"); if (!body) return;
    if (!Array.isArray(rows)) { body.innerHTML = '<tr><td colspan="5">Não foi possível carregar os produtos agora.</td></tr>'; return; }
    if (!rows.length) { body.innerHTML = '<tr><td colspan="5">Nenhuma venda com itens identificados no período.</td></tr>'; return; }
    body.innerHTML = rows.map((row) => {
      const coverage = row.coverage_days == null ? "—" : row.stock <= 0 ? "Sem estoque" : `${decimal(row.coverage_days, 0)} dias`;
      const tone = row.stock == null ? "neutral" : row.stock <= 0 || (row.coverage_days != null && row.coverage_days <= 7) ? "danger" : row.coverage_days != null && row.coverage_days <= 15 ? "warning" : "success";
      return `<tr><td><strong class="mg-dashboard-top-title">${esc(row.title)}</strong><small>${esc(row.sku)}</small></td><td>${integer(row.units)}</td><td>${money(row.revenue)}</td><td>${row.stock == null ? "—" : integer(row.stock)}</td><td><span class="mg-dashboard-status" data-tone="${tone}">${esc(coverage)}</span></td></tr>`;
    }).join("");
  }

  function renderStockRisk(risk) {
    const card = $("mg-dashboard-stock-risk-card");
    if (!risk) { setText("mg-dashboard-stock-risk", "—"); setText("mg-dashboard-stock-count", "Não foi possível calcular agora"); setText("mg-dashboard-stock-risk-count", "—"); return; }
    const tone = risk.out_of_stock ? "danger" : risk.count ? "warning" : "success";
    if (card) card.dataset.tone = tone;
    const status = $("mg-dashboard-stock-status"); if (status) { status.textContent = tone === "danger" ? "Ruptura" : tone === "warning" ? "Atenção" : "Saudável"; status.dataset.tone = tone; }
    setText("mg-dashboard-stock-risk", integer(risk.count));
    setText("mg-dashboard-stock-count", risk.sold_skus ? `de ${integer(risk.sold_skus)} produto(s) vendidos nos últimos ${risk.window_days} dias estão sem estoque ou com até ${risk.coverage_limit_days} dias` : "Sem vendas com itens identificados nos últimos 30 dias");
    const list = $("mg-dashboard-stock-items");
    if (list) list.innerHTML = (risk.items || []).map((item) => `<div><span title="${esc(item.title)}">${esc(item.title)}</span><strong>${item.stock <= 0 ? "Sem estoque" : `${integer(item.stock)} un. · ${decimal(item.coverage_days, 0)} dias`}</strong></div>`).join("");
    setText("mg-dashboard-stock-risk-count", integer(risk.count));
    setText("mg-dashboard-stock-meta", risk.count ? `${integer(risk.out_of_stock)} sem estoque · ${integer(risk.low_coverage)} acabando` : "produtos que vendem com estoque ok");
    const mini = $("mg-dashboard-stock-card"); if (mini) mini.dataset.tone = tone === "success" ? "" : tone;
  }

  function renderDeliveryStatuses(rows) {
    const values = Array.isArray(rows) ? rows : [];
    const total = values.reduce((sum, row) => sum + num(row.total), 0);
    setText("mg-dashboard-delivery-main", total ? integer(total) : "—");
    const badge = $("mg-dashboard-delivery-badge"); if (badge) { badge.textContent = total ? "Atualizadas" : "Sem entregas"; badge.dataset.tone = total ? "success" : "warning"; }
    const host = $("mg-dashboard-delivery-statuses"); if (!host) return;
    host.innerHTML = values.length ? values.slice(0, 6).map((row) => `<div><span>${esc(DELIVERY_LABELS[String(row.status || "unknown").toLowerCase()] || row.status)}</span><strong>${integer(row.total)}</strong></div>`).join("") : '<div><span>Sem entregas sincronizadas</span><strong>—</strong></div>';
  }

  function renderError() {
    ["kpi-gmv-30d","kpi-orders-30d","kpi-ticket-30d","mg-dashboard-margin-pct","mg-dashboard-orders-today","mg-dashboard-orders-period","mg-dashboard-commercial-gmv","mg-dashboard-commercial-ticket","mg-dashboard-cost-coverage","mg-dashboard-updated"].forEach((id) => setText(id, "—"));
    const priority = $("mg-dashboard-priorities");
    if (priority) priority.innerHTML = '<div class="mg-dashboard-priority" data-tone="danger"><span class="mg-dashboard-priority__copy"><strong>Não foi possível atualizar o painel</strong><span>Tente novamente pelo botão de atualização.</span></span></div>';
  }

  function render(data) {
    if (!document.querySelector('[data-page="/"]') || location.pathname.replace(/\/$/, "") !== "/magalu") return;
    if (!data) { renderError(); return; }
    const orders = data.orders || {}, prev = data.previous_orders || {}, coverage = data.margin_coverage || {}, account = data.account || {};
    const insights = data.insights || {};
    const periodKey = data.period?.key || "7d";
    const windows = insights.windows || {};
    const prevRange = windows.previous ? `${shortDate(windows.previous.from)}${windows.previous.from !== windows.previous.to ? ` a ${shortDate(windows.previous.to)}` : ""}` : "";
    const previousLabel = `${PREVIOUS_LABELS[periodKey] || "Período anterior"}${prevRange ? ` (${prevRange})` : ""}`;
    const marginNow = insights.margin?.current || null, marginPrev = insights.margin?.previous || null;
    const cancelNow = insights.cancellations?.current || null, cancelPrev = insights.cancellations?.previous || null;

    setText("mg-dashboard-period-label", data.period?.label || "Período selecionado");
    setText("mg-dashboard-account-name", account.magalu_tenant_name || "Conta Magalu");
    setText("mg-dashboard-updated", `Atualizado às ${time(data.meta?.generated_at)}`);

    // KPIs principais com hover comparativo.
    delta("mg-dashboard-gmv-delta", comparison("kpi-gmv-30d", { label: "Faturamento", current: orders.gross_value_30d, previous: prev.gross_value_30d, format: money, previousLabel }));
    const ordersV = comparison("kpi-orders-30d", { label: "Pedidos", current: num(orders.total), previous: num(prev.total), format: integer, previousLabel });
    delta("mg-dashboard-orders-delta", ordersV);
    delta("mg-dashboard-ticket-delta", comparison("kpi-ticket-30d", { label: "Ticket médio", current: orders.ticket_average_30d, previous: prev.ticket_average_30d, format: money, previousLabel }));

    const marginCard = $("mg-dashboard-margin-card");
    if (marginNow && has(marginNow.known_margin_pct)) {
      const v = comparison("mg-dashboard-margin-pct", { label: "Margem", current: Number(marginNow.known_margin_pct), previous: marginPrev && has(marginPrev.known_margin_pct) ? Number(marginPrev.known_margin_pct) : null, format: (x) => pct(x), previousLabel, mode: "points",
        extra: [["Resultado atual", money(marginNow.known_result)], ["Resultado anterior", marginPrev && has(marginPrev.known_result) ? money(marginPrev.known_result) : "—"]] });
      const el = $("mg-dashboard-margin-delta"); if (el) { el.textContent = `${money(marginNow.known_result)} de resultado${v && v.raw !== null ? ` · ${v.text}` : ""}`; el.dataset.tone = v?.tone || "neutral"; }
      if (marginCard) marginCard.dataset.tone = num(marginNow.known_margin_pct) < 0 ? "danger" : num(marginNow.known_margin_pct) <= 10 ? "warning" : "success";
    } else {
      setText("mg-dashboard-margin-pct", "—");
      const el = $("mg-dashboard-margin-delta"); if (el) { el.textContent = marginNow ? "Sem pedidos com custo e relatório financeiro" : "Não foi possível calcular agora"; el.dataset.tone = "neutral"; }
    }

    // Indicadores complementares.
    if (cancelNow) {
      delta("mg-dashboard-cancel-meta", comparison("mg-dashboard-cancel", { label: "Cancelamentos", current: num(cancelNow.total), previous: cancelPrev ? num(cancelPrev.total) : null, format: integer, previousLabel, inverse: true,
        extra: [["Valor cancelado", money(cancelNow.value)]] }));
    } else setText("mg-dashboard-cancel", "—");
    setText("mg-dashboard-cost-coverage", `${num(coverage.percent)}%`);
    setText("mg-dashboard-cost-coverage-meta", `${integer(coverage.costed_skus)} de ${integer(coverage.priced_skus)} SKU(s) com preço`);
    const costCard = $("mg-dashboard-cost-card"); if (costCard) costCard.dataset.tone = num(coverage.percent) < 80 ? "warning" : "";
    setText("mg-dashboard-orders-today", integer(orders.today));
    setText("mg-dashboard-products-sold", has(insights.sold_skus) ? `${integer(insights.sold_skus)} produto(s) diferentes vendidos no período` : "produtos vendidos no período");

    // Comercial.
    setText("mg-dashboard-orders-period", integer(orders.total));
    const cmp = $("mg-dashboard-comparison"); if (cmp && ordersV) { cmp.textContent = ordersV.raw === null ? ordersV.text : `${ordersV.text} vs. período anterior`; cmp.dataset.tone = ordersV.tone; }
    comparison("mg-dashboard-commercial-gmv", { label: "Faturamento", current: orders.gross_value_30d, previous: prev.gross_value_30d, format: money, previousLabel });
    comparison("mg-dashboard-commercial-ticket", { label: "Ticket médio", current: orders.ticket_average_30d, previous: prev.ticket_average_30d, format: money, previousLabel });
    if (cancelNow) {
      comparison("mg-dashboard-commercial-cancel", { label: "Cancelamentos", current: num(cancelNow.total), previous: cancelPrev ? num(cancelPrev.total) : null, format: integer, previousLabel, inverse: true });
      comparison("mg-dashboard-commercial-cancel-value", { label: "Valor cancelado", current: num(cancelNow.value), previous: cancelPrev ? num(cancelPrev.value) : null, format: money, previousLabel, inverse: true });
    }

    // Resultado.
    if (marginNow) {
      setText("mg-dashboard-result-main", has(marginNow.known_margin_pct) ? pct(marginNow.known_margin_pct) : "—");
      setText("mg-dashboard-result-caption", has(marginNow.known_margin_pct) ? "margem sobre o faturamento com resultado" : "sem pedidos completos no período");
      const result = (key, id, inverse = false) => comparison(id, { label: $(id)?.previousElementSibling?.textContent || "Valor", current: num(marginNow[key]), previous: marginPrev ? num(marginPrev[key]) : null, format: money, previousLabel, inverse });
      result("covered_gmv", "mg-dashboard-result-gmv");
      result("product_cost", "mg-dashboard-result-cost", true);
      result("taxes", "mg-dashboard-result-taxes", true);
      result("operating_costs", "mg-dashboard-result-operating", true);
      result("known_result", "mg-dashboard-result-value");
      setText("mg-dashboard-result-orders", `${integer(marginNow.complete_orders)} de ${integer(marginNow.orders)}`);
      const pending = num(marginNow.incomplete_orders);
      const note = $("mg-dashboard-result-note");
      if (note) { note.hidden = !pending; note.textContent = pending ? `${integer(pending)} pedido(s) (${money(marginNow.incomplete_gmv)}) ainda sem relatório financeiro do Magalu ou sem custo cadastrado. Eles entram no resultado quando completos.` : ""; }
    }

    // Ritmo do mes.
    const pace = insights.month_pace || null;
    let paceGmv = null;
    if (pace && has(pace.day_of_month)) {
      paceGmv = paceModel(pace.current_gmv, pace.previous_gmv, pace.day_of_month, pace.days_in_month);
      renderPace("mg-dashboard-pace-gmv", "Faturamento", paceGmv, money);
      renderPace("mg-dashboard-pace-orders", "Pedidos", paceModel(pace.current_orders, pace.previous_orders, pace.day_of_month, pace.days_in_month), (x) => integer(Math.round(x)));
      setText("mg-dashboard-pace-caption", `Dia ${paceGmv.day} de ${paceGmv.dim}. O esperado até hoje é o mês passado proporcional aos dias corridos.`);
    } else setText("mg-dashboard-pace-caption", "Não foi possível calcular o ritmo agora.");

    renderTopProducts(insights.top_products);
    renderStockRisk(insights.stock_risk || null);
    renderDeliveryStatuses(orders.delivery_statuses);
    renderPriorities(buildPriorities(data, { paceGmv, risk: insights.stock_risk, marginNow, cancelNow, cancelPrev }));
  }

  window.addEventListener("magalu:dashboarddata", (event) => render(event.detail?.data || null));
  window.MagaluDashboard = { _test: { variation, paceModel, buildPriorities } };
})();
