"use strict";

(function enhanceOrdersPage() {
  async function loadStatus(container) {
    try {
      container.classList.remove("danger-note");
      const data = await api("/orders/sync/status");
      const run = data.run;
      const checkpoint = data.checkpoint;
      container.innerHTML = run
        ? `<h4>Último sync</h4><p><strong>${escapeHtml(run.status)}</strong> · ${run.records_upserted || 0} gravados · ${run.pages || 0} página(s) · início ${date(run.started_at)}${run.error_message ? ` · ${escapeHtml(run.error_message)}` : ""}. Checkpoint: ${date(checkpoint?.last_success_at)}</p>`
        : '<h4>Sincronização Tray</h4><p>Nenhuma sincronização registrada.</p>';
    } catch (error) {
      container.innerHTML = `<h4>Status do sync indisponível</h4><p>${escapeHtml(error.message)}</p>`;
      container.classList.add("danger-note");
    }
  }

  async function showUnmatched(button) {
    const data = await api("/orders/unmatched");
    const body = document.querySelector("#orderRows");
    if (!body) return;
    body.innerHTML = data.rows.map((order) => `<tr>
      <td>${escapeHtml(order.order_date || "—")}</td><td>${escapeHtml(order.source_order_id)}</td>
      <td><span class="badge">${escapeHtml(order.status || "—")}</span></td><td>${money(order.total_amount)}</td>
      <td>${escapeHtml(order.marketplace === "meli" ? "Mercado Livre" : order.marketplace === "shopee" ? "Shopee / loja" : order.marketplace || "—")}${["meli", "shopee"].includes(order.marketplace) ? (order.marketplace_account_id ? ` · ${order.marketplace === "shopee" ? "loja" : "conta"} ${escapeHtml(order.marketplace_account_id)}` : " · conta não identificada") : ""}</td><td>${escapeHtml(order.marketplace_order_id || "—")}</td>
      <td><span class="badge warning">${escapeHtml(order.reconciliation_status)}</span> <button data-reconcile="${order.id}">Vincular</button></td>
    </tr>`).join("") || '<tr><td colspan="7" class="muted">Todos os pedidos estão conciliados.</td></tr>';
    body.querySelectorAll("[data-reconcile]").forEach((link) => {
      link.onclick = async () => {
        const marketplace = prompt("Marketplace: meli ou shopee", "meli");
        if (!marketplace) return;
        const externalOrderId = prompt("ID do pedido no marketplace", "");
        if (!externalOrderId) return;
        const marketplaceAccountId = ["meli", "shopee"].includes(marketplace) ? prompt(marketplace === "shopee" ? "ID da loja Shopee" : "ID da conta Mercado Livre", "") : null;
        if (["meli", "shopee"].includes(marketplace) && !marketplaceAccountId) return;
        if (marketplace === "shopee") {
          const integrations = await api("/integrations/");
          const hasShop = (integrations.connections || []).some((connection) => connection.channel === "shopee" && String(connection.external_account_id) === String(marketplaceAccountId));
          if (!hasShop) { toast("Selecione uma loja Shopee conectada para vincular o pedido.", true); return; }
        }
        try {
          await api(`/orders/${link.dataset.reconcile}/link-marketplace`, { method: "PATCH", body: JSON.stringify({ marketplace, externalOrderId, marketplaceAccountId }) });
          toast("Pedido conciliado.");
          await showUnmatched(button);
        } catch (error) { toast(error.message, true); }
      };
    });
    button.textContent = `Não conciliados (${data.rows.length})`;
  }

  function install() {
    const syncButton = document.querySelector("#syncTray");
    if (!syncButton || document.querySelector("#unmatchedOrders")) return;
    const button = document.createElement("button");
    button.id = "unmatchedOrders";
    button.textContent = "Não conciliados";
    button.onclick = () => showUnmatched(button).catch((error) => toast(error.message, true));
    syncButton.insertAdjacentElement("afterend", button);
    const status = document.createElement("div");
    status.id = "ordersSyncStatus";
    status.className = "banner-ai";
    status.style.marginBottom = "16px";
    syncButton.closest(".card").insertAdjacentElement("beforebegin", status);
    loadStatus(status);
    syncButton.addEventListener("click", () => setTimeout(() => loadStatus(status), 500));
  }

  new MutationObserver(install).observe(document.documentElement, { childList: true, subtree: true });
  install();
})();
