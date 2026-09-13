"use strict";

const integrationChannels = ["tray", "meli", "shopee"];
const integrationNames = { tray: "Tray", meli: "Mercado Livre", shopee: "Shopee" };

function consumeIntegrationRedirect() {
  const params = new URLSearchParams(location.search);
  if (params.get("connected") === "tray") toast("Tray conectada com sucesso.");
  if (params.get("connected") === "meli") toast("Conta do Mercado Livre vinculada com sucesso.");
  if (params.get("connected") === "shopee") toast("Conta da Shopee vinculada com sucesso.");
  if (params.get("tray") === "error") toast("Não foi possível concluir a autorização da Tray. Tente novamente.", true);
  if (params.get("shopee") === "error") toast("Não foi possível concluir a autorização da Shopee. Tente novamente.", true);
  if (params.has("connected") || params.has("tray") || params.has("shopee")) history.replaceState({}, "", location.pathname);
}

function connectionStatusClass(connection) {
  const classes = { connected: "green", expiring: "amber", reauthorization_required: "amber", error: "red", revoked: "red", disconnected: "blue" };
  return classes[connection?.connection_status] || "blue";
}

function connectionLifecycle(connection) {
  const details = [
    connection.external_account_id ? (connection.channel === "shopee" ? `Shopee / loja ${connection.external_account_id}` : `Conta ${connection.external_account_id}`) : null,
    `Token até ${date(connection.token_expires_at)}`,
    connection.refresh_expires_at ? `renovação até ${date(connection.refresh_expires_at)}` : null,
    connection.last_refresh_at ? `última renovação ${date(connection.last_refresh_at)}` : null,
  ].filter(Boolean);
  return details.map(escapeHtml).join(" · ");
}

function channelSummary(connections) {
  if (!connections.length) return "Nenhuma conta vinculada";
  const needsAttention = connections.some((connection) => ["error", "revoked", "reauthorization_required"].includes(connection.connection_status));
  return needsAttention ? "Uma ou mais contas precisam de atenção" : "Conexões em dia";
}

async function startTrayAuthorization(event) {
  event.preventDefault();
  const button = $("#connectTray");
  setFormError("#trayConnectError");
  button.disabled = true;
  try {
    const result = await api("/integrations/tray/connect",{method:"POST",body:JSON.stringify({storeHost:$("#trayHost").value.trim()})});
    location.assign(result.authorizationUrl);
  } catch (error) {
    setFormError("#trayConnectError", error.message);
    button.disabled = false;
  }
}

function connectionEditor(connection) {
  const id = escapeHtml(connection.id);
  const channel = escapeHtml(connection.channel);
  const status = connectionStatusClass(connection);
  const legacyRefresh = connection.channel === "meli" ? ' data-refresh="meli"' : "";
  const shopeeRefresh = connection.channel === "shopee" ? ` data-refresh="${channel}" data-connection-id="${id}"` : "";
  const shopeeDisconnect = connection.channel === "shopee" ? ` data-disconnect="${channel}" data-connection-id="${id}"` : "";
  return `<article class="connection-row"><div class="connection-main"><label>Nome da conta<input data-name-for="${id}" value="${escapeHtml(connection.display_name || "")}" maxlength="120" aria-label="Nome da conta ${escapeHtml(connection.display_name || connection.external_account_id || "vinculada")}" /></label><div class="tiny">${connectionLifecycle(connection)}</div>${connection.last_error ? `<div class="integration-error tiny">${escapeHtml(connection.last_error)}</div>` : ""}</div><div class="connection-actions"><span class="chip ${status}">${escapeHtml(connection.connection_status || "desconhecido")}</span><button data-save-connection="${id}" type="button">Salvar</button><button data-refresh-connection="${id}"${legacyRefresh}${shopeeRefresh} type="button">Renovar</button><button class="danger" data-disconnect-connection="${id}"${shopeeDisconnect} type="button">Remover</button></div></article>`;
}

