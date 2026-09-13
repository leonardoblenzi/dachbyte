"use strict";

const STORAGE_KEYS = {
  token: "davantti_extension_token",
  user: "davantti_extension_user",
  accountId: "davantti_extension_account_id",
};
const DEFAULT_BASE_URL = "https://www.davanttisuite.com.br/ml";
const DAVANTTI_LANDING_URL = "https://www.davanttisuite.com.br/landing";
const DAVANTTI_CONTACT_URL = "https://www.davanttisuite.com.br/landing#contato";

const el = {
  loginView: document.getElementById("loginView"),
  appView: document.getElementById("appView"),
  email: document.getElementById("email"),
  password: document.getElementById("password"),
  btnLogin: document.getElementById("btnLogin"),
  btnLogout: document.getElementById("btnLogout"),
  btnClone: document.getElementById("btnClone"),
  btnRefreshAccounts: document.getElementById("btnRefreshAccounts"),
  feedback: document.getElementById("feedback"),
  userLabel: document.getElementById("userLabel"),
  accountSelect: document.getElementById("accountSelect"),
  accountMeta: document.getElementById("accountMeta"),
  openDrafts: document.getElementById("openDrafts"),
  openLanding: document.getElementById("openLanding"),
  openSupport: document.getElementById("openSupport"),
};

let state = {
  baseUrl: DEFAULT_BASE_URL,
  token: "",
  user: null,
  accounts: [],
  accountId: "",
};

function setFeedback(message, type = "") {
  el.feedback.textContent = message || "";
  el.feedback.className = `feedback ${type}`.trim();
}

function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = label || "Aguarde...";
    button.disabled = true;
    return;
  }
  button.textContent = button.dataset.originalText || button.textContent;
  button.disabled = false;
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function apiUrl(path) {
  return `${normalizeBaseUrl(state.baseUrl)}${path.startsWith("/") ? path : `/${path}`}`;
}

function extensionReloadError() {
  return new Error("A extensao foi recarregada. Feche e abra o popup novamente.");
}

function isExtensionContextError(error) {
  return /extension context invalidated|context invalidated|extension context/i.test(String(error?.message || error || ""));
}

function ensureExtensionContext() {
  try {
    if (!chrome?.runtime?.id || !chrome?.storage?.local) {
      throw extensionReloadError();
    }
  } catch (error) {
    if (isExtensionContextError(error)) throw extensionReloadError();
    throw error;
  }
}

function storageGet(keys) {
  ensureExtensionContext();
  return chrome.storage.local.get(keys);
}

function storageSet(values) {
  ensureExtensionContext();
  return chrome.storage.local.set(values);
}

function storageRemove(keys) {
  ensureExtensionContext();
  return chrome.storage.local.remove(keys);
}

