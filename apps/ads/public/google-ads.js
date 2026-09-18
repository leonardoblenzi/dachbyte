"use strict";

(() => {
  const connectButton = document.querySelector("[data-google-connect]");
  const refreshButton = document.querySelector("[data-google-refresh]");
  const connectionHost = document.querySelector("[data-google-connections]");
  const accountHost = document.querySelector("[data-google-accounts]");
  const alertBox = document.querySelector("[data-google-alert]");
  const configBadge = document.querySelector("[data-google-config-badge]");
  const summaryState = document.querySelector("[data-google-summary-state]");
  const summaryCopy = document.querySelector("[data-google-summary-copy]");
  const dashboardCardTitle = document.querySelector("[data-google-card-title]");
  const dashboardCardCopy = document.querySelector("[data-google-card-copy]");

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function formatCustomerId(value) {
    const digits = String(value || "").replace(/\D/g, "");
    if (digits.length === 10) return `${digits.slice(0,3)}-${digits.slice(3,6)}-${digits.slice(6)}`;
    return digits || "—";
  }

  function formatDate(value) {
    if (!value) return "Nunca";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(date);
  }

  function showAlert(message, tone = "info") {
    if (!alertBox) return;
    alertBox.hidden = !message;
    alertBox.className = `ads-alert ads-alert--${tone}`;
    alertBox.textContent = message || "";
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

  function renderConnections(data) {
    if (!connectionHost) return;
    connectionHost.replaceChildren();
    const connections = data.connections || [];
    if (!connections.length) {
      const empty = el("div", "ads-empty-state ads-empty-state--compact");
      empty.append(el("span", "ads-empty-state__icon", "G"));
      const copy = el("div");
      copy.append(el("strong", "", "Nenhuma conta Google conectada."), el("p", "", "Use o botão Conectar Google Ads para autorizar o DACH em modo somente leitura."));
      empty.append(copy);
      connectionHost.append(empty);
      return;
    }

    connections.forEach((connection) => {
      const row = el("div", "ads-integration-row");
      const avatar = el("span", "ads-integration-row__avatar", "G");
      const copy = el("div", "ads-integration-row__copy");
      copy.append(
        el("strong", "", connection.name || connection.email || "Conta Google"),
        el("small", "", `${connection.email || "Google Ads"} · ${connection.status === "active" ? "Conectada" : connection.status}`),
      );
      const meta = el("div", "ads-integration-row__meta");
      meta.append(el("span", "", `${connection.discoveredAccounts || 0} contas encontradas`), el("small", "", connection.lastDiscoveryAt ? `Atualizado ${formatDate(connection.lastDiscoveryAt)}` : "Aguardando descoberta"));
      const actions = el("div", "ads-integration-row__actions");
      const discover = el("button", "ads-secondary-button", "Redescobrir");
      discover.type = "button";
      discover.addEventListener("click", async () => {
        discover.disabled = true;
        try {
          await request(`/ads/api/google/connections/${encodeURIComponent(connection.id)}/discover`, { method: "POST", body: "{}" });
          showAlert("Contas Google atualizadas.", "success");
          await loadStatus();
        } catch (error) { showAlert(error.message, "danger"); }
        finally { discover.disabled = false; }
      });
      const disconnect = el("button", "ads-danger-button", "Desconectar");
      disconnect.type = "button";
      disconnect.addEventListener("click", async () => {
        if (!window.confirm("Desconectar esta identidade Google do DACH Ads? As métricas já sincronizadas permanecem no histórico.")) return;
        disconnect.disabled = true;
        try {
          await request(`/ads/api/google/connections/${encodeURIComponent(connection.id)}`, { method: "DELETE" });
          showAlert("Conexão Google removida.", "success");
          await loadStatus();
        } catch (error) { showAlert(error.message, "danger"); }
        finally { disconnect.disabled = false; }
      });
      actions.append(discover, disconnect);
      row.append(avatar, copy, meta, actions);
      connectionHost.append(row);
    });
  }

  function renderAccounts(data) {
    if (!accountHost) return;
    accountHost.replaceChildren();
    const accounts = data.accounts || [];
    if (!accounts.length) {
      const row = document.createElement("tr");
      const cell = el("td", "ads-table-empty", "Conecte uma conta Google para listar as contas acessíveis.");
      cell.colSpan = 6;
      row.append(cell);
      accountHost.append(row);
      return;
    }

    accounts.forEach((account) => {
      const row = document.createElement("tr");
      const accountCell = document.createElement("td");
      const title = el("strong", "ads-table-title", account.name || `Conta ${formatCustomerId(account.customerId)}`);
      const id = el("small", "ads-table-subtitle", formatCustomerId(account.customerId));
      accountCell.append(title, id);

      const typeCell = document.createElement("td");
      const typeBadge = el("span", `ads-mini-badge ${account.manager ? "ads-mini-badge--manager" : ""}`, account.manager ? "MCC" : "Anunciante");
      typeCell.append(typeBadge);

      const localeCell = document.createElement("td");
      localeCell.append(el("strong", "ads-table-title", account.currencyCode || "—"), el("small", "ads-table-subtitle", account.timezone || "Fuso não informado"));

      const syncCell = document.createElement("td");
      if (account.manager) {
        syncCell.append(el("span", "ads-muted-copy", "Somente descoberta"));
      } else {
        const label = el("label", "ads-toggle");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = Boolean(account.selected);
        const visual = el("span", "ads-toggle__visual");
        const text = el("span", "ads-toggle__label", account.selected ? "Selecionada" : "Ignorada");
        checkbox.addEventListener("change", async () => {
          checkbox.disabled = true;
          try {
            await request(`/ads/api/google/accounts/${encodeURIComponent(account.id)}/selection`, {
              method: "PUT",
              body: JSON.stringify({ enabled: checkbox.checked }),
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
      }

      const lastCell = document.createElement("td");
      lastCell.append(el("strong", "ads-table-title", formatDate(account.lastSyncedAt)));
      const syncStatus = account.lastSyncStatus || (account.selected ? "Na fila" : "Não selecionada");
      lastCell.append(el("small", `ads-table-subtitle ${account.lastSyncStatus === "failed" ? "is-danger" : ""}`, syncStatus));

      const actionCell = document.createElement("td");
      if (!account.manager && account.selected) {
        const sync = el("button", "ads-icon-text-button", "Sincronizar");
        sync.type = "button";
        sync.addEventListener("click", async () => {
          sync.disabled = true;
          try {
            await request(`/ads/api/google/accounts/${encodeURIComponent(account.id)}/sync`, { method: "POST", body: "{}" });
            showAlert("Sincronização solicitada. O worker vai processar a conta em segundo plano.", "success");
          } catch (error) { showAlert(error.message, "danger"); }
          finally { sync.disabled = false; }
        });
        actionCell.append(sync);
      }

      row.append(accountCell, typeCell, localeCell, syncCell, lastCell, actionCell);
      accountHost.append(row);
    });
  }

  function renderSummary(data) {
    const activeConnections = (data.connections || []).filter((item) => item.status === "active").length;
    const selectedAccounts = (data.accounts || []).filter((item) => item.selected && !item.manager).length;
    if (summaryState) summaryState.textContent = selectedAccounts ? `${selectedAccounts} conta${selectedAccounts > 1 ? "s" : ""}` : activeConnections ? "Conectado" : "Não conectado";
    if (summaryCopy) summaryCopy.textContent = selectedAccounts ? "Coleta read-only habilitada pelo worker." : activeConnections ? "Selecione uma conta anunciante para iniciar a coleta." : "Conecte o Google Ads para começar.";
    if (dashboardCardTitle) dashboardCardTitle.textContent = selectedAccounts ? `${selectedAccounts} conta${selectedAccounts > 1 ? "s" : ""} em sincronização` : activeConnections ? "Google conectado" : "Aguardando integração";
    if (dashboardCardCopy) dashboardCardCopy.textContent = selectedAccounts ? "Campanhas, palavras, termos de pesquisa, conversões e métricas estão sendo sincronizados." : "OAuth e seleção de contas ficam disponíveis na tela Google Ads.";
  }

  function renderConfiguration(configuration) {
    if (!configBadge) return;
    configBadge.textContent = configuration?.configured ? `API ${configuration.apiVersion || "v25"}` : "Configuração pendente";
    configBadge.classList.toggle("ads-badge--ok", Boolean(configuration?.configured));
    if (connectButton) connectButton.disabled = !configuration?.configured;
    if (!configuration?.configured && connectionHost) {
      showAlert(`Configure no servidor: ${(configuration.missing || []).join(", ")}.`, "warning");
    }
  }

  async function loadStatus() {
    try {
      const data = await request("/ads/api/google/status");
      renderConfiguration(data.configuration);
      renderConnections(data);
      renderAccounts(data);
      renderSummary(data);
    } catch (error) {
      showAlert(error.message, "danger");
      if (dashboardCardTitle) dashboardCardTitle.textContent = "Status indisponível";
    }
  }

  connectButton?.addEventListener("click", () => {
    window.location.href = "/ads/api/google/oauth/start?returnTo=%2Fads%2Fapp%2Fgoogle";
  });
  refreshButton?.addEventListener("click", () => void loadStatus());

  const params = new URLSearchParams(window.location.search);
  const oauthState = params.get("google");
  if (oauthState === "connected") showAlert(`Google Ads conectado. ${params.get("accounts") || "0"} conta(s) encontrada(s).`, "success");
  if (oauthState === "error" || oauthState === "cancelled") showAlert(params.get("message") || "A conexão Google não foi concluída.", oauthState === "error" ? "danger" : "warning");
  if (oauthState) {
    params.delete("google"); params.delete("accounts"); params.delete("message");
    const clean = `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", clean);
  }

  void loadStatus();
})();
