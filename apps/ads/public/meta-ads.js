"use strict";

(() => {
  const connectButton = document.querySelector("[data-meta-connect]");
  const refreshButton = document.querySelector("[data-meta-refresh]");
  const alertHost = document.querySelector("[data-meta-alert]");
  const configBadge = document.querySelector("[data-meta-config-badge]");
  const connectionHost = document.querySelector("[data-meta-connections]");
  const businessHost = document.querySelector("[data-meta-businesses]");
  const businessCount = document.querySelector("[data-meta-business-count]");
  const accountHost = document.querySelector("[data-meta-accounts]");
  const dashboardTitle = document.querySelector("[data-meta-card-title]");
  const dashboardCopy = document.querySelector("[data-meta-card-copy]");

  if (!connectButton && !dashboardTitle) return;

  function el(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(date);
  }

  function showAlert(message, variant = "info") {
    if (!alertHost) return;
    alertHost.hidden = !message;
    alertHost.className = `ads-alert ads-alert--${variant}`;
    alertHost.textContent = message || "";
  }

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: "include",
      headers: { accept: "application/json", "content-type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
    return payload;
  }

  function renderConfiguration(configuration) {
    if (!configBadge) return;
    configBadge.textContent = configuration?.configured ? `Graph ${configuration.apiVersion || "v26.0"}` : "Configuração pendente";
    configBadge.classList.toggle("ads-badge--ok", Boolean(configuration?.configured));
    if (connectButton) connectButton.disabled = !configuration?.configured;
    if (!configuration?.configured) showAlert(`Configure no servidor: ${(configuration?.missing || []).join(", ")}.`, "warning");
  }

  function renderConnections(data) {
    if (!connectionHost) return;
    connectionHost.replaceChildren();
    const connections = data.connections || [];
    if (!connections.length) {
      const empty = el("div", "ads-empty-state ads-empty-state--compact");
      empty.append(el("span", "ads-empty-state__icon", "M"));
      const copy = el("div");
      copy.append(el("strong", "", "Nenhuma identidade Meta conectada."), el("p", "", "Autorize o DACH Ads em modo somente leitura para descobrir os ativos disponíveis."));
      empty.append(copy);
      connectionHost.append(empty);
      return;
    }
    for (const connection of connections) {
      const row = el("div", "ads-integration-row");
      const avatar = el("span", "ads-integration-row__avatar", "M");
      const copy = el("div", "ads-integration-row__copy");
      copy.append(
        el("strong", "", connection.name || connection.email || "Conta Meta"),
        el("small", "", `${connection.email || "Meta"} · ${connection.status === "active" ? "Conectada" : connection.status}`),
      );
      const meta = el("div", "ads-integration-row__meta");
      meta.append(
        el("span", "", `${connection.discoveredAccounts || 0} conta(s) · ${connection.discoveredBusinesses || 0} Business`),
        el("small", "", connection.lastDiscoveryAt ? `Atualizado ${formatDate(connection.lastDiscoveryAt)}` : "Aguardando descoberta"),
      );
      const actions = el("div", "ads-integration-row__actions");
      const discover = el("button", "ads-secondary-button", "Redescobrir");
      discover.type = "button";
      discover.addEventListener("click", async () => {
        discover.disabled = true;
        try {
          await request(`/ads/api/meta/connections/${encodeURIComponent(connection.id)}/discover`, { method: "POST", body: "{}" });
          showAlert("Ativos Meta atualizados.", "success");
          await loadStatus();
        } catch (error) { showAlert(error.message, "danger"); }
        finally { discover.disabled = false; }
      });
      const disconnect = el("button", "ads-danger-button", "Desconectar");
      disconnect.type = "button";
      disconnect.addEventListener("click", async () => {
        if (!window.confirm("Desconectar esta identidade Meta do DACH Ads? Os dados históricos já coletados serão preservados.")) return;
        disconnect.disabled = true;
        try {
          await request(`/ads/api/meta/connections/${encodeURIComponent(connection.id)}`, { method: "DELETE" });
          showAlert("Conexão Meta removida.", "success");
          await loadStatus();
        } catch (error) { showAlert(error.message, "danger"); }
        finally { disconnect.disabled = false; }
      });
      actions.append(discover, disconnect);
      row.append(avatar, copy, meta, actions);
      connectionHost.append(row);
    }
  }

  function renderBusinesses(data) {
    if (!businessHost) return;
    businessHost.replaceChildren();
    const businesses = data.businesses || [];
    if (businessCount) businessCount.textContent = String(businesses.length);
    if (!businesses.length) {
      businessHost.append(el("div", "ads-loading-row", "Nenhum Business Portfolio retornado. Contas de anúncio ainda podem ser descobertas diretamente."));
      return;
    }
    for (const business of businesses) {
      const row = el("div", "ads-integration-row");
      row.append(
        el("span", "ads-integration-row__avatar", "B"),
        (() => { const copy = el("div", "ads-integration-row__copy"); copy.append(el("strong", "", business.name || "Business Portfolio"), el("small", "", `ID ${business.businessId}`)); return copy; })(),
        (() => { const meta = el("div", "ads-integration-row__meta"); meta.append(el("span", "", business.verificationStatus || "Status não informado")); return meta; })(),
      );
      businessHost.append(row);
    }
  }

  function renderAccounts(data) {
    if (!accountHost) return;
    accountHost.replaceChildren();
    const accounts = data.accounts || [];
    if (!accounts.length) {
      const row = document.createElement("tr");
      const cell = el("td", "ads-table-empty", "Conecte uma identidade Meta para listar as contas de anúncio acessíveis.");
      cell.colSpan = 6;
      row.append(cell);
      accountHost.append(row);
      return;
    }

    for (const account of accounts) {
      const row = document.createElement("tr");
      const accountCell = document.createElement("td");
      accountCell.append(el("strong", "ads-table-title", account.name || `Conta ${account.accountId}`), el("small", "ads-table-subtitle", `act_${account.accountId} · ${account.status || "status desconhecido"}`));

      const businessCell = document.createElement("td");
      businessCell.append(el("strong", "ads-table-title", account.businessName || "—"), el("small", "ads-table-subtitle", account.businessId || "Sem Business associado"));

      const localeCell = document.createElement("td");
      localeCell.append(el("strong", "ads-table-title", account.currencyCode || "—"), el("small", "ads-table-subtitle", account.timezone || "Fuso não informado"));

      const syncCell = document.createElement("td");
      const label = el("label", "ads-toggle");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = Boolean(account.selected);
      const visual = el("span", "ads-toggle__visual");
      const text = el("span", "ads-toggle__label", account.selected ? "Selecionada" : "Ignorada");
      checkbox.addEventListener("change", async () => {
        checkbox.disabled = true;
        try {
          await request(`/ads/api/meta/accounts/${encodeURIComponent(account.id)}/selection`, {
            method: "PUT", body: JSON.stringify({ enabled: checkbox.checked }),
          });
          text.textContent = checkbox.checked ? "Selecionada" : "Ignorada";
          showAlert(checkbox.checked ? "Conta selecionada. A primeira coleta foi enfileirada." : "Conta removida da sincronização.", "success");
          await loadStatus();
        } catch (error) {
          checkbox.checked = !checkbox.checked;
          showAlert(error.message, "danger");
        } finally { checkbox.disabled = false; }
      });
      label.append(checkbox, visual, text);
      syncCell.append(label);

      const lastCell = document.createElement("td");
      lastCell.append(el("strong", "ads-table-title", formatDate(account.lastSyncedAt)), el("small", `ads-table-subtitle ${account.lastSyncStatus === "failed" ? "is-danger" : ""}`, account.lastSyncStatus || (account.selected ? "Na fila" : "Não selecionada")));

      const actionCell = document.createElement("td");
      if (account.selected) {
        const sync = el("button", "ads-icon-text-button", "Sincronizar");
        sync.type = "button";
        sync.addEventListener("click", async () => {
          sync.disabled = true;
          try {
            await request(`/ads/api/meta/accounts/${encodeURIComponent(account.id)}/sync`, { method: "POST", body: "{}" });
            showAlert("Sincronização Meta solicitada. O worker vai processar em segundo plano.", "success");
          } catch (error) { showAlert(error.message, "danger"); }
          finally { sync.disabled = false; }
        });
        actionCell.append(sync);
      }
      row.append(accountCell, businessCell, localeCell, syncCell, lastCell, actionCell);
      accountHost.append(row);
    }
  }

  function renderDashboard(data) {
    const activeConnections = (data.connections || []).filter((item) => item.status === "active").length;
    const selected = (data.accounts || []).filter((item) => item.selected).length;
    if (dashboardTitle) dashboardTitle.textContent = selected ? `${selected} conta${selected > 1 ? "s" : ""} em sincronização` : activeConnections ? "Meta conectada" : "Aguardando integração";
    if (dashboardCopy) dashboardCopy.textContent = selected ? "Campanhas, conjuntos, anúncios, criativos e Insights estão sendo sincronizados." : activeConnections ? "Selecione uma conta de anúncio para iniciar a coleta." : "Conecte a Meta para começar.";
  }

  async function loadStatus() {
    try {
      const data = await request("/ads/api/meta/status");
      renderConfiguration(data.configuration);
      renderConnections(data);
      renderBusinesses(data);
      renderAccounts(data);
      renderDashboard(data);
    } catch (error) {
      showAlert(error.message, "danger");
      if (dashboardTitle) dashboardTitle.textContent = "Status indisponível";
    }
  }

  connectButton?.addEventListener("click", () => {
    window.location.href = "/ads/api/meta/oauth/start?returnTo=%2Fads%2Fapp%2Fmeta";
  });
  refreshButton?.addEventListener("click", () => void loadStatus());

  const params = new URLSearchParams(window.location.search);
  const oauthState = params.get("meta");
  if (oauthState === "connected") showAlert(`Meta Ads conectada. ${params.get("accounts") || "0"} conta(s) encontrada(s).`, "success");
  if (oauthState === "error" || oauthState === "cancelled") showAlert(params.get("message") || "A conexão Meta não foi concluída.", oauthState === "error" ? "danger" : "warning");
  if (oauthState) {
    params.delete("meta"); params.delete("accounts"); params.delete("message");
    const clean = `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", clean);
  }

  void loadStatus();
})();
