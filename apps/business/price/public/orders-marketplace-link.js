"use strict";

(function marketplaceOrderLinking() {
  const marketplaceNames = { meli: "Mercado Livre", shopee: "Shopee" };
  let requestGeneration = 0;
  let connectionsByChannel = {};

  function dialog() {
    let node = document.querySelector("#marketplaceLinkDialog");
    if (node) return node;
    node = document.createElement("dialog");
    node.id = "marketplaceLinkDialog";
    node.className = "marketplace-link-dialog";
    node.setAttribute("aria-labelledby", "marketplaceLinkDialogTitle");
    node.innerHTML = `<form method="dialog" class="card section"><div class="section-title"><div><h3 id="marketplaceLinkDialogTitle">Vincular pedido ao marketplace</h3><p class="muted">Escolha a conta que recebeu esta venda.</p></div><button type="button" id="closeMarketplaceLink" aria-label="Fechar">×</button></div><div class="form-grid"><label>Marketplace<select id="marketplaceLinkChannel"><option value="meli">Mercado Livre</option><option value="shopee">Shopee</option></select></label><label>Conta vinculada<select id="marketplaceLinkConnection" required></select></label><label class="wide">ID do pedido no marketplace<input id="marketplaceLinkOrderId" required /></label></div><p id="marketplaceLinkError" class="form-error hidden" role="alert"></p><div class="toolbar"><button class="primary" id="saveMarketplaceLink" type="button" disabled>Salvar vínculo</button></div></form>`;
    document.body.append(node);
    node.querySelector("#closeMarketplaceLink").onclick = () => node.close();
    node.querySelector("#marketplaceLinkChannel").onchange = () => fillConnectionOptions(node);
    node.querySelector("#saveMarketplaceLink").onclick = () => saveMarketplaceLink(node);
    return node;
  }

  function fillConnectionOptions(node) {
    const channel = node.querySelector("#marketplaceLinkChannel").value;
    const select = node.querySelector("#marketplaceLinkConnection");
    const connections = connectionsByChannel[channel] || [];
    select.replaceChildren();
    if (!connections.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = `Nenhuma conta ${marketplaceNames[channel]} ativa`;
      select.append(option);
      select.disabled = true;
      node.querySelector("#saveMarketplaceLink").disabled = true;
      return;
    }
    select.disabled = false;
    connections.forEach((connection) => {
      const option = document.createElement("option");
      option.value = connection.id;
      option.textContent = connection.display_name || connection.external_account_id || "Conta vinculada";
      select.append(option);
    });
    node.querySelector("#saveMarketplaceLink").disabled = false;
  }

  async function openMarketplaceLink(button) {
    const node = dialog();
    const generation = ++requestGeneration;
    const target = {
      orderId: button.dataset.link,
      orderIdExternal: button.dataset.currentOrder || "",
      marketplace: button.dataset.currentMarket,
      connectionId: button.dataset.currentConnection || "",
    };
    node.dataset.orderId = "";
    node.querySelector("#saveMarketplaceLink").disabled = true;
    node.querySelector("#marketplaceLinkError").classList.add("hidden");
    node.querySelector("#marketplaceLinkOrderId").value = target.orderIdExternal;
    const selectedChannel = ["meli", "shopee"].includes(target.marketplace) ? target.marketplace : "meli";
    node.querySelector("#marketplaceLinkChannel").value = selectedChannel;
    try {
      const [result, orderResult] = await Promise.all([api("/integrations/"), api(`/orders/${target.orderId}`)]);
      if (generation !== requestGeneration) return;
      const authoritativeOrder = orderResult.order || {};
      target.marketplace = authoritativeOrder.marketplace || target.marketplace;
      target.orderIdExternal = authoritativeOrder.marketplace_order_id || target.orderIdExternal;
      target.connectionId = authoritativeOrder.marketplace_connection_id || "";
      node.querySelector("#marketplaceLinkOrderId").value = target.orderIdExternal;
      node.querySelector("#marketplaceLinkChannel").value = ["meli", "shopee"].includes(target.marketplace) ? target.marketplace : "meli";
      connectionsByChannel = (result.connections || [])
        .filter((connection) => ["meli", "shopee"].includes(connection.channel) && connection.status === "active")
        .reduce((groups, connection) => ((groups[connection.channel] ??= []).push(connection), groups), {});
      fillConnectionOptions(node);
      node.dataset.orderId = target.orderId;
      const connectionSelect = node.querySelector("#marketplaceLinkConnection");
      if (target.connectionId && [...connectionSelect.options].some((option) => option.value === target.connectionId)) connectionSelect.value = target.connectionId;
      node.querySelector("#saveMarketplaceLink").disabled = !connectionSelect.value;
      if (typeof node.showModal === "function") node.showModal();
      else node.setAttribute("open", "");
    } catch (error) {
      if (generation !== requestGeneration) return;
      toast(error.message, true);
    }
  }

  async function saveMarketplaceLink(node) {
    const marketplace = node.querySelector("#marketplaceLinkChannel").value;
    const connectionId = node.querySelector("#marketplaceLinkConnection").value;
    const externalOrderId = node.querySelector("#marketplaceLinkOrderId").value.trim();
    const error = node.querySelector("#marketplaceLinkError");
    const orderId = node.dataset.orderId;
    if (!orderId || !connectionId || !externalOrderId) {
      error.textContent = "Informe a conta e o ID do pedido no marketplace.";
      error.classList.remove("hidden");
      return;
    }
    try {
      await api(`/orders/${orderId}/link-marketplace`, { method: "PATCH", body: JSON.stringify({ marketplace, externalOrderId, connectionId }) });
      node.close();
      toast("Pedido vinculado.");
      document.querySelector("#filterOrders")?.click();
    } catch (requestError) {
      error.textContent = requestError.message;
      error.classList.remove("hidden");
    }
  }

  async function showSelectedAccounts() {
    const buttons = [...document.querySelectorAll("#orderRows [data-link]:not([data-account-label-processed])")];
    if (!buttons.length) return;
    const query = new URLSearchParams();
    const status = document.querySelector("#orderStatus")?.value;
    const from = document.querySelector("#orderFrom")?.value;
    const to = document.querySelector("#orderTo")?.value;
    if (status) query.set("status", status);
    if (from) query.set("from", from);
    if (to) query.set("to", to);
    const result = await api(`/orders/?${query}`);
    const orders = new Map((result.rows || []).map((order) => [String(order.id), order]));
    buttons.forEach((button) => {
      const order = orders.get(button.dataset.link);
      const accountName = order?.marketplace_connection_display_name;
      button.dataset.accountLabelProcessed = "true";
      if (!accountName) return;
      button.dataset.currentConnection = order.marketplace_connection_id || "";
      const cell = button.parentElement;
      cell.querySelector(".marketplace-connection-label")?.remove();
      const label = document.createElement("small");
      label.className = "marketplace-connection-label tiny";
      label.textContent = `Conta: ${accountName}`;
      cell.append(document.createElement("br"), label);
    });
  }

  let accountLabelTimer;
  function scheduleAccountLabels() {
    if (!document.querySelector("#orderRows [data-link]:not([data-account-label-processed])")) return;
    clearTimeout(accountLabelTimer);
    accountLabelTimer = setTimeout(() => showSelectedAccounts().catch(() => {}), 0);
  }

  window.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-link]");
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openMarketplaceLink(button);
  }, true);
  new MutationObserver(scheduleAccountLabels).observe(document.body, { childList: true, subtree: true });
}());
