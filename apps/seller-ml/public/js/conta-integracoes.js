"use strict";

(() => {
  const state = {
    integrations: [],
    filtered: [],
    sectors: [],
    editing: null,
  };
  const els = {};

  function $(id) {
    return document.getElementById(id);
  }

  function api(path, options = {}) {
    return fetch(path, {
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      ...options,
    }).then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }
      return payload;
    });
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function normalize(value) {
    return String(value || "").trim().toLowerCase();
  }

  function statusLabel(status) {
    const map = { active: "Conectado", disabled: "Desativado", error: "Com erro" };
    return map[normalize(status)] || "Disponivel";
  }

  function providerStatusLabel(status) {
    const map = { available: "Disponivel", planned: "Planejado" };
    return map[normalize(status)] || "Disponivel";
  }

  function statusClass(status) {
    const value = normalize(status);
    if (value === "active") return "au-pill--ok";
    if (value === "error") return "au-pill--danger";
    return "au-pill--muted";
  }

  function formatDate(value) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  }

  function sectorKey(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  function selectedAutoSendSectors() {
    return Array.from(els.autoSendSectors?.querySelectorAll("input[type='checkbox']:checked") || [])
      .map((input) => sectorKey(input.value))
      .filter(Boolean);
  }

  function renderAutoSendSectors(selected = []) {
    if (!els.autoSendSectors) return;
    const sectors = state.sectors.length
      ? state.sectors
      : [{ key: "marketing", label: "Marketing" }, { key: "cadastro", label: "Cadastro" }];
    const selectedSet = new Set((Array.isArray(selected) ? selected : []).map(sectorKey));
    els.autoSendSectors.innerHTML = sectors.map((sector) => {
      const key = sectorKey(sector.key || sector.setor);
      const label = sector.label || key;
      return `
        <label class="au-check au-check--pill">
          <input type="checkbox" value="${escapeHtml(key)}" ${selectedSet.has(key) ? "checked" : ""} />
          <span>${escapeHtml(label)}</span>
        </label>
      `;
    }).join("");
  }

  function toast(message, type = "ok") {
    const node = document.createElement("div");
    node.className = `au-toast au-toast--${type}`;
    node.textContent = message;
    document.body.appendChild(node);
    window.setTimeout(() => node.remove(), 3800);
  }

  function searchBlob(item) {
    return [
      item.provider,
      item.label,
      item.category,
      item.description,
      item.status,
      item.provider_status,
    ].map(normalize).join(" ");
  }

  function applyFilter() {
    const term = normalize(els.search.value);
    state.filtered = term
      ? state.integrations.filter((item) => searchBlob(item).includes(term))
      : [...state.integrations];
    render();
  }

  function renderStats() {
    els.statTotal.textContent = String(state.integrations.length);
    els.statActive.textContent = String(state.integrations.filter((item) => item.status === "active").length);
    els.statError.textContent = String(state.integrations.filter((item) => item.status === "error").length);
    els.statPlanned.textContent = String(state.integrations.filter((item) => item.provider_status === "planned").length);
  }

  function renderCards() {
    const total = state.integrations.length;
    const showing = state.filtered.length;
    els.counter.textContent = `Exibindo ${showing} de ${total} conector(es).`;
    if (!showing) {
      els.grid.innerHTML = `<div class="au-empty">Nenhuma integracao encontrada.</div>`;
      return;
    }
    els.grid.innerHTML = state.filtered.map((item) => {
      const planned = item.provider_status === "planned";
      const connected = item.status === "active";
      return `
        <article class="au-integration-card">
          <div class="au-integration-card__head">
            <div>
              <span class="account-users-kicker">${escapeHtml(item.category || "Integracao")}</span>
              <h3>${escapeHtml(item.label)}</h3>
            </div>
            <span class="au-pill ${planned ? "au-pill--muted" : statusClass(item.status)}">
              ${escapeHtml(planned ? providerStatusLabel(item.provider_status) : statusLabel(item.status))}
            </span>
          </div>
          <p>${escapeHtml(item.description || "")}</p>
          <div class="au-integration-meta">
            <span><b>Escopo:</b> Empresa inteira</span>
            <span><b>Ultimo teste:</b> ${escapeHtml(formatDate(item.last_test_at))}</span>
            <span><b>Ultima sync:</b> ${escapeHtml(formatDate(item.last_sync_at))}</span>
          </div>
          ${item.api_base_url ? `<code class="au-integration-url">${escapeHtml(item.api_base_url)}</code>` : ""}
          ${item.last_error ? `<div class="au-inline-error">${escapeHtml(item.last_error)}</div>` : ""}
          <div class="au-row-actions">
            <button class="au-btn ${connected ? "au-btn-secondary" : "au-btn-primary"}" type="button" data-configure="${escapeHtml(item.provider)}" ${planned ? "disabled" : ""}>
              ${item.configured ? "Configurar" : "Conectar"}
            </button>
          </div>
        </article>
      `;
    }).join("");
  }

  function render() {
    renderStats();
    renderCards();
  }

  function webhookUrlFor(item) {
    const path = item.webhook_path || `/api/integrations/${item.provider}/webhook`;
    const resolved = window.ML?.url ? window.ML.url(path) : path;
    return new URL(resolved, window.location.origin).href;
  }

  function setSectionVisibility(node, visible) {
    if (!node) return;
    node.hidden = !visible;
  }

  function providerUiProfile(item = {}) {
    const provider = normalize(item.provider);
    if (provider === "trello") {
      return {
        subtitle: "Configuracao da empresa para importar boards/listas do Trello na criacao de tarefas dos Estrategicos.",
        urlTitle: "URL da API do Trello",
        urlHelp: "Use a URL base do Trello. Padrao: https://api.trello.com/1",
        tokenTitle: "Token do Trello",
        tokenPlaceholder: "Token do Trello",
        tokenHelpEmpty: "Cole o token da API do Trello.",
        tokenHelpMaskPrefix: "Token atual",
        apiKeyVisible: true,
        apiKeyHelp: "Cole a API Key da conta Trello.",
        apiKeyPlaceholder: "API key do Trello",
        apiKeyMaskPrefix: "API key atual",
        automationVisible: false,
        webhookVisible: false,
        markflowGuideVisible: false,
        trelloGuideVisible: true,
      };
    }
    return {
      subtitle: "Esta integracao vale para toda a empresa e para todas as contas ML vinculadas.",
      urlTitle: "API externa",
      urlHelp: "Use a URL base do sistema externo. Ex.: https://markflow.vercel.app",
      tokenTitle: "Token de integracao",
      tokenPlaceholder: "Token da API externa",
      tokenHelpEmpty: "Cole o token de integracao fornecido pelo sistema externo.",
      tokenHelpMaskPrefix: "Token atual",
      apiKeyVisible: false,
      apiKeyHelp: "",
      apiKeyPlaceholder: "API key",
      apiKeyMaskPrefix: "API key atual",
      automationVisible: (item.fields?.auto_send !== false),
      webhookVisible: (item.fields?.webhook !== false),
      markflowGuideVisible: normalize(item.provider) === "markflow",
      trelloGuideVisible: false,
    };
  }

  function applyProviderUi(item = {}) {
    const profile = providerUiProfile(item);
    setSectionVisibility(els.sectionApiUrl, item.fields?.api_base_url !== false);
    setSectionVisibility(els.sectionApiKey, profile.apiKeyVisible);
    setSectionVisibility(els.sectionToken, item.fields?.access_token !== false);
    setSectionVisibility(els.sectionAutomation, profile.automationVisible);
    setSectionVisibility(els.sectionWebhook, profile.webhookVisible);
    setSectionVisibility(els.sectionGuideMarkflow, profile.markflowGuideVisible);
    setSectionVisibility(els.sectionGuideTrello, profile.trelloGuideVisible);

    if (els.dialogSubtitle) els.dialogSubtitle.textContent = profile.subtitle;
    if (els.urlTitle) els.urlTitle.textContent = profile.urlTitle;
    if (els.urlHelp) els.urlHelp.textContent = profile.urlHelp;
    if (els.tokenTitle) els.tokenTitle.textContent = profile.tokenTitle;
    if (els.token) els.token.placeholder = profile.tokenPlaceholder;
    if (els.apiKeyHelp) els.apiKeyHelp.textContent = profile.apiKeyHelp;
    if (els.apiKey) els.apiKey.placeholder = profile.apiKeyPlaceholder;
  }

  function openEditor(provider) {
    const item = state.integrations.find((entry) => entry.provider === provider);
    if (!item || item.provider_status === "planned") return;
    state.editing = item;
    els.dialogTitle.textContent = `Configurar ${item.label}`;
    els.status.value = item.status === "active" ? "active" : "disabled";
    els.url.value = item.api_base_url || "";
    els.apiKey.value = "";
    els.token.value = "";
    const profile = providerUiProfile(item);
    els.tokenHelp.textContent = item.has_access_token
      ? `${profile.tokenHelpMaskPrefix}: ${item.access_token_mask}. Cole um novo valor somente para substituir.`
      : profile.tokenHelpEmpty;
    if (els.apiKeyHelp) {
      els.apiKeyHelp.textContent = item.has_api_key
        ? `${profile.apiKeyMaskPrefix}: ${item.api_key_mask}. Cole um novo valor somente para substituir.`
        : profile.apiKeyHelp;
    }
    els.autoSend.checked = item.config?.auto_send_tasks === true || item.config?.auto_send_marketing_tasks === true;
    renderAutoSendSectors(item.config?.auto_send_task_sectors || (item.config?.auto_send_marketing_tasks ? ["marketing"] : []));
    els.manualSync.checked = item.config?.manual_sync_enabled !== false;
    els.webhookUrl.textContent = webhookUrlFor(item);
    if (els.guideWebhookUrl) els.guideWebhookUrl.textContent = webhookUrlFor(item);
    els.webhookSecretHelp.textContent = item.webhook_secret_mask
      ? `Secret atual: ${item.webhook_secret_mask}. Ao gerar um novo, atualize o valor no sistema externo.`
      : "Salve a integracao para gerar o secret do webhook.";
    applyProviderUi(item);
    els.dialog.showModal();
  }

  function collectPayload() {
    return {
      status: els.status.value || "disabled",
      api_base_url: els.url.value,
      api_key: els.apiKey.value,
      access_token: els.token.value,
      config: {
        auto_send_tasks: els.autoSend.checked,
        auto_send_task_sectors: selectedAutoSendSectors(),
        manual_sync_enabled: els.manualSync.checked,
      },
    };
  }

  async function saveIntegration() {
    if (!state.editing?.provider) return;
    els.save.disabled = true;
    els.save.textContent = "Salvando...";
    try {
      const payload = await api(`/api/account/integrations/${encodeURIComponent(state.editing.provider)}`, {
        method: "PUT",
        body: JSON.stringify(collectPayload()),
      });
      const updated = payload.integration;
      state.integrations = state.integrations.map((item) => item.provider === updated.provider ? updated : item);
      applyFilter();
      state.editing = updated;
      openEditor(updated.provider);
      toast("Integracao salva.");
    } catch (error) {
      toast(error.message || "Falha ao salvar integracao.", "error");
    } finally {
      els.save.disabled = false;
      els.save.textContent = "Salvar integracao";
    }
  }

  async function testIntegration() {
    if (!state.editing?.provider) return;
    els.test.disabled = true;
    els.test.textContent = "Testando...";
    try {
      const payload = collectPayload();
      await api(`/api/account/integrations/${encodeURIComponent(state.editing.provider)}/test`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      await loadIntegrations();
      toast("Conexao validada.");
    } catch (error) {
      await loadIntegrations().catch(() => null);
      toast(error.message || "Falha ao testar conexao.", "error");
    } finally {
      els.test.disabled = false;
      els.test.textContent = "Testar conexao";
    }
  }

  async function rotateSecret() {
    if (!state.editing?.provider) return;
    if (!state.editing.configured) {
      toast("Salve a integracao antes de gerar o secret.", "error");
      return;
    }
    if (!confirm("Gerar novo webhook secret? O sistema externo precisara ser atualizado com o novo valor.")) return;
    els.rotate.disabled = true;
    els.rotate.textContent = "Gerando...";
    try {
      const payload = await api(`/api/account/integrations/${encodeURIComponent(state.editing.provider)}/rotate-secret`, { method: "POST" });
      const updated = payload.integration;
      state.integrations = state.integrations.map((item) => item.provider === updated.provider ? updated : item);
      state.editing = updated;
      els.webhookSecretHelp.textContent = `Novo secret: ${payload.webhook_secret}. Salve este valor no sistema externo agora.`;
      applyFilter();
      toast("Webhook secret gerado.");
    } catch (error) {
      toast(error.message || "Falha ao gerar secret.", "error");
    } finally {
      els.rotate.disabled = false;
      els.rotate.textContent = "Gerar novo secret";
    }
  }

  async function loadIntegrations() {
    els.grid.innerHTML = `<div class="au-empty">Carregando integracoes...</div>`;
    const payload = await api("/api/account/integrations");
    state.integrations = Array.isArray(payload.integrations) ? payload.integrations : [];
    state.sectors = Array.isArray(payload.sectors) ? payload.sectors : [];
    applyFilter();
  }

  function bindEvents() {
    els.refresh.addEventListener("click", async () => {
      els.refresh.disabled = true;
      els.refresh.textContent = "Atualizando...";
      try {
        await loadIntegrations();
      } catch (error) {
        toast(error.message || "Falha ao carregar integracoes.", "error");
      } finally {
        els.refresh.disabled = false;
        els.refresh.textContent = "Atualizar";
      }
    });
    els.search.addEventListener("input", applyFilter);
    els.grid.addEventListener("click", (event) => {
      const button = event.target.closest("[data-configure]");
      if (button) openEditor(button.dataset.configure);
    });
    els.save.addEventListener("click", saveIntegration);
    els.test.addEventListener("click", testIntegration);
    els.rotate.addEventListener("click", rotateSecret);
  }

  async function init() {
    Object.assign(els, {
      refresh: $("btn-refresh-integrations"),
      search: $("integration-search"),
      grid: $("integrations-grid"),
      counter: $("integrations-counter"),
      statTotal: $("stat-total"),
      statActive: $("stat-active"),
      statError: $("stat-error"),
      statPlanned: $("stat-planned"),
      dialog: $("integration-dialog"),
      dialogTitle: $("dialog-title"),
      dialogSubtitle: $("dialog-subtitle"),
      status: $("integration-status"),
      url: $("integration-url"),
      token: $("integration-token"),
      tokenHelp: $("token-help"),
      autoSend: $("auto-send"),
      autoSendSectors: $("auto-send-sector-list"),
      manualSync: $("manual-sync"),
      webhookUrl: $("webhook-url"),
      guideWebhookUrl: $("guide-webhook-url"),
      webhookSecretHelp: $("webhook-secret-help"),
      sectionApiUrl: $("section-api-url"),
      urlTitle: $("integration-url-title"),
      urlHelp: $("integration-url-help"),
      sectionApiKey: $("section-api-key"),
      apiKey: $("integration-api-key"),
      apiKeyHelp: $("api-key-help"),
      sectionToken: $("section-token"),
      tokenTitle: $("token-title"),
      sectionAutomation: $("section-automation"),
      sectionWebhook: $("section-webhook"),
      sectionGuideMarkflow: $("guide-markflow"),
      sectionGuideTrello: $("guide-trello"),
      rotate: $("btn-rotate-secret"),
      test: $("btn-test-integration"),
      save: $("btn-save-integration"),
    });
    bindEvents();
    try {
      await loadIntegrations();
    } catch (error) {
      els.grid.innerHTML = `<div class="au-empty">${escapeHtml(error.message || "Falha ao carregar integracoes.")}</div>`;
      toast(error.message || "Falha ao carregar integracoes.", "error");
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
