"use strict";

(function enhanceFinancialTruth() {
  let loading = false;

  function askNumber(label, defaultValue = "0") {
    const value = prompt(label, defaultValue);
    return value === null ? null : value;
  }

  function enhanceOrderButtons() {
    document.querySelectorAll("[data-profit]:not([data-financial-ready])").forEach((button) => {
      button.dataset.financialReady = "true";
      button.onclick = async () => {
        const costAmount = askNumber("CMV/custo do pedido (R$)"); if (costAmount === null) return;
        const expectedFeeAmount = askNumber("Fee esperada (R$). Deixe 0 se desconhecida."); if (expectedFeeAmount === null) return;
        const shippingAmount = askNumber("Frete manual adicional (R$)"); if (shippingAmount === null) return;
        const adsAmount = askNumber("Ads atribuídos ao pedido (R$)"); if (adsAmount === null) return;
        const taxAmount = askNumber("Impostos do pedido (R$)"); if (taxAmount === null) return;
        const packagingAmount = askNumber("Embalagem (R$)"); if (packagingAmount === null) return;
        const otherAmount = askNumber("Outros custos (R$)"); if (otherAmount === null) return;
        try {
          const data = await api(`/profit/order/${button.dataset.profit}/calculate`, {
            method: "POST",
            body: JSON.stringify({ costAmount, expectedFeeAmount, shippingAmount, adsAmount, taxAmount, packagingAmount, otherAmount }),
          });
          const snapshot = data.snapshot;
          toast(`${snapshot.calculation_type === "realized" ? "MC realizada" : "MC esperada"}: ${money(snapshot.contribution_amount)} · versão ${snapshot.version}`);
        } catch (error) { toast(error.message, true); }
      };
    });
  }

  async function enhanceProfitPage() {
    const root = document.querySelector("#content");
    if (!root || document.querySelector("#financialBreakdown") || document.querySelector("#pageTitle")?.textContent !== "Profit" || loading) return;
    loading = true;
    try {
      const data = await api("/profit");
      const section = document.createElement("section");
      section.id = "financialBreakdown";
      section.className = "profit-breakdown";
      const snapshots = data.snapshots || [];
      const hasExpected = snapshots.length > 0;
      const hasRealized = snapshots.some((row) => row.calculation_type === "realized");
      const expected = hasExpected ? Number(data.totals?.expected_contribution_amount || 0) : null;
      const realized = hasRealized ? Number(data.totals?.realized_contribution_amount || 0) : null;
      section.innerHTML = `
        <div class="section-title"><h2>Margem esperada × margem real</h2><span class="chip ${hasRealized ? "green" : "amber"}">${hasRealized ? "Realizada disponível" : "Aguardando taxas reais"}</span></div>
        <div class="grid kpis profit-compare">
          <div class="card kpi"><small>MC esperada</small><strong>${expected == null ? "—" : money(expected)}</strong></div>
          <div class="card kpi"><small>MC realizada</small><strong>${realized == null ? "—" : money(realized)}</strong></div>
          <div class="card kpi"><small>Variação</small><strong>${expected == null || realized == null ? "—" : money(realized - expected)}</strong></div>
        </div>
        <div class="grid two">
          <div class="card section"><div class="section-title"><h2>Profit por canal</h2><span class="chip">${(data.byChannel || []).length} canal(is)</span></div>${(data.byChannel || []).map((row) => `<div class="metric-row"><span>${escapeHtml(row.source_channel || "—")} · ${row.orders} pedido(s)</span><strong>${money(row.contribution)}</strong></div>`).join("") || '<p class="muted">Sem dados calculados.</p>'}</div>
          <div class="card section"><div class="section-title"><h2>Profit por SKU</h2><span class="chip">${(data.bySku || []).length} SKU(s)</span></div>${(data.bySku || []).slice(0, 20).map((row) => `<div class="metric-row"><span>${escapeHtml(row.sku || row.title || "Sem SKU")} · ${Number(row.quantity || 0)} un.</span><strong>${money(row.contribution)}</strong></div>`).join("") || '<p class="muted">Hidrate pedidos Tray para habilitar o rateio por SKU.</p>'}</div>
        </div>`;
      root.append(section);
    } catch (error) {
      const section = document.createElement("div");
      section.id = "financialBreakdown";
      section.className = "notice danger-note";
      section.textContent = `Visão financeira indisponível: ${error.message}`;
      root.append(section);
    } finally { loading = false; }
  }

  function install() {
    enhanceOrderButtons();
    enhanceProfitPage();
  }
  new MutationObserver(install).observe(document.documentElement, { childList: true, subtree: true });
  install();
})();