async function proxyApiFetch(path, options = {}) {
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    ...(options.headers || {}),
  };
  if (state.token) headers.authorization = `Bearer ${state.token}`;

  let result = null;
  try {
    ensureExtensionContext();
    result = await chrome.runtime.sendMessage({
      type: "DVTI_PROXY_FETCH",
      url: apiUrl(path),
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch (error) {
    if (isExtensionContextError(error)) throw extensionReloadError();
    throw error;
  }

  if (!result) {
    throw new Error("Sem resposta do proxy da extensao.");
  }
  if (!result.ok || result?.payload?.ok === false) {
    throw new Error(result?.payload?.error || result?.error || `Erro HTTP ${result.status || 0}`);
  }
  return result.payload;
}

async function directApiFetch(path, options = {}) {
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    ...(options.headers || {}),
  };
  if (state.token) headers.authorization = `Bearer ${state.token}`;

  const response = await fetch(apiUrl(path), {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `Erro HTTP ${response.status}`);
  }
  return payload;
}

async function apiFetch(path, options = {}) {
  try {
    return await proxyApiFetch(path, options);
  } catch (proxyError) {
    if (isExtensionContextError(proxyError)) throw proxyError;
    try {
      return await directApiFetch(path, options);
    } catch (directError) {
      throw new Error(
        directError?.message || proxyError?.message || "Falha de rede ao comunicar com a Davantti.",
      );
    }
  }
}

function renderAuthState() {
  const logged = Boolean(state.token);
  el.loginView.classList.toggle("hidden", logged);
  el.appView.classList.toggle("hidden", !logged);
  el.openDrafts.href = `${normalizeBaseUrl(state.baseUrl)}/clonar-anuncio`;
  if (el.openLanding) el.openLanding.href = DAVANTTI_LANDING_URL;
  if (el.openSupport) el.openSupport.href = DAVANTTI_CONTACT_URL;

  if (state.user) {
    el.userLabel.textContent = state.user.nome || state.user.email || "Usuario Davantti";
  }
}

function selectedAccount() {
  const selectedId = String(el.accountSelect.value || state.accountId || "");
  return state.accounts.find((account) => String(account.id) === selectedId) || null;
}

function buildAccountText(account) {
  const statusLabel = account.status ? ` (${account.status})` : "";
  const tokenLabel = account.has_tokens ? "" : " - sem token";
  return `${account.label || `Conta ${account.id}`}${statusLabel}${tokenLabel}`;
}

function renderAccounts() {
  el.accountSelect.innerHTML = "";
  el.accountMeta.textContent = "";

  if (!state.accounts.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Nenhuma conta ML encontrada";
    el.accountSelect.appendChild(option);
    state.accountId = "";
    el.btnClone.disabled = true;
    el.accountMeta.textContent = "Vincule uma conta Mercado Livre na Davantti antes de clonar.";
    return;
  }

  for (const account of state.accounts) {
    const option = document.createElement("option");
    option.value = String(account.id);
    option.textContent = buildAccountText(account);
    option.disabled = !account.has_tokens;
    el.accountSelect.appendChild(option);
  }

  if (
    state.accountId &&
    state.accounts.some((account) => String(account.id) === String(state.accountId) && account.has_tokens)
  ) {
    el.accountSelect.value = String(state.accountId);
  } else {
    const firstAvailable = state.accounts.find((account) => account.has_tokens) || null;
    state.accountId = firstAvailable ? String(firstAvailable.id) : "";
    el.accountSelect.value = state.accountId;
  }

  const account = selectedAccount();
  el.btnClone.disabled = !account?.has_tokens;
  if (!account) {
    el.accountMeta.textContent = "Nenhuma conta ativa disponivel para clonagem.";
    return;
  }

  const parts = [
    account.empresa_nome ? `Empresa: ${account.empresa_nome}` : "",
    account.meli_user_id ? `ML user: ${account.meli_user_id}` : "",
    account.has_tokens ? "Conectada" : "Sem token Mercado Livre",
  ].filter(Boolean);
  el.accountMeta.textContent = parts.join(" | ");
}

async function loadSession() {
  const saved = await storageGet(Object.values(STORAGE_KEYS));
  state.baseUrl = DEFAULT_BASE_URL;
  state.token = saved[STORAGE_KEYS.token] || "";
  state.user = saved[STORAGE_KEYS.user] || null;
  state.accountId = saved[STORAGE_KEYS.accountId] || "";
  renderAuthState();

  if (state.token) {
    try {
      await refreshAccounts();
      setFeedback("Extensao pronta. Confira a conta ML antes de clonar.", "ok");
    } catch (error) {
      setFeedback(error.message || "Sessao expirada. Faca login novamente.", "error");
      await logout();
    }
  }
}

async function refreshAccounts() {
  setBusy(el.btnRefreshAccounts, true, "Atualizando...");
  try {
    const payload = await apiFetch("/api/extension/accounts");
    state.accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
    renderAccounts();
    await storageSet({ [STORAGE_KEYS.accountId]: state.accountId });
  } finally {
    setBusy(el.btnRefreshAccounts, false);
  }
}

async function login() {
  const email = String(el.email.value || "").trim();
  const senha = String(el.password.value || "");
  state.baseUrl = DEFAULT_BASE_URL;

  if (!email || !senha) {
    setFeedback("Informe e-mail e senha.", "error");
    return;
  }

  setBusy(el.btnLogin, true, "Entrando...");
  setFeedback("Validando login Davantti...");
  try {
    const payload = await apiFetch("/api/extension/auth/login", {
      method: "POST",
      body: {
        email,
        senha,
      },
    });

    state.token = payload.extension_token || "";
    state.user = payload.user || null;
    if (!state.token) throw new Error("Login aceito, mas o token da extensao nao voltou.");

    await storageSet({
      [STORAGE_KEYS.token]: state.token,
      [STORAGE_KEYS.user]: state.user,
    });
    el.password.value = "";
    renderAuthState();
    await refreshAccounts();
    setFeedback("Login realizado. Escolha a conta ML que vai receber o rascunho.", "ok");
  } catch (error) {
    setFeedback(error.message || "Falha ao entrar.", "error");
  } finally {
    setBusy(el.btnLogin, false);
  }
}

async function logout() {
  state.token = "";
  state.user = null;
  state.accounts = [];
  state.accountId = "";
  await storageRemove([STORAGE_KEYS.token, STORAGE_KEYS.user, STORAGE_KEYS.accountId]);
  renderAuthState();
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0] || null;
}