function trayPanel(connections) {
  const rows = connections.length ? connections.map(connectionEditor).join("") : `<p class="muted">Nenhuma loja Tray vinculada.</p>`;
  return `<div class="stack"><form id="trayConnectForm" class="card section"><div class="section-title"><div><h3>Vincular loja Tray</h3><p class="muted">Informe a URL da loja para abrir a autorização segura da Tray.</p></div><span class="chip blue">OAuth</span></div><label class="tray-host-label">URL da loja<input id="trayHost" type="url" inputmode="url" autocomplete="url" placeholder="https://sualoja.commercesuite.com.br" required /></label><p id="trayConnectError" class="form-error hidden" role="alert" aria-live="assertive"></p><div class="toolbar"><button class="primary" id="connectTray" type="submit">Autorizar na Tray</button></div><p class="tiny">As credenciais do aplicativo ficam somente no ambiente seguro. Tokens não são exibidos nesta tela.</p></form><section class="card section"><div class="section-title"><h3>Lojas Tray vinculadas</h3><span class="chip">${connections.length}</span></div><div class="connection-list">${rows}</div></section></div>`;
}

function marketplacePanel(channel, connections) {
  const name = integrationNames[channel];
  const connectLabel = channel === "meli" ? "Adicionar conta Mercado Livre" : "Adicionar loja Shopee";
  const rows = connections.length ? connections.map(connectionEditor).join("") : `<div class="empty compact"><p>Nenhuma conta ${name} vinculada.</p><p class="muted">Vincule a primeira conta para consultar taxas e conciliar pedidos.</p></div>`;
  return `<section class="card section"><div class="section-title"><div><h3>${name}</h3><p class="muted">Gerencie as contas vinculadas a esta empresa.</p></div><span class="chip blue">OAuth</span></div><div class="toolbar"><button class="primary" data-connect-channel="${channel}" type="button">${connectLabel}</button><button data-link-channel="${channel}" type="button">Gerar link</button></div><div class="connection-list">${rows}</div><div id="oauthLinkOutput" class="oauth-link-output hidden" aria-live="polite"><label>Link de integração<input id="oauthLinkValue" readonly aria-label="Link de integração gerado" /></label><button id="copyOAuthLink" type="button">Copiar link</button><p class="tiny">Use uma vez em até 15 minutos. Não compartilhe em canais públicos.</p></div></section>`;
}

function bindConnectionActions(panel, root, channel) {
  const connectButton = panel.querySelector("[data-connect-channel]");
  if (connectButton) connectButton.onclick = () => connectUrl(`/integrations/${channel}/connect`);
  const linkButton = panel.querySelector("[data-link-channel]");
  if (linkButton) linkButton.onclick = async () => {
    try {
      const result = await api(`/integrations/${channel}/links`, { method: "POST", body: "{}" });
      const output = panel.querySelector("#oauthLinkOutput");
      const input = panel.querySelector("#oauthLinkValue");
      input.value = result.authorizationUrl;
      output.classList.remove("hidden");
      panel.querySelector("#copyOAuthLink").onclick = async () => {
        try {
          await navigator.clipboard.writeText(input.value);
          toast("Link copiado.");
        } catch {
          input.focus();
          input.select();
          toast("Copie o link selecionado.");
        }
      };
    } catch (error) { toast(error.message, true); }
  };
  panel.querySelectorAll("[data-save-connection]").forEach((button) => {
    button.onclick = async () => {
      const id = button.dataset.saveConnection;
      const input = panel.querySelector(`[data-name-for="${id}"]`);
      try {
        await api(`/integrations/${id}`, { method: "PATCH", body: JSON.stringify({ displayName: input.value.trim() }) });
        toast("Nome da conta salvo.");
        renderTrayIntegrations(root, channel);
      } catch (error) { toast(error.message, true); }
    };
  });
  panel.querySelectorAll("[data-refresh-connection]").forEach((button) => {
    button.onclick = async () => {
      try {
        await api(`/integrations/${button.dataset.refreshConnection}/refresh`, { method: "POST", body: JSON.stringify({ connectionId: button.dataset.connectionId }) });
        toast("Token renovado.");
        renderTrayIntegrations(root, channel);
      } catch (error) { toast(error.message, true); }
    };
  });
  panel.querySelectorAll("[data-disconnect-connection]").forEach((button) => {
    button.onclick = async () => {
      if (!confirm("Remover esta conta vinculada?")) return;
      try {
        await api(`/integrations/${button.dataset.disconnectConnection}/disconnect`, { method: "POST", body: JSON.stringify({ connectionId: button.dataset.connectionId }) });
        toast("Conta removida.");
        renderTrayIntegrations(root, channel);
      } catch (error) { toast(error.message, true); }
    };
  });
}

