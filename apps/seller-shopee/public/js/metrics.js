let metricsRevenueChart = null;
let metricsOrdersChart = null;
let metricsProductRevenueChart = null;
let metricsProductOrdersChart = null;

class MetricsManager {
  constructor() {
    this.data = null;
    this.selectedProduct = null;
    this.productCompare = null;
    this.bound = false;
  }

  fmtMoney(value) {
    const n = Number(value || 0);
    return n.toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
    });
  }

  fmtInt(value) {
    return Number(value || 0).toLocaleString("pt-BR");
  }

  fmtDelta(value, suffix = "", isMoney = false) {
    const n = Number(value || 0);
    const sign = n > 0 ? "+" : n < 0 ? "-" : "";
    const abs = Math.abs(n);
    if (isMoney) return `${sign}${this.fmtMoney(abs)}${suffix}`;
    return `${sign}${abs.toLocaleString("pt-BR")}${suffix}`;
  }

  fmtDeltaPct(value) {
    if (value == null || !Number.isFinite(Number(value))) return "sem base comparativa";
    const n = Number(value);
    return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
  }

  async apiGet(path) {
    const response = await fetch(`/shopee${path}`, { credentials: "include" });
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(json?.message || json?.error || `HTTP ${response.status}`);
    }
    return json;
  }

  setMessage(text, type = "loading") {
    const el = document.getElementById("metricsMsg");
    if (!el) return;
    el.className = `muted ui-state ui-state--${type}`;
    el.textContent = text;
  }

  clearMessage() {
    const el = document.getElementById("metricsMsg");
    if (!el) return;
    el.className = "muted";
    el.textContent = "";
  }

  getThemeColors() {
    const styles = getComputedStyle(document.body);
    const text =
      styles.getPropertyValue("--text").trim() || "rgba(255,255,255,0.92)";
    const muted =
      styles.getPropertyValue("--muted").trim() || "rgba(255,255,255,0.64)";
    const grid = document.body.classList.contains("theme-light")
      ? "rgba(15,23,42,0.10)"
      : "rgba(255,255,255,0.08)";

    return { text, muted, grid };
  }

  destroyChart(chart) {
    if (chart && typeof chart.destroy === "function") chart.destroy();
    return null;
  }

  renderLineChart(canvasId, labels, datasets) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !window.Chart) return null;
    const colors = this.getThemeColors();

    return new Chart(canvas.getContext("2d"), {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            labels: { color: colors.text },
          },
        },
        scales: {
          x: {
            ticks: { color: colors.muted, maxRotation: 0 },
            grid: { color: colors.grid },
          },
          y: {
            ticks: { color: colors.muted },
            grid: { color: colors.grid },
          },
        },
      },
    });
  }

  renderBarChart(canvasId, labels, datasets) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !window.Chart) return null;
    const colors = this.getThemeColors();

    return new Chart(canvas.getContext("2d"), {
      type: "bar",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: { color: colors.text },
          },
        },
        scales: {
          x: {
            ticks: { color: colors.muted, maxRotation: 0 },
            grid: { display: false },
          },
          y: {
            ticks: { color: colors.muted },
            grid: { color: colors.grid },
          },
        },
      },
    });
  }

  setKpiValue(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  renderDelta(id, pctValue, rawValue, isMoney = false) {
    const el = document.getElementById(id);
    if (!el) return;

    const pct = this.fmtDeltaPct(pctValue);
    const raw = this.fmtDelta(rawValue, "", isMoney);
    el.textContent = `${pct} • ${raw}`;
    el.style.color =
      pctValue == null
        ? this.getThemeColors().muted
        : Number(pctValue) >= 0
          ? "rgba(34,197,94,0.96)"
          : "rgba(251,113,133,0.96)";
  }

  renderRankList(rootId, rows, formatter) {
    const root = document.getElementById(rootId);
    if (!root) return;

    if (!rows || !rows.length) {
      root.innerHTML = '<div class="muted ui-state ui-state--empty">Sem dados para este ranking.</div>';
      return;
    }

    root.innerHTML = rows
      .map((row, index) => formatter(row, index))
      .join("");
  }

  rankItemHtml(row, index, rightHtml) {
    return `
      <div class="metrics-rank-item">
        <div class="metrics-rank-item__index">${index + 1}</div>
        <div>
          <div class="metrics-rank-item__title">${this.escapeHtml(row.title || `Item ${row.itemId}`)}</div>
          <div class="metrics-rank-item__meta">ID ${this.escapeHtml(row.itemId)} • ${this.fmtInt(row.orders || row.currentOrders || 0)} pedidos</div>
        </div>
        <div class="metrics-rank-item__value">${rightHtml}</div>
      </div>
    `;
  }

  escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  renderOverview(data) {
    const current = data.overview.current;
    const delta = data.overview.delta;
    const labels = data.overview.series.map((row) => row.label);

    this.setKpiValue("metricsRevenueValue", this.fmtMoney(current.revenue));
    this.setKpiValue(
      "metricsRevenueCreatedValue",
      this.fmtMoney(current.revenueCreated),
    );
    this.setKpiValue(
      "metricsOrdersCreatedValue",
      this.fmtInt(current.ordersCreated),
    );
    this.setKpiValue("metricsOrdersPaidValue", this.fmtInt(current.ordersPaid));
    this.setKpiValue("metricsTicketValue", this.fmtMoney(current.ticketAverage));

    this.renderDelta("metricsRevenueDelta", delta.revenuePct, delta.revenueValue, true);
    this.renderDelta(
      "metricsRevenueCreatedDelta",
      delta.revenueCreatedPct,
      delta.revenueCreatedValue,
      true,
    );
    this.renderDelta(
      "metricsOrdersCreatedDelta",
      delta.ordersCreatedPct,
      delta.ordersCreatedValue,
    );
    this.renderDelta(
      "metricsOrdersPaidDelta",
      delta.ordersPaidPct,
      delta.ordersPaidValue,
    );
    this.renderDelta(
      "metricsTicketDelta",
      delta.ticketAveragePct,
      delta.ticketAverageValue,
      true,
    );

    const meta = document.getElementById("metricsRangeMeta");
    if (meta) {
      meta.textContent = `Atual: ${data.period.current.from} → ${data.period.current.to} • Comparação: ${data.period.previous.from} → ${data.period.previous.to}`;
    }

    metricsRevenueChart = this.destroyChart(metricsRevenueChart);
    metricsRevenueChart = this.renderLineChart("metricsRevenueChart", labels, [
      {
        label: "Faturamento atual",
        data: data.overview.series.map((row) => row.currentRevenue),
        borderColor: "#22d3ee",
        backgroundColor: "rgba(34,211,238,0.12)",
        borderWidth: 2,
        tension: 0.28,
        pointRadius: 0,
      },
      {
        label: "Período anterior",
        data: data.overview.series.map((row) => row.previousRevenue),
        borderColor: "#a855f7",
        backgroundColor: "rgba(168,85,247,0.12)",
        borderWidth: 2,
        tension: 0.28,
        pointRadius: 0,
      },
    ]);

    metricsOrdersChart = this.destroyChart(metricsOrdersChart);
    metricsOrdersChart = this.renderBarChart("metricsOrdersChart", labels, [
      {
        label: "Pedidos feitos",
        data: data.overview.series.map((row) => row.currentOrdersCreated),
        backgroundColor: "rgba(59,130,246,0.48)",
        borderColor: "rgba(59,130,246,0.8)",
        borderWidth: 1,
        borderRadius: 10,
      },
      {
        label: "Pedidos pagos",
        data: data.overview.series.map((row) => row.currentOrdersPaid),
        backgroundColor: "rgba(34,197,94,0.48)",
        borderColor: "rgba(34,197,94,0.8)",
        borderWidth: 1,
        borderRadius: 10,
      },
    ]);

    this.renderRankList("metricsTopSoldList", data.rankings.topSold, (row, index) =>
      this.rankItemHtml(
        row,
        index,
        `<div>${this.fmtInt(row.quantity)} un.</div><div class="metrics-rank-item__meta">${this.fmtMoney(row.revenue)}</div>`,
      ),
    );

    this.renderRankList("metricsTopRevenueList", data.rankings.topRevenue, (row, index) =>
      this.rankItemHtml(
        row,
        index,
        `<div>${this.fmtMoney(row.revenue)}</div><div class="metrics-rank-item__meta">${this.fmtInt(row.quantity)} un.</div>`,
      ),
    );

    this.renderRankList("metricsTopUpList", data.rankings.topUp, (row, index) =>
      this.rankItemHtml(
        row,
        index,
        `<div class="metrics-rank-item__delta--up">${this.fmtDelta(row.revenueDelta, "", true)}</div><div class="metrics-rank-item__meta">${this.fmtDeltaPct(row.revenueDeltaPct)}</div>`,
      ),
    );

    this.renderRankList("metricsTopDownList", data.rankings.topDown, (row, index) =>
      this.rankItemHtml(
        row,
        index,
        `<div class="metrics-rank-item__delta--down">${this.fmtDelta(row.revenueDelta, "", true)}</div><div class="metrics-rank-item__meta">${this.fmtDeltaPct(row.revenueDeltaPct)}</div>`,
      ),
    );

    this.renderFallingTable(data.rankings.productsFalling || []);
  }

  renderFallingTable(rows) {
    const tbody = document.getElementById("metricsFallingBody");
    if (!tbody) return;

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8"><div class="muted ui-state ui-state--empty">Nenhum produto em queda no período.</div></td></tr>';
      return;
    }

    tbody.innerHTML = rows
      .map(
        (row) => `
          <tr>
            <td>${this.escapeHtml(row.itemId)}</td>
            <td>${this.escapeHtml(row.title || `Item ${row.itemId}`)}</td>
            <td>${this.fmtMoney(row.currentRevenue)}</td>
            <td>${this.fmtMoney(row.previousRevenue)}</td>
            <td style="color:${row.revenueDelta >= 0 ? "rgba(34,197,94,0.96)" : "rgba(251,113,133,0.96)"}">${this.fmtDelta(row.revenueDelta, "", true)}</td>
            <td>${this.fmtInt(row.currentOrders)}</td>
            <td>${this.fmtInt(row.previousOrders)}</td>
            <td style="color:${row.ordersDelta >= 0 ? "rgba(34,197,94,0.96)" : "rgba(251,113,133,0.96)"}">${this.fmtDelta(row.ordersDelta)}</td>
          </tr>
        `,
      )
      .join("");
  }

  async loadOverview() {
    const days = document.getElementById("metricsDaysFilter")?.value || "30";
    this.setMessage("Carregando métricas comparativas...", "loading");
    try {
      const data = await this.apiGet(`/shops/active/metrics/overview?days=${encodeURIComponent(days)}`);
      this.data = data;
      this.renderOverview(data);
      this.clearMessage();
      if (this.selectedProduct) {
        await this.loadProductCompare(this.selectedProduct);
      }
    } catch (error) {
      this.setMessage(`Erro ao carregar métricas: ${error.message}`, "error");
    }
  }

  async searchProducts() {
    const q = String(
      document.getElementById("metricsProductSearch")?.value || "",
    ).trim();
    const root = document.getElementById("metricsProductResults");
    if (!root) return;

    if (!q) {
      root.innerHTML =
        '<div class="muted ui-state ui-state--empty">Digite um nome ou ID para buscar produtos.</div>';
      return;
    }

    root.innerHTML =
      '<div class="muted ui-state ui-state--loading">Buscando produtos...</div>';

    try {
      const data = await this.apiGet(
        `/shops/active/products?page=1&pageSize=25&q=${encodeURIComponent(q)}`,
      );
      const items = Array.isArray(data?.items) ? data.items : [];
      if (!items.length) {
        root.innerHTML =
          '<div class="muted ui-state ui-state--empty">Nenhum produto encontrado para a busca.</div>';
        return;
      }

      root.innerHTML = items
        .slice(0, 8)
        .map(
          (item) => `
            <button class="metrics-product-pick" data-metrics-item-id="${this.escapeHtml(item.itemId)}" type="button">
              ${
                item.images?.[0]?.url
                  ? `<img class="metrics-product-pick__thumb" src="${this.escapeHtml(item.images[0].url)}" alt="">`
                  : `<div class="metrics-product-pick__thumb"></div>`
              }
              <div>
                <div class="metrics-product-pick__title">${this.escapeHtml(item.title || `Item ${item.itemId}`)}</div>
                <div class="metrics-product-pick__meta">ID ${this.escapeHtml(item.itemId)} • ${this.fmtInt(item.sold || 0)} vendidos</div>
              </div>
              <span class="btn btn-ghost">Comparar</span>
            </button>
          `,
        )
        .join("");

      root.querySelectorAll("[data-metrics-item-id]").forEach((button) => {
        button.addEventListener("click", async () => {
          const itemId = button.getAttribute("data-metrics-item-id");
          if (!itemId) return;
          this.selectedProduct = itemId;
          await this.loadProductCompare(itemId);
        });
      });
    } catch (error) {
      root.innerHTML = `<div class="muted ui-state ui-state--error">Erro ao buscar produtos: ${this.escapeHtml(error.message)}</div>`;
    }
  }

  async loadProductCompare(itemId) {
    const days = document.getElementById("metricsDaysFilter")?.value || "30";
    const label = document.getElementById("metricsSelectedProductLabel");
    if (label) {
      label.textContent = `Carregando métricas do ID ${itemId}...`;
    }

    try {
      const data = await this.apiGet(
        `/shops/active/metrics/products/${encodeURIComponent(itemId)}?days=${encodeURIComponent(days)}`,
      );
      this.productCompare = data;

      if (label) {
        label.textContent = `${data.product.title} • ID ${data.product.itemId}`;
      }

      this.setKpiValue("metricsProductRevenueValue", this.fmtMoney(data.current.revenue));
      this.setKpiValue("metricsProductOrdersValue", this.fmtInt(data.current.orders));
      this.setKpiValue("metricsProductQuantityValue", this.fmtInt(data.current.quantity));
      this.setKpiValue("metricsProductTicketValue", this.fmtMoney(data.current.ticketAverage));

      this.renderDelta(
        "metricsProductRevenueDelta",
        data.delta.revenuePct,
        data.delta.revenueValue,
        true,
      );
      this.renderDelta(
        "metricsProductOrdersDelta",
        data.delta.ordersPct,
        data.delta.ordersValue,
      );
      this.renderDelta(
        "metricsProductQuantityDelta",
        data.delta.quantityPct,
        data.delta.quantityValue,
      );
      this.renderDelta(
        "metricsProductTicketDelta",
        data.delta.ticketAveragePct,
        data.delta.ticketAverageValue,
        true,
      );

      const labels = data.current.series.map((row) => row.label);

      metricsProductRevenueChart = this.destroyChart(metricsProductRevenueChart);
      metricsProductRevenueChart = this.renderLineChart(
        "metricsProductRevenueChart",
        labels,
        [
          {
            label: "Receita atual",
            data: data.current.series.map((row) => row.revenue),
            borderColor: "#22d3ee",
            backgroundColor: "rgba(34,211,238,0.12)",
            borderWidth: 2,
            tension: 0.28,
            pointRadius: 0,
          },
          {
            label: "Período anterior",
            data: data.previous.series.map((row) => row.revenue),
            borderColor: "#a855f7",
            backgroundColor: "rgba(168,85,247,0.12)",
            borderWidth: 2,
            tension: 0.28,
            pointRadius: 0,
          },
        ],
      );

      metricsProductOrdersChart = this.destroyChart(metricsProductOrdersChart);
      metricsProductOrdersChart = this.renderBarChart(
        "metricsProductOrdersChart",
        labels,
        [
          {
            label: "Pedidos atual",
            data: data.current.series.map((row) => row.orders),
            backgroundColor: "rgba(34,197,94,0.48)",
            borderColor: "rgba(34,197,94,0.8)",
            borderWidth: 1,
            borderRadius: 10,
          },
          {
            label: "Itens vendidos",
            data: data.current.series.map((row) => row.quantity),
            backgroundColor: "rgba(249,115,22,0.48)",
            borderColor: "rgba(249,115,22,0.8)",
            borderWidth: 1,
            borderRadius: 10,
          },
        ],
      );
    } catch (error) {
      if (label) {
        label.textContent = `Falha ao carregar o ID ${itemId}: ${error.message}`;
      }
    }
  }

  exportReport() {
    if (!this.data) return;

    const lines = [];
    lines.push("secao,metrica,valor");
    lines.push(`overview,Faturamento Total Pago,${this.data.overview.current.revenue}`);
    lines.push(`overview,Faturamento Total Feito,${this.data.overview.current.revenueCreated}`);
    lines.push(`overview,Pedidos Feitos,${this.data.overview.current.ordersCreated}`);
    lines.push(`overview,Pedidos Pagos,${this.data.overview.current.ordersPaid}`);
    lines.push(`overview,Ticket Medio,${this.data.overview.current.ticketAverage}`);

    for (const row of this.data.rankings.topRevenue || []) {
      lines.push(
        `top_revenue,${String(row.itemId).replace(/,/g, " ")},${row.revenue}`,
      );
    }

    for (const row of this.data.rankings.topDown || []) {
      lines.push(
        `top_down,${String(row.itemId).replace(/,/g, " ")},${row.revenueDelta}`,
      );
    }

    const blob = new Blob([lines.join("\n")], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `metricas-${this.data.period.days}d.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  bind() {
    if (this.bound) return;
    this.bound = true;

    document
      .getElementById("btnMetricsReload")
      ?.addEventListener("click", () => this.loadOverview());
    document
      .getElementById("btnMetricsExport")
      ?.addEventListener("click", () => this.exportReport());
    document
      .getElementById("btnMetricsSearchProduct")
      ?.addEventListener("click", () => this.searchProducts());
    document
      .getElementById("metricsProductSearch")
      ?.addEventListener("keydown", (event) => {
        if (event.key === "Enter") this.searchProducts();
      });
    document
      .getElementById("metricsDaysFilter")
      ?.addEventListener("change", () => this.loadOverview());

    document.querySelectorAll("[data-metrics-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        document
          .querySelectorAll("[data-metrics-tab]")
          .forEach((node) => node.classList.toggle("active", node === button));
        const target = button.getAttribute("data-metrics-tab");
        document.querySelectorAll(".metrics-sub-panel").forEach((panel) => {
          panel.classList.toggle("is-active", panel.id === `metrics-tab-${target}`);
        });
      });
    });
  }

  async load() {
    this.bind();
    await this.loadOverview();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  window.metricsManager = new MetricsManager();
});