async function captureActiveTab(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      url: window.location.href,
      title: document.title || "",
      html: document.documentElement ? document.documentElement.outerHTML : "",
      captured_at: new Date().toISOString(),
    }),
  });
  return result?.result || null;
}

async function cloneCurrentAd() {
  const accountId = String(el.accountSelect.value || state.accountId || "");
  const account = selectedAccount();
  if (!accountId || !account?.has_tokens) {
    setFeedback("Selecione uma conta Mercado Livre conectada.", "error");
    return;
  }

  setBusy(el.btnClone, true, "Capturando...");
  setFeedback("Lendo aba atual...");
  try {
    const tab = await getActiveTab();
    if (!tab?.id || !/mercadolivre\.com\.br/i.test(String(tab.url || ""))) {
      throw new Error("Abra um anuncio do Mercado Livre antes de clonar.");
    }

    const capture = await captureActiveTab(tab.id);
    if (!capture?.html || !capture?.url) {
      throw new Error("Nao foi possivel capturar a pagina atual.");
    }

    setFeedback(`Enviando rascunho para ${account.label || "a conta selecionada"}...`);
    const payload = await apiFetch("/api/extension/clonar-anuncio/browser-capture", {
      method: "POST",
      body: {
        account_id: accountId,
        url: capture.url,
        title: capture.title,
        html: capture.html,
        captured_at: capture.captured_at,
      },
    });

    const draftId = payload?.draft?.id ? ` #${payload.draft.id}` : "";
    setFeedback(`Rascunho${draftId} criado com sucesso.`, "ok");
  } catch (error) {
    setFeedback(error.message || "Falha ao clonar anuncio.", "error");
  } finally {
    setBusy(el.btnClone, false);
    renderAccounts();
  }
}

el.btnLogin.addEventListener("click", login);
el.btnLogout.addEventListener("click", logout);
el.btnClone.addEventListener("click", cloneCurrentAd);
el.btnRefreshAccounts.addEventListener("click", async () => {
  try {
    await refreshAccounts();
    setFeedback("Contas atualizadas.", "ok");
  } catch (error) {
    setFeedback(error.message || "Falha ao atualizar contas.", "error");
  }
});
el.accountSelect.addEventListener("change", async () => {
  state.accountId = String(el.accountSelect.value || "");
  renderAccounts();
  await storageSet({ [STORAGE_KEYS.accountId]: state.accountId });
});

loadSession();