function renderIntegrationPanel(root, channel, byChannel) {
  const panel = root.querySelector("#integrationPanel");
  panel.innerHTML = channel === "tray" ? trayPanel(byChannel.tray || []) : marketplacePanel(channel, byChannel[channel] || []);
  if (channel === "tray") {
    $("#trayConnectForm").addEventListener("submit", startTrayAuthorization);
    bindConnectionActions(panel, root, channel);
    return;
  }
  bindConnectionActions(panel, root, channel);
}

async function renderTrayIntegrations(root, selectedChannel = null) {
  const data = await api("/integrations/");
  consumeIntegrationRedirect();
  const connections = data.connections || [];
  const byChannel = {
    tray: connections.filter(connection=>connection.channel==="tray"),
    meli: connections.filter(connection=>connection.channel==="meli"),
    shopee: connections.filter(connection=>connection.channel==="shopee"),
  };
  const channels=["tray","meli","shopee"];
  const selected = channels.includes(selectedChannel) ? selectedChannel : "tray";
  root.innerHTML = `<div class="pagehead"><div><h1>Integrações</h1><div class="sub">Canais conectados e saúde dos acessos</div></div></div><div class="integration-workspace"><section class="card section"><div class="section-title"><h3>Conexões</h3><span class="chip">OAuth</span></div><div id="integrationList" class="integration-channel-list"></div></section><div id="integrationPanel" class="integration-panel"></div></div>`;
  const list = root.querySelector("#integrationList");
  channels.forEach((channel) => {
    const channelConnections = byChannel[channel] || [];
    const count = channelConnections.length;
    const active = channel === selected;
    const row = document.createElement("article");
    row.className = "integration-channel-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = `integration-channel${active ? " selected" : ""}`;
    button.dataset.selectChannel = channel;
    button.setAttribute("aria-pressed", String(active));
    button.innerHTML = `<span class="logo" aria-hidden="true">${integrationNames[channel][0]}</span><span class="integration-channel-copy"><strong>${integrationNames[channel]}</strong><span class="muted">${count} conta${count===1?"":"s"} vinculada${count===1?"":"s"}</span><small>${escapeHtml(channelSummary(channelConnections))}</small></span><span class="chip ${connectionStatusClass(channelConnections[0])}">${count ? "Ver contas" : "Pendente"}</span>`;
    button.onclick = () => renderTrayIntegrations(root, channel);
    const linkButton = document.createElement("button");
    linkButton.type = "button";
    linkButton.className = "integration-link-button";
    linkButton.setAttribute("aria-label", `Vincular conta ${integrationNames[channel]}`);
    linkButton.textContent = "+";
    linkButton.onclick = () => {
      if (channel === "tray") {
        renderTrayIntegrations(root, "tray").then(() => root.querySelector("#trayHost")?.focus());
        return;
      }
      connectUrl(`/integrations/${channel}/connect`);
    };
    row.append(button, linkButton);
    list.append(row);
  });
  renderIntegrationPanel(root, selected, byChannel);
}

window.integrations = renderTrayIntegrations;
