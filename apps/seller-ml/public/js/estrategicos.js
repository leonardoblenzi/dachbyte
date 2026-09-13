"use strict";

(() => {
  console.info("estrategicos.js ativo | v=41");

  const state = {
    preview: [],
    rounds: [],
    taskSectors: [],
    tasks: [],
    taskBatches: [],
    roundBatches: [],
    watchlist: [],
    taskUserSectors: [],
    strategyActions: [],
    actionPermissions: {},
    integrations: { active: false, integrations: [] },
    taskIsAdmin: false,
    taskCanAct: false,
    taskUserId: null,
    currentCompleteTaskId: "",
    selectedTaskBatchId: "",
    metricView: "auto",
    page: 1,
    limit: 25,
    total: 0,
    pages: 1,
    taskPage: 1,
    taskLimit: 25,
    taskTotal: 0,
    taskPages: 1,
    watchlistPage: 1,
    watchlistLimit: 25,
    watchlistTotal: 0,
    watchlistPages: 1,
    watchlistDetailId: "",
    watchlistDetailMode: "first_action",
    watchlistDetailFrom: "",
    watchlistDetailTo: "",
    watchlistGroupMode: "family",
    strategyGroupExpanded: {},
    watchlistSelectedIds: new Set(),
    watchlistVisibleGroups: new Map(),
    trelloBoards: [],
    trelloLists: [],
    trelloCards: [],
    trelloImportTarget: "create",
    trelloBatchExistingTokens: new Set(),
    taskTags: [],
    taskTagColors: {},
    batchDraftTags: [],
    batchDraftTagColors: {},
    availableTaskTags: [],
  };
  let activeTooltip = null;
  let activeTooltipTarget = null;
  const $ = (id) => document.getElementById(id);
  const on = (id, eventName, handler) => {
    const element = $(id);
    if (!element) {
      console.warn(`[estrategicos] Elemento nao encontrado: #${id}`);
      return null;
    }
    element.addEventListener(eventName, handler);
    return element;
  };
  const setValue = (id, value) => {
    const element = $(id);
    if (element) element.value = value;
  };
  const setText = (id, value) => {
    const element = $(id);
    if (element) element.textContent = value;
  };
  const eventElement = (event) => {
    const target = event?.target;
    if (!target) return null;
    if (target instanceof Element) return target;
    return target.parentElement || null;
  };
  const closestFromEvent = (event, selector) => {
    const element = eventElement(event);
    return element ? element.closest(selector) : null;
  };
  const fmtInt = (value) => Number(value || 0).toLocaleString("pt-BR");
  const fmtMoney = (value) => Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const fmtPct = (value) => value == null || value === "" ? "--" : `${Number(value || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
  const uniq = (values = []) => Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
  const parseTaskTokens = (value = "") => uniq(String(value || "").split(/[\s,;]+/));
  const normalizeTaskToken = (value = "") => String(value || "").trim().toUpperCase();
  const tagColorPresets = {
    blue: "#3b82f6",
    green: "#22c55e",
    amber: "#f59e0b",
    violet: "#8b5cf6",
    rose: "#f43f5e",
    slate: "#64748b",
  };
  const normalizeTagName = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 40);
  const normalizeTagColor = (value) => {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return "";
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw)) {
      return raw.length === 4
        ? `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`.toLowerCase()
        : raw.toLowerCase();
    }
    return tagColorPresets[raw] || "";
  };
  const defaultTagColor = "#3b82f6";
  const todayYmd = () => new Date().toISOString().slice(0, 10);
  const monthStartYmd = () => `${todayYmd().slice(0, 8)}01`;
  const labelMap = {
    active: "Em observacao", ready: "Revisar", completed: "Concluido", interrupted: "Interrompido", failed: "Erro",
    improved: "Melhorou", worse: "Caiu", stable: "Estavel", inconclusive: "Inconclusivo", pending: "Pendente", interrupted: "Interrompido", failed: "Erro",
  };
  const metricLabels = { impressions: "Impressoes", clicks: "Cliques", ctr: "CTR", visits: "Visitas", sales: "Vendas", conversion: "Conversao", revenue: "Receita" };
  const flagLabels = { photo: "foto", title: "titulo", price: "preco", description: "descricao", attributes: "ficha", model: "modelo", clips: "clips", lead_time: "prazo", shipping: "frete", stock: "estoque", promotion: "promocao", ads: "ads", other: "outro" };
  const materialLabels = { photos: "Fotos novas", clips_video: "Clips/videos novos" };
  const notApplicableText = "N\u00e3o se aplica";
  const listingChangeLabels = { photos: "Fotos publicadas", clips_video: "Clips/videos publicados", title: "Titulo", description: "Descricao", attributes: "Ficha tecnica", model: "Modelo", lead_time: "Prazo de producao", price: "Preco", stock: "Estoque", promotion: "Promocao", ads: "Ads", shipping: "Frete", other: "Outro ajuste" };
  const materialProgressKeys = [
    { key: "photos", flag: "photo", label: "Foto", icon: "▧" },
    { key: "clips_video", flag: "clips", label: "Clips", icon: "▶" },
  ];
  const listingProgressKeys = [
    { key: "photos", flag: "photo", label: "Foto", icon: "▧" },
    { key: "clips_video", flag: "clips", label: "Clips", icon: "▶" },
    { key: "title", flag: "title", label: "Titulo", icon: "A" },
    { key: "description", flag: "description", label: "Descricao", icon: "▤" },
    { key: "attributes", flag: "attributes", label: "Ficha", icon: "≡" },
    { key: "model", flag: "model", label: "Modelo", icon: "M" },
    { key: "lead_time", flag: "lead_time", label: "Prazo", icon: "◷" },
    { key: "price", flag: "price", label: "Preco", icon: "$" },
    { key: "stock", flag: "stock", label: "Estoque", icon: "E" },
    { key: "promotion", flag: "promotion", label: "Promo", icon: "◇" },
    { key: "ads", flag: "ads", label: "Ads", icon: "↗" },
    { key: "shipping", flag: "shipping", label: "Frete", icon: "▣" },
    { key: "other", flag: "other", label: "Outro", icon: "..." },
  ];
  const taskFlagOptions = [
    { key: "photo", label: "Foto", icon: "▧" },
    { key: "clips", label: "Clips", icon: "▶" },
    { key: "title", label: "Titulo", icon: "A" },
    { key: "description", label: "Descricao", icon: "▤" },
    { key: "attributes", label: "Ficha tecnica", icon: "≡" },
    { key: "model", label: "Modelo", icon: "M" },
    { key: "lead_time", label: "Prazo", icon: "◷" },
    { key: "price", label: "Preco", icon: "$" },
    { key: "stock", label: "Estoque", icon: "E" },
    { key: "promotion", label: "Promocao", icon: "◇" },
    { key: "ads", label: "Ads", icon: "↗" },
    { key: "shipping", label: "Frete", icon: "▣" },
    { key: "other", label: "Outro", icon: "..." },
  ];
  const materialIconMap = Object.fromEntries(materialProgressKeys.map((item) => [item.key, item.icon]));
  const listingIconMap = Object.fromEntries(listingProgressKeys.map((item) => [item.key, item.icon]));
  const materialActionMap = { photos: "material.photos", clips_video: "material.clips_video" };
  const listingActionMap = {
    photos: "listing.photos",
    clips_video: "listing.clips_video",
    title: "listing.title",
    description: "listing.description",
    attributes: "listing.attributes",
    model: "listing.model",
    stock: "listing.stock",
    other: "listing.other",
    lead_time: "listing.lead_time",
    shipping: "listing.shipping",
    price: "listing.price",
    promotion: "listing.promotion",
    ads: "listing.ads",
  };
  const defaultActionSectors = {
    "material.photos": ["marketing"],
    "material.clips_video": ["marketing"],
    "listing.photos": ["cadastro"],
    "listing.clips_video": ["cadastro"],
    "listing.title": ["cadastro"],
    "listing.description": ["cadastro"],
    "listing.attributes": ["cadastro"],
    "listing.model": ["cadastro"],
    "listing.stock": ["cadastro"],
    "listing.other": ["cadastro"],
    "listing.lead_time": ["logistica"],
    "listing.shipping": ["logistica"],
    "listing.price": ["comercial"],
    "listing.promotion": ["comercial"],
    "listing.ads": ["ads"],
  };
  const statusLabels = { pending: "Pendente", in_progress: "Em andamento", review: "Em revisao", returned: "Devolvida", completed: "Concluida", canceled: "Cancelada" };
  const priorityLabels = { low: "Baixa", medium: "Media", high: "Alta" };
  const sectorFallbackLabels = { marketing: "Marketing", cadastro: "Cadastro", comercial: "Comercial/Preco", ads: "Ads", logistica: "Logistica", atendimento: "Atendimento", gestao: "Gestao" };
  function sectorLabel(value) {
    const key = String(value || "").trim().toLowerCase();
    return state.taskSectors.find((item) => String(item.key) === key)?.label || sectorFallbackLabels[key] || key;
  }
  function canActOnSector(value) {
    const key = String(value || "").trim().toLowerCase();
    return state.taskIsAdmin || state.taskUserSectors.some((item) => String(item.key || item.setor || item).toLowerCase() === key);
  }
  function canEditTask(task = {}) {
    if (state.taskIsAdmin) return true;
    const sectors = Array.isArray(task.sectors) ? task.sectors : [];
    return sectors.some((sector) => canActOnSector(sector.key || sector.setor));
  }
  function actionEditSectors(actionKey = "") {
    const configured = state.actionPermissions?.[actionKey] || {};
    const sectors = Object.entries(configured)
      .filter(([, value]) => value?.can_edit === true || value?.pode_editar === true)
      .map(([setor]) => setor);
    return sectors.length ? sectors : (defaultActionSectors[actionKey] || []);
  }
  function actionViewSectors(actionKey = "") {
    const configured = state.actionPermissions?.[actionKey] || {};
    const sectors = Object.entries(configured)
      .filter(([, value]) => value?.can_view === true || value?.pode_visualizar === true || value?.can_edit === true || value?.pode_editar === true)
      .map(([setor]) => setor);
    return sectors.length ? sectors : actionEditSectors(actionKey);
  }
  function canUseAction(actionMap = {}, value = "") {
    const actionKey = actionMap[value];
    if (!actionKey) return true;
    return state.taskIsAdmin || actionEditSectors(actionKey).some((setor) => canActOnSector(setor));
  }
  function canViewActionKey(actionKey = "") {
    if (!actionKey) return true;
    return state.taskIsAdmin || actionViewSectors(actionKey).some((setor) => canActOnSector(setor));
  }
  function canCreateTasks() {
    return state.taskIsAdmin || actionEditSectors("task.create").some((setor) => canActOnSector(setor));
  }
  function canViewWatchlist() {
    return state.taskIsAdmin || actionViewSectors("watchlist").some((setor) => canActOnSector(setor));
  }
  function canEditWatchlist() {
    return state.taskIsAdmin || actionEditSectors("watchlist").some((setor) => canActOnSector(setor));
  }
  function userSectorNames() {
    return state.taskUserSectors.map((item) => sectorLabel(item.key || item.setor || item)).filter(Boolean);
  }
  function permissionMessage(actionLabel = "esta acao") {
    if (state.taskIsAdmin) return "";
    const sectors = userSectorNames();
    if (!sectors.length) {
      return "Seu usuario nao possui setor estrategico vinculado nesta empresa. Peça para um administrador liberar seu setor em Conta > Usuarios ou em Estrategicos > Permissoes.";
    }
    return `Seu setor (${sectors.join(", ")}) nao possui permissao para ${actionLabel}. Peça para um administrador ajustar em Estrategicos > Permissoes.`;
  }
  function actionAllowedLabel(actionMap = {}, value = "") {
    const actionKey = actionMap[value];
    return actionEditSectors(actionKey).map(sectorLabel).join(", ") || "nenhum setor";
  }
  function userAssumedSectorInBatch(batch = {}, exceptSector = "") {
    const userId = String(state.taskUserId || "");
    if (!userId) return null;
    const except = String(exceptSector || "").trim().toLowerCase();
    return (batch.sectors || []).find((sector) => {
      const key = String(sector.key || sector.setor || "").trim().toLowerCase();
      const assignedId = String(sector.assigned_to?.id || "");
      return assignedId && assignedId === userId && key !== except && ["pending", "in_progress", "review", "returned"].includes(String(sector.status || "pending"));
    }) || null;
  }
  function taskMissingRequiredWork(task = {}, materialsCreated = {}, listingChanges = {}, notApplicable = {}) {
    const progress = taskProgress(task);
    const flags = task.task_flags || {};
    const hasMaterialInput = (key) => Object.prototype.hasOwnProperty.call(materialsCreated || {}, key);
    const hasListingInput = (key) => Object.prototype.hasOwnProperty.call(listingChanges || {}, key);
    const materialDone = Object.fromEntries(progress.materials.map((item) => [item.key, hasMaterialInput(item.key) ? !!materialsCreated?.[item.key] : !!item.done]));
    const listingDone = Object.fromEntries(progress.listings.map((item) => [item.key, hasListingInput(item.key) ? !!listingChanges?.[item.key] : !!item.done]));
    const materialNotApplicable = Object.fromEntries(progress.materials.map((item) => [item.key, notApplicable?.materials?.[item.key] ?? !!item.notApplicable]));
    const listingNotApplicable = Object.fromEntries(progress.listings.map((item) => [item.key, notApplicable?.listings?.[item.key] ?? !!item.notApplicable]));
    const missingMaterials = materialProgressKeys.filter((item) => flags[item.flag] && !materialDone[item.key] && !materialNotApplicable[item.key]).map((item) => item.label);
    const missingListings = listingProgressKeys.filter((item) => flags[item.flag] && !listingDone[item.key] && !listingNotApplicable[item.key]).map((item) => item.label);
    return { missingMaterials, missingListings, complete: !missingMaterials.length && !missingListings.length };
  }
  function missingWorkMessage(state = {}) {
    const parts = [];
    if (state.missingMaterials?.length) parts.push(`materiais: ${state.missingMaterials.join(", ")}`);
    if (state.missingListings?.length) parts.push(`publicacao no anuncio: ${state.missingListings.join(", ")}`);
    return parts.length ? `Ainda faltam etapas obrigatorias antes de iniciar o monitoramento (${parts.join("; ")}).` : "";
  }

  async function api(path, options = {}) {
    const url = window.ML?.url ? window.ML.url(path) : typeof window.withBase === "function" ? window.withBase(path) : path;
    const response = await fetch(url, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  function apiUrl(path) {
    return window.ML?.url ? window.ML.url(path) : typeof window.withBase === "function" ? window.withBase(path) : path;
  }

  function fillSelectOptions(select, rows = [], placeholder = "Todos", valueKey = "id", labelKey = "name") {
    if (!select) return;
    const current = select.value;
    select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>`;
    rows.forEach((row) => {
      const value = row?.[valueKey] ?? "";
      const label = row?.[labelKey] ?? value;
      if (!value && value !== 0) return;
      select.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`);
    });
    if ([...select.options].some((option) => option.value === current)) select.value = current;
  }

  async function loadTaskReportOptions() {
    const data = await api("/api/estrategicos/tasks/report-options");
    fillSelectOptions($("taskReportUser"), data.users || [], "Todos os usuarios", "id", "name");
    fillSelectOptions($("taskReportSector"), data.sectors || [], "Todos os setores", "key", "label");
    fillSelectOptions($("taskReportBatch"), data.batches || [], "Todos os lotes", "id", "name");
  }

  async function openTaskReportModal() {
    setValue("taskReportDateFrom", $("taskCreatedFrom")?.value || monthStartYmd());
    setValue("taskReportDateTo", $("taskCreatedTo")?.value || todayYmd());
    setValue("taskReportUser", "");
    setValue("taskReportSector", $("taskSectorFilter")?.value || "");
    setValue("taskReportBatch", state.selectedTaskBatchId || "");
    const status = $("taskStatusFilter")?.value || "all";
    setValue("taskReportStatus", status === "open" ? "open" : status || "all");
    $("taskReportModal").hidden = false;
    try {
      await loadTaskReportOptions();
      if ($("taskReportSector") && $("taskSectorFilter")?.value) $("taskReportSector").value = $("taskSectorFilter").value;
      if ($("taskReportBatch") && state.selectedTaskBatchId) $("taskReportBatch").value = String(state.selectedTaskBatchId);
    } catch (error) {
      closeTaskReportModal();
      showNotice(error.message || "Falha ao carregar opcoes do relatorio.", { kind: "warning", title: "Relatorio" });
    }
  }

  function closeTaskReportModal() {
    if ($("taskReportModal")) $("taskReportModal").hidden = true;
  }

  function exportTaskReport() {
    const params = new URLSearchParams();
    const map = [
      ["date_from", "taskReportDateFrom"],
      ["date_to", "taskReportDateTo"],
      ["user_id", "taskReportUser"],
      ["sector", "taskReportSector"],
      ["batch_id", "taskReportBatch"],
      ["status", "taskReportStatus"],
    ];
    map.forEach(([key, id]) => {
      const value = $(id)?.value || "";
      if (value && !(key === "status" && value === "all")) params.set(key, value);
    });
    closeTaskReportModal();
    window.location.href = apiUrl(`/api/estrategicos/tasks/report.xlsx?${params.toString()}`);
  }

  function setBusy(button, busy) {
    if (!button) return;
    button.disabled = !!busy;
    if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
    button.innerHTML = busy ? "Processando..." : button.dataset.originalHtml;
  }

  function mlPanelUrl(mlb) {
    const clean = String(mlb || "").trim().toUpperCase();
    return clean ? `https://www.mercadolivre.com.br/anuncios/${encodeURIComponent(clean)}/modificar` : "";
  }

  function mlbLinkHtml(mlb, options = {}) {
    const clean = String(mlb || "").trim().toUpperCase();
    if (!clean) return "";
    const url = mlPanelUrl(clean);
    const tip = "Abre o anuncio no painel do Mercado Livre.\nPara funcionar corretamente, esteja logado no Mercado Livre com a mesma conta selecionada aqui.";
    const copyButton = options.copyable === false
      ? ""
      : `<button class="strategy-product__mlb-copy" type="button" data-copy-mlb="${escapeHtml(clean)}" data-tooltip="Copiar MLB" data-tooltip-default="Copiar MLB" aria-label="Copiar codigo ${escapeHtml(clean)}"><span aria-hidden="true">⧉</span></button>`;
    return `<span class="strategy-product__mlb-row">${copyButton}<a class="strategy-product__mlb strategy-product__mlb-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" data-tooltip="${escapeHtml(tip)}">${escapeHtml(clean)}</a></span><small class="strategy-mlb-login-hint">Use logado na conta selecionada</small>`;
  }

  function updateTooltipContent(target, text) {
    if (!target) return;
    target.dataset.tooltip = String(text || "");
    if (activeTooltip && activeTooltipTarget === target) {
      activeTooltip.innerHTML = escapeHtml(target.dataset.tooltip || "").replace(/\n/g, "<br>");
    }
  }

  function restoreTooltipContent(target) {
    if (!target?.dataset?.tooltipDefault) return;
    updateTooltipContent(target, target.dataset.tooltipDefault);
  }

  function showTransientTooltip(target, text, duration = 1400) {
    if (!target) return;
    updateTooltipContent(target, text);
    clearTimeout(target.__strategyTooltipTimer);
    target.__strategyTooltipTimer = window.setTimeout(() => {
      restoreTooltipContent(target);
      if (target.classList.contains("is-copied")) target.classList.remove("is-copied");
    }, duration);
  }

  async function copyTextToClipboard(value = "") {
    const text = String(value || "").trim();
    if (!text) throw new Error("MLB invalido para copiar.");
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return text;
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("Nao foi possivel copiar o MLB.");
    return text;
  }

  async function copyMlbFromButton(button) {
    const mlb = String(button?.dataset?.copyMlb || "").trim().toUpperCase();
    await copyTextToClipboard(mlb);
    button.classList.add("is-copied");
    showTransientTooltip(button, "MLB copiado");
  }

  function handleCopyMlbClick(event) {
    const copyMlbButton = closestFromEvent(event, "[data-copy-mlb]");
    if (!copyMlbButton) return false;
    event.preventDefault();
    event.stopPropagation();
    copyMlbFromButton(copyMlbButton).catch((error) => showNotice(error.message, { kind: "warning", title: "Falha ao copiar" }));
    return true;
  }

  function noticeKindFromMessage(message = "") {
    const text = String(message || "").toLowerCase();
    if (/permiss|setor|funcao|função|administrador|403|nao possui|não possui|restrito/.test(text)) return "warning";
    if (/erro|falha|inval|não foi|nao foi/.test(text)) return "danger";
    if (/sucesso|salv/.test(text)) return "success";
    return "info";
  }

  function showNotice(message, { title = "", kind = "" } = {}) {
    const type = kind || noticeKindFromMessage(message);
    const labels = {
      warning: ["Atencao necessaria", "Permissao ou funcao"],
      danger: ["Nao foi possivel concluir", "Erro"],
      success: ["Tudo certo", "Sucesso"],
      info: ["Aviso", "Informacao"],
    };
    const icons = { warning: "!", danger: "x", success: "✓", info: "i" };
    $("noticeModal").className = `strategy-modal strategy-modal--notice-${type}`;
    $("noticeTitle").textContent = title || labels[type]?.[0] || "Aviso";
    $("noticeEyebrow").textContent = labels[type]?.[1] || "Aviso";
    $("noticeIcon").textContent = icons[type] || "i";
    $("noticeMessage").textContent = message || "Ocorreu um aviso inesperado.";
    $("noticeModal").hidden = false;
    setTimeout(() => $("btnNoticeClose")?.focus(), 30);
  }

  function closeNotice() {
    $("noticeModal").hidden = true;
  }

  function renderKpis(summary = {}) {
    const cards = [
      ["Em observacao", summary.active || 0, "janela aberta", ""],
      ["Concluidos", summary.completed || 0, "com antes/depois", ""],
      ["Melhoraram", summary.improved || 0, "sinal positivo", "strategy-kpi--success"],
      ["Com queda", summary.worse || 0, "pedem revisao", "strategy-kpi--danger"],
    ];
    $("strategyKpis").innerHTML = cards.map(([label, value, sub, className]) => `<article class="strategy-kpi ${className}"><span>${escapeHtml(label)}</span><strong>${fmtInt(value)}</strong><small>${escapeHtml(sub)}</small></article>`).join("");
  }

  function switchTab(tab = "tasks") {
    const allowedTabs = ["tasks", "rounds", "watchlist"];
    if (canCreateTasks()) allowedTabs.unshift("cadastro");
    if (state.taskIsAdmin) allowedTabs.push("permissions");
    if (tab === "cadastro" && !canCreateTasks()) {
      showNotice(permissionMessage("criar lotes"), { kind: "warning", title: "Criacao de lote bloqueada" });
    }
    if (tab === "watchlist" && !canViewWatchlist()) {
      showNotice(permissionMessage("visualizar a Watchlist"), { kind: "warning", title: "Watchlist bloqueada" });
    }
    const normalized = allowedTabs.includes(tab) ? tab : "tasks";
    document.querySelectorAll("[data-tab]").forEach((item) => item.classList.toggle("active", item.dataset.tab === normalized));
    $("cadastroPanel").hidden = normalized !== "cadastro";
    $("tasksPanel").hidden = normalized !== "tasks";
    $("roundsPanel").hidden = normalized !== "rounds";
    $("watchlistPanel").hidden = normalized !== "watchlist";
    $("permissionsPanel").hidden = normalized !== "permissions";
    if (normalized === "watchlist") loadWatchlist().catch((error) => renderWatchlistAccess(error.message));
  }

  function renderInsights(insights = []) {
    $("strategyInsights").innerHTML = (insights.length ? insights : [{ type: "neutral", title: "Sem dados ainda", text: "Cadastre uma alteracao para iniciar a leitura." }]).map((item) => `
      <article class="strategy-insight strategy-insight--${escapeHtml(item.type || "neutral")}">
        <strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.text)}</p>
      </article>`).join("");
  }

  function renderTaskSectorOptions() {
    const wrap = $("taskRequiredSectors");
    const sectors = state.taskSectors.length ? state.taskSectors : [{ key: "marketing", label: "Marketing" }, { key: "cadastro", label: "Cadastro" }];
    if (wrap) {
      wrap.innerHTML = sectors.map((sector) => `
        <label class="strategy-sector-option"><input type="checkbox" value="${escapeHtml(sector.key)}" ${String(sector.key) === "cadastro" ? "checked" : ""} /><span class="strategy-chip-icon" aria-hidden="true">●</span> ${escapeHtml(sector.label)}</label>`).join("");
    }
    if ($("taskSectorFilter")) {
      $("taskSectorFilter").innerHTML = [`<option value="">Todos os setores</option>`]
        .concat(sectors.map((sector) => `<option value="${escapeHtml(sector.key)}">${escapeHtml(sector.label)}</option>`))
        .join("");
    }
  }

  function permissionValue(actionKey, sectorKey) {
    return state.actionPermissions?.[actionKey]?.[sectorKey] || { can_view: false, can_edit: false };
  }

  function renderPermissionsMatrix() {
    const wrap = $("permissionsMatrix");
    if (!wrap) return;
    if (!state.taskIsAdmin) {
      wrap.innerHTML = `<div class="strategy-empty"><strong>Acesso restrito</strong><p>Somente administradores conseguem configurar as permissoes por setor.</p></div>`;
      return;
    }
    const sectors = state.taskSectors || [];
    const actions = state.strategyActions?.length ? state.strategyActions : [];
    if (!sectors.length || !actions.length) {
      wrap.innerHTML = `<div class="strategy-empty"><strong>Sem configuracao</strong><p>Nenhum setor ou acao disponivel para configurar.</p></div>`;
      return;
    }
    const rows = actions.map((action) => `
      <tr data-permission-action="${escapeHtml(action.key)}">
        <td>
          <strong>${escapeHtml(action.label)}</strong>
          <span>${escapeHtml(action.group || "")}</span>
        </td>
        ${sectors.map((sector) => {
          const value = permissionValue(action.key, sector.key);
          if (action.key === "task.create") {
            return `<td data-permission-sector="${escapeHtml(sector.key)}">
              <label><input type="checkbox" data-permission-kind="edit" ${value.can_edit ? "checked" : ""} /> Sim</label>
            </td>`;
          }
          return `<td data-permission-sector="${escapeHtml(sector.key)}">
            <label><input type="checkbox" data-permission-kind="view" ${value.can_view ? "checked" : ""} /> Ver</label>
            <label><input type="checkbox" data-permission-kind="edit" ${value.can_edit ? "checked" : ""} /> Editar</label>
          </td>`;
        }).join("")}
      </tr>`).join("");
    wrap.innerHTML = `
      <div class="strategy-permissions__hint">A primeira linha controla <b>Criar tarefa</b> como Sim/Nao. Na Watchlist e nas demais acoes, marcar <b>Editar</b> tambem libera visualizacao. Usuarios admin continuam com acesso total.</div>
      <div class="strategy-table-wrap">
        <table class="strategy-table strategy-permissions-table">
          <thead><tr><th>Acao</th>${sectors.map((sector) => `<th>${escapeHtml(sector.label)}</th>`).join("")}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function collectPermissionsMatrix() {
    const permissions = {};
    document.querySelectorAll("[data-permission-action]").forEach((row) => {
      const actionKey = row.dataset.permissionAction;
      permissions[actionKey] = {};
      row.querySelectorAll("[data-permission-sector]").forEach((cell) => {
        const sector = cell.dataset.permissionSector;
        const canEdit = cell.querySelector("[data-permission-kind='edit']")?.checked === true;
        const canView = canEdit || cell.querySelector("[data-permission-kind='view']")?.checked === true;
        permissions[actionKey][sector] = { can_view: canView, can_edit: canEdit };
      });
    });
    return permissions;
  }

  async function savePermissions() {
    const btn = $("btnSavePermissions");
    if (!state.taskIsAdmin) return;
    try {
      setBusy(btn, true);
      $("permissionsStatus").classList.remove("is-success", "is-error");
      $("permissionsStatus").textContent = "Salvando permissoes...";
      const data = await api("/api/estrategicos/permissions", {
        method: "PUT",
        body: JSON.stringify({ permissions: collectPermissionsMatrix() }),
      });
      state.strategyActions = data.actions || state.strategyActions;
      state.actionPermissions = data.permissions || state.actionPermissions;
      renderPermissionsMatrix();
      $("permissionsStatus").classList.add("is-success");
      $("permissionsStatus").textContent = "Permissoes salvas com sucesso.";
    } catch (error) {
      $("permissionsStatus").classList.add("is-error");
      $("permissionsStatus").textContent = error.message;
    } finally {
      setBusy(btn, false);
    }
  }

  function syncSuggestedTaskSectors() {
    const flags = flagsFrom("taskFlags");
    const setSector = (key, checked) => {
      const input = Array.from(document.querySelectorAll("#taskRequiredSectors input[type='checkbox']")).find((item) => item.value === key);
      if (input) input.checked = checked;
    };
    const actionKeys = [];
    if (flags.photo) actionKeys.push("material.photos", "listing.photos");
    if (flags.clips) actionKeys.push("material.clips_video", "listing.clips_video");
    Object.entries({ title: "listing.title", description: "listing.description", attributes: "listing.attributes", model: "listing.model", lead_time: "listing.lead_time", price: "listing.price", stock: "listing.stock", promotion: "listing.promotion", ads: "listing.ads", shipping: "listing.shipping", other: "listing.other" })
      .forEach(([flag, action]) => { if (flags[flag]) actionKeys.push(action); });
    actionKeys.forEach((action) => actionEditSectors(action).forEach((sector) => setSector(sector, true)));
  }

  function renderTaskAccessNotice() {
    const notice = $("taskSectorNotice");
    if (!notice) return;
    if (state.taskIsAdmin || state.taskCanAct) {
      notice.hidden = true;
      notice.innerHTML = "";
      return;
    }
    notice.hidden = false;
    notice.innerHTML = `<strong>Usuario sem setor operacional</strong><span>Voce pode visualizar os lotes, mas precisa que um administrador defina seu setor em Conta &gt; Usuarios para assumir ou editar tarefas.</span>`;
  }

  function activeMarkflowIntegration() {
    const list = Array.isArray(state.integrations?.integrations) ? state.integrations.integrations : [];
    return list.find((item) => item.provider === "markflow" && item.active) || null;
  }
  function activeTrelloIntegration() {
    const list = Array.isArray(state.integrations?.integrations) ? state.integrations.integrations : [];
    return list.find((item) => item.provider === "trello" && item.active) || null;
  }

  function renderIntegrationBadge() {
    const badge = $("strategyIntegrationBadge");
    if (!badge) return;
    const markflow = activeMarkflowIntegration();
    const trello = activeTrelloIntegration();
    const list = Array.isArray(state.integrations?.integrations) ? state.integrations.integrations : [];
    const errored = list.find((item) => item.provider === "markflow" && item.status === "error");
    badge.hidden = false;
    if (markflow) {
      const sectors = Array.isArray(markflow.auto_send_task_sectors) && markflow.auto_send_task_sectors.length
        ? markflow.auto_send_task_sectors.map(sectorLabel).join(", ")
        : "sem envio automatico configurado";
      badge.className = "strategy-integration-badge strategy-integration-badge--active";
      badge.innerHTML = `<span aria-hidden="true">●</span> Integracao ativa`;
      badge.dataset.tooltip = `Conectado ao MarkFlow.\nSetores enviados automaticamente: ${sectors}.`;
      return;
    }
    if (trello) {
      badge.className = "strategy-integration-badge strategy-integration-badge--active";
      badge.innerHTML = `<span aria-hidden="true">●</span> Trello ativo`;
      badge.dataset.tooltip = "Conectado ao Trello para importar cards na criacao de lotes.";
      return;
    }
    if (errored) {
      badge.className = "strategy-integration-badge strategy-integration-badge--error";
      badge.innerHTML = `<span aria-hidden="true">●</span> Integracao com erro`;
      badge.dataset.tooltip = errored.last_error || "A integracao MarkFlow esta com erro.";
      return;
    }
    badge.hidden = true;
    badge.className = "strategy-integration-badge strategy-integration-badge--off";
    badge.innerHTML = `<span aria-hidden="true">○</span> Integracao`;
    badge.dataset.tooltip = "Sem integracao externa ativa nesta empresa.";
  }

  function renderTrelloImportStatus() {
    const status = $("trelloImportStatus");
    const button = $("btnOpenTrelloImport");
    if (!status || !button) return;
    const trello = activeTrelloIntegration();
    status.classList.remove("is-success", "is-warning", "is-error");
    button.disabled = false;
    if (!canCreateTasks()) {
      status.classList.add("is-warning");
      status.textContent = "Seu usuario nao pode criar lotes.";
      button.dataset.tooltip = permissionMessage("importar tarefas do Trello");
      return;
    }
    if (trello) {
      status.classList.add("is-success");
      status.textContent = "Trello conectado. Importe boards/listas para preencher a lista.";
      delete button.dataset.tooltip;
      return;
    }
    status.classList.add("is-warning");
    status.textContent = "Configure o Trello em Conta > Integracoes para importar cards.";
    button.dataset.tooltip = "Sem Trello ativo nesta empresa. Configure em Conta > Integracoes.";
  }

  async function loadTaskSectors() {
    const data = await api("/api/estrategicos/task-sectors");
    state.taskSectors = data.sectors || [];
    state.integrations = data.integrations || { active: false, integrations: [] };
    state.strategyActions = data.actions || [];
    state.actionPermissions = data.permissions || {};
    state.taskUserSectors = data.user_sectors || [];
    state.taskIsAdmin = data.is_admin === true;
    state.taskCanAct = data.can_act === true;
    state.taskUserId = data.user_id || null;
    if ($("taskScopeFilter")) {
      $("taskScopeFilter").value = state.taskIsAdmin || !state.taskCanAct ? "all" : "mine";
      $("taskScopeFilter").disabled = !state.taskCanAct && !state.taskIsAdmin;
    }
    if ($("taskOrderMode")) {
      $("taskOrderMode").value = "mine_first";
    }
    document.querySelectorAll("[data-admin-only]").forEach((item) => { item.hidden = !state.taskIsAdmin; });
    document.querySelector("[data-tab='cadastro']")?.toggleAttribute("hidden", false);
    $("btnOpenCreate")?.toggleAttribute("hidden", false);
    if (!canCreateTasks() && !$("cadastroPanel").hidden) switchTab("tasks");
    if (!state.taskIsAdmin && !$("permissionsPanel").hidden) switchTab("tasks");
    renderTaskSectorOptions();
    renderPermissionsMatrix();
    renderTaskAccessNotice();
    renderIntegrationBadge();
    renderTrelloImportStatus();
    renderWatchlistAccess();
    if (state.rounds.length) renderRounds(state.rounds);
    if (state.taskBatches.length) renderTaskBatches(state.taskBatches);
  }

  function metricHtml(row, key, formatter) {
    const data = row.deltas?.[key] || {};
    const after = data.after ?? row.after_metrics?.[key];
    const before = data.before ?? row.before_metrics?.[key];
    const hasAfter = after !== undefined && after !== null && after !== "";
    const formatValue = (value) => value === undefined || value === null || value === "" ? "--" : formatter(value);
    const shouldShowAfter = state.metricView === "after" || (state.metricView === "auto" && (row.status === "completed" || row.status === "ready"));
    const display = shouldShowAfter && hasAfter ? formatValue(after) : formatValue(before);
    const modeLabel = shouldShowAfter && hasAfter ? "Metrica exibida: comparada" : "Metrica exibida: inicial";
    const pct = Number(data.pct);
    const cls = !Number.isFinite(pct) || Math.abs(pct) < 1 ? "flat" : pct > 0 ? "up" : "down";
    const arrow = cls === "up" ? "▲" : cls === "down" ? "▼" : "→";
    const clickTip = key === "ctr" ? `\nCliques antes: ${formatValue(row.before_metrics?.clicks)}\nCliques depois: ${formatValue(row.after_metrics?.clicks)}` : "";
    const tip = `${metricLabels[key] || key.toUpperCase()}\n${modeLabel}\nAntes: ${formatValue(before)}\nDepois: ${formatValue(after)}${clickTip}\nPeriodo antes: ${row.before_from || "--"} a ${row.before_to || "--"}\nPeriodo depois: ${row.after_from || "--"} a ${row.after_to || "--"}`;
    return `<div class="strategy-metric strategy-metric--${cls}" data-tooltip="${escapeHtml(tip)}"><div class="strategy-value">${escapeHtml(display)}</div><div class="strategy-metric__delta">${arrow} ${Number.isFinite(pct) ? fmtPct(Math.abs(pct)) : "--"}</div></div>`;
  }

  function flagsHtml(flags = {}) {
    const active = Object.keys(flags).filter((key) => flags[key]).map((key) => flagLabels[key] || key);
    const labels = active.length ? active : ["alteracao manual"];
    return labels.map((label) => `<span>${escapeHtml(label)}</span>`).join("");
  }
  function executionLine(entry = {}) {
    const materials = labelList(entry.materials_created, materialLabels);
    const returnedMaterials = labelList(entry.materials_returned || entry.materials_unset, materialLabels);
    const changes = labelList(entry.listing_changes, listingChangeLabels);
    const notApplicableMaterials = labelList(entry.materials_not_applicable, materialLabels);
    const notApplicableListings = labelList(entry.listing_not_applicable, listingChangeLabels);
    const parts = [];
    if (returnedMaterials.length) parts.push(`devolveu ${returnedMaterials.join(", ")}`);
    if (materials.length) parts.push(`criou ${materials.join(", ")}`);
    if (changes.length) parts.push(`publicou ${changes.join(", ")}`);
    if (notApplicableMaterials.length || notApplicableListings.length) parts.push(`marcou como nao se aplica ${[...notApplicableMaterials, ...notApplicableListings].join(", ")}`);
    return parts.length ? `${entry.user_name || "Usuario"} ${parts.join(" e ")}` : `${entry.user_name || "Usuario"} registrou execucao`;
  }
  function hasProgress(entries = [], mapKey, itemKey) {
    return entries.some((entry) => !!entry?.[mapKey]?.[itemKey]);
  }
  function listingChangesFromLegacyFlags(flags = {}) {
    return {
      photos: !!flags.photo,
      clips_video: !!flags.clips,
      title: !!flags.title,
      description: !!flags.description,
      attributes: !!flags.attributes,
      model: !!flags.model,
      lead_time: !!flags.lead_time,
      price: !!flags.price,
      stock: !!flags.stock,
      promotion: !!flags.promotion,
      ads: !!flags.ads,
      shipping: !!flags.shipping,
      other: !!flags.other,
    };
  }
  function progressStateFromEntries(entries = []) {
    const materialDone = {};
    const listingDone = {};
    const materialNotApplicable = {};
    const listingNotApplicable = {};
    for (const entry of Array.isArray(entries) ? entries : []) {
      const reopened = listingChangesFromLegacyFlags(entry?.reopen_flags || {});
      Object.entries(reopened).forEach(([key, value]) => {
        if (value) listingDone[key] = false;
      });
      materialProgressKeys.forEach((item) => {
        if (entry?.materials_unset?.[item.key]) materialDone[item.key] = false;
        if (entry?.materials_not_applicable_unset?.[item.key]) materialNotApplicable[item.key] = false;
        if (entry?.materials_created?.[item.key]) {
          materialDone[item.key] = true;
          materialNotApplicable[item.key] = false;
        }
        if (entry?.materials_not_applicable?.[item.key]) {
          materialDone[item.key] = false;
          materialNotApplicable[item.key] = true;
        }
      });
      listingProgressKeys.forEach((item) => {
        if (entry?.listing_unset?.[item.key]) listingDone[item.key] = false;
        if (entry?.listing_not_applicable_unset?.[item.key]) listingNotApplicable[item.key] = false;
        if (entry?.listing_changes?.[item.key]) {
          listingDone[item.key] = true;
          listingNotApplicable[item.key] = false;
        }
        if (entry?.listing_not_applicable?.[item.key]) {
          listingDone[item.key] = false;
          listingNotApplicable[item.key] = true;
        }
      });
    }
    return { materialDone, listingDone, materialNotApplicable, listingNotApplicable };
  }
  function latestMaterialLocation(entries = [], itemKey) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index] || {};
      const location = String(entry.material_locations?.[itemKey] || "").trim();
      if (entry.materials_created?.[itemKey] && location) return location;
    }
    return "";
  }
  function taskProgress(task = {}) {
    const entries = Array.isArray(task.execution_payload?.entries) ? task.execution_payload.entries : [];
    const flags = task.task_flags || {};
    const stateFromEntries = progressStateFromEntries(entries);
    const requestedMaterials = materialProgressKeys.filter((item) => flags[item.flag] || stateFromEntries.materialDone[item.key] || stateFromEntries.materialNotApplicable[item.key]);
    const requestedListings = listingProgressKeys.filter((item) => flags[item.flag] || stateFromEntries.listingDone[item.key] || stateFromEntries.listingNotApplicable[item.key] || hasProgress(entries, "listing_changes", item.key));
    const materials = requestedMaterials.map((item) => ({
      ...item,
      actionKey: materialActionMap[item.key],
      done: !!stateFromEntries.materialDone[item.key],
      notApplicable: !!stateFromEntries.materialNotApplicable[item.key],
      location: latestMaterialLocation(entries, item.key),
    }));
    const listings = requestedListings.map((item) => ({
      ...item,
      actionKey: listingActionMap[item.key],
      done: !!stateFromEntries.listingDone[item.key],
      notApplicable: !!stateFromEntries.listingNotApplicable[item.key],
    }));
    const pendingMaterials = materials.filter((item) => !item.done && !item.notApplicable);
    const pendingListings = listings.filter((item) => !item.done && !item.notApplicable);
    const sectors = Array.isArray(task.sectors) ? task.sectors : [];
    const activeSector = sectors.find((sector) => !["completed", "canceled"].includes(String(sector.status || "pending")));
    let nextLabel = "Aguardando inicio";
    let nextClass = "pending";
    if (task.status === "completed") {
      nextLabel = "Publicado e monitorando";
      nextClass = "done";
    } else if (task.status === "canceled") {
      nextLabel = "Cancelada";
      nextClass = "canceled";
    } else if (task.status === "returned") {
      nextLabel = "Devolvida para ajustes";
      nextClass = "returned";
    } else if (task.status === "review") {
      nextLabel = "Pronto para revisao";
      nextClass = "review";
    } else if (activeSector) {
      const label = activeSector.label || sectorLabel(activeSector.key || activeSector.setor);
      nextLabel = activeSector.assigned_to?.name ? `${label} em andamento` : `Aguardando ${label}`;
      nextClass = activeSector.key === "marketing" || activeSector.setor === "marketing" ? "marketing" : activeSector.key === "cadastro" || activeSector.setor === "cadastro" ? "catalog" : "sector";
    } else if (pendingMaterials.length) {
      nextLabel = materials.some((item) => item.done) ? "Marketing em andamento" : "Aguardando marketing";
      nextClass = "marketing";
    } else if (pendingListings.length) {
      nextLabel = "Aguardando cadastro";
      nextClass = "catalog";
    } else if (entries.length) {
      nextLabel = "Etapas registradas";
      nextClass = "done";
    }
    return { entries, materials, listings, sectors, nextLabel, nextClass };
  }
  function renderSectorChips(sectors = [], { compact = false, externalLinks = [] } = {}) {
    if (!sectors.length) return `<span class="strategy-muted">Sem setores</span>`;
    const hasMarkflow = (Array.isArray(externalLinks) ? externalLinks : []).some((link) => String(link.provider || "").toLowerCase() === "markflow");
    return sectors.map((sector) => {
      const status = String(sector.status || "pending");
      const owner = sector.assigned_to?.name || "";
      const sectorKey = String(sector.key || sector.setor || "").toLowerCase();
      const linked = hasMarkflow && sectorKey === "marketing";
      const title = `${sector.label || sectorLabel(sector.key || sector.setor)}\n${owner ? `Responsavel: ${owner}` : "Sem responsavel"}\nStatus: ${statusLabels[status] || status}${linked ? "\nSincronizado com MarkFlow." : ""}`;
      return `<span class="strategy-sector-chip strategy-sector-chip--${escapeHtml(status)} ${compact ? "is-compact" : ""}" data-tooltip="${escapeHtml(title)}">
        <b>${status === "completed" ? "✓" : status === "in_progress" ? "●" : status === "returned" ? "↩" : "○"}</b>
        ${escapeHtml(sector.label || sectorLabel(sector.key || sector.setor))}
        ${linked ? `<span class="strategy-sector-chip__link" aria-hidden="true">↔</span>` : ""}
      </span>`;
    }).join("");
  }
  function progressChips(items = []) {
    const visibleItems = items.filter((item) => canViewActionKey(item.actionKey));
    if (!visibleItems.length) return `<span class="strategy-progress-empty">Nada visivel</span>`;
    return visibleItems.map((item) => {
      const attrs = item.done && item.location
        ? `data-material-location="${escapeHtml(item.location)}" data-material-label="${escapeHtml(item.label)}" role="button" tabindex="0"`
        : "";
      const tip = item.notApplicable ? notApplicableText : item.done && item.location ? `${item.label} feito\nClique para ver o caminho` : item.done ? `${item.label} feito` : `${item.label} pendente`;
      const stateClass = item.notApplicable ? "not-applicable" : item.done ? "done" : "pending";
      return `<span class="strategy-progress-chip ${stateClass} ${item.location ? "is-clickable" : ""}" ${attrs} data-tooltip="${escapeHtml(tip)}"><b>${item.notApplicable ? "&#8856;" : escapeHtml(item.icon)}</b>${escapeHtml(item.label)}</span>`;
    }).join("");
  }
  function renderTaskProgress(task = {}) {
    const progress = taskProgress(task);
    return `<div class="strategy-task-progress">
      ${progress.sectors.length ? `<div class="strategy-progress-row"><span>Setores</span><div>${renderSectorChips(progress.sectors, { compact: true, externalLinks: task.external_links || [] })}</div></div>` : ""}
      ${progress.materials.length ? `<div class="strategy-progress-row"><span>Materiais</span><div>${progressChips(progress.materials)}</div></div>` : ""}
      <div class="strategy-progress-row"><span>Publicado</span><div>${progressChips(progress.listings)}</div></div>
      ${task.latest_execution ? `<div class="strategy-table-sub strategy-table-sub--execution">${escapeHtml(executionLine(task.latest_execution))}</div>` : task.task_notes ? `<div class="strategy-table-sub">${escapeHtml(task.task_notes)}</div>` : ""}
    </div>`;
  }
  function renderRounds(rounds = []) {
    state.rounds = rounds;
    $("roundCount").textContent = `${fmtInt(state.total || rounds.length)} monitoramento${(state.total || rounds.length) === 1 ? "" : "s"}`;
    if (!rounds.length) {
      $("roundsEmpty").hidden = false;
      $("roundsTableWrap").hidden = true;
      renderPager();
      return;
    }
    $("roundsEmpty").hidden = true;
    $("roundsTableWrap").hidden = false;
    const roundRow = (row) => `
      <tr>
        <td>
          <div class="strategy-product">
            <div class="strategy-thumb"><img src="${escapeHtml(row.thumbnail || "/ml/img/placeholder.png")}" alt="" /></div>
            <div class="strategy-product__info">
              ${mlbLinkHtml(row.mlb)}
              <div class="strategy-product__title" title="${escapeHtml(row.title || row.mlb)}">${escapeHtml(row.title || row.mlb)}</div>
              <div class="strategy-product__meta">SKU ${escapeHtml(row.sku || "sem SKU")}</div>
              <div class="strategy-product__origin" title="${escapeHtml(`Lote: ${row.task_batch_name || "Sem lote vinculado"}${row.source_task_id ? ` · Tarefa #${row.source_task_id}` : ""}`)}">
                ${escapeHtml(`Lote: ${row.task_batch_name || "Sem lote vinculado"}${row.source_task_id ? ` · Tarefa #${row.source_task_id}` : ""}`)}
              </div>
            </div>
          </div>
        </td>
        <td><div class="strategy-change-tags">${flagsHtml(row.change_flags)}</div><div class="strategy-table-sub">${escapeHtml(row.alteration_date || "--")} -> revisar ${escapeHtml(row.review_due_date || "--")}</div></td>
        <td>
          <span class="strategy-status-pill">${escapeHtml(labelMap[row.status] || row.status)}</span>
          ${row.task_review?.status === "open" ? `<div class="strategy-review-badge" data-tooltip="${escapeHtml(row.task_review.reason || "Existe uma revisao aberta para este monitoramento.")}">Em revisao</div>` : ""}
        </td>
        <td>${metricHtml(row, "impressions", fmtInt)}</td>
        <td>${metricHtml(row, "visits", fmtInt)}</td>
        <td>${metricHtml(row, "ctr", fmtPct)}</td>
        <td>${metricHtml(row, "sales", fmtInt)}</td>
        <td>${metricHtml(row, "conversion", fmtPct)}</td>
        <td>${metricHtml(row, "revenue", fmtMoney)}</td>
        <td><span class="strategy-impact strategy-impact--${escapeHtml(row.impact || "pending")}">${escapeHtml(labelMap[row.impact] || row.impact || "Pendente")}</span></td>
        <td>
          <div class="strategy-action-buttons">
            <button class="strategy-icon-action" data-history="${escapeHtml(row.mlb)}" type="button" data-tooltip="Ver historico de alteracoes" aria-label="Ver historico de alteracoes de ${escapeHtml(row.mlb)}"><span class="strategy-icon-action__icon" aria-hidden="true">↺</span></button>
            ${state.taskIsAdmin && row.source_task_id ? `<button class="strategy-mini-btn strategy-mini-btn--warning" data-return-round="${escapeHtml(row.id)}" type="button">${row.task_review?.status === "open" ? "Revisar itens" : "Voltar p/ revisao"}</button>` : ""}
          </div>
        </td>
      </tr>`;
    const groupMode = $("roundGroupMode")?.value || "family";
    if (groupMode === "none") {
      $("roundsBody").innerHTML = rounds.map((row) => roundRow(row)).join("");
      renderPager();
      return;
    }
    const groups = new Map();
    rounds.forEach((row) => {
      const meta = strategicGroupMeta(row, groupMode, "round");
      const key = meta.key || "outros";
      if (!groups.has(key)) groups.set(key, { key, label: meta.label || "Outros", items: [] });
      groups.get(key).items.push(row);
    });
    const ordered = Array.from(groups.values()).sort((a, b) => (b.items.length - a.items.length) || a.label.localeCompare(b.label, "pt-BR"));
    $("roundsBody").innerHTML = ordered.map((group) => {
      const expanded = state.strategyGroupExpanded[group.key] !== false;
      const rowCount = `${fmtInt(group.items.length)} monitoramento${group.items.length === 1 ? "" : "s"}`;
      const head = `<tr class="strategy-group-row">
        <td colspan="11">
          <button class="strategy-group-toggle" type="button" data-round-group-toggle="${escapeHtml(group.key)}" aria-expanded="${expanded ? "true" : "false"}">
            <span class="strategy-group-toggle__arrow">${expanded ? "▾" : "▸"}</span>
            <strong>${escapeHtml(group.label)}</strong>
            <span>${rowCount}</span>
          </button>
        </td>
      </tr>`;
      if (!expanded) return head;
      return `${head}${group.items.map((row) => roundRow(row)).join("")}`;
    }).join("");
    renderPager();
  }

  function renderGenericPager({ el, total, page, limit, pages }) {
    if (!el) return;
    total = Number(total || 0);
    page = Number(page || 1);
    limit = Number(limit || 25);
    pages = Math.max(1, Number(pages || Math.ceil(total / limit) || 1));
    const from = total === 0 ? 0 : (page - 1) * limit + 1;
    const to = Math.min(total, page * limit);
    const mkBtn = (label, p, disabled = false, active = false) => {
      const cls = ["pg-btn", disabled ? "disabled" : "", active ? "active" : ""].filter(Boolean).join(" ");
      return `<button class="${cls}" data-page="${p}" ${disabled ? "disabled" : ""} type="button">${label}</button>`;
    };
    const windowSize = 7;
    let start = Math.max(1, page - Math.floor(windowSize / 2));
    let end = Math.min(pages, start + windowSize - 1);
    start = Math.max(1, end - windowSize + 1);
    const parts = [`<div class="strategy-pager-row"><div>Mostrando <b>${from}</b>-<b>${to}</b> de <b>${total}</b></div><div class="paginator">`];
    parts.push(mkBtn("<<", 1, page <= 1));
    parts.push(mkBtn("<", page - 1, page <= 1));
    if (start > 1) {
      parts.push(mkBtn("1", 1, false, page === 1));
      if (start > 2) parts.push(`<span class="strategy-pager-dots">...</span>`);
    }
    for (let p = start; p <= end; p += 1) parts.push(mkBtn(String(p), p, false, p === page));
    if (end < pages) {
      if (end < pages - 1) parts.push(`<span class="strategy-pager-dots">...</span>`);
      parts.push(mkBtn(String(pages), pages, false, page === pages));
    }
    parts.push(mkBtn(">", page + 1, page >= pages));
    parts.push(mkBtn(">>", pages, page >= pages));
    parts.push("</div></div>");
    el.innerHTML = parts.join("");
  }

  function renderPager() {
    renderGenericPager({
      el: $("strategyPager"),
      total: state.total,
      page: state.page,
      limit: state.limit,
      pages: state.pages,
    });
  }

  function renderTaskKpis(summary = {}) {
    const cards = [
      ["Abertas", summary.open || 0, "fila atual", ""],
      ["Em andamento", summary.in_progress || 0, "assumidas pela equipe", ""],
      ["Devolvidas", summary.returned || 0, "precisam ajuste", "strategy-kpi--warning"],
      ["Atrasadas", summary.overdue || 0, "passaram do prazo", "strategy-kpi--danger"],
      ["Alta prioridade", summary.high || 0, "precisam de foco", "strategy-kpi--warning"],
    ];
    $("taskKpis").innerHTML = cards.map(([label, value, sub, className]) => `<article class="strategy-kpi ${className}"><span>${escapeHtml(label)}</span><strong>${fmtInt(value)}</strong><small>${escapeHtml(sub)}</small></article>`).join("");
  }

  function batchStatusLabel(batch = {}) {
    if (Number(batch.returned || 0) > 0) return "Devolvido";
    if (Number(batch.review || 0) > 0) return "Em revisao";
    if (Number(batch.in_progress || 0) > 0) return "Em andamento";
    if (Number(batch.pending || 0) > 0) return "Pendente";
    if (Number(batch.completed || 0) > 0) return "Concluido";
    if (Number(batch.canceled || 0) > 0) return "Cancelado";
    return "Sem itens";
  }

  function renderTaskBatchNameOptions(batches = []) {
    const select = $("taskBatchNameFilter");
    if (!select) return;
    const current = select.value || "";
    const names = uniq(
      (batches || [])
        .map((batch) => String(batch?.name || "").trim())
        .filter(Boolean),
    ).sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" }));
    const options = [`<option value="">Todas as tarefas</option>`]
      .concat(names.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`));
    select.innerHTML = options.join("");
    if (current && names.includes(current)) select.value = current;
    renderTagSelect("taskTagFilter", $("taskTagFilter")?.value || "", batches.flatMap((batch) => batch.tags || []));
    renderTagSelect("roundTagFilter", $("roundTagFilter")?.value || "", batches.flatMap((batch) => batch.tags || []));
  }

  function renderTaskBatches(batches = []) {
    state.taskBatches = batches;
    renderTaskBatchNameOptions(batches);
    const wrap = $("taskBatches");
    if (!wrap) return;
    if (!batches.length) {
      state.selectedTaskBatchId = "";
      wrap.innerHTML = `<div class="strategy-empty strategy-empty--compact"><strong>Nenhum lote encontrado</strong><p>Crie uma lista de tarefas para acompanhar os MLBs por status.</p></div>`;
      $("selectedBatchTitle").textContent = "Selecione um lote";
      $("selectedBatchMeta").textContent = "0 anuncios";
      return;
    }
    if (state.selectedTaskBatchId && !batches.some((batch) => String(batch.id) === String(state.selectedTaskBatchId))) {
      state.selectedTaskBatchId = "";
    }
    wrap.innerHTML = batches.map((batch) => {
      const done = Number(batch.completed || 0);
      const total = Number(batch.total || 0);
      const pct = total ? Math.round((done / total) * 100) : 0;
      const active = String(batch.id) === String(state.selectedTaskBatchId);
      return `<div class="strategy-batch-card ${active ? "active" : ""}" role="button" tabindex="0" data-task-batch="${escapeHtml(batch.id)}">
        <div class="strategy-batch-card__head">
          <strong>${escapeHtml(batch.name || "Lote de tarefas")}</strong>
          <span class="strategy-task-status ${statusClass(Number(batch.returned || 0) ? "returned" : Number(batch.review || 0) ? "review" : Number(batch.in_progress || 0) ? "in_progress" : Number(batch.pending || 0) ? "pending" : "completed")}">${escapeHtml(batchStatusLabel(batch))}</span>
        </div>
        <div class="strategy-batch-card__meta">
          <span>${fmtInt(total)} anuncio${total === 1 ? "" : "s"}</span>
          ${batch.next_due_date ? `<span>Prazo ${escapeHtml(batch.next_due_date)}</span>` : ""}
          ${batch.analysis_start_date ? `<span>Analise desde ${escapeHtml(batch.analysis_start_date)}</span>` : ""}
        </div>
        ${Array.isArray(batch.tags) && batch.tags.length ? `<div class="strategy-tag-list">${batch.tags.map((tag) => taskTagChip(tag, batch.tag_colors?.[tag])).join("")}</div>` : ""}
        <div class="strategy-batch-progress"><span style="width:${pct}%"></span></div>
        <div class="strategy-batch-counts">
          <span>${fmtInt(batch.pending)} pend.</span>
          <span>${fmtInt(batch.in_progress)} and.</span>
          ${Number(batch.returned || 0) ? `<span>${fmtInt(batch.returned)} dev.</span>` : ""}
          <span>${fmtInt(batch.review)} rev.</span>
          <span>${fmtInt(batch.completed)} concl.</span>
        </div>
        ${batch.sectors?.length ? `<div class="strategy-batch-sectors">${renderSectorChips(batch.sectors, { compact: true })}</div>` : ""}
        ${batch.sectors?.length ? `<div class="strategy-batch-claim">${batch.sectors.filter((sector) => {
          const key = sector.key || sector.setor;
          const assignedToOther = sector.assigned_to?.id && String(sector.assigned_to.id) !== String(state.taskUserId || "");
          return ["pending", "in_progress", "review", "returned"].includes(String(sector.status || "pending"))
            && canActOnSector(key)
            && !assignedToOther
            && !userAssumedSectorInBatch(batch, key);
        }).map((sector) => `<button type="button" data-claim-sector="${escapeHtml(sector.key || sector.setor)}" data-claim-batch="${escapeHtml(batch.id)}">Assumir ${escapeHtml(sector.label || sectorLabel(sector.key || sector.setor))}</button>`).join("")}</div>` : ""}
        <div class="strategy-batch-actions">
          <button type="button" data-edit-batch="${escapeHtml(batch.id)}">Editar</button>
          <button type="button" data-add-batch-items="${escapeHtml(batch.id)}">Adicionar MLBs</button>
          <button type="button" data-archive-batch="${escapeHtml(batch.id)}">Arquivar</button>
          ${state.taskIsAdmin ? `<button type="button" data-cancel-batch="${escapeHtml(batch.id)}" class="danger">Cancelar lote</button>` : ""}
        </div>
        ${batch.overdue ? `<small class="strategy-batch-alert">${fmtInt(batch.overdue)} atrasada${batch.overdue === 1 ? "" : "s"}</small>` : ""}
      </div>`;
    }).join("");
    const selected = batches.find((batch) => String(batch.id) === String(state.selectedTaskBatchId));
    const totalFiltered = batches.reduce((sum, batch) => sum + Number(batch.total || 0), 0);
    $("selectedBatchTitle").textContent = selected?.name || "Itens filtrados";
    $("selectedBatchMeta").textContent = selected
      ? `${fmtInt(selected.total || 0)} anuncio${Number(selected.total || 0) === 1 ? "" : "s"}`
      : `${fmtInt(totalFiltered)} anuncio${totalFiltered === 1 ? "" : "s"} nos lotes filtrados`;
  }

  function priorityClass(priority) {
    return `strategy-priority--${String(priority || "medium").replace(/[^a-z_]/g, "")}`;
  }

  function statusClass(status) {
    return `strategy-task-status--${String(status || "pending").replace(/[^a-z_]/g, "")}`;
  }

  function isOverdue(task) {
    if (!task?.due_date || !["pending", "in_progress", "review", "returned"].includes(task.status)) return false;
    return task.due_date < todayYmd();
  }

  function renderTasks(tasks = []) {
    state.tasks = tasks;
    const tbody = $("tasksBody");
    if (!state.selectedTaskBatchId) {
      $("selectedBatchTitle").textContent = "Itens filtrados";
      $("selectedBatchMeta").textContent = `${fmtInt(state.taskTotal || tasks.length || 0)} pendencia${Number(state.taskTotal || tasks.length || 0) === 1 ? "" : "s"}`;
    }
    if (!tasks.length) {
      tbody.innerHTML = `<tr><td colspan="6">Nenhuma pendencia encontrada.</td></tr>`;
      renderTaskPager();
      return;
    }
    const taskRow = (task) => `
      <tr>
        <td>
          <div class="strategy-product">
            <div class="strategy-thumb"><img src="${escapeHtml(task.thumbnail || "/ml/img/placeholder.png")}" alt="" /></div>
            <div class="strategy-product__info">
              ${mlbLinkHtml(task.mlb, { copyable: true })}
              <div class="strategy-product__title" title="${escapeHtml(task.title || task.mlb)}">${escapeHtml(task.title || task.mlb)}</div>
              <div class="strategy-product__meta">SKU ${escapeHtml(task.sku || "sem SKU")}</div>
              <div class="strategy-listing-state ${escapeHtml(listingStatusMeta(task.listing_status).className)}"><i aria-hidden="true"></i>${escapeHtml(listingStatusMeta(task.listing_status).label)}</div>
            </div>
          </div>
        </td>
        <td>
          ${renderTaskProgress(task)}
        </td>
        <td><span class="strategy-priority ${priorityClass(task.priority)}">${escapeHtml(priorityLabels[task.priority] || task.priority)}</span></td>
        <td>
          <span class="${isOverdue(task) ? "strategy-due-overdue" : ""}">${escapeHtml(task.due_date || "--")}</span>
          <div class="strategy-table-sub">Criada ${escapeHtml(formatDateTime(task.created_at))}</div>
          <label class="strategy-inline-date">
            <span>Analise</span>
            <input type="date" value="${escapeHtml(task.analysis_start_date || "")}" data-task-analysis-date="${escapeHtml(task.id)}" />
          </label>
          <div class="strategy-table-sub">Efetiva ${escapeHtml(task.effective_analysis_start_date || task.batch_analysis_start_date || "ao finalizar")}${task.analysis_start_date ? " · individual" : task.batch_analysis_start_date ? " · herdada do lote" : ""}</div>
        </td>
        <td><span class="strategy-task-status ${statusClass(task.status)}">${escapeHtml(statusLabels[task.status] || task.status)}</span></td>
        <td>
          <div class="strategy-task-actions">
            ${["pending", "in_progress", "review", "returned"].includes(task.status) ? `<button class="strategy-mini-btn" ${canEditTask(task) ? `data-task-complete="${escapeHtml(task.id)}"` : `data-task-denied="${escapeHtml(permissionMessage("editar esta pendencia"))}"`} type="button" data-tooltip="${canEditTask(task) ? "Editar pendencia" : escapeHtml(permissionMessage("editar esta pendencia"))}">Editar</button>` : ""}
            ${state.taskIsAdmin && ["pending", "in_progress", "review", "returned"].includes(task.status) ? `<button class="strategy-icon-action" data-task-status="canceled" data-task-id="${escapeHtml(task.id)}" type="button" data-tooltip="Cancelar pendencia" aria-label="Cancelar pendencia"><span class="strategy-icon-action__icon" aria-hidden="true">x</span></button>` : ""}
            <button class="strategy-icon-action" data-history="${escapeHtml(task.mlb)}" type="button" data-tooltip="Ver historico" aria-label="Ver historico"><span class="strategy-icon-action__icon" aria-hidden="true">↺</span></button>
          </div>
        </td>
      </tr>`;
    const groupMode = $("taskGroupMode")?.value || "family";
    if (groupMode === "none") {
      tbody.innerHTML = tasks.map((task) => taskRow(task)).join("");
      renderTaskPager();
      return;
    }
    const groups = new Map();
    tasks.forEach((task) => {
      const meta = strategicGroupMeta(task, groupMode, "task");
      const key = meta.key || "outros";
      if (!groups.has(key)) groups.set(key, { key, label: meta.label || "Outros", items: [] });
      groups.get(key).items.push(task);
    });
    const ordered = Array.from(groups.values()).sort((a, b) => (b.items.length - a.items.length) || a.label.localeCompare(b.label, "pt-BR"));
    tbody.innerHTML = ordered.map((group) => {
      const expanded = state.strategyGroupExpanded[group.key] !== false;
      const rowCount = `${fmtInt(group.items.length)} pendencia${group.items.length === 1 ? "" : "s"}`;
      const head = `<tr class="strategy-group-row">
        <td colspan="6">
          <button class="strategy-group-toggle" type="button" data-task-group-toggle="${escapeHtml(group.key)}" aria-expanded="${expanded ? "true" : "false"}">
            <span class="strategy-group-toggle__arrow">${expanded ? "▾" : "▸"}</span>
            <strong>${escapeHtml(group.label)}</strong>
            <span>${rowCount}</span>
          </button>
        </td>
      </tr>`;
      if (!expanded) return head;
      return `${head}${group.items.map((task) => taskRow(task)).join("")}`;
    }).join("");
    renderTaskPager();
  }

  function renderTaskPager() {
    renderGenericPager({
      el: $("taskPager"),
      total: state.taskTotal,
      page: state.taskPage,
      limit: state.taskLimit,
      pages: state.taskPages,
    });
  }

  async function loadDashboard() {
    const params = new URLSearchParams({ page: String(state.page), limit: String(state.limit) });
    const batchId = $("roundBatchFilter")?.value || "";
    const tag = $("roundTagFilter")?.value || "";
    const impact = $("roundImpactFilter")?.value || "";
    const analysisFrom = $("roundAnalysisFrom")?.value || "";
    const analysisTo = $("roundAnalysisTo")?.value || "";
    if (batchId) params.set("batch_id", batchId);
    if (tag) params.set("tag", tag);
    if (impact) params.set("impact", impact);
    if (analysisFrom) params.set("analysis_from", analysisFrom);
    if (analysisTo) params.set("analysis_to", analysisTo);
    const qs = `?${params.toString()}`;
    const data = await api(`/api/estrategicos${qs}`);
    state.page = Number(data.page || state.page || 1);
    state.limit = Number(data.limit || state.limit || 25);
    state.total = Number(data.total || 0);
    state.pages = Number(data.pages || 1);
    renderRoundBatchOptions(data.batches || []);
    renderKpis(data.summary || {});
    renderInsights(data.insights || []);
    renderRounds(data.rounds || []);
  }

  function renderRoundBatchOptions(batches = []) {
    const select = $("roundBatchFilter");
    if (!select) return;
    const current = select.value || "";
    state.roundBatches = batches;
    const options = [`<option value="">Todos os lotes</option>`].concat((batches || []).map((batch) => (
      `<option value="${escapeHtml(batch.id)}">${escapeHtml(batch.name || `Lote #${batch.id}`)}</option>`
    )));
    select.innerHTML = options.join("");
    if (current && batches.some((batch) => String(batch.id) === String(current))) select.value = current;
    renderTagSelect("roundTagFilter", $("roundTagFilter")?.value || "", (batches || []).flatMap((batch) => batch.tags || []));
  }

  async function reviewVisibleRounds(button) {
    const ids = state.rounds.map((round) => round.id).filter(Boolean);
    if (!ids.length) {
      showNotice("Nao ha monitoramentos listados para comparar neste filtro.", { kind: "info", title: "Comparar todos" });
      return;
    }
    let ok = 0;
    let failed = 0;
    try {
      setBusy(button, true);
      for (const id of ids) {
        try {
          await api(`/api/estrategicos/rounds/${encodeURIComponent(id)}/review`, { method: "POST", body: JSON.stringify({ force: false }) });
          ok += 1;
        } catch (_) {
          failed += 1;
        }
      }
      await loadDashboard();
      showNotice(`${fmtInt(ok)} monitoramento(s) comparado(s).${failed ? ` ${fmtInt(failed)} falharam e podem ser revisados individualmente pelo historico.` : ""}`, {
        kind: failed ? "warning" : "success",
        title: "Comparacao concluida",
      });
    } finally {
      setBusy(button, false);
    }
  }

  async function loadTasks() {
    const params = new URLSearchParams({
      page: String(state.taskPage),
      limit: String(state.taskLimit),
      status: $("taskStatusFilter")?.value || "open",
    });
    const scope = $("taskScopeFilter")?.value || "all";
    const priority = $("taskPriorityFilter")?.value || "";
    const sector = $("taskSectorFilter")?.value || "";
    const tag = $("taskTagFilter")?.value || "";
    const orderMode = $("taskOrderMode")?.value || "mine_first";
    const batchName = $("taskBatchNameFilter")?.value || "";
    const query = $("taskSearch")?.value || "";
    const dateFilters = {
      created_from: $("taskCreatedFrom")?.value || "",
      created_to: $("taskCreatedTo")?.value || "",
      analysis_from: $("taskAnalysisFrom")?.value || "",
      analysis_to: $("taskAnalysisTo")?.value || "",
      due_from: $("taskDueFrom")?.value || "",
      due_to: $("taskDueTo")?.value || "",
    };
    if (scope === "mine") params.set("scope", "mine");
    if (priority) params.set("priority", priority);
    if (sector) params.set("sector", sector);
    if (tag) params.set("tag", tag);
    if (orderMode === "mine_first") params.set("prioritize_my_pending", "1");
    if (batchName) params.set("batch_name", batchName);
    if (query) params.set("q", query);
    Object.entries(dateFilters).forEach(([key, value]) => { if (value) params.set(key, value); });
    if (state.selectedTaskBatchId) params.set("batch_id", state.selectedTaskBatchId);
    const data = await api(`/api/estrategicos/tasks?${params.toString()}`);
    state.taskPage = Number(data.page || state.taskPage || 1);
    state.taskLimit = Number(data.limit || state.taskLimit || 25);
    state.taskTotal = Number(data.total || 0);
    state.taskPages = Number(data.pages || 1);
    renderTaskKpis(data.summary || {});
    renderTasks(data.tasks || []);
  }

  async function loadWatchlist() {
    if (!canViewWatchlist()) {
      renderWatchlistAccess();
      return;
    }
    const params = new URLSearchParams({
      page: String(state.watchlistPage),
      limit: String(state.watchlistLimit),
    });
    const status = $("watchlistStatusFilter")?.value || "active";
    const listingStatus = $("watchlistListingStatusFilter")?.value || "all";
    const impact = $("watchlistImpactFilter")?.value || "";
    const query = $("watchlistSearch")?.value || "";
    if (status) params.set("status", status);
    if (listingStatus && listingStatus !== "all") params.set("listing_status", listingStatus);
    if (impact) params.set("impact", impact);
    if (query) params.set("q", query);
    const data = await api(`/api/estrategicos/watchlist?${params.toString()}`);
    state.watchlistPage = Number(data.page || state.watchlistPage || 1);
    state.watchlistLimit = Number(data.limit || state.watchlistLimit || 25);
    state.watchlistTotal = Number(data.total || 0);
    state.watchlistPages = Number(data.pages || 1);
    renderWatchlistKpis(data.summary || {});
    renderWatchlist(data.items || []);
  }

  async function loadTaskBatches({ keepSelection = true } = {}) {
    const params = new URLSearchParams({
      status: $("taskStatusFilter")?.value || "open",
    });
    const scope = $("taskScopeFilter")?.value || "all";
    const priority = $("taskPriorityFilter")?.value || "";
    const sector = $("taskSectorFilter")?.value || "";
    const tag = $("taskTagFilter")?.value || "";
    const batchName = $("taskBatchNameFilter")?.value || "";
    const query = $("taskSearch")?.value || "";
    const dateFilters = {
      created_from: $("taskCreatedFrom")?.value || "",
      created_to: $("taskCreatedTo")?.value || "",
      analysis_from: $("taskAnalysisFrom")?.value || "",
      analysis_to: $("taskAnalysisTo")?.value || "",
      due_from: $("taskDueFrom")?.value || "",
      due_to: $("taskDueTo")?.value || "",
    };
    if (scope === "mine") params.set("scope", "mine");
    if (priority) params.set("priority", priority);
    if (sector) params.set("sector", sector);
    if (tag) params.set("tag", tag);
    if (batchName) params.set("batch_name", batchName);
    if (query) params.set("q", query);
    Object.entries(dateFilters).forEach(([key, value]) => { if (value) params.set(key, value); });
    const previous = state.selectedTaskBatchId;
    const data = await api(`/api/estrategicos/tasks/batches?${params.toString()}`);
    if (Array.isArray(data.tags)) collectAvailableTags(data.tags);
    if (!keepSelection) state.selectedTaskBatchId = "";
    renderTaskBatches(data.batches || []);
    if (keepSelection && previous && state.taskBatches.some((batch) => String(batch.id) === String(previous))) {
      state.selectedTaskBatchId = previous;
      renderTaskBatches(state.taskBatches);
    }
  }

  async function reloadTaskWorkspace({ keepSelection = true } = {}) {
    await loadTaskBatches({ keepSelection });
    state.taskPage = 1;
    await loadTasks();
  }

  function flagsFrom(containerId) {
    const flags = {};
    document.querySelectorAll(`#${containerId} input[type='checkbox']`).forEach((input) => { flags[input.value] = input.checked; });
    return flags;
  }
  function anyChecked(map = {}) {
    return Object.values(map || {}).some(Boolean);
  }
  function checkedMap(containerId) {
    return flagsFrom(containerId);
  }
  function renderedCheckboxValues(containerId) {
    return new Set(Array.from(document.querySelectorAll(`#${containerId} input[type='checkbox']`)).map((input) => input.value));
  }
  function notApplicableMap(containerId) {
    const values = {};
    document.querySelectorAll(`#${containerId} [data-complete-item]`).forEach((item) => {
      values[item.dataset.completeItem] = item.dataset.notApplicable === "true";
    });
    return values;
  }
  function checkedEditableMap(containerId) {
    const flags = {};
    document.querySelectorAll(`#${containerId} input[type='checkbox']`).forEach((input) => {
      flags[input.value] = input.checked && !input.disabled;
    });
    return flags;
  }
  function labelList(map = {}, labels = {}) {
    return Object.keys(labels).filter((key) => map?.[key]).map((key) => labels[key]);
  }
  function formatDateTime(value) {
    if (!value) return "--";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  }
  function formatDateOnly(value) {
    if (!value) return "--";
    const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
    if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
    return date.toLocaleDateString("pt-BR");
  }
  function metricDeltaClass(delta) {
    const value = Number(delta);
    if (!Number.isFinite(value) || value === 0) return "";
    return value > 0 ? "strategy-metric--up" : "strategy-metric--down";
  }
  function formatMetricDelta(delta, kind = "number") {
    const value = Number(delta);
    if (!Number.isFinite(value) || value === 0) return "0";
    if (kind === "pct") return `${value > 0 ? "+" : ""}${value.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
    if (kind === "pp") return `${value > 0 ? "+" : ""}${value.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} p.p.`;
    if (kind === "money") return `${value > 0 ? "+" : "-"}${fmtMoney(Math.abs(value))}`;
    return `${value > 0 ? "+" : ""}${value.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}`;
  }
  function taskCreateSummary(data = {}) {
    const inserted = Number(data.inserted ?? data.total ?? 0);
    const skipped = Number(data.skipped ?? 0);
    const withHistory = Number(data.with_history ?? 0);
    const parts = [`${fmtInt(inserted)} MLB${inserted === 1 ? "" : "s"} inserido${inserted === 1 ? "" : "s"}`];
    if (skipped) parts.push(`${fmtInt(skipped)} ignorado${skipped === 1 ? "" : "s"} porque ja esta${skipped === 1 ? "" : "o"} em tarefa aberta`);
    if (withHistory) parts.push(`${fmtInt(withHistory)} com historico anterior cadastrado${withHistory === 1 ? "" : "s"} em nova tarefa`);
    const skippedLines = (data.skipped_items || []).map((item) => `${item.mlb} ja esta ${statusLabels[item.status] || item.status || "aberto"}${item.task_batch_name ? ` no lote "${item.task_batch_name}"` : ""}${item.task_id ? ` (tarefa #${item.task_id})` : ""}.`);
    const historyLines = (data.history_items || []).map((item) => `${item.mlb} tinha ${fmtInt(item.previous_tasks || 0)} tarefa${Number(item.previous_tasks || 0) === 1 ? "" : "s"} anterior${Number(item.previous_tasks || 0) === 1 ? "" : "es"} e ${fmtInt(item.previous_rounds || 0)} monitoramento${Number(item.previous_rounds || 0) === 1 ? "" : "s"}.`);
    const sync = data.integration_sync || {};
    const syncLines = (sync.results || []).map((item) => item.error
      ? `${item.provider || "Integracao"}: falha ao enviar (${item.error}).`
      : `${item.provider || "Integracao"}: ${fmtInt(item.sent || 0)} tarefa${Number(item.sent || 0) === 1 ? "" : "s"} enviada${Number(item.sent || 0) === 1 ? "" : "s"}.`);
    return { text: `${parts.join(". ")}.`, details: [...skippedLines, ...historyLines, ...syncLines].join("\n") };
  }

  function resetTaskCreateForm() {
    $("taskQuery").value = "";
    $("taskBatchName").value = "";
    $("taskPriority").value = "medium";
    $("taskDueDate").value = "";
    $("taskAnalysisStartDate").value = "";
    $("taskNotes").value = "";
    state.taskTags = [];
    state.taskTagColors = {};
    renderCreateTags();
    document.querySelectorAll("#taskFlags input[type='checkbox']").forEach((input) => { input.checked = false; });
    document.querySelectorAll("#taskRequiredSectors input[type='checkbox']").forEach((input) => {
      input.checked = String(input.value) === "cadastro";
    });
  }

  function watchlistStatusLabel(item = {}) {
    if (item.open_task_id) return "Tarefa aberta";
    if (!anyChecked(item.action_flags || {})) return "Sem acao registrada";
    return labelMap[item.status] || statusLabels[item.status] || {
      tracking: "Em acompanhamento",
      no_action: "Sem acao",
      action_registered: "Acao registrada",
      task_open: "Tarefa aberta",
      analysis: "Em analise",
      improved: "Melhorou",
      worse: "Caiu",
      inconclusive: "Inconclusivo",
    }[item.status] || item.status || "Em acompanhamento";
  }

  function listingStatusMeta(status) {
    const normalized = String(status || "").trim().toLowerCase();
    if (normalized === "active") return { label: "Ativo", className: "strategy-listing-state--active" };
    if (normalized === "paused") return { label: "Pausado", className: "strategy-listing-state--paused" };
    if (normalized) return { label: "Inativo", className: "strategy-listing-state--inactive" };
    return { label: "Nao informado", className: "strategy-listing-state--unknown" };
  }
  function watchlistListingBadgesHtml(badges = {}) {
    const list = [
      badges.full ? ["Full", "strategy-listing-badge--blue"] : null,
      badges.free_shipping ? ["Frete gratis", "strategy-listing-badge--green"] : null,
      badges.catalog ? ["Catalogo", "strategy-listing-badge--purple"] : null,
      badges.promo ? ["Promocao", "strategy-listing-badge--yellow"] : null,
      badges.ads ? ["Ads", "strategy-listing-badge--gray"] : null,
    ].filter(Boolean);
    if (!list.length) return "";
    return `<div class="strategy-listing-badges">${list.map(([label, cls]) => `<span class="strategy-listing-badge ${cls}">${escapeHtml(label)}</span>`).join("")}</div>`;
  }

  function watchlistActionChips(flags = {}, latestEvent = null) {
    return listingProgressKeys.map((item) => {
      const done = !!flags?.[item.flag];
      const tip = done
        ? `${item.label} registrado${latestEvent?.created_at ? `\nUltima acao: ${formatDateTime(latestEvent.created_at)}` : ""}${latestEvent?.notes ? `\n${latestEvent.notes}` : ""}`
        : `${item.label} sem registro na Watchlist`;
      return `<span class="strategy-progress-chip ${done ? "done" : "neutral"}" data-tooltip="${escapeHtml(tip)}"><b>${escapeHtml(item.icon)}</b>${escapeHtml(item.label)}</span>`;
    }).join("");
  }

  function renderWatchlistAccess(message = "") {
    const notice = $("watchlistAccessNotice");
    const content = $("watchlistContent");
    if (!notice || !content) return;
    if (canViewWatchlist()) {
      notice.hidden = true;
      notice.innerHTML = "";
      content.hidden = false;
      $("btnAddWatchlist")?.toggleAttribute("hidden", !canEditWatchlist());
      return;
    }
    content.hidden = true;
    notice.hidden = false;
    notice.innerHTML = `<strong>Watchlist em modo restrito</strong><span>${escapeHtml(message || "Voce nao tem permissao para visualizar a Watchlist. Solicite acesso ao administrador da conta.")}</span>`;
  }

  function renderWatchlistKpis(summary = {}) {
    const cards = [
      ["Na Watchlist", summary.total || 0, "itens acompanhados", ""],
      ["Sem acao", summary.no_action || 0, "ainda sem registro", "strategy-kpi--warning"],
      ["Com acao", summary.with_action || 0, "ja alterados", "strategy-kpi--success"],
      ["Tarefa aberta", summary.task_open || 0, "em execucao", ""],
      ["Em analise", summary.analysis || 0, "aguardando resultado", ""],
    ];
    $("watchlistKpis").innerHTML = cards.map(([label, value, sub, className]) => `<article class="strategy-kpi ${className}"><span>${escapeHtml(label)}</span><strong>${fmtInt(value)}</strong><small>${escapeHtml(sub)}</small></article>`).join("");
  }

  function watchlistStockCell(item = {}) {
    if (item.stock == null || item.stock === "") {
      return `<td><div class="strategy-stock-cell"><strong>--</strong><div class="strategy-table-sub">sem leitura</div></div></td>`;
    }
    const stock = Number(item.stock);
    if (!Number.isFinite(stock)) {
      return `<td><div class="strategy-stock-cell"><strong>--</strong><div class="strategy-table-sub">sem leitura</div></div></td>`;
    }
    const className = stock <= 0 ? "strategy-stock-cell--danger" : stock <= 5 ? "strategy-stock-cell--warning" : "";
    return `<td><div class="strategy-stock-cell ${className}"><strong>${fmtInt(stock)}</strong><div class="strategy-table-sub">un. disponiveis</div></div></td>`;
  }

  function strategicFamilyKey(item = {}, namespace = "strategy") {
    const sku = String(item.sku || "").trim().toUpperCase();
    if (sku) {
      const base = sku.split(/[-_/]/)[0]?.trim();
      if (base && base.length >= 4) return { key: `${namespace}:family:sku:${base}`, label: `Familia SKU ${base}` };
    }
    const title = String(item.title || item.mlb || "").trim().toUpperCase();
    const words = title
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .map((part) => part.trim())
      .filter((part) => part && part.length > 2 && !["COM", "PARA", "DAS", "DOS", "SEM"].includes(part));
    const stem = words.slice(0, 4).join(" ").trim() || title || item.mlb;
    return { key: `${namespace}:family:title:${stem}`, label: stem };
  }

  function strategicGroupMeta(item = {}, mode = "none", namespace = "strategy") {
    if (mode === "family") return strategicFamilyKey(item, namespace);
    const fallback = String(item.id || item.source_task_id || item.mlb || item.sku || item.title || "outros").trim() || "outros";
    return { key: `${namespace}:item:${fallback}`, label: "" };
  }

  function watchlistRowHtml(item = {}) {
    const impact = String(item.round_impact || "").trim().toLowerCase();
    const impactLabel = impact ? (labelMap[impact] || impact) : "Sem comparacao";
    const selected = state.watchlistSelectedIds.has(String(item.id));
    const tags = Array.isArray(item.watchlist_tags) ? item.watchlist_tags : [];
    const showingRemoved = ($("watchlistStatusFilter")?.value || "active") === "removed";
    const isRemoved = String(item.status || "").trim().toLowerCase() === "removed";
    const removedActions = `
          <button class="strategy-mini-btn strategy-mini-btn--success" ${canEditWatchlist() ? `data-watchlist-restore="${escapeHtml(item.id)}"` : `data-watchlist-denied="${escapeHtml(permissionMessage("restaurar itens da Watchlist"))}"`} type="button">Restaurar</button>
          <button class="strategy-mini-btn strategy-mini-btn--warning" data-history="${escapeHtml(item.mlb)}" type="button">Ver historico</button>`;
    const activeActions = `
          <button class="strategy-mini-btn strategy-mini-btn--warning" data-watchlist-detail="${escapeHtml(item.id)}" type="button">Detalhar</button>
          <button class="strategy-mini-btn" ${canEditWatchlist() ? `data-watchlist-action="${escapeHtml(item.id)}"` : `data-watchlist-denied="${escapeHtml(permissionMessage("editar a Watchlist"))}"`} type="button">Registrar acao</button>
          <button class="strategy-mini-btn" ${canEditWatchlist() && canCreateTasks() ? `data-watchlist-task="${escapeHtml(item.id)}"` : `data-watchlist-denied="${escapeHtml(permissionMessage("criar tarefa pela Watchlist"))}"`} type="button">Criar tarefa</button>
          <button class="strategy-icon-action" data-history="${escapeHtml(item.mlb)}" type="button" data-tooltip="Ver historico" aria-label="Ver historico"><span class="strategy-icon-action__icon" aria-hidden="true">↺</span></button>
          ${canEditWatchlist() ? `<button class="strategy-icon-action" data-watchlist-remove="${escapeHtml(item.id)}" type="button" data-tooltip="Remover da Watchlist" aria-label="Remover da Watchlist"><span class="strategy-icon-action__icon" aria-hidden="true">x</span></button>` : ""}`;
    return `<tr>
      <td>
        <div class="strategy-product">
          <label class="strategy-row-check" aria-label="Selecionar anuncio"><input type="checkbox" data-watchlist-select="${escapeHtml(item.id)}" ${selected ? "checked" : ""} /></label>
          <div class="strategy-thumb"><img src="${escapeHtml(item.thumbnail || "/ml/img/placeholder.png")}" alt="" /></div>
          <div class="strategy-product__info">
            ${mlbLinkHtml(item.mlb)}
            <div class="strategy-product__title" title="${escapeHtml(item.title || item.mlb)}">${escapeHtml(item.title || item.mlb)}</div>
            <div class="strategy-product__meta">SKU ${escapeHtml(item.sku || "sem SKU")}</div>
            <div class="strategy-listing-state ${escapeHtml(listingStatusMeta(item.listing_status).className)}"><i aria-hidden="true"></i>${escapeHtml(listingStatusMeta(item.listing_status).label)}</div>
            ${watchlistListingBadgesHtml(item.listing_badges || {})}
            ${tags.length ? `<div class="strategy-tag-list strategy-tag-list--watchlist">${tags.map((tag) => taskTagChip(tag, item.watchlist_tag_colors?.[tag])).join("")}</div>` : ""}
          </div>
        </div>
      </td>
      ${watchlistStockCell(item)}
      <td><strong>${escapeHtml(item.reason || "Acompanhamento estrategico")}</strong>${item.notes ? `<div class="strategy-table-sub">${escapeHtml(item.notes)}</div>` : ""}</td>
      <td><div class="strategy-progress-row strategy-progress-row--flat"><div>${watchlistActionChips(item.action_flags || {}, item.latest_event)}</div></div></td>
      <td>${item.latest_event ? `<strong>${escapeHtml(formatDateTime(item.latest_event.created_at))}</strong><div class="strategy-table-sub">${escapeHtml(item.latest_event.notes || item.latest_event.hypothesis || item.latest_event.type || "")}</div>` : `<span class="strategy-muted">Sem acao registrada</span>`}</td>
      <td>${item.open_task_id ? `<strong>Tarefa #${escapeHtml(item.open_task_id)}</strong><div class="strategy-table-sub">${escapeHtml(statusLabels[item.open_task_status] || item.open_task_status || "")}${item.open_task_batch_name ? ` · ${escapeHtml(item.open_task_batch_name)}` : ""}</div>` : `<span class="strategy-muted">Sem tarefa</span>`}</td>
      <td><span class="strategy-impact strategy-impact--${escapeHtml(impact || "pending")}">${escapeHtml(impactLabel)}</span></td>
      <td>
        <div class="strategy-task-actions">
          ${showingRemoved || isRemoved ? removedActions : activeActions}
        </div>
      </td>
    </tr>`;
  }

  function renderWatchlist(items = []) {
    state.watchlist = items;
    pruneWatchlistSelection();
    renderWatchlistAccess();
    const tbody = $("watchlistBody");
    const tableWrap = $("watchlistTableWrap");
    const empty = $("watchlistEmpty");
    if (!canViewWatchlist()) return;
    let filteredItems = Array.isArray(items) ? items.slice() : [];
    const impactFilter = String($("watchlistImpactFilter")?.value || "").trim().toLowerCase();
    if (impactFilter) {
      filteredItems = filteredItems.filter((item) => String(item?.round_impact || "").trim().toLowerCase() === impactFilter);
    }
    const updateWatchlistListSummary = (count, groups = null, stock = null) => {
      const summary = $("watchlistListSummary");
      if (!summary) return;
      if (!count) {
        summary.textContent = "Nenhum anuncio encontrado neste filtro.";
        return;
      }
      const parts = [];
      if (groups != null) parts.push(`${fmtInt(groups)} familia${groups === 1 ? "" : "s"}`);
      parts.push(`${fmtInt(count)} anuncio${count === 1 ? "" : "s"}`);
      if (stock != null) parts.push(`${fmtInt(stock)} un. em estoque`);
      summary.textContent = parts.join(" · ");
    };
    if (!filteredItems.length) {
      if (tableWrap) tableWrap.hidden = true;
      if (empty) empty.hidden = false;
      updateWatchlistListSummary(0);
      renderWatchlistBulkBar();
      renderWatchlistPager();
      return;
    }
    if (tableWrap) tableWrap.hidden = false;
    if (empty) empty.hidden = true;
    const groupMode = $("watchlistGroupMode")?.value || "family";
    state.watchlistGroupMode = groupMode;
    state.watchlistVisibleGroups = new Map();
    if (groupMode === "none") {
      tbody.innerHTML = filteredItems.map((item) => watchlistRowHtml(item)).join("");
      const totalStock = filteredItems.reduce((sum, item) => {
        const stock = Number(item.stock || 0);
        return sum + (Number.isFinite(stock) ? stock : 0);
      }, 0);
      updateWatchlistListSummary(filteredItems.length, null, totalStock);
      renderWatchlistBulkBar();
      renderWatchlistPager();
      return;
    }
    const groups = new Map();
    filteredItems.forEach((item) => {
      const meta = strategicGroupMeta(item, groupMode, "watchlist");
      const key = meta.key || "outros";
      if (!groups.has(key)) groups.set(key, { key, label: meta.label || "Outros", items: [], stock: 0 });
      const group = groups.get(key);
      group.items.push(item);
      const stock = Number(item.stock || 0);
      if (Number.isFinite(stock)) group.stock += stock;
    });
    const ordered = Array.from(groups.values()).sort((a, b) => (b.items.length - a.items.length) || a.label.localeCompare(b.label, "pt-BR"));
    const totalStock = ordered.reduce((sum, group) => sum + Number(group.stock || 0), 0);
    updateWatchlistListSummary(filteredItems.length, ordered.length, totalStock);
    tbody.innerHTML = ordered.map((group) => {
      state.watchlistVisibleGroups.set(group.key, group.items.map((item) => String(item.id)));
      const expanded = state.strategyGroupExpanded[group.key] !== false;
      const rowCount = `${fmtInt(group.items.length)} anuncio${group.items.length === 1 ? "" : "s"}`;
      const stockText = group.stock > 0 ? `${fmtInt(group.stock)} un.` : "sem estoque lido";
      const selectedCount = group.items.filter((item) => state.watchlistSelectedIds.has(String(item.id))).length;
      const allSelected = selectedCount > 0 && selectedCount === group.items.length;
      const partialAttr = selectedCount > 0 && !allSelected ? `data-indeterminate="true"` : "";
      const head = `<tr class="strategy-group-row">
        <td colspan="8">
          <div class="strategy-group-toggle strategy-group-toggle--selectable">
            <label class="strategy-row-check strategy-row-check--group" aria-label="Selecionar familia inteira">
              <input type="checkbox" data-watchlist-group-select="${escapeHtml(group.key)}" ${allSelected ? "checked" : ""} ${partialAttr} />
            </label>
            <button class="strategy-group-collapse" type="button" data-watchlist-group-toggle="${escapeHtml(group.key)}" aria-expanded="${expanded ? "true" : "false"}">
              <span class="strategy-group-toggle__arrow">${expanded ? "▾" : "▸"}</span>
              <strong>${escapeHtml(group.label)}</strong>
              <span class="strategy-group-count">${rowCount}</span>
              <span class="strategy-group-stock">Estoque ${stockText}</span>
            </button>
          </div>
        </td>
      </tr>`;
      if (!expanded) return head;
      return `${head}${group.items.map((item) => watchlistRowHtml(item)).join("")}`;
    }).join("");
    syncIndeterminateWatchlistChecks();
    renderWatchlistBulkBar();
    renderWatchlistPager();
  }

  function renderWatchlistPager() {
    renderGenericPager({
      el: $("watchlistPager"),
      total: state.watchlistTotal,
      page: state.watchlistPage,
      limit: state.watchlistLimit,
      pages: state.watchlistPages,
    });
  }

  function visibleWatchlistIds() {
    return new Set((state.watchlist || []).map((item) => String(item.id)));
  }

  function selectedWatchlistItems() {
    const selected = state.watchlistSelectedIds || new Set();
    return (state.watchlist || []).filter((item) => selected.has(String(item.id)));
  }

  function pruneWatchlistSelection() {
    const visible = visibleWatchlistIds();
    state.watchlistSelectedIds = new Set(Array.from(state.watchlistSelectedIds || []).filter((id) => visible.has(String(id))));
  }

  function renderWatchlistBulkBar() {
    const bar = $("watchlistBulkBar");
    if (!bar) return;
    const count = state.watchlistSelectedIds?.size || 0;
    setText("watchlistSelectedCount", fmtInt(count));
    bar.hidden = !count;
    const disabled = !count || !canEditWatchlist();
    ["btnWatchlistBulkAction", "btnWatchlistBulkTag", "btnWatchlistBulkRemove"].forEach((id) => {
      const button = $(id);
      if (button) button.disabled = disabled;
    });
    if ($("btnWatchlistBulkTask")) $("btnWatchlistBulkTask").disabled = !count || !canCreateTasks();
  }

  function syncIndeterminateWatchlistChecks() {
    document.querySelectorAll("input[data-indeterminate]").forEach((input) => {
      input.indeterminate = true;
    });
  }

  function clearWatchlistSelection({ rerender = true } = {}) {
    state.watchlistSelectedIds = new Set();
    if (rerender) renderWatchlist(state.watchlist || []);
    else renderWatchlistBulkBar();
  }

  function toggleWatchlistItemSelection(id, checked) {
    const key = String(id || "");
    if (!key) return;
    if (checked) state.watchlistSelectedIds.add(key);
    else state.watchlistSelectedIds.delete(key);
    renderWatchlist(state.watchlist || []);
  }

  function toggleWatchlistGroupSelection(groupKey, checked) {
    const ids = state.watchlistVisibleGroups.get(String(groupKey || "")) || [];
    ids.forEach((id) => {
      if (checked) state.watchlistSelectedIds.add(String(id));
      else state.watchlistSelectedIds.delete(String(id));
    });
    renderWatchlist(state.watchlist || []);
  }

  function selectedWatchlistIds() {
    return Array.from(state.watchlistSelectedIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0);
  }

  async function refreshWatchlistListingStatus(button) {
    try {
      setBusy(button, true);
      const payload = {
        status: $("watchlistStatusFilter")?.value || "active",
        listing_status: $("watchlistListingStatusFilter")?.value || "all",
        impact: $("watchlistImpactFilter")?.value || "",
        q: $("watchlistSearch")?.value || "",
        refresh_listing: true,
        compare_rounds: false,
      };
      const result = await api("/api/estrategicos/watchlist/refresh-listing-status", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      await loadWatchlist();
      showNotice(`${fmtInt(result.updated || 0)} anuncio(s) atualizado(s) com status e badges. ${fmtInt(result.not_found || 0)} sem retorno da API nesta consulta.`, {
        kind: "success",
        title: "Anuncios atualizados",
      });
    } catch (error) {
      showNotice(error.message, { kind: "warning", title: "Falha ao atualizar lista" });
    } finally {
      setBusy(button, false);
    }
  }

  async function compareWatchlistImpact(button) {
    try {
      setBusy(button, true);
      const payload = {
        status: $("watchlistStatusFilter")?.value || "active",
        listing_status: $("watchlistListingStatusFilter")?.value || "all",
        impact: $("watchlistImpactFilter")?.value || "",
        q: $("watchlistSearch")?.value || "",
        refresh_listing: false,
        compare_rounds: true,
      };
      const result = await api("/api/estrategicos/watchlist/refresh-listing-status", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      await Promise.all([loadWatchlist(), loadDashboard()]);
      showNotice(`${fmtInt(result.compared || 0)} item(ns) comparado(s) para atualizar impacto.${Number(result.compare_failed || 0) ? ` ${fmtInt(result.compare_failed || 0)} falharam.` : ""}`, {
        kind: Number(result.compare_failed || 0) ? "warning" : "success",
        title: "Comparacao concluida",
      });
    } catch (error) {
      showNotice(error.message, { kind: "warning", title: "Falha ao comparar watchlist" });
    } finally {
      setBusy(button, false);
    }
  }

  async function refreshTaskListingStatus(button) {
    try {
      setBusy(button, true);
      const payload = {
        status: $("taskStatusFilter")?.value || "open",
        scope: $("taskScopeFilter")?.value || "all",
        priority: $("taskPriorityFilter")?.value || "",
        sector: $("taskSectorFilter")?.value || "",
        tag: $("taskTagFilter")?.value || "",
        batch_name: $("taskBatchNameFilter")?.value || "",
        q: $("taskSearch")?.value || "",
        created_from: $("taskCreatedFrom")?.value || "",
        created_to: $("taskCreatedTo")?.value || "",
        analysis_from: $("taskAnalysisFrom")?.value || "",
        analysis_to: $("taskAnalysisTo")?.value || "",
        due_from: $("taskDueFrom")?.value || "",
        due_to: $("taskDueTo")?.value || "",
      };
      if (state.selectedTaskBatchId) payload.batch_id = state.selectedTaskBatchId;
      const result = await api("/api/estrategicos/tasks/refresh-listing-status", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      await reloadTaskWorkspace({ keepSelection: true });
      showNotice(`${fmtInt(result.updated || 0)} anuncio(s) atualizado(s). ${fmtInt(result.not_found || 0)} sem retorno da API nesta consulta.`, {
        kind: "success",
        title: "Status dos MLBs atualizado",
      });
    } catch (error) {
      showNotice(error.message, { kind: "warning", title: "Falha ao atualizar status" });
    } finally {
      setBusy(button, false);
    }
  }

  function resetTrelloImportModal() {
    state.trelloLists = [];
    state.trelloCards = [];
    if ($("trelloListsWrap")) $("trelloListsWrap").innerHTML = `<span class="strategy-status">Selecione um board para carregar as listas.</span>`;
    if ($("trelloCardsBody")) $("trelloCardsBody").innerHTML = `<tr><td colspan="4">Carregue listas para visualizar os cards.</td></tr>`;
    if ($("trelloImportResult")) {
      $("trelloImportResult").hidden = true;
      $("trelloImportResult").textContent = "";
    }
  }

  function trelloTokenStatus(token) {
    const normalized = normalizeTaskToken(token);
    return state.trelloImportTarget === "batch_items" && normalized && state.trelloBatchExistingTokens.has(normalized)
      ? "existing"
      : "new";
  }

  function renderTrelloToken(token) {
    const status = trelloTokenStatus(token);
    const className = status === "existing" ? "strategy-trello-token strategy-trello-token--existing" : "strategy-trello-token";
    const tooltip = status === "existing" ? "Ja esta neste lote e nao sera adicionado novamente." : "Novo para este lote.";
    return `<span class="${className}" data-tooltip="${escapeHtml(tooltip)}">${escapeHtml(token)}</span>`;
  }

  async function openTrelloImportModal(target = "create") {
    if (!canCreateTasks()) {
      showNotice(permissionMessage("importar tarefas do Trello"), { kind: "warning", title: "Importacao bloqueada" });
      return;
    }
    if (!activeTrelloIntegration()) {
      showNotice("Configure e ative o conector Trello em Conta > Integracoes. Depois disso, voce consegue importar boards, listas e cards aqui no Estrategicos.", { kind: "warning", title: "Trello nao configurado" });
      return;
    }
    resetTrelloImportModal();
    state.trelloImportTarget = target === "batch_items" ? "batch_items" : "create";
    setText("trelloImportTitle", state.trelloImportTarget === "batch_items" ? "Importar novos MLBs do Trello" : "Importar cards do Trello");
    const title = $("trelloImportTitle");
    const subtitle = title?.closest(".strategy-modal__head")?.querySelector("p");
    if (subtitle) {
      subtitle.textContent = state.trelloImportTarget === "batch_items"
        ? "Selecione o card/lista que recebeu novos MLBs ou SKUs para adicionar ao lote aberto sem substituir os itens atuais."
        : "Selecione um board, escolha as listas e adicione os MLBs/SKUs encontrados para montar o lote.";
    }
    setText("btnApplyTrelloImport", state.trelloImportTarget === "batch_items" ? "Usar no lote aberto" : "Adicionar ao lote");
    $("trelloImportModal").hidden = false;
    await loadTrelloBoards();
  }

  function closeTrelloImportModal() {
    $("trelloImportModal").hidden = true;
  }

  async function loadTrelloBoards() {
    const select = $("trelloBoardSelect");
    const btn = $("btnOpenTrelloImport");
    try {
      setBusy(btn, true);
      if (select) select.innerHTML = `<option value="">Carregando boards...</option>`;
      const data = await api("/api/estrategicos/trello/boards");
      state.trelloBoards = data.boards || [];
      if (select) {
        select.innerHTML = [`<option value="">Selecione um board</option>`]
          .concat(state.trelloBoards.map((board) => `<option value="${escapeHtml(board.id)}">${escapeHtml(board.name)}</option>`))
          .join("");
      }
      if (!state.trelloBoards.length) {
        $("trelloImportResult").hidden = false;
        $("trelloImportResult").textContent = "Nenhum board aberto encontrado para esta conta Trello.";
      }
    } catch (error) {
      if (select) select.innerHTML = `<option value="">Falha ao carregar boards</option>`;
      showNotice(error.message, { kind: "warning", title: "Falha no Trello" });
    } finally {
      setBusy(btn, false);
    }
  }

  function renderTrelloLists(lists = []) {
    const wrap = $("trelloListsWrap");
    if (!wrap) return;
    if (!lists.length) {
      wrap.innerHTML = `<span class="strategy-status is-warning">Nenhuma lista aberta encontrada neste board.</span>`;
      return;
    }
    wrap.innerHTML = lists.map((list) => `
      <label>
        <input type="checkbox" value="${escapeHtml(list.id)}" checked />
        <span class="strategy-chip-icon" aria-hidden="true">▤</span>
        ${escapeHtml(list.name)}
      </label>`).join("");
  }

  async function loadTrelloLists() {
    const boardId = $("trelloBoardSelect")?.value || "";
    const btn = $("btnLoadTrelloLists");
    try {
      if (!boardId) throw new Error("Selecione um board do Trello.");
      setBusy(btn, true);
      $("trelloListsWrap").innerHTML = `<span class="strategy-status">Carregando listas...</span>`;
      $("trelloCardsBody").innerHTML = `<tr><td colspan="4">Carregue os cards depois de escolher as listas.</td></tr>`;
      const data = await api(`/api/estrategicos/trello/boards/${encodeURIComponent(boardId)}/lists`);
      state.trelloLists = data.lists || [];
      state.trelloCards = [];
      renderTrelloLists(state.trelloLists);
    } catch (error) {
      $("trelloListsWrap").innerHTML = `<span class="strategy-status is-error">${escapeHtml(error.message)}</span>`;
    } finally {
      setBusy(btn, false);
    }
  }

  function selectedTrelloListIds() {
    return Array.from(document.querySelectorAll("#trelloListsWrap input[type='checkbox']:checked")).map((input) => input.value).filter(Boolean);
  }

  function setAllTrelloLists(checked) {
    document.querySelectorAll("#trelloListsWrap input[type='checkbox']").forEach((input) => {
      input.checked = checked;
    });
  }

  function renderTrelloCards(cards = []) {
    const tbody = $("trelloCardsBody");
    if (!tbody) return;
    if (!cards.length) {
      tbody.innerHTML = `<tr><td colspan="4">Nenhum card encontrado nas listas selecionadas.</td></tr>`;
      return;
    }
    tbody.innerHTML = cards.map((card, index) => {
      const tokens = card.tokens || [];
      const hasNewTokens = tokens.some((token) => trelloTokenStatus(token) === "new");
      const selectable = card.matched && (state.trelloImportTarget !== "batch_items" || hasNewTokens);
      return `
        <tr class="${selectable ? "" : "strategy-trello-row--muted"}">
          <td><input type="checkbox" data-trello-card="${index}" ${selectable ? "checked" : "disabled"} /></td>
          <td>${escapeHtml(card.list_name || "-")}</td>
          <td>
            <strong>${escapeHtml(card.name)}</strong>
            ${card.url ? `<small><a href="${escapeHtml(card.url)}" target="_blank" rel="noopener noreferrer">Abrir no Trello</a></small>` : ""}
          </td>
          <td>
            ${tokens.length ? tokens.map(renderTrelloToken).join("") : `<span class="strategy-muted">Nenhum MLB/SKU identificado</span>`}
          </td>
        </tr>`;
    }).join("");
  }

  async function loadTrelloCards() {
    const boardId = $("trelloBoardSelect")?.value || "";
    const listIds = selectedTrelloListIds();
    const btn = $("btnLoadTrelloCards");
    try {
      if (!boardId) throw new Error("Selecione um board do Trello.");
      if (!listIds.length) throw new Error("Selecione ao menos uma lista.");
      setBusy(btn, true);
      $("trelloCardsBody").innerHTML = `<tr><td colspan="4">Consultando cards no Trello...</td></tr>`;
      const data = await api("/api/estrategicos/trello/cards-preview", {
        method: "POST",
        body: JSON.stringify({ board_id: boardId, list_ids: listIds, filter: $("trelloCardFilter")?.value || "open" }),
      });
      state.trelloCards = data.cards || [];
      renderTrelloCards(state.trelloCards);
      $("trelloImportResult").hidden = false;
      $("trelloImportResult").textContent = `${fmtInt(data.total || 0)} card(s) lidos. ${fmtInt(data.matched || 0)} card(s) com MLB/SKU identificado.`;
    } catch (error) {
      $("trelloCardsBody").innerHTML = `<tr><td colspan="4">${escapeHtml(error.message)}</td></tr>`;
    } finally {
      setBusy(btn, false);
    }
  }

  function setAllTrelloCards(checked) {
    document.querySelectorAll("#trelloCardsBody input[data-trello-card]:not(:disabled)").forEach((input) => {
      input.checked = checked;
    });
  }

  function applyTrelloImport(event) {
    event?.preventDefault();
    try {
      const selected = Array.from(document.querySelectorAll("#trelloCardsBody input[data-trello-card]:checked"))
        .map((input) => state.trelloCards[Number(input.dataset.trelloCard)])
        .filter(Boolean);
      const tokens = uniq(selected.flatMap((card) => card.tokens || []));
      if (!tokens.length) {
        showNotice("Selecione ao menos um card com MLB ou SKU identificado.", { kind: "warning", title: "Nada para importar" });
        return;
      }
      if (state.trelloImportTarget === "batch_items") {
        const batchQuery = $("batchItemsQuery");
        const batchStatus = $("batchItemsName");
        if (!batchQuery || !$("batchItemsModal") || $("batchItemsModal").hidden) {
          throw new Error("Nao encontrei o lote aberto para receber os MLBs importados.");
        }
        const current = parseTaskTokens(batchQuery.value || "");
        const currentSet = new Set(current.map(normalizeTaskToken));
        const existingSet = state.trelloBatchExistingTokens || new Set();
        const newTokens = tokens.filter((token) => {
          const key = normalizeTaskToken(token);
          return key && !existingSet.has(key) && !currentSet.has(key);
        });
        if (!newTokens.length) {
          showNotice("Os MLBs/SKUs selecionados ja estao neste lote. Nenhum item novo foi adicionado ao campo.", {
            kind: "warning",
            title: "Sem novidades no Trello",
          });
          return;
        }
        const merged = uniq([...current, ...newTokens]);
        batchQuery.value = merged.join("\n");
        closeTrelloImportModal();
        if (batchStatus) {
          batchStatus.insertAdjacentHTML("beforeend", `<div class="strategy-table-sub strategy-table-sub--success">${fmtInt(newTokens.length)} MLB/SKU novo(s) importado(s) do Trello. Confira e clique em Adicionar ao lote.</div>`);
        }
        showNotice(`${fmtInt(newTokens.length)} MLB/SKU novo(s) importado(s) do Trello para o lote aberto. Os itens atuais foram mantidos.`, {
          kind: "success",
          title: "Importacao aplicada",
        });
        batchQuery.scrollIntoView({ block: "center", behavior: "smooth" });
        batchQuery.focus({ preventScroll: true });
        return;
      }
      const queryInput = $("taskQuery");
      const batchInput = $("taskBatchName");
      const notesInput = $("taskNotes");
      const status = $("taskStatus");
      if (!queryInput || !batchInput || !notesInput || !status) throw new Error("Nao encontrei os campos de criacao do lote na tela.");
      const current = parseTaskTokens(queryInput.value || "");
      const merged = uniq([...current, ...tokens]);
      queryInput.value = merged.join("\n");
      if (!batchInput.value) {
        const board = state.trelloBoards.find((item) => item.id === ($("trelloBoardSelect")?.value || ""));
        const firstList = state.trelloLists.find((item) => selectedTrelloListIds().includes(item.id));
        batchInput.value = [firstList?.name, board?.name].filter(Boolean).join(" - ").slice(0, 100);
      }
      const cardNotes = selected
        .filter((card) => card.url)
        .slice(0, 20)
        .map((card) => `${card.name}: ${card.url}`)
        .join("\n");
      if (cardNotes && !notesInput.value) notesInput.value = `Origem Trello:\n${cardNotes}`;
      closeTrelloImportModal();
      status.classList.remove("is-error", "is-warning");
      status.classList.add("is-success");
      status.textContent = `${fmtInt(tokens.length)} MLB/SKU importado(s) do Trello. Confira as tarefas e crie as pendencias.`;
      queryInput.scrollIntoView({ block: "center", behavior: "smooth" });
      queryInput.focus({ preventScroll: true });
    } catch (error) {
      showNotice(error.message || "Nao foi possivel adicionar os cards ao lote.", { kind: "warning", title: "Importacao do Trello" });
      console.error("[estrategicos] Falha ao aplicar importacao do Trello", error);
    }
  }

  function normalizeTagList(tags = []) {
    const list = [];
    const seen = new Set();
    for (const raw of Array.isArray(tags) ? tags : []) {
      const name = normalizeTagName(raw);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(name);
      if (list.length >= 12) break;
    }
    return list;
  }

  function normalizeTagColorMap(colors = {}, tags = []) {
    const source = colors && typeof colors === "object" ? colors : {};
    const allowed = new Set(normalizeTagList(tags).map((tag) => tag.toLowerCase()));
    const map = {};
    Object.entries(source).forEach(([rawName, rawColor]) => {
      const name = normalizeTagName(rawName);
      if (!name) return;
      if (allowed.size && !allowed.has(name.toLowerCase())) return;
      const color = normalizeTagColor(rawColor);
      if (color) map[name] = color;
    });
    return map;
  }

  function collectAvailableTags(extra = []) {
    const tags = []
      .concat(Array.isArray(extra) ? extra : [])
      .concat((state.taskBatches || []).flatMap((batch) => Array.isArray(batch.tags) ? batch.tags : []))
      .concat((state.roundBatches || []).flatMap((batch) => Array.isArray(batch.tags) ? batch.tags : []))
      .concat((state.tasks || []).flatMap((task) => Array.isArray(task.task_tags) ? task.task_tags : []));
    const next = normalizeTagList(tags).sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" }));
    state.availableTaskTags = next;
    return next;
  }

  function renderTagSelect(selectId, current = "", extra = []) {
    const select = $(selectId);
    if (!select) return;
    const tags = collectAvailableTags(extra);
    const placeholder = selectId === "roundTagFilter" ? "Todas as tags" : "Todas as tags";
    select.innerHTML = [`<option value="">${placeholder}</option>`]
      .concat(tags.map((tag) => `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`))
      .join("");
    if (current && tags.some((tag) => tag.toLowerCase() === String(current).toLowerCase())) {
      const match = tags.find((tag) => tag.toLowerCase() === String(current).toLowerCase());
      select.value = match || "";
    }
  }

  function taskTagChip(name, color, removableAttr = "") {
    const chipColor = normalizeTagColor(color) || defaultTagColor;
    return `
      <span class="strategy-tag-chip" style="--tag-color:${escapeHtml(chipColor)}">
        <i aria-hidden="true"></i>
        ${escapeHtml(name)}
        ${removableAttr ? `<button type="button" ${removableAttr} aria-label="Remover tag ${escapeHtml(name)}">x</button>` : ""}
      </span>
    `;
  }

  function renderCreateTags() {
    const wrap = $("taskTagsWrap");
    if (!wrap) return;
    if (!state.taskTags.length) {
      wrap.innerHTML = `<span class="strategy-muted">Sem tags no lote. Opcional.</span>`;
      return;
    }
    wrap.innerHTML = state.taskTags
      .map((tag) => taskTagChip(tag, state.taskTagColors?.[tag], `data-remove-create-tag="${escapeHtml(tag)}"`))
      .join("");
  }

  function renderBatchTags() {
    const wrap = $("batchTagsWrap");
    if (!wrap) return;
    if (!state.batchDraftTags.length) {
      wrap.innerHTML = `<span class="strategy-muted">Sem tags neste lote.</span>`;
      return;
    }
    wrap.innerHTML = state.batchDraftTags
      .map((tag) => taskTagChip(tag, state.batchDraftTagColors?.[tag], `data-remove-batch-tag="${escapeHtml(tag)}"`))
      .join("");
  }

  function addCreateTag() {
    const input = $("taskTagInput");
    const colorInput = $("taskTagColor");
    const name = normalizeTagName(input?.value);
    if (!name) return;
    if (state.taskTags.some((tag) => tag.toLowerCase() === name.toLowerCase())) {
      input.value = "";
      return;
    }
    state.taskTags = normalizeTagList([...state.taskTags, name]);
    const color = normalizeTagColor(colorInput?.value);
    if (color) state.taskTagColors[name] = color;
    input.value = "";
    renderCreateTags();
    renderTagSelect("taskTagFilter", $("taskTagFilter")?.value || "", state.taskTags);
    renderTagSelect("roundTagFilter", $("roundTagFilter")?.value || "", state.taskTags);
  }

  function removeCreateTag(tagName = "") {
    const key = String(tagName || "").toLowerCase();
    state.taskTags = state.taskTags.filter((tag) => tag.toLowerCase() !== key);
    Object.keys(state.taskTagColors || {}).forEach((name) => {
      if (String(name).toLowerCase() === key) delete state.taskTagColors[name];
    });
    renderCreateTags();
  }

  function addBatchTag() {
    const input = $("batchTagInput");
    const colorInput = $("batchTagColor");
    const name = normalizeTagName(input?.value);
    if (!name) return;
    if (state.batchDraftTags.some((tag) => tag.toLowerCase() === name.toLowerCase())) {
      input.value = "";
      return;
    }
    state.batchDraftTags = normalizeTagList([...state.batchDraftTags, name]);
    const color = normalizeTagColor(colorInput?.value);
    if (color) state.batchDraftTagColors[name] = color;
    input.value = "";
    renderBatchTags();
  }

  function removeBatchTag(tagName = "") {
    const key = String(tagName || "").toLowerCase();
    state.batchDraftTags = state.batchDraftTags.filter((tag) => tag.toLowerCase() !== key);
    Object.keys(state.batchDraftTagColors || {}).forEach((name) => {
      if (String(name).toLowerCase() === key) delete state.batchDraftTagColors[name];
    });
    renderBatchTags();
  }

  async function createTasks() {
    const btn = $("btnCreateTasks");
    try {
      const query = $("taskQuery").value;
      if (!String(query || "").trim()) throw new Error("Informe ao menos um MLB ou SKU.");
      setBusy(btn, true);
      $("taskStatus").classList.remove("is-success", "is-warning", "is-error");
      $("taskStatus").textContent = "Criando pendencias...";
      $("taskCreateDetails").hidden = true;
      $("taskCreateDetails").textContent = "";
      const requiredSectorFlags = flagsFrom("taskRequiredSectors");
      const data = await api("/api/estrategicos/tasks", {
        method: "POST",
        body: JSON.stringify({
          query,
          task_batch_name: $("taskBatchName")?.value || "",
          priority: $("taskPriority").value || "medium",
          due_date: $("taskDueDate").value || null,
          analysis_start_date: $("taskAnalysisStartDate").value || null,
          task_tags: state.taskTags,
          task_tag_colors: state.taskTagColors,
          required_sectors: Object.keys(requiredSectorFlags).filter((key) => requiredSectorFlags[key]),
          task_flags: flagsFrom("taskFlags"),
          task_notes: $("taskNotes").value,
        }),
      });
      const summary = taskCreateSummary(data);
      const inserted = Number(data.inserted ?? data.total ?? 0);
      $("taskStatus").classList.add(inserted ? "is-success" : "is-warning");
      $("taskStatus").textContent = inserted ? `Tarefa criada com sucesso. ${summary.text}` : `Nenhuma nova tarefa criada. ${summary.text}`;
      if (summary.details) $("taskStatus").dataset.tooltip = summary.details;
      else delete $("taskStatus").dataset.tooltip;
      $("taskCreateDetails").hidden = !summary.details;
      $("taskCreateDetails").textContent = summary.details;
      if (inserted) resetTaskCreateForm();
      state.taskPage = 1;
      state.selectedTaskBatchId = data.tasks?.[0]?.task_batch_id || state.selectedTaskBatchId || "";
      await reloadTaskWorkspace({ keepSelection: true });
    } catch (error) {
      $("taskStatus").classList.remove("is-success", "is-warning");
      $("taskStatus").classList.add("is-error");
      $("taskStatus").textContent = error.message;
      delete $("taskStatus").dataset.tooltip;
      $("taskCreateDetails").hidden = true;
      $("taskCreateDetails").textContent = "";
    } finally {
      setBusy(btn, false);
    }
  }

  async function reviewRound(id, button) {
    try {
      setBusy(button, true);
      await api(`/api/estrategicos/rounds/${encodeURIComponent(id)}/review`, { method: "POST", body: JSON.stringify({ force: false }) });
      await loadDashboard();
    } catch (error) {
      showNotice(error.message);
    } finally {
      setBusy(button, false);
    }
  }

  function openRoundReviewModal(id) {
    const round = state.rounds.find((item) => String(item.id) === String(id));
    if (!round) return;
    $("roundReviewId").value = round.id;
    $("roundReviewReason").value = round.task_review?.reason || "";
    $("roundReviewProduct").innerHTML = `
      <div class="strategy-product">
        <div class="strategy-thumb"><img src="${escapeHtml(round.thumbnail || "/ml/img/placeholder.png")}" alt="" /></div>
        <div class="strategy-product__info">
          ${mlbLinkHtml(round.mlb)}
          <div class="strategy-product__title">${escapeHtml(round.title || round.mlb)}</div>
          <div class="strategy-product__meta">SKU ${escapeHtml(round.sku || "sem SKU")} · Monitoramento #${escapeHtml(round.id)}</div>
        </div>
      </div>`;
    const activeFlags = round.task_review?.flags || {};
    $("roundReviewFlags").innerHTML = listingProgressKeys.map((item) => `
      <label class="${activeFlags[item.flag] ? "is-pending" : ""}">
        <input type="checkbox" value="${escapeHtml(item.flag)}" ${activeFlags[item.flag] ? "checked" : ""} />
        <span class="strategy-chip-icon" aria-hidden="true">${escapeHtml(item.icon)}</span> ${escapeHtml(item.label)}
      </label>`).join("");
    $("roundReviewModal").hidden = false;
  }

  function closeRoundReviewModal() {
    $("roundReviewModal").hidden = true;
  }

  async function confirmRoundReview() {
    const btn = $("btnConfirmRoundReview");
    const id = $("roundReviewId").value;
    const reason = $("roundReviewReason").value;
    const reopenFlags = flagsFrom("roundReviewFlags");
    if (!String(reason || "").trim()) {
      showNotice("Informe o motivo da revisao para orientar a equipe.", { kind: "warning" });
      return;
    }
    if (!anyChecked(reopenFlags)) {
      showNotice("Selecione ao menos uma alteracao que precisa voltar para revisao.", { kind: "warning" });
      return;
    }
    try {
      setBusy(btn, true);
      await api(`/api/estrategicos/rounds/${encodeURIComponent(id)}/return-task`, {
        method: "POST",
        body: JSON.stringify({ reason, reopen_flags: reopenFlags }),
      });
      closeRoundReviewModal();
      state.selectedTaskBatchId = "";
      await Promise.all([reloadTaskWorkspace({ keepSelection: false }), loadDashboard()]);
      switchTab("tasks");
      showNotice("Revisao aberta. O monitoramento continua ativo e o item voltou para tarefas com os icones selecionados pendentes.", { kind: "success", title: "Item enviado para revisao" });
    } catch (error) {
      showNotice(error.message);
    } finally {
      setBusy(btn, false);
    }
  }

  function openWatchlistAddModal(prefill = "") {
    if (!canEditWatchlist()) {
      showNotice("Seu setor nao possui permissao para editar a Watchlist.", { kind: "warning" });
      return;
    }
    $("watchlistAddQuery").value = prefill || "";
    $("watchlistAddReason").value = "Produto estrategico";
    $("watchlistAddNotes").value = "";
    $("watchlistAddModal").hidden = false;
  }

  function closeWatchlistAddModal() {
    $("watchlistAddModal").hidden = true;
  }

  async function confirmWatchlistAdd() {
    const btn = $("btnConfirmWatchlistAdd");
    try {
      const query = $("watchlistAddQuery").value;
      const tokens = parseTaskTokens(query);
      if (!tokens.length) throw new Error("Informe ao menos um MLB ou SKU.");
      if (tokens.length > 100) throw new Error("Informe no maximo 100 MLBs/SKUs por vez para manter a consulta leve.");
      setBusy(btn, true);
      const result = await api("/api/estrategicos/watchlist", {
        method: "POST",
        body: JSON.stringify({
          query,
          reason: $("watchlistAddReason").value,
          notes: $("watchlistAddNotes").value,
        }),
      });
      const total = Number(result.total || result.items?.length || (result.item ? 1 : 0));
      const failed = Number(result.failed || result.failures?.length || 0);
      const added = Math.max(0, total - failed);
      if (added > 0) {
        closeWatchlistAddModal();
        state.watchlistPage = 1;
        await loadWatchlist();
      }
      const firstFailure = result.failures?.[0]?.message ? ` Primeiro erro: ${result.failures[0].message}` : "";
      const failureText = failed ? ` ${fmtInt(failed)} item(ns) nao foram adicionados.${firstFailure}` : "";
      showNotice(`${fmtInt(added)} item(ns) adicionados/atualizados na Watchlist.${failureText}`, { kind: failed ? "warning" : "success", title: "Watchlist atualizada" });
    } catch (error) {
      showNotice(error.message);
    } finally {
      setBusy(btn, false);
    }
  }

  function selectedWatchlistItem(id) {
    return state.watchlist.find((item) => String(item.id) === String(id));
  }

  function renderWatchlistFlagChecks(containerId, checked = {}) {
    $(containerId).innerHTML = listingProgressKeys.map((item) => `
      <label class="${checked?.[item.flag] ? "is-done" : ""}">
        <input type="checkbox" value="${escapeHtml(item.flag)}" ${checked?.[item.flag] ? "checked" : ""} />
        <span class="strategy-chip-icon" aria-hidden="true">${escapeHtml(item.icon)}</span> ${escapeHtml(item.label)}
      </label>`).join("");
  }

  function renderTaskFlagChecks(containerId, checked = {}) {
    $(containerId).innerHTML = taskFlagOptions.map((item) => `
      <label class="${checked?.[item.key] ? "is-selected" : ""}">
        <input type="checkbox" value="${escapeHtml(item.key)}" ${checked?.[item.key] ? "checked" : ""} />
        <span class="strategy-chip-icon" aria-hidden="true">${escapeHtml(item.icon)}</span> ${escapeHtml(item.label)}
      </label>`).join("");
  }

  function syncCheckVisualState(containerId) {
    document.querySelectorAll(`#${containerId} label`).forEach((label) => {
      const input = label.querySelector("input[type='checkbox']");
      if (!input) return;
      label.classList.toggle("is-selected", !!input.checked);
    });
  }

  function renderSectorOptions(containerId, checkedKeys = []) {
    const checked = new Set((checkedKeys || []).map((key) => String(key).toLowerCase()));
    const sectors = state.taskSectors.length ? state.taskSectors : [{ key: "cadastro", label: "Cadastro" }];
    $(containerId).innerHTML = sectors.map((sector) => `
      <label class="strategy-sector-option"><input type="checkbox" value="${escapeHtml(sector.key)}" ${checked.has(String(sector.key).toLowerCase()) ? "checked" : ""} /><span class="strategy-chip-icon" aria-hidden="true">●</span> ${escapeHtml(sector.label)}</label>`).join("");
  }

  function openWatchlistActionModal(id) {
    if (!canEditWatchlist()) {
      showNotice("Seu setor nao possui permissao para editar a Watchlist.", { kind: "warning" });
      return;
    }
    const isBulk = String(id || "") === "__bulk__";
    const item = isBulk ? null : selectedWatchlistItem(id);
    const selectedItems = isBulk ? selectedWatchlistItems() : [];
    if (!isBulk && !item) return;
    if (isBulk && !selectedItems.length) return showNotice("Selecione ao menos um anuncio.", { kind: "warning", title: "Nada selecionado" });
    $("watchlistActionId").value = isBulk ? "__bulk__" : item.id;
    $("watchlistActionHypothesis").value = "";
    $("watchlistActionNotes").value = "";
    $("watchlistActionDate").value = todayYmd();
    $("watchlistActionMetric").value = "conversion";
    $("watchlistActionWindow").value = "7";
    renderWatchlistFlagChecks("watchlistActionFlags", {});
    $("watchlistActionTitle").textContent = isBulk ? "Registrar acao em massa" : "Registrar acao estrategica";
    $("watchlistActionProduct").innerHTML = isBulk ? `
      <div class="strategy-bulk-summary">
        <strong>${fmtInt(selectedItems.length)} anuncio(s) selecionado(s)</strong>
        <span>${escapeHtml(selectedItems.slice(0, 5).map((selected) => selected.mlb).join(", "))}${selectedItems.length > 5 ? "..." : ""}</span>
      </div>` : `
      <div class="strategy-product">
        <div class="strategy-thumb"><img src="${escapeHtml(item.thumbnail || "/ml/img/placeholder.png")}" alt="" /></div>
        <div class="strategy-product__info">
          ${mlbLinkHtml(item.mlb)}
          <div class="strategy-product__title">${escapeHtml(item.title || item.mlb)}</div>
          <div class="strategy-product__meta">SKU ${escapeHtml(item.sku || "sem SKU")}</div>
        </div>
      </div>`;
    $("watchlistActionModal").hidden = false;
  }

  function closeWatchlistActionModal() {
    $("watchlistActionModal").hidden = true;
  }

  async function confirmWatchlistAction() {
    const btn = $("btnConfirmWatchlistAction");
    const id = $("watchlistActionId").value;
    const flags = flagsFrom("watchlistActionFlags");
    try {
      if (!id) throw new Error("Item da Watchlist invalido.");
      if (!anyChecked(flags)) throw new Error("Marque ao menos uma alteracao.");
      setBusy(btn, true);
      const isBulk = id === "__bulk__";
      const path = isBulk ? "/api/estrategicos/watchlist/bulk/actions" : `/api/estrategicos/watchlist/${encodeURIComponent(id)}/actions`;
      const body = {
        action_flags: flags,
        hypothesis: $("watchlistActionHypothesis").value,
        notes: $("watchlistActionNotes").value,
        occurred_on: $("watchlistActionDate").value || todayYmd(),
        primary_metric: $("watchlistActionMetric").value,
        window_days: $("watchlistActionWindow").value || 7,
      };
      if (isBulk) body.ids = selectedWatchlistIds();
      const result = await api(path, {
        method: "POST",
        body: JSON.stringify(body),
      });
      closeWatchlistActionModal();
      await loadWatchlist();
      if (isBulk) clearWatchlistSelection({ rerender: false });
      showNotice(isBulk ? `${fmtInt(result.saved || 0)} acao(oes) registrada(s) na Watchlist.` : "Acao registrada na Watchlist.", { kind: "success", title: "Registro salvo" });
    } catch (error) {
      showNotice(error.message);
    } finally {
      setBusy(btn, false);
    }
  }

  function openWatchlistTaskModal(id) {
    const item = selectedWatchlistItem(id);
    if (!item) return;
    if (!canEditWatchlist() || !canCreateTasks()) {
      showNotice("Seu setor nao possui permissao para criar tarefa pela Watchlist.", { kind: "warning" });
      return;
    }
    $("watchlistTaskId").value = item.id;
    $("watchlistTaskPriority").value = "medium";
    $("watchlistTaskDueDate").value = "";
    $("watchlistTaskNotes").value = item.notes || item.reason || "";
    renderWatchlistFlagChecks("watchlistTaskFlags", {});
    renderSectorOptions("watchlistTaskSectors", ["cadastro"]);
    $("watchlistTaskProduct").innerHTML = `
      <div class="strategy-product">
        <div class="strategy-thumb"><img src="${escapeHtml(item.thumbnail || "/ml/img/placeholder.png")}" alt="" /></div>
        <div class="strategy-product__info">
          ${mlbLinkHtml(item.mlb)}
          <div class="strategy-product__title">${escapeHtml(item.title || item.mlb)}</div>
          <div class="strategy-product__meta">SKU ${escapeHtml(item.sku || "sem SKU")}</div>
        </div>
      </div>`;
    $("watchlistTaskModal").hidden = false;
  }

  function closeWatchlistTaskModal() {
    $("watchlistTaskModal").hidden = true;
  }

  function openWatchlistRemoveModal(id) {
    const isBulk = String(id || "") === "__bulk__";
    const item = isBulk ? null : selectedWatchlistItem(id);
    const selectedItems = isBulk ? selectedWatchlistItems() : [];
    if (!isBulk && !item) return;
    if (isBulk && !selectedItems.length) return showNotice("Selecione ao menos um anuncio.", { kind: "warning", title: "Nada selecionado" });
    $("watchlistRemoveId").value = isBulk ? "" : item.id;
    $("watchlistRemoveIds").value = isBulk ? selectedWatchlistIds().join(",") : "";
    $("watchlistRemoveTitle").textContent = isBulk ? "Remover selecionados?" : "Remover da Watchlist?";
    $("watchlistRemoveProduct").innerHTML = isBulk ? `
      <div class="strategy-bulk-summary strategy-bulk-summary--danger">
        <strong>${fmtInt(selectedItems.length)} anuncio(s) serao removido(s) da Watchlist.</strong>
        <span>O historico de acoes, tarefas e monitoramentos permanece salvo.</span>
      </div>` : `
      <div class="strategy-product">
        <div class="strategy-thumb"><img src="${escapeHtml(item.thumbnail || "/ml/img/placeholder.png")}" alt="" /></div>
        <div class="strategy-product__info">
          ${mlbLinkHtml(item.mlb)}
          <div class="strategy-product__title">${escapeHtml(item.title || item.mlb)}</div>
          <div class="strategy-product__meta">SKU ${escapeHtml(item.sku || "sem SKU")}</div>
        </div>
      </div>`;
    $("watchlistRemoveModal").hidden = false;
  }

  function closeWatchlistRemoveModal() {
    $("watchlistRemoveModal").hidden = true;
    $("watchlistRemoveId").value = "";
    $("watchlistRemoveIds").value = "";
  }

  function createTaskFromWatchlistSelection() {
    const items = selectedWatchlistItems();
    if (!items.length) return showNotice("Selecione ao menos um anuncio.", { kind: "warning", title: "Nada selecionado" });
    if (!canCreateTasks()) return showNotice(permissionMessage("criar tarefas"), { kind: "warning", title: "Acao bloqueada" });
    $("taskQuery").value = items.map((item) => item.mlb).filter(Boolean).join("\n");
    $("taskBatchName").value = `Watchlist - ${fmtInt(items.length)} anuncios`;
    $("taskNotes").value = "Tarefa criada a partir da selecao da Watchlist.";
    switchTab("cadastro");
    showNotice(`${fmtInt(items.length)} anuncio(s) enviados para o formulario de criacao de lote. Revise setores, tarefas e prazo antes de criar.`, { kind: "success", title: "Criacao preparada" });
  }

  function openWatchlistTagModal() {
    const items = selectedWatchlistItems();
    if (!items.length) return showNotice("Selecione ao menos um anuncio.", { kind: "warning", title: "Nada selecionado" });
    if (!canEditWatchlist()) return showNotice(permissionMessage("editar a Watchlist"), { kind: "warning", title: "Acao bloqueada" });
    $("watchlistBulkTagName").value = "";
    $("watchlistBulkTagColor").value = "#3b82f6";
    $("watchlistTagTitle").textContent = `Adicionar tag em ${fmtInt(items.length)} anuncio(s)`;
    $("watchlistTagModal").hidden = false;
  }

  function closeWatchlistTagModal() {
    $("watchlistTagModal").hidden = true;
  }

  async function confirmWatchlistTag() {
    const btn = $("btnConfirmWatchlistTag");
    const ids = selectedWatchlistIds();
    try {
      if (!ids.length) throw new Error("Selecione ao menos um anuncio.");
      const tag = $("watchlistBulkTagName").value;
      if (!String(tag || "").trim()) throw new Error("Informe a tag.");
      setBusy(btn, true);
      const result = await api("/api/estrategicos/watchlist/bulk/tags", {
        method: "POST",
        body: JSON.stringify({ ids, tag, color: $("watchlistBulkTagColor").value }),
      });
      closeWatchlistTagModal();
      clearWatchlistSelection({ rerender: false });
      await loadWatchlist();
      showNotice(`${fmtInt(result.updated || 0)} anuncio(s) receberam a tag "${escapeHtml(result.tag || tag)}".`, { kind: "success", title: "Tags atualizadas" });
    } catch (error) {
      showNotice(error.message);
    } finally {
      setBusy(btn, false);
    }
  }

  function syncWatchlistDetailDateInputs() {
    const custom = ($("watchlistDetailMode")?.value || "first_action") === "custom";
    if ($("watchlistDetailFrom")) $("watchlistDetailFrom").disabled = !custom;
    if ($("watchlistDetailTo")) $("watchlistDetailTo").disabled = !custom;
  }

  function watchlistInsightHtml(insight = {}) {
    const kind = String(insight.type || "neutral").toLowerCase();
    const cls = kind === "positive" ? "strategy-insight--positive" : kind === "danger" ? "strategy-insight--danger" : kind === "warning" ? "strategy-insight--warning" : "";
    return `<article class="strategy-insight ${cls}"><strong>${escapeHtml(insight.title || "Insight")}</strong><p>${escapeHtml(insight.text || "")}</p></article>`;
  }

  function watchlistRangeLabel(mode) {
    if (mode === "custom") return "Data personalizada";
    if (mode === "last_action") return "Desde ultima acao";
    return "Desde 1a acao";
  }

  function watchlistSummaryPill(label, value, className = "") {
    return `<span class="strategy-pill strategy-pill--detail ${className}"><b>${escapeHtml(label)}:</b> ${escapeHtml(value)}</span>`;
  }

  function watchlistMetricCard(label, value, delta = null, kind = "number") {
    const deltaValue = Number(delta);
    const deltaText = Number.isFinite(deltaValue) ? formatMetricDelta(deltaValue, kind) : "--";
    const deltaClass = metricDeltaClass(deltaValue);
    return `<article class="strategy-kpi strategy-kpi--detail ${deltaClass}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${Number.isFinite(deltaValue) ? `vs periodo anterior: ${deltaText}` : "sem comparacao anterior"}</small>
    </article>`;
  }
  function watchlistChangesHtml(flags = {}) {
    const labels = Object.keys(flags || {})
      .filter((key) => !!flags[key])
      .map((key) => listingChangeLabels[key] || flagLabels[key] || key);
    if (!labels.length) return "";
    return labels.map((label) => `<span>${escapeHtml(label)}</span>`).join("");
  }

  function renderWatchlistDetail(payload = {}) {
    const item = payload.item || {};
    const range = payload.range || {};
    const refs = payload.references || {};
    const live = payload.live_metrics || {};
    const deltas = payload.deltas || {};
    const stock = payload.stock_snapshot || {};
    const roundMetrics = payload.round_metrics || {};
    const rounds = Array.isArray(payload.rounds) ? payload.rounds : [];
    const watchEvents = Array.isArray(payload.watchlist_events) ? payload.watchlist_events : [];
    const taskEvents = Array.isArray(payload.task_events) ? payload.task_events : [];
    const operational = Array.isArray(payload.operational_history) ? payload.operational_history : [];
    const insights = Array.isArray(payload.insights) ? payload.insights : [];

    $("watchlistDetailProduct").innerHTML = `
      <div class="strategy-product">
        <div class="strategy-thumb"><img src="${escapeHtml(item.thumbnail || "/ml/img/placeholder.png")}" alt="" /></div>
        <div class="strategy-product__info">
          ${mlbLinkHtml(item.mlb || "")}
          <div class="strategy-product__title">${escapeHtml(item.title || item.mlb || "Anuncio")}</div>
          <div class="strategy-product__meta">SKU ${escapeHtml(item.sku || "sem SKU")} · ${escapeHtml(item.reason || "Acompanhamento estrategico")}</div>
        </div>
      </div>`;

    $("watchlistDetailMode").value = range.mode || "first_action";
    $("watchlistDetailFrom").value = range.from || "";
    $("watchlistDetailTo").value = range.to || "";
    syncWatchlistDetailDateInputs();

    const rangePills = [
      watchlistSummaryPill("Periodo", watchlistRangeLabel(range.mode), "strategy-pill--detail-primary"),
      watchlistSummaryPill("Faixa", `${formatDateOnly(range.from)} ate ${formatDateOnly(range.to)}`),
      watchlistSummaryPill("Janela", `${fmtInt(range.days || 0)} dia(s)`),
    ];
    if (range.was_clamped) {
      rangePills.push(watchlistSummaryPill("Ajuste", `maximo ${fmtInt(range.max_days || 180)} dias`, "strategy-pill--detail-warning"));
    }
    $("watchlistDetailRangeHint").innerHTML = `<div class="strategy-watchlist-range-row">${rangePills.join("")}</div>`;

    const summaryPills = [
      watchlistSummaryPill("Status anuncio", item.listing_status ? String(item.listing_status).toUpperCase() : "--", "strategy-pill--detail-soft"),
      watchlistSummaryPill("Preco atual", stock.price == null ? "--" : fmtMoney(stock.price)),
      watchlistSummaryPill("Estoque atual", stock.current_stock == null ? "--" : fmtInt(stock.current_stock)),
      watchlistSummaryPill("Primeira acao", formatDateOnly(refs.first_action_on)),
      watchlistSummaryPill("Ultima acao", formatDateOnly(refs.last_action_on)),
      watchlistSummaryPill("Acoes", fmtInt(watchEvents.length)),
      watchlistSummaryPill("Operacoes", fmtInt(taskEvents.length)),
      watchlistSummaryPill("Monitoramentos", fmtInt(rounds.length)),
    ];
    $("watchlistDetailSummary").innerHTML = summaryPills.join("");

    const kpis = [
      watchlistMetricCard("Visitas", fmtInt(live.visits || 0), deltas?.visits?.pct, "pct"),
      watchlistMetricCard("Vendas", fmtInt(live.sales || 0), deltas?.sales?.pct, "pct"),
      watchlistMetricCard("Conversao", fmtPct(live.conversion), deltas?.conversion?.delta, "pp"),
      watchlistMetricCard("Receita", fmtMoney(live.revenue || 0), deltas?.revenue?.pct, "pct"),
      watchlistMetricCard("CTR", fmtPct(live.ctr), deltas?.ctr?.delta, "pp"),
      watchlistMetricCard("Impressoes", fmtInt(live.impressions || 0), deltas?.impressions?.pct, "pct"),
    ];
    $("watchlistDetailKpis").innerHTML = kpis.join("");

    $("watchlistDetailInsights").innerHTML = insights.length
      ? insights.map(watchlistInsightHtml).join("")
      : `<article class="strategy-insight"><strong>Sem alertas criticos</strong><p>Os sinais atuais do item estao dentro do esperado para o periodo selecionado.</p></article>`;

    const prazoSubtitle = stock.lead_time_updated_at
      ? `atualizado no ML: ${formatDateTime(stock.lead_time_updated_at)}`
      : (stock.lead_time_label || stock.lead_time_days != null)
        ? "valor atual do anuncio no ML"
        : "sem prazo cadastrado no anuncio";

    const opsCards = [
      ["Estoque atual", stock.current_stock == null ? "--" : fmtInt(stock.current_stock), stock.has_stock_monitoring ? `base estoque: ${fmtInt(stock.stock_watch_stock || 0)}` : "sem monitoramento de estoque vinculado"],
      ["Prazo fabricacao", stock.lead_time_label || (stock.lead_time_days != null ? `${fmtInt(stock.lead_time_days)} dia(s)` : "--"), prazoSubtitle],
      ["Cobertura estoque", stock.coverage_days == null ? "--" : `${Number(stock.coverage_days).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} dias`, stock.stockout_date ? `ruptura prevista: ${formatDateOnly(stock.stockout_date)}` : "sem previsao de ruptura"],
      ["Risco estoque", stock.risk_level ? String(stock.risk_level).toUpperCase() : "--", stock.trend ? `tendencia: ${stock.trend}` : "tendencia nao informada"],
      ["Preco atual", stock.price == null ? "--" : fmtMoney(stock.price), "preco ativo no anuncio"],
      ["Sugestao reposicao", stock.suggested_restock == null ? "--" : `${fmtInt(stock.suggested_restock)} un`, stock.avg_daily_sales != null ? `venda media: ${Number(stock.avg_daily_sales).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}/dia` : "sem media diaria"],
      ["Monitoramentos", fmtInt(rounds.length), rounds.length ? `receita consolidada: ${fmtMoney(roundMetrics.revenue || 0)}` : "nenhum monitoramento nesta janela"],
      ["Acoes registradas", fmtInt(watchEvents.length), `${fmtInt(taskEvents.length)} registro(s) operacionais na janela`],
    ];
    $("watchlistDetailOps").innerHTML = opsCards.map(([label, value, sub]) => `
      <article class="strategy-watchlist-op">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(String(value))}</strong>
        <small>${escapeHtml(sub)}</small>
      </article>`).join("");

    const timeline = [
      ...watchEvents.map((entry) => ({
        at: entry.at || entry.occurred_on,
        type: "watchlist",
        title: entry.event_type === "action_registered" ? "Acao estrategica registrada" : entry.event_type === "task_created" ? "Tarefa criada" : entry.event_type === "added" ? "Adicionado na watchlist" : entry.event_type === "removed" ? "Removido da watchlist" : entry.event_type === "lead_time_changed" ? "Prazo de fabricacao atualizado" : "Evento da watchlist",
        flags: entry.action_flags || {},
        notes: entry.notes || entry.hypothesis || "",
        meta: `${entry.user_name ? `por ${entry.user_name}` : "registro manual"}${entry.occurred_on ? ` · acao em ${formatDateOnly(entry.occurred_on)}` : ""}`,
      })),
      ...operational.map((entry) => ({
        at: entry.at,
        type: "operational",
        title: "Atualizacao operacional",
        flags: entry.listing_changes || {},
        notes: entry.notes || "",
        meta: `${entry.user_name || "usuario"}${entry.task_id ? ` · tarefa #${entry.task_id}` : ""}`,
      })),
      ...rounds.map((entry) => ({
        at: entry.reviewed_at || entry.created_at || entry.alteration_date,
        type: "monitoring",
        title: `Monitoramento ${labelMap[entry.impact] || entry.impact || "pendente"}`,
        flags: entry.change_flags || {},
        notes: entry.change_notes || "",
        meta: `${entry.alteration_date ? `alteracao ${formatDateOnly(entry.alteration_date)}` : "data nao informada"}${entry.review_due_date ? ` · revisao ${formatDateOnly(entry.review_due_date)}` : ""}`,
      })),
    ]
      .filter((entry) => entry.at)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 80);

    $("watchlistDetailTimeline").innerHTML = timeline.length
      ? timeline.map((entry) => `
        <article class="strategy-history-item ${entry.type === "operational" ? "strategy-history-item--execution" : entry.type === "monitoring" ? "strategy-history-item--watch" : "strategy-history-item--watchlist"}">
          <div class="strategy-history-item__head">
            <div class="strategy-history-item__title-wrap">
              <strong>${escapeHtml(formatDateTime(entry.at))}</strong>
              <span class="strategy-history-item__subtitle">${escapeHtml(entry.title)}</span>
            </div>
            <span class="strategy-task-status ${statusClass(entry.type === "monitoring" ? "review" : entry.type === "operational" ? "in_progress" : "pending")}">${escapeHtml(entry.type === "monitoring" ? "Monitoramento" : entry.type === "operational" ? "Operacao" : "Watchlist")}</span>
          </div>
          ${anyChecked(entry.flags || {}) ? `<div class="strategy-change-tags">${watchlistChangesHtml(entry.flags)}</div>` : ""}
          ${entry.notes ? `<p class="strategy-history-item__note">${escapeHtml(entry.notes)}</p>` : ""}
          ${entry.meta ? `<small class="strategy-history-item__meta">${escapeHtml(entry.meta)}</small>` : ""}
        </article>`).join("")
      : `<div class="strategy-empty strategy-empty--compact"><strong>Sem registros no periodo</strong><p>Troque o filtro de periodo para buscar acoes anteriores.</p></div>`;
  }

  async function loadWatchlistDetail() {
    const id = state.watchlistDetailId || $("watchlistDetailId")?.value;
    if (!id) return;
    const mode = $("watchlistDetailMode")?.value || state.watchlistDetailMode || "first_action";
    const from = $("watchlistDetailFrom")?.value || "";
    const to = $("watchlistDetailTo")?.value || "";
    state.watchlistDetailId = String(id);
    state.watchlistDetailMode = mode;
    state.watchlistDetailFrom = from;
    state.watchlistDetailTo = to;
    const params = new URLSearchParams({ mode });
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const data = await api(`/api/estrategicos/watchlist/${encodeURIComponent(id)}/details?${params.toString()}`);
    renderWatchlistDetail(data);
  }

  async function openWatchlistDetailModal(id) {
    const item = selectedWatchlistItem(id);
    if (!item) return;
    state.watchlistDetailId = String(item.id);
    $("watchlistDetailId").value = String(item.id);
    $("watchlistDetailMode").value = "first_action";
    $("watchlistDetailFrom").value = "";
    $("watchlistDetailTo").value = "";
    syncWatchlistDetailDateInputs();
    $("watchlistDetailProduct").innerHTML = `<div class="strategy-muted">Carregando detalhes...</div>`;
    $("watchlistDetailRangeHint").innerHTML = "";
    $("watchlistDetailSummary").innerHTML = "";
    $("watchlistDetailKpis").innerHTML = "";
    $("watchlistDetailInsights").innerHTML = "";
    $("watchlistDetailOps").innerHTML = "";
    $("watchlistDetailTimeline").innerHTML = "";
    const stockPath = "/estoque";
    const stockLink = $("btnOpenStockFromWatchlist");
    if (stockLink) {
      stockLink.href = window.ML?.url
        ? window.ML.url(stockPath)
        : typeof window.withBase === "function"
          ? window.withBase(stockPath)
          : stockPath;
    }
    $("watchlistDetailModal").hidden = false;
    try {
      await loadWatchlistDetail();
    } catch (error) {
      $("watchlistDetailProduct").innerHTML = `<div class="strategy-insight strategy-insight--danger"><strong>Falha ao carregar detalhe</strong><p>${escapeHtml(error.message)}</p></div>`;
    }
  }

  function closeWatchlistDetailModal() {
    $("watchlistDetailModal").hidden = true;
  }

  async function confirmWatchlistTask() {
    const btn = $("btnConfirmWatchlistTask");
    const id = $("watchlistTaskId").value;
    const flags = flagsFrom("watchlistTaskFlags");
    const sectors = Object.keys(flagsFrom("watchlistTaskSectors")).filter((key) => flagsFrom("watchlistTaskSectors")[key]);
    try {
      if (!id) throw new Error("Item da Watchlist invalido.");
      if (!anyChecked(flags)) throw new Error("Marque ao menos uma alteracao para a tarefa.");
      setBusy(btn, true);
      await api(`/api/estrategicos/watchlist/${encodeURIComponent(id)}/create-task`, {
        method: "POST",
        body: JSON.stringify({
          task_flags: flags,
          required_sectors: sectors,
          priority: $("watchlistTaskPriority").value || "medium",
          due_date: $("watchlistTaskDueDate").value || null,
          task_notes: $("watchlistTaskNotes").value,
        }),
      });
      closeWatchlistTaskModal();
      await Promise.all([loadWatchlist(), reloadTaskWorkspace({ keepSelection: false })]);
      showNotice("Tarefa criada e vinculada a Watchlist.", { kind: "success", title: "Tarefa criada" });
    } catch (error) {
      showNotice(error.message);
    } finally {
      setBusy(btn, false);
    }
  }

  function historyMetric(round, key, formatter) {
    const before = round.before_metrics?.[key];
    const after = round.after_metrics?.[key];
    const formatValue = (value) => value === undefined || value === null || value === "" ? "--" : formatter(value);
    return `<span><b>${escapeHtml(metricLabels[key] || key)}</b> ${escapeHtml(formatValue(before))} -> ${escapeHtml(formatValue(after))}</span>`;
  }
  function historyMetricsHtml(round = {}) {
    return `
      <div class="strategy-history-metrics">
        ${historyMetric(round, "impressions", fmtInt)}
        ${historyMetric(round, "visits", fmtInt)}
        ${historyMetric(round, "ctr", fmtPct)}
        ${historyMetric(round, "sales", fmtInt)}
        ${historyMetric(round, "conversion", fmtPct)}
        ${historyMetric(round, "revenue", fmtMoney)}
      </div>`;
  }
  function renderTimelineEntry(event = {}) {
    if (event.type === "watchlist_event") {
      const typeLabel = {
        added: "Adicionado a Watchlist",
        action_registered: "Acao estrategica registrada",
        task_created: "Tarefa criada pela Watchlist",
        lead_time_changed: "Prazo de fabricacao atualizado",
        removed: "Removido da Watchlist",
      };
      return `<article class="strategy-history-item">
        <div class="strategy-history-item__head">
          <div>
            <strong>${escapeHtml(formatDateTime(event.at))}</strong>
            <span>${escapeHtml(typeLabel[event.event_type] || event.event_type || "Watchlist")}</span>
          </div>
          <span class="strategy-task-status ${statusClass(event.event_type === "removed" ? "canceled" : event.event_type === "task_created" ? "in_progress" : "review")}">Watchlist</span>
        </div>
        ${anyChecked(event.action_flags || {}) ? `<div class="strategy-change-tags">${flagsHtml(event.action_flags)}</div>` : ""}
        ${event.hypothesis ? `<p><b>Hipotese:</b> ${escapeHtml(event.hypothesis)}</p>` : ""}
        ${event.notes ? `<p>${escapeHtml(event.notes)}</p>` : ""}
        <small>${event.user_name ? `Registrado por ${escapeHtml(event.user_name)}` : "Registro da Watchlist"}${event.source_task_id ? ` · Tarefa #${escapeHtml(event.source_task_id)}` : ""}${event.occurred_on ? ` · Acao em ${escapeHtml(event.occurred_on)}` : ""}</small>
      </article>`;
    }
    if (event.type === "task_created") {
      return `<article class="strategy-history-item">
        <div class="strategy-history-item__head">
          <div>
            <strong>${escapeHtml(formatDateTime(event.at))}</strong>
            <span>Tarefa criada${event.task_batch_name ? ` no lote ${escapeHtml(event.task_batch_name)}` : ""}</span>
          </div>
          <span class="strategy-task-status ${statusClass(event.status)}">${escapeHtml(statusLabels[event.status] || event.status || "Pendente")}</span>
        </div>
        <div class="strategy-change-tags">${flagsHtml(event.task_flags)}</div>
        ${event.task_notes ? `<p>${escapeHtml(event.task_notes)}</p>` : ""}
        <small>Prioridade: ${escapeHtml(priorityLabels[event.priority] || event.priority || "Media")}${event.created_by?.name ? ` · Criada por ${escapeHtml(event.created_by.name)}` : ""}${event.task_id ? ` · Tarefa #${escapeHtml(event.task_id)}` : ""}</small>
      </article>`;
    }
    if (event.type === "task_execution") {
      const materials = labelList(event.materials_created, materialLabels);
      const returnedMaterials = labelList(event.materials_returned || event.materials_unset, materialLabels);
      const changes = labelList(event.listing_changes, listingChangeLabels);
      const notApplicable = [
        ...labelList(event.materials_not_applicable, materialLabels),
        ...labelList(event.listing_not_applicable, listingChangeLabels),
      ];
      const locations = event.material_locations || {};
      return `<article class="strategy-history-item strategy-history-item--execution">
        <div class="strategy-history-item__head">
          <div>
            <strong>${escapeHtml(formatDateTime(event.at))}</strong>
            <span>${escapeHtml(event.user_name || "Usuario")} registrou esta etapa</span>
          </div>
          <span class="strategy-impact strategy-impact--${event.creates_round ? "improved" : "pending"}">${event.creates_round ? "Monitorando" : escapeHtml(statusLabels[event.status_after] || "Registrado")}</span>
        </div>
        ${returnedMaterials.length ? `<div class="strategy-history-block"><b>Materiais devolvidos</b><div class="strategy-change-tags">${returnedMaterials.map((label) => `<span>${escapeHtml(label)}</span>`).join("")}</div></div>` : ""}
        ${materials.length ? `<div class="strategy-history-block"><b>Materiais criados</b><div class="strategy-change-tags">${materials.map((label) => `<span>${escapeHtml(label)}</span>`).join("")}</div></div>` : ""}
        ${Object.keys(locations).length ? `<div class="strategy-history-links">${Object.entries(locations).map(([key, value]) => `<span><b>${escapeHtml(materialLabels[key] || key)}:</b> ${escapeHtml(value)}</span>`).join("")}</div>` : ""}
        ${changes.length ? `<div class="strategy-history-block"><b>Alteracoes publicadas</b><div class="strategy-change-tags">${changes.map((label) => `<span>${escapeHtml(label)}</span>`).join("")}</div></div>` : ""}
        ${notApplicable.length ? `<div class="strategy-history-block"><b>Nao se aplica</b><div class="strategy-change-tags strategy-change-tags--muted">${notApplicable.map((label) => `<span>&#8856; ${escapeHtml(label)}</span>`).join("")}</div></div>` : ""}
        ${event.notes ? `<p>${escapeHtml(event.notes)}</p>` : ""}
        <small>${event.creates_round ? `Monitoramento iniciado${event.round_id ? ` #${escapeHtml(event.round_id)}` : ""}` : "Registro salvo sem iniciar monitoramento"}${event.task_id ? ` · Tarefa #${escapeHtml(event.task_id)}` : ""}</small>
      </article>`;
    }
    if (event.type === "reopened_from_monitoring") {
      const reopened = Object.keys(flagLabels).filter((key) => event.reopen_flags?.[key]).map((key) => flagLabels[key]);
      return `<article class="strategy-history-item strategy-history-item--warning">
        <div class="strategy-history-item__head">
          <div>
            <strong>${escapeHtml(formatDateTime(event.at))}</strong>
            <span>${escapeHtml(event.user_name || "Usuario")} enviou o item para revisao</span>
          </div>
          <span class="strategy-task-status ${statusClass("returned")}">Em revisao</span>
        </div>
        ${reopened.length ? `<div class="strategy-history-block"><b>Revisar novamente</b><div class="strategy-change-tags">${reopened.map((label) => `<span>${escapeHtml(label)}</span>`).join("")}</div></div>` : ""}
        ${event.notes ? `<p>${escapeHtml(event.notes)}</p>` : ""}
        <small>Monitoramento #${escapeHtml(event.round_id || "--")} mantido ativo${event.task_id ? ` · Tarefa #${escapeHtml(event.task_id)}` : ""}</small>
      </article>`;
    }
    if (event.type === "monitoring_started") {
      const round = event.round || {};
      return `<article class="strategy-history-item">
        <div class="strategy-history-item__head">
          <div>
            <strong>${escapeHtml(formatDateTime(event.at))}</strong>
            <span>Monitoramento iniciado${round.task_batch_name ? ` a partir do lote ${escapeHtml(round.task_batch_name)}` : ""}</span>
          </div>
          <span class="strategy-impact strategy-impact--pending">${escapeHtml(labelMap[round.status] || round.status || "Pendente")}</span>
        </div>
        <div class="strategy-change-tags">${flagsHtml(round.change_flags)}</div>
        ${round.change_notes ? `<p>${escapeHtml(round.change_notes)}</p>` : ""}
        <small>Alteracao em ${escapeHtml(round.alteration_date || "--")} · Revisao ${escapeHtml(round.review_due_date || "--")}${round.source_task_id ? ` · Tarefa #${escapeHtml(round.source_task_id)}` : ""}</small>
      </article>`;
    }
    if (event.type === "monitoring_result") {
      const round = event.round || {};
      return `<article class="strategy-history-item">
        <div class="strategy-history-item__head">
          <div>
            <strong>${escapeHtml(formatDateTime(event.at))}</strong>
            <span>Resultado do monitoramento · ${escapeHtml(round.alteration_date || "--")} -> ${escapeHtml(round.review_due_date || "--")}</span>
          </div>
          <span class="strategy-impact strategy-impact--${escapeHtml(round.impact || "pending")}">${escapeHtml(labelMap[round.impact] || round.impact || "Pendente")}</span>
        </div>
        <div class="strategy-change-tags">${flagsHtml(round.change_flags)}</div>
        ${round.change_notes ? `<p>${escapeHtml(round.change_notes)}</p>` : ""}
        ${historyMetricsHtml(round)}
        <small>Status: ${escapeHtml(labelMap[round.status] || round.status || "--")}${round.confidence ? ` · Confianca: ${escapeHtml(round.confidence)}` : ""}</small>
      </article>`;
    }
    return "";
  }

  function renderHistoryModal(payload = {}) {
    const item = payload.item || {};
    const rounds = Array.isArray(payload.rounds) ? payload.rounds : [];
    const taskEvents = Array.isArray(payload.task_events) ? payload.task_events : [];
    const watchlistEvents = Array.isArray(payload.watchlist_events) ? payload.watchlist_events : [];
    const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
    const timeline = Array.isArray(payload.timeline) ? payload.timeline : [];
    $("historyProduct").innerHTML = `
      <div class="strategy-product">
        <div class="strategy-thumb"><img src="${escapeHtml(item.thumbnail || "/ml/img/placeholder.png")}" alt="" /></div>
        <div class="strategy-product__info">
          ${mlbLinkHtml(item.mlb || "")}
          <div class="strategy-product__title">${escapeHtml(item.title || item.mlb || "Anuncio")}</div>
          <div class="strategy-product__meta">SKU ${escapeHtml(item.sku || "sem SKU")} · ${fmtInt(tasks.length)} tarefa${tasks.length === 1 ? "" : "s"} · ${fmtInt(taskEvents.length)} registro${taskEvents.length === 1 ? "" : "s"} · ${fmtInt(watchlistEvents.length)} watchlist · ${fmtInt(rounds.length)} monitoramento${rounds.length === 1 ? "" : "s"}</div>
        </div>
      </div>`;
    if (timeline.length) {
      $("historyList").innerHTML = `<div class="strategy-history-section-title">Linha do tempo completa</div>${timeline.map(renderTimelineEntry).join("")}`;
      return;
    }
    const taskEventsHtml = taskEvents.length ? `
      <div class="strategy-history-section-title">Historico operacional</div>
      ${taskEvents.map((entry) => {
        const materials = labelList(entry.materials_created, materialLabels);
        const changes = labelList(entry.listing_changes, listingChangeLabels);
        const locations = entry.material_locations || {};
        return `<article class="strategy-history-item strategy-history-item--execution">
          <div class="strategy-history-item__head">
            <div>
              <strong>${escapeHtml(formatDateTime(entry.at))}</strong>
              <span>${escapeHtml(entry.user_name || "Usuario")} registrou esta etapa</span>
            </div>
            <span class="strategy-impact strategy-impact--${entry.creates_round ? "improved" : "pending"}">${entry.creates_round ? "Monitorando" : escapeHtml(statusLabels[entry.status_after] || "Registrado")}</span>
          </div>
          ${materials.length ? `<div class="strategy-history-block"><b>Materiais criados</b><div class="strategy-change-tags">${materials.map((label) => `<span>${escapeHtml(label)}</span>`).join("")}</div></div>` : ""}
          ${Object.keys(locations).length ? `<div class="strategy-history-links">${Object.entries(locations).map(([key, value]) => `<span><b>${escapeHtml(materialLabels[key] || key)}:</b> ${escapeHtml(value)}</span>`).join("")}</div>` : ""}
          ${changes.length ? `<div class="strategy-history-block"><b>Alteracoes publicadas</b><div class="strategy-change-tags">${changes.map((label) => `<span>${escapeHtml(label)}</span>`).join("")}</div></div>` : ""}
          ${entry.notes ? `<p>${escapeHtml(entry.notes)}</p>` : ""}
          <small>${entry.creates_round ? `Monitoramento iniciado${entry.round_id ? ` #${escapeHtml(entry.round_id)}` : ""}` : "Registro salvo sem iniciar monitoramento"}</small>
        </article>`;
      }).join("")}` : "";
    const roundsHtml = rounds.length ? `
      <div class="strategy-history-section-title">Monitoramento de resultados</div>
      ${rounds.map((round) => `
      <article class="strategy-history-item">
        <div class="strategy-history-item__head">
          <div>
            <strong>${escapeHtml(round.alteration_date || "--")}</strong>
            <span>Revisao ${escapeHtml(round.review_due_date || "--")}</span>
          </div>
          <span class="strategy-impact strategy-impact--${escapeHtml(round.impact || "pending")}">${escapeHtml(labelMap[round.impact] || round.impact || "Pendente")}</span>
        </div>
        <div class="strategy-change-tags">${flagsHtml(round.change_flags)}</div>
        ${round.change_notes ? `<p>${escapeHtml(round.change_notes)}</p>` : ""}
        ${historyMetricsHtml(round)}
        <small>Status: ${escapeHtml(labelMap[round.status] || round.status || "--")}</small>
      </article>`).join("")}` : "";
    $("historyList").innerHTML = taskEventsHtml || roundsHtml ? `${taskEventsHtml}${roundsHtml}` : `<div class="strategy-empty"><strong>Nenhum historico encontrado</strong></div>`;
  }

  async function openHistory(mlb) {
    try {
      $("historyModal").hidden = false;
      $("historyProduct").innerHTML = `<div class="strategy-muted">Carregando historico...</div>`;
      $("historyList").innerHTML = "";
      const data = await api(`/api/estrategicos/items/${encodeURIComponent(mlb)}/history`);
      renderHistoryModal(data);
    } catch (error) {
      $("historyProduct").innerHTML = `<div class="strategy-insight strategy-insight--danger"><strong>Falha ao carregar</strong><p>${escapeHtml(error.message)}</p></div>`;
    }
  }

  function closeHistoryModal() {
    $("historyModal").hidden = true;
  }

  function renderCheckGroup(containerId, labels, checked = {}, progress = {}, icons = {}, locations = {}, actionSectors = {}, allowedValues = null, notApplicable = {}) {
    $(containerId).innerHTML = Object.entries(labels).filter(([value]) => {
      if (allowedValues && !allowedValues.has(value)) return false;
      const actionKey = actionSectors[value];
      return progress?.[value] || canViewActionKey(actionKey);
    }).map(([value, label]) => {
      const isNotApplicable = !!notApplicable?.[value];
      const canUse = canUseAction(actionSectors, value);
      const tooltip = !canUse ? `Disponivel para: ${actionAllowedLabel(actionSectors, value)}` : isNotApplicable ? notApplicableText : "";
      return `
      <label data-complete-item="${escapeHtml(value)}" data-not-applicable="${isNotApplicable ? "true" : "false"}" class="${isNotApplicable ? "is-not-applicable" : progress?.[value] ? "is-done" : "is-pending"} ${locations?.[value] && !isNotApplicable ? "has-location" : ""} ${!canUse ? "is-disabled" : ""}" ${tooltip ? `data-tooltip="${escapeHtml(tooltip)}"` : ""}>
        <input type="checkbox" value="${escapeHtml(value)}" ${checked?.[value] && !isNotApplicable ? "checked" : ""} ${!canUse || isNotApplicable ? "disabled" : ""} />
        <span class="strategy-chip-icon" aria-hidden="true">${isNotApplicable ? "&#8856;" : escapeHtml(icons[value] || "•")}</span> ${escapeHtml(label)}
        ${locations?.[value] && !isNotApplicable ? `<span class="strategy-material-view" data-material-view="${escapeHtml(locations[value])}" data-material-label="${escapeHtml(label)}">ver caminho</span>` : ""}
        ${canUse ? `<span class="strategy-not-applicable-toggle" role="button" tabindex="0" data-toggle-not-applicable="${escapeHtml(value)}" data-tooltip="${isNotApplicable ? "Voltar para pendente" : notApplicableText}" aria-label="${isNotApplicable ? "Voltar para pendente" : "Marcar como nao se aplica"}">${isNotApplicable ? "&#8630;" : "&#8856;"}</span>` : ""}
      </label>`;
    }).join("");
  }

  function toggleCompleteNotApplicable(container, value) {
    const item = container?.querySelector(`[data-complete-item="${CSS.escape(String(value || ""))}"]`);
    if (!item || item.classList.contains("is-disabled")) return;
    const next = item.dataset.notApplicable !== "true";
    item.dataset.notApplicable = next ? "true" : "false";
    item.classList.toggle("is-not-applicable", next);
    item.classList.toggle("is-pending", !next);
    item.classList.remove("is-done");
    item.dataset.tooltip = next ? notApplicableText : "";
    const input = item.querySelector("input[type='checkbox']");
    if (input) {
      input.checked = false;
      input.disabled = next;
    }
    const icon = item.querySelector(".strategy-chip-icon");
    if (icon) icon.innerHTML = next ? "&#8856;" : escapeHtml(container.id === "completeMaterialsCreated" ? materialIconMap[value] || "•" : listingIconMap[value] || "•");
    const toggle = item.querySelector("[data-toggle-not-applicable]");
    if (toggle) {
      toggle.dataset.tooltip = next ? "Voltar para pendente" : notApplicableText;
      toggle.setAttribute("aria-label", next ? "Voltar para pendente" : "Marcar como nao se aplica");
      toggle.innerHTML = next ? "&#8630;" : "&#8856;";
    }
    syncCompleteConditionalFields();
  }

  function syncCompleteConditionalFields() {
    const materials = checkedEditableMap("completeMaterialsCreated");
    document.querySelectorAll("[data-material-field]").forEach((el) => {
      el.hidden = !materials?.[el.dataset.materialField];
    });
    const status = $("completeTaskNextStatus")?.value || "in_progress";
    $("completeTaskMonitorFields").hidden = status !== "completed";
    $("btnConfirmCompleteTask").textContent = status === "completed" ? "Finalizar e acompanhar" : "Salvar registro";
  }

  function resetMaterialReturnForm() {
    const form = $("completeMaterialsReturnForm");
    if (form) form.hidden = true;
    document.querySelectorAll("#completeMaterialsReturnChecks input").forEach((input) => {
      input.checked = false;
      input.disabled = false;
      input.closest("label")?.toggleAttribute("hidden", false);
    });
    if ($("completeMaterialReturnReason")) $("completeMaterialReturnReason").value = "";
    if ($("completeMaterialReturnNote")) $("completeMaterialReturnNote").value = "";
  }

  function renderMaterialReturnBox(materialDone = {}) {
    const box = $("completeMaterialsReturn");
    if (!box) return;
    const hasReturnable = !!materialDone.photos || !!materialDone.clips_video;
    box.hidden = !hasReturnable;
    resetMaterialReturnForm();
    document.querySelectorAll("#completeMaterialsReturnChecks input").forEach((input) => {
      const canReturn = !!materialDone[input.value];
      input.disabled = !canReturn;
      input.closest("label")?.toggleAttribute("hidden", !canReturn);
    });
  }

  function toggleMaterialReturnForm(show = null) {
    const form = $("completeMaterialsReturnForm");
    if (!form) return;
    form.hidden = show == null ? !form.hidden : !show;
  }

  function renderCompleteNextStatusOptions(task = {}) {
    const select = $("completeTaskNextStatus");
    const options = ['<option value="in_progress">Salvar progresso</option>'];
    if (state.taskIsAdmin) {
      options.push('<option value="completed">Finalizar e acompanhar resultado</option>');
    }
    select.innerHTML = options.join("");
    select.value = state.taskIsAdmin && task.status === "review" ? "completed" : "in_progress";
  }

  function openCompleteTask(taskId) {
    const task = state.tasks.find((item) => String(item.id) === String(taskId));
    if (!task) return;
    if (!canEditTask(task)) {
      showNotice("Seu usuario ainda nao possui setor liberado para editar esta pendencia.");
      return;
    }
    state.currentCompleteTaskId = String(task.id);
    $("completeTaskId").value = task.id;
    $("completeAlterationDate").value = todayYmd();
    $("completeWindowDays").value = "7";
    $("completeTaskNotes").value = task.task_notes || "";
    const progress = taskProgress(task);
    const materialDone = Object.fromEntries(progress.materials.map((item) => [item.key, !!item.done]));
    const listingDone = Object.fromEntries(progress.listings.map((item) => [item.key, !!item.done]));
    const materialNotApplicable = Object.fromEntries(progress.materials.map((item) => [item.key, !!item.notApplicable]));
    const listingNotApplicable = Object.fromEntries(progress.listings.map((item) => [item.key, !!item.notApplicable]));
    const materialLocations = Object.fromEntries(progress.materials.map((item) => [item.key, item.location || ""]).filter(([, value]) => value));
    const requestedFlags = task.task_flags || {};
    const hasRequestedFlags = anyChecked(requestedFlags);
    const allowedMaterials = hasRequestedFlags
      ? new Set(materialProgressKeys.filter((item) => requestedFlags[item.flag] || materialDone[item.key] || materialNotApplicable[item.key]).map((item) => item.key))
      : null;
    const allowedListings = hasRequestedFlags
      ? new Set(listingProgressKeys.filter((item) => requestedFlags[item.flag] || listingDone[item.key] || listingNotApplicable[item.key]).map((item) => item.key))
      : null;
    renderCheckGroup("completeMaterialsCreated", materialLabels, materialDone, materialDone, materialIconMap, materialLocations, materialActionMap, allowedMaterials, materialNotApplicable);
    renderMaterialReturnBox(materialDone);
    renderCheckGroup("completeListingChanges", listingChangeLabels, listingDone, listingDone, listingIconMap, {}, listingActionMap, allowedListings, listingNotApplicable);
    document.querySelector("[data-complete-section='materials']")?.toggleAttribute("hidden", !$("completeMaterialsCreated").children.length);
    document.querySelector("[data-complete-section='listing']")?.toggleAttribute("hidden", !$("completeListingChanges").children.length);
    $("completePhotosLocation").value = materialLocations.photos || "";
    $("completeClipsLocation").value = materialLocations.clips_video || "";
    renderCompleteNextStatusOptions(task);
    syncCompleteConditionalFields();
    $("completeTaskProduct").innerHTML = `
      <div class="strategy-product">
        <div class="strategy-thumb"><img src="${escapeHtml(task.thumbnail || "/ml/img/placeholder.png")}" alt="" /></div>
          <div class="strategy-product__info">
            ${mlbLinkHtml(task.mlb)}
            <div class="strategy-product__title">${escapeHtml(task.title || task.mlb)}</div>
            <div class="strategy-product__meta">SKU ${escapeHtml(task.sku || "sem SKU")}</div>
            <div class="strategy-sector-owner-list">${renderSectorChips(task.sectors || [], { compact: true, externalLinks: task.external_links || [] })}</div>
          </div>
      </div>`;
    $("completeTaskModal").hidden = false;
  }

  function closeCompleteTaskModal() {
    state.currentCompleteTaskId = "";
    resetMaterialReturnForm();
    $("completeTaskModal").hidden = true;
  }

  function openMaterialLocationModal(label, location) {
    const cleanLocation = String(location || "").trim();
    if (!cleanLocation) return;
    $("materialLocationLabel").textContent = label || "Endereco";
    $("materialLocationValue").value = cleanLocation;
    $("materialLocationModal").hidden = false;
    setTimeout(() => $("materialLocationValue")?.select(), 50);
  }

  function closeMaterialLocationModal() {
    $("materialLocationModal").hidden = true;
  }

  function selectedBatch(id) {
    return state.taskBatches.find((batch) => String(batch.id) === String(id));
  }

  function openBatchModal(id) {
    const batch = selectedBatch(id);
    if (!batch) return;
    $("batchId").value = batch.id;
    $("batchName").value = batch.name || "";
    $("batchPriority").value = batch.priority || "medium";
    $("batchDueDate").value = batch.due_date || batch.next_due_date || "";
    $("batchAnalysisStartDate").value = batch.analysis_start_date || "";
    state.batchDraftTags = normalizeTagList(batch.tags || []);
    state.batchDraftTagColors = normalizeTagColorMap(batch.tag_colors, state.batchDraftTags);
    const firstTagColor = normalizeTagColor(state.batchDraftTagColors[state.batchDraftTags[0]]) || defaultTagColor;
    if ($("batchTagColor")) $("batchTagColor").value = firstTagColor;
    renderBatchTags();
    renderTaskFlagChecks("batchTaskFlags", batch.task_flags || {});
    syncCheckVisualState("batchTaskFlags");
    renderSectorOptions(
      "batchRequiredSectors",
      Array.isArray(batch.sectors) && batch.sectors.length
        ? batch.sectors.map((sector) => sector.key || sector.setor).filter(Boolean)
        : (state.taskSectors || []).map((sector) => sector.key || sector.setor).filter(Boolean),
    );
    syncCheckVisualState("batchRequiredSectors");
    $("batchModal").hidden = false;
  }

  function closeBatchModal() {
    $("batchModal").hidden = true;
  }

  async function saveBatch() {
    const btn = $("btnSaveBatch");
    const id = $("batchId").value;
    try {
      if (!id) throw new Error("Lote invalido.");
      setBusy(btn, true);
      const requiredSectorFlags = flagsFrom("batchRequiredSectors");
      const payload = await api(`/api/estrategicos/tasks/batches/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify({
          name: $("batchName").value,
          priority: $("batchPriority").value,
          due_date: $("batchDueDate").value || null,
          analysis_start_date: $("batchAnalysisStartDate").value || null,
          task_tags: state.batchDraftTags,
          task_tag_colors: state.batchDraftTagColors,
          task_flags: flagsFrom("batchTaskFlags"),
          required_sectors: Object.keys(requiredSectorFlags).filter((key) => requiredSectorFlags[key]),
        }),
      });
      closeBatchModal();
      await reloadTaskWorkspace({ keepSelection: true });
      const affected = Number(payload?.affected_open_tasks || 0);
      showNotice(`Lote atualizado. ${fmtInt(affected)} pendencia(s) aberta(s) do lote receberam as tarefas programadas.`, {
        kind: "success",
        title: "Atualizacao aplicada",
      });
    } catch (error) {
      showNotice(error.message);
    } finally {
      setBusy(btn, false);
    }
  }

  async function loadBatchExistingTokens(id) {
    state.trelloBatchExistingTokens = new Set();
    const cleanId = String(id || "").trim();
    if (!cleanId) return;
    const data = await api(`/api/estrategicos/tasks/batches/${encodeURIComponent(cleanId)}/items`);
    state.trelloBatchExistingTokens = new Set((data.tokens || []).map(normalizeTaskToken).filter(Boolean));
  }

  async function openBatchItemsModal(id) {
    const batch = selectedBatch(id);
    if (!batch) return;
    $("batchItemsId").value = batch.id;
    $("batchItemsQuery").value = "";
    $("batchItemsName").innerHTML = `<strong>${escapeHtml(batch.name || "Lote")}</strong><div class="strategy-table-sub">${fmtInt(batch.total || 0)} anuncio${Number(batch.total || 0) === 1 ? "" : "s"} atualmente</div>`;
    $("batchItemsModal").hidden = false;
    try {
      await loadBatchExistingTokens(batch.id);
      $("batchItemsName").insertAdjacentHTML("beforeend", `<div class="strategy-table-sub">${fmtInt(state.trelloBatchExistingTokens.size)} MLB/SKU ja mapeado(s) neste lote.</div>`);
    } catch (error) {
      state.trelloBatchExistingTokens = new Set();
      showNotice(error.message || "Nao foi possivel carregar os itens atuais do lote.", { kind: "warning", title: "Itens do lote" });
    }
  }

  function closeBatchItemsModal() {
    $("batchItemsModal").hidden = true;
    state.trelloBatchExistingTokens = new Set();
  }

  async function addBatchItems() {
    const btn = $("btnAddBatchItems");
    const id = $("batchItemsId").value;
    try {
      if (!id) throw new Error("Lote invalido.");
      if (!String($("batchItemsQuery").value || "").trim()) throw new Error("Informe ao menos um MLB ou SKU.");
      setBusy(btn, true);
      const data = await api(`/api/estrategicos/tasks/batches/${encodeURIComponent(id)}/items`, {
        method: "POST",
        body: JSON.stringify({ query: $("batchItemsQuery").value }),
      });
      closeBatchItemsModal();
      state.selectedTaskBatchId = id;
      await reloadTaskWorkspace({ keepSelection: true });
      const summary = taskCreateSummary(data);
      const inserted = Number(data.inserted ?? data.total ?? 0);
      showNotice(summary.text, {
        kind: inserted ? "success" : "warning",
        title: inserted ? "Itens adicionados" : "Nenhum item novo",
      });
    } catch (error) {
      showNotice(error.message);
    } finally {
      setBusy(btn, false);
    }
  }

  async function archiveBatch(id) {
    if (!id) return;
    await api(`/api/estrategicos/tasks/batches/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ status: "archived" }) });
    state.selectedTaskBatchId = "";
    await reloadTaskWorkspace({ keepSelection: false });
  }

  async function cancelBatch(id) {
    if (!id) return;
    await api(`/api/estrategicos/tasks/batches/${encodeURIComponent(id)}/cancel`, { method: "POST", body: JSON.stringify({}) });
    state.selectedTaskBatchId = "";
    await reloadTaskWorkspace({ keepSelection: false });
  }

  async function claimBatchSector(batchId, sector, button) {
    if (!batchId || !sector) return;
    try {
      setBusy(button, true);
      const data = await api(`/api/estrategicos/tasks/batches/${encodeURIComponent(batchId)}/sectors/${encodeURIComponent(sector)}/claim`, { method: "POST", body: JSON.stringify({}) });
      const blocked = Number(data.blocked || 0);
      if (blocked) showNotice(`${fmtInt(blocked)} pendencia(s) deste setor ja estavam assumidas por outra pessoa.`, { kind: "warning", title: "Parte do lote ja estava assumida" });
      await reloadTaskWorkspace({ keepSelection: true });
    } finally {
      setBusy(button, false);
    }
  }

  async function updateTaskStatus(taskId, status, extra = {}) {
    await api(`/api/estrategicos/tasks/${encodeURIComponent(taskId)}`, { method: "PUT", body: JSON.stringify({ status, ...extra }) });
    await reloadTaskWorkspace({ keepSelection: true });
  }

  async function updateTaskAnalysisDate(taskId, value, input) {
    try {
      if (input) input.disabled = true;
      await api(`/api/estrategicos/tasks/${encodeURIComponent(taskId)}`, {
        method: "PUT",
        body: JSON.stringify({ analysis_start_date: value || null }),
      });
      await reloadTaskWorkspace({ keepSelection: true });
      showNotice(value ? "Data de analise do anuncio atualizada." : "Data individual removida. O anuncio volta a herdar a data do lote.", { kind: "success", title: "Analise atualizada" });
    } catch (error) {
      showNotice(error.message);
      await reloadTaskWorkspace({ keepSelection: true });
    } finally {
      if (input) input.disabled = false;
    }
  }

  async function removeWatchlistItem(id) {
    if (!id) return;
    await api(`/api/estrategicos/watchlist/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadWatchlist();
    showNotice("Item removido da Watchlist.", { kind: "success", title: "Watchlist atualizada" });
  }

  async function restoreWatchlistItem(id) {
    if (!id) return;
    try {
      await api(`/api/estrategicos/watchlist/${encodeURIComponent(id)}/restore`, { method: "POST" });
      clearWatchlistSelection({ rerender: false });
      await loadWatchlist();
      showNotice("Item restaurado para a Watchlist ativa.", { kind: "success", title: "Watchlist atualizada" });
    } catch (error) {
      showNotice(error.message);
    }
  }

  async function confirmWatchlistRemove() {
    const btn = $("btnConfirmWatchlistRemove");
    const id = $("watchlistRemoveId").value;
    const ids = String($("watchlistRemoveIds")?.value || "").split(",").map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);
    try {
      if (!id && !ids.length) throw new Error("Item da Watchlist invalido.");
      setBusy(btn, true);
      if (ids.length) {
        const result = await api("/api/estrategicos/watchlist/bulk/remove", {
          method: "POST",
          body: JSON.stringify({ ids }),
        });
        closeWatchlistRemoveModal();
        clearWatchlistSelection({ rerender: false });
        await loadWatchlist();
        showNotice(`${fmtInt(result.removed || 0)} anuncio(s) removido(s) da Watchlist. O historico permanece salvo.`, { kind: "success", title: "Watchlist atualizada" });
      } else {
        await removeWatchlistItem(id);
        closeWatchlistRemoveModal();
      }
    } catch (error) {
      showNotice(error.message);
    } finally {
      setBusy(btn, false);
    }
  }

  function openCancelTaskModal(taskId) {
    const task = state.tasks.find((item) => String(item.id) === String(taskId));
    if (!task) return;
    $("cancelTaskId").value = task.id;
    $("cancelTaskReasonSelect").value = "";
    $("cancelTaskReasonDetail").value = "";
    $("cancelTaskConfirm").checked = false;
    $("cancelTaskProduct").innerHTML = `
      <div class="strategy-product">
        <div class="strategy-thumb"><img src="${escapeHtml(task.thumbnail || "/ml/img/placeholder.png")}" alt="" /></div>
        <div class="strategy-product__info">
          ${mlbLinkHtml(task.mlb)}
          <div class="strategy-product__title">${escapeHtml(task.title || task.mlb)}</div>
          <div class="strategy-product__meta">SKU ${escapeHtml(task.sku || "sem SKU")}</div>
        </div>
      </div>`;
    $("cancelTaskModal").hidden = false;
  }

  function closeCancelTaskModal() {
    $("cancelTaskModal").hidden = true;
  }

  async function confirmCancelTask() {
    const btn = $("btnConfirmCancelTask");
    const id = $("cancelTaskId").value;
    const reason = [$("cancelTaskReasonSelect").value, $("cancelTaskReasonDetail").value].map((value) => String(value || "").trim()).filter(Boolean).join(" - ");
    try {
      if (!id) throw new Error("Pendencia invalida.");
      if (!$("cancelTaskConfirm").checked) throw new Error("Confirme o cancelamento antes de continuar.");
      if (!reason) throw new Error("Informe o motivo do cancelamento.");
      setBusy(btn, true);
      await updateTaskStatus(id, "canceled", { cancel_reason: reason });
      closeCancelTaskModal();
    } catch (error) {
      showNotice(error.message);
    } finally {
      setBusy(btn, false);
    }
  }

  async function completeTask() {
    const btn = $("btnConfirmCompleteTask");
    const id = $("completeTaskId").value;
    try {
      if (!id) throw new Error("Pendencia invalida.");
      const materialsCreated = checkedMap("completeMaterialsCreated");
      const listingChanges = checkedMap("completeListingChanges");
      const materialsNotApplicable = notApplicableMap("completeMaterialsCreated");
      const listingNotApplicable = notApplicableMap("completeListingChanges");
      const materialLocations = {
        photos: $("completePhotosLocation").value,
        clips_video: $("completeClipsLocation").value,
      };
      const nextStatus = $("completeTaskNextStatus").value || "in_progress";
      const task = state.tasks.find((item) => String(item.id) === String(id));
      const currentProgress = taskProgress(task || {});
      const alreadyDoneMaterials = Object.fromEntries(currentProgress.materials.map((item) => [item.key, !!item.done]));
      const alreadyDoneListings = Object.fromEntries(currentProgress.listings.map((item) => [item.key, !!item.done]));
      const alreadyNotApplicableMaterials = Object.fromEntries(currentProgress.materials.map((item) => [item.key, !!item.notApplicable]));
      const alreadyNotApplicableListings = Object.fromEntries(currentProgress.listings.map((item) => [item.key, !!item.notApplicable]));
      const renderedMaterials = renderedCheckboxValues("completeMaterialsCreated");
      const renderedListings = renderedCheckboxValues("completeListingChanges");
      const newMaterialsCreated = Object.fromEntries(Object.entries(materialsCreated).map(([key, value]) => [key, !!value && !alreadyDoneMaterials[key]]));
      const newListingChanges = Object.fromEntries(Object.entries(listingChanges).map(([key, value]) => [key, !!value && !alreadyDoneListings[key]]));
      const unsetMaterials = Object.fromEntries(Object.entries(alreadyDoneMaterials).map(([key, value]) => [key, renderedMaterials.has(key) && !!value && !materialsCreated[key]]));
      const unsetListings = Object.fromEntries(Object.entries(alreadyDoneListings).map(([key, value]) => [key, renderedListings.has(key) && !!value && !listingChanges[key]]));
      const newMaterialsNotApplicable = Object.fromEntries(Object.entries(materialsNotApplicable).map(([key, value]) => [key, !!value && !alreadyNotApplicableMaterials[key]]));
      const newListingsNotApplicable = Object.fromEntries(Object.entries(listingNotApplicable).map(([key, value]) => [key, !!value && !alreadyNotApplicableListings[key]]));
      const unsetMaterialsNotApplicable = Object.fromEntries(Object.entries(alreadyNotApplicableMaterials).map(([key, value]) => [key, renderedMaterials.has(key) && !!value && !materialsNotApplicable[key]]));
      const unsetListingsNotApplicable = Object.fromEntries(Object.entries(alreadyNotApplicableListings).map(([key, value]) => [key, renderedListings.has(key) && !!value && !listingNotApplicable[key]]));
      if (nextStatus !== "completed" && ![newMaterialsCreated, newListingChanges, unsetMaterials, unsetListings, newMaterialsNotApplicable, newListingsNotApplicable, unsetMaterialsNotApplicable, unsetListingsNotApplicable].some(anyChecked)) {
        throw new Error("Marque, desmarque ou defina ao menos uma atividade como nao se aplica.");
      }
      if (materialsCreated.photos && !String(materialLocations.photos || "").trim()) throw new Error("Informe o local/link das fotos novas.");
      if (materialsCreated.clips_video && !String(materialLocations.clips_video || "").trim()) throw new Error("Informe o local/link dos clips/videos novos.");
      if (nextStatus === "completed") {
        const missing = taskMissingRequiredWork(task, materialsCreated, listingChanges, { materials: materialsNotApplicable, listings: listingNotApplicable });
        if (!missing.complete) throw new Error(missingWorkMessage(missing));
      }
      setBusy(btn, true);
      let result = null;
      if (nextStatus === "completed") {
        result = await api(`/api/estrategicos/tasks/${encodeURIComponent(id)}/complete`, {
          method: "POST",
          body: JSON.stringify({
            alteration_date: $("completeAlterationDate").value || todayYmd(),
            window_days: $("completeWindowDays").value || 7,
            listing_changes: listingChanges,
            materials_created: materialsCreated,
            materials_not_applicable: materialsNotApplicable,
            listing_not_applicable: listingNotApplicable,
            material_locations: materialLocations,
            change_notes: $("completeTaskNotes").value,
          }),
        });
      } else {
        result = await api(`/api/estrategicos/tasks/${encodeURIComponent(id)}/execution`, {
          method: "POST",
          body: JSON.stringify({
            status_after: nextStatus,
            listing_changes: newListingChanges,
            materials_created: newMaterialsCreated,
            listing_unset: unsetListings,
            materials_unset: unsetMaterials,
            materials_not_applicable: newMaterialsNotApplicable,
            listing_not_applicable: newListingsNotApplicable,
            materials_not_applicable_unset: unsetMaterialsNotApplicable,
            listing_not_applicable_unset: unsetListingsNotApplicable,
            material_locations: materialLocations,
            notes: $("completeTaskNotes").value,
          }),
        });
      }
      closeCompleteTaskModal();
      state.taskPage = 1;
      state.page = 1;
      await Promise.all([reloadTaskWorkspace({ keepSelection: true }), loadDashboard()]);
      if (result?.completed_without_monitoring) showNotice("As atividades foram encerradas sem alteracao publicada. O item foi concluido sem iniciar monitoramento.", { kind: "success", title: "Concluido sem alteracao" });
      else if (result?.auto_completed) showNotice("Todas as alteracoes obrigatorias foram concluidas. O item entrou automaticamente em monitoramento.", { kind: "success", title: "Monitoramento iniciado" });
      else if (result?.auto_ready && result?.auto_error) {
        showNotice(`As etapas foram salvas, mas o monitoramento automatico falhou: ${result.auto_error}`, { kind: "warning", title: "Auto monitoramento pendente" });
      } else if (!result?.auto_completed && result?.completion && result.completion.complete !== true) {
        const missingParts = [];
        if (Array.isArray(result.completion.missing_materials) && result.completion.missing_materials.length) {
          const labels = result.completion.missing_materials.map((key) => materialLabels[key] || key);
          missingParts.push(`materiais: ${labels.join(", ")}`);
        }
        if (Array.isArray(result.completion.missing_listings) && result.completion.missing_listings.length) {
          const labels = result.completion.missing_listings.map((key) => listingChangeLabels[key] || key);
          missingParts.push(`publicacao: ${labels.join(", ")}`);
        }
        if (missingParts.length) {
          showNotice(`Ainda faltam etapas para monitoramento (${missingParts.join("; ")}).`, { kind: "info", title: "Pendencias restantes" });
        }
      }
    } catch (error) {
      showNotice(error.message);
    } finally {
      setBusy(btn, false);
    }
  }

  async function returnTaskMaterials() {
    const btn = $("btnConfirmMaterialReturn");
    const id = $("completeTaskId")?.value || state.currentCompleteTaskId;
    try {
      if (!id) throw new Error("Pendencia invalida.");
      const materials = checkedMap("completeMaterialsReturnChecks");
      if (!anyChecked(materials)) throw new Error("Selecione fotos, clips ou ambos para devolver.");
      const reason = String($("completeMaterialReturnReason")?.value || "").trim();
      const note = String($("completeMaterialReturnNote")?.value || "").trim();
      if (!reason) throw new Error("Informe o motivo da devolucao.");
      setBusy(btn, true);
      const result = await api(`/api/estrategicos/tasks/${encodeURIComponent(id)}/return-materials`, {
        method: "POST",
        body: JSON.stringify({ materials, reason, note }),
      });
      closeCompleteTaskModal();
      await Promise.all([reloadTaskWorkspace({ keepSelection: true }), loadDashboard()]);
      const sync = result?.integration_sync || {};
      const failed = (sync.results || []).find((item) => item.error);
      if (failed) {
        showNotice(`Materiais devolvidos internamente, mas a integracao nao confirmou o retorno: ${failed.error}`, { kind: "warning", title: "Devolucao registrada" });
      } else if (sync.attempted) {
        showNotice("Materiais devolvidos e MarkFlow notificado para correcao.", { kind: "success", title: "Devolucao enviada" });
      } else {
        showNotice("Materiais devolvidos para o setor responsavel.", { kind: "success", title: "Devolucao registrada" });
      }
    } catch (error) {
      showNotice(error.message);
    } finally {
      setBusy(btn, false);
    }
  }

  function setupTooltip() {
    document.addEventListener("mouseover", (event) => {
      const target = closestFromEvent(event, "[data-tooltip]");
      if (!target) return;
      if (activeTooltip) activeTooltip.remove();
      activeTooltip = document.createElement("div");
      activeTooltip.className = "strategy-tooltip";
      activeTooltip.innerHTML = escapeHtml(target.dataset.tooltip || "").replace(/\n/g, "<br>");
      document.body.appendChild(activeTooltip);
      activeTooltipTarget = target;
    });
    document.addEventListener("mousemove", (event) => {
      if (!activeTooltip) return;
      activeTooltip.style.left = `${event.clientX + 14}px`;
      activeTooltip.style.top = `${event.clientY + 14}px`;
    });
    document.addEventListener("mouseout", (event) => {
      if (!closestFromEvent(event, "[data-tooltip]") || !activeTooltip) return;
      activeTooltip.remove();
      activeTooltip = null;
      activeTooltipTarget = null;
    });
  }

  function renderStartupError(error) {
    console.error("[estrategicos] Falha ao inicializar tela", error);
    const page = document.querySelector(".strategy-page");
    if (!page) return;
    const message = escapeHtml(error?.message || error || "Erro inesperado ao carregar a tela.");
    page.insertAdjacentHTML("afterbegin", `
      <div class="strategy-access-notice strategy-access-notice--danger">
        <strong>Falha ao carregar os botoes da tela</strong>
        <span>Atualize a pagina. Se continuar, envie esta mensagem ao suporte: ${message}</span>
      </div>
    `);
  }

  function init() {
    setValue("taskDueDate", "");
    setValue("taskAnalysisStartDate", "");
    on("btnCreateTasks", "click", createTasks);
    on("btnReloadTasks", "click", () => reloadTaskWorkspace({ keepSelection: true }).catch((error) => { setText("taskStatus", error.message); }));
    on("btnRefreshTaskListingStatus", "click", (event) => refreshTaskListingStatus(event.currentTarget));
    on("btnOpenTaskReport", "click", () => openTaskReportModal());
    on("btnConfirmTaskReport", "click", exportTaskReport);
    on("btnReload", "click", loadDashboard);
    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        switchTab(button.dataset.tab || "tasks");
      });
    });
    $("btnOpenCreate")?.addEventListener("click", () => switchTab("cadastro"));
    $("btnOpenPermissions")?.addEventListener("click", () => switchTab("permissions"));
    $("btnClosePermissions")?.addEventListener("click", () => switchTab("tasks"));
    if ($("taskTagColor")) $("taskTagColor").value = defaultTagColor;
    if ($("batchTagColor")) $("batchTagColor").value = defaultTagColor;
    renderCreateTags();
    renderBatchTags();
    ["taskScopeFilter", "taskStatusFilter", "taskPriorityFilter", "taskSectorFilter", "taskOrderMode", "taskBatchNameFilter", "taskTagFilter"].forEach((id) => {
      $(id)?.addEventListener("change", () => {
        state.taskPage = 1;
        state.selectedTaskBatchId = "";
        reloadTaskWorkspace({ keepSelection: false }).catch((error) => { setText("taskStatus", error.message); });
      });
    });
    ["taskCreatedFrom", "taskCreatedTo", "taskAnalysisFrom", "taskAnalysisTo", "taskDueFrom", "taskDueTo"].forEach((id) => {
      $(id)?.addEventListener("change", () => {
        state.taskPage = 1;
        state.selectedTaskBatchId = "";
        reloadTaskWorkspace({ keepSelection: false }).catch((error) => { setText("taskStatus", error.message); });
      });
    });
    $("taskSearch")?.addEventListener("input", () => {
      clearTimeout(state.taskSearchTimer);
      state.taskSearchTimer = setTimeout(() => {
        state.taskPage = 1;
        state.selectedTaskBatchId = "";
        reloadTaskWorkspace({ keepSelection: false }).catch((error) => { setText("taskStatus", error.message); });
      }, 300);
    });
    $("metricViewFilter")?.addEventListener("change", (event) => {
      state.metricView = event.target.value || "auto";
      renderRounds(state.rounds);
    });
    ["roundBatchFilter", "roundTagFilter", "roundImpactFilter", "roundAnalysisFrom", "roundAnalysisTo", "roundGroupMode"].forEach((id) => {
      $(id)?.addEventListener("change", () => {
        state.page = 1;
        loadDashboard().catch((error) => showNotice(error.message, { kind: "warning", title: "Monitoramento" }));
      });
    });
    on("btnReloadRounds", "click", () => {
      state.page = 1;
      loadDashboard().catch((error) => showNotice(error.message, { kind: "warning", title: "Monitoramento" }));
    });
    on("btnReviewVisibleRounds", "click", (event) => reviewVisibleRounds(event.currentTarget));
    on("historyModal", "click", (event) => {
      if (closestFromEvent(event, "[data-close-history]")) closeHistoryModal();
    });
    on("materialLocationModal", "click", (event) => {
      if (closestFromEvent(event, "[data-close-material-location]")) closeMaterialLocationModal();
    });
    on("noticeModal", "click", (event) => {
      if (closestFromEvent(event, "[data-close-notice]")) closeNotice();
    });
    on("taskReportModal", "click", (event) => {
      if (closestFromEvent(event, "[data-close-task-report]")) closeTaskReportModal();
    });
    on("trelloImportModal", "click", (event) => {
      if (closestFromEvent(event, "[data-close-trello-import]")) closeTrelloImportModal();
    });
    on("completeTaskModal", "click", (event) => {
      const notApplicable = closestFromEvent(event, "[data-toggle-not-applicable]");
      if (notApplicable) {
        event.preventDefault();
        event.stopPropagation();
        toggleCompleteNotApplicable(notApplicable.closest(".strategy-checks"), notApplicable.dataset.toggleNotApplicable);
        return;
      }
      const location = closestFromEvent(event, "[data-material-view], [data-material-location]");
      if (location) {
        event.preventDefault();
        openMaterialLocationModal(location.dataset.materialLabel, location.dataset.materialView || location.dataset.materialLocation);
        return;
      }
      if (closestFromEvent(event, "[data-close-complete-task]")) closeCompleteTaskModal();
    });
    on("completeTaskModal", "keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const notApplicable = closestFromEvent(event, "[data-toggle-not-applicable]");
      if (!notApplicable) return;
      event.preventDefault();
      event.stopPropagation();
      toggleCompleteNotApplicable(notApplicable.closest(".strategy-checks"), notApplicable.dataset.toggleNotApplicable);
    });
    on("cancelTaskModal", "click", (event) => {
      if (closestFromEvent(event, "[data-close-cancel-task]")) closeCancelTaskModal();
    });
    on("roundReviewModal", "click", (event) => {
      if (closestFromEvent(event, "[data-close-round-review]")) closeRoundReviewModal();
    });
    on("watchlistAddModal", "click", (event) => {
      if (closestFromEvent(event, "[data-close-watchlist-add]")) closeWatchlistAddModal();
    });
    on("watchlistActionModal", "click", (event) => {
      if (closestFromEvent(event, "[data-close-watchlist-action]")) closeWatchlistActionModal();
    });
    on("watchlistTaskModal", "click", (event) => {
      if (closestFromEvent(event, "[data-close-watchlist-task]")) closeWatchlistTaskModal();
    });
    on("watchlistRemoveModal", "click", (event) => {
      if (closestFromEvent(event, "[data-close-watchlist-remove]")) closeWatchlistRemoveModal();
    });
    on("watchlistTagModal", "click", (event) => {
      if (closestFromEvent(event, "[data-close-watchlist-tag]")) closeWatchlistTagModal();
    });
    on("watchlistDetailModal", "click", (event) => {
      if (closestFromEvent(event, "[data-close-watchlist-detail]")) closeWatchlistDetailModal();
    });
    on("batchModal", "click", (event) => {
      if (closestFromEvent(event, "[data-close-batch]")) closeBatchModal();
    });
    on("batchTaskFlags", "change", () => {
      syncCheckVisualState("batchTaskFlags");
    });
    on("batchRequiredSectors", "change", () => {
      syncCheckVisualState("batchRequiredSectors");
    });
    on("batchItemsModal", "click", (event) => {
      if (closestFromEvent(event, "[data-close-batch-items]")) closeBatchItemsModal();
    });
    on("completeTaskModal", "change", (event) => {
      if (closestFromEvent(event, "#completeMaterialsCreated") || closestFromEvent(event, "#completeTaskNextStatus")) syncCompleteConditionalFields();
    });
    on("btnToggleMaterialReturn", "click", () => toggleMaterialReturnForm());
    on("btnCancelMaterialReturn", "click", () => resetMaterialReturnForm());
    on("btnConfirmMaterialReturn", "click", returnTaskMaterials);
    $("taskFlags")?.addEventListener("change", syncSuggestedTaskSectors);
    on("btnConfirmCompleteTask", "click", completeTask);
    on("btnConfirmRoundReview", "click", confirmRoundReview);
    $("btnOpenTrelloImport")?.addEventListener("click", () => openTrelloImportModal("create").catch((error) => showNotice(error.message, { kind: "warning", title: "Falha no Trello" })));
    $("btnAddTaskTag")?.addEventListener("click", addCreateTag);
    $("taskTagInput")?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      addCreateTag();
    });
    $("btnAddBatchTag")?.addEventListener("click", addBatchTag);
    $("batchTagInput")?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      addBatchTag();
    });
    $("trelloBoardSelect")?.addEventListener("change", () => {
      resetTrelloImportModal();
      if ($("trelloBoardSelect")?.value) loadTrelloLists().catch((error) => showNotice(error.message, { kind: "warning", title: "Falha no Trello" }));
    });
    $("btnLoadTrelloLists")?.addEventListener("click", () => loadTrelloLists().catch((error) => showNotice(error.message, { kind: "warning", title: "Falha no Trello" })));
    $("btnLoadTrelloCards")?.addEventListener("click", () => loadTrelloCards().catch((error) => showNotice(error.message, { kind: "warning", title: "Falha no Trello" })));
    $("btnSelectAllTrelloLists")?.addEventListener("click", () => setAllTrelloLists(true));
    $("btnUnselectAllTrelloLists")?.addEventListener("click", () => setAllTrelloLists(false));
    $("btnSelectAllTrelloCards")?.addEventListener("click", () => setAllTrelloCards(true));
    $("btnUnselectAllTrelloCards")?.addEventListener("click", () => setAllTrelloCards(false));
    $("btnApplyTrelloImport")?.addEventListener("click", applyTrelloImport);
    $("btnAddWatchlist")?.addEventListener("click", () => openWatchlistAddModal());
    $("btnConfirmWatchlistAdd")?.addEventListener("click", confirmWatchlistAdd);
    $("btnConfirmWatchlistAction")?.addEventListener("click", confirmWatchlistAction);
    $("btnConfirmWatchlistTask")?.addEventListener("click", confirmWatchlistTask);
    $("btnConfirmWatchlistRemove")?.addEventListener("click", confirmWatchlistRemove);
    $("btnConfirmWatchlistTag")?.addEventListener("click", confirmWatchlistTag);
    $("btnWatchlistBulkTask")?.addEventListener("click", createTaskFromWatchlistSelection);
    $("btnWatchlistBulkAction")?.addEventListener("click", () => openWatchlistActionModal("__bulk__"));
    $("btnWatchlistBulkTag")?.addEventListener("click", openWatchlistTagModal);
    $("btnWatchlistBulkRemove")?.addEventListener("click", () => openWatchlistRemoveModal("__bulk__"));
    $("btnWatchlistClearSelection")?.addEventListener("click", () => clearWatchlistSelection());
    $("btnReloadWatchlistDetail")?.addEventListener("click", () => {
      loadWatchlistDetail().catch((error) => showNotice(error.message, { kind: "warning", title: "Falha no detalhe" }));
    });
    $("watchlistDetailMode")?.addEventListener("change", () => {
      syncWatchlistDetailDateInputs();
      if (($("watchlistDetailMode")?.value || "first_action") !== "custom") {
        loadWatchlistDetail().catch((error) => showNotice(error.message, { kind: "warning", title: "Falha no detalhe" }));
      }
    });
    $("watchlistSearch")?.addEventListener("input", () => {
      clearTimeout(state.watchlistSearchTimer);
      state.watchlistSearchTimer = setTimeout(() => {
        state.watchlistPage = 1;
        loadWatchlist().catch((error) => renderWatchlistAccess(error.message));
      }, 300);
    });
    ["watchlistStatusFilter", "watchlistListingStatusFilter", "watchlistGroupMode", "watchlistImpactFilter"].forEach((id) => {
      $(id)?.addEventListener("change", () => {
        state.watchlistPage = 1;
        loadWatchlist().catch((error) => renderWatchlistAccess(error.message));
      });
    });
    $("taskGroupMode")?.addEventListener("change", () => {
      renderTasks(state.tasks || []);
    });
    on("btnRefreshWatchlistListingStatus", "click", (event) => refreshWatchlistListingStatus(event.currentTarget));
    on("btnCompareWatchlistImpact", "click", (event) => compareWatchlistImpact(event.currentTarget));
    $("btnSavePermissions")?.addEventListener("click", savePermissions);
    $("permissionsMatrix")?.addEventListener("change", (event) => {
      const input = closestFromEvent(event, "[data-permission-kind]");
      if (!input) return;
      const cell = input.closest("[data-permission-sector]");
      const view = cell?.querySelector("[data-permission-kind='view']");
      const edit = cell?.querySelector("[data-permission-kind='edit']");
      if (input.dataset.permissionKind === "edit" && input.checked && view) view.checked = true;
      if (input.dataset.permissionKind === "view" && !input.checked && edit) edit.checked = false;
    });
    on("btnCopyMaterialLocation", "click", async () => {
      const value = $("materialLocationValue")?.value || "";
      try {
        await navigator.clipboard.writeText(value);
        setText("btnCopyMaterialLocation", "Copiado");
        setTimeout(() => { setText("btnCopyMaterialLocation", "Copiar endereco"); }, 1200);
      } catch (_) {
        $("materialLocationValue")?.select();
        document.execCommand("copy");
      }
    });
    on("btnConfirmCancelTask", "click", confirmCancelTask);
    on("btnSaveBatch", "click", saveBatch);
    on("btnAddBatchItems", "click", addBatchItems);
    on("btnImportBatchItemsTrello", "click", () => openTrelloImportModal("batch_items").catch((error) => showNotice(error.message, { kind: "warning", title: "Falha no Trello" })));
    on("strategyPager", "click", (event) => {
      const button = closestFromEvent(event, "[data-page]");
      if (!button || button.classList.contains("disabled") || button.classList.contains("active")) return;
      const page = Number(button.dataset.page || 1);
      if (!Number.isFinite(page) || page < 1) return;
      state.page = page;
      loadDashboard().catch((error) => renderInsights([{ type: "danger", title: "Falha ao paginar", text: error.message }]));
    });
    on("taskPager", "click", (event) => {
      const button = closestFromEvent(event, "[data-page]");
      if (!button || button.classList.contains("disabled") || button.classList.contains("active")) return;
      const page = Number(button.dataset.page || 1);
      if (!Number.isFinite(page) || page < 1) return;
      state.taskPage = page;
      loadTasks().catch((error) => { setText("taskStatus", error.message); });
    });
    $("watchlistPager")?.addEventListener("click", (event) => {
      const button = closestFromEvent(event, "[data-page]");
      if (!button || button.classList.contains("disabled") || button.classList.contains("active")) return;
      const page = Number(button.dataset.page || 1);
      if (!Number.isFinite(page) || page < 1) return;
      state.watchlistPage = page;
      loadWatchlist().catch((error) => renderWatchlistAccess(error.message));
    });
    on("taskBatches", "click", (event) => {
      const claim = closestFromEvent(event, "[data-claim-sector]");
      if (claim) {
        event.preventDefault();
        event.stopPropagation();
        claimBatchSector(claim.dataset.claimBatch, claim.dataset.claimSector, claim).catch((error) => showNotice(error.message));
        return;
      }
      const edit = closestFromEvent(event, "[data-edit-batch]");
      if (edit) {
        event.preventDefault();
        event.stopPropagation();
        openBatchModal(edit.dataset.editBatch);
        return;
      }
      const addItems = closestFromEvent(event, "[data-add-batch-items]");
      if (addItems) {
        event.preventDefault();
        event.stopPropagation();
        openBatchItemsModal(addItems.dataset.addBatchItems).catch((error) => showNotice(error.message, { kind: "warning", title: "Adicionar MLBs" }));
        return;
      }
      const archive = closestFromEvent(event, "[data-archive-batch]");
      if (archive) {
        event.preventDefault();
        event.stopPropagation();
        if (confirm("Arquivar este lote? Ele sai da visao principal, mas o historico permanece.")) archiveBatch(archive.dataset.archiveBatch).catch((error) => showNotice(error.message));
        return;
      }
      const cancel = closestFromEvent(event, "[data-cancel-batch]");
      if (cancel) {
        event.preventDefault();
        event.stopPropagation();
        if (confirm("Cancelar todas as tarefas abertas deste lote?")) cancelBatch(cancel.dataset.cancelBatch).catch((error) => showNotice(error.message));
        return;
      }
      const button = closestFromEvent(event, "[data-task-batch]");
      if (!button) return;
      const batchId = button.dataset.taskBatch || "";
      state.selectedTaskBatchId = String(state.selectedTaskBatchId) === String(batchId) ? "" : batchId;
      state.taskPage = 1;
      renderTaskBatches(state.taskBatches);
      loadTasks().catch((error) => { setText("taskStatus", error.message); });
    });
    on("taskBatches", "keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const button = closestFromEvent(event, "[data-task-batch]");
      if (!button || closestFromEvent(event, "button")) return;
      event.preventDefault();
      const batchId = button.dataset.taskBatch || "";
      state.selectedTaskBatchId = String(state.selectedTaskBatchId) === String(batchId) ? "" : batchId;
      state.taskPage = 1;
      renderTaskBatches(state.taskBatches);
      loadTasks().catch((error) => { setText("taskStatus", error.message); });
    });
    on("btnExportCsv", "click", () => {
      const path = "/api/estrategicos/export.csv";
      window.location.href = window.ML?.url ? window.ML.url(path) : typeof window.withBase === "function" ? window.withBase(path) : path;
    });
    $("roundsBody")?.addEventListener("click", (event) => {
      const roundGroupToggle = closestFromEvent(event, "[data-round-group-toggle]");
      if (roundGroupToggle) {
        const groupKey = roundGroupToggle.dataset.roundGroupToggle || "";
        if (groupKey) state.strategyGroupExpanded[groupKey] = state.strategyGroupExpanded[groupKey] === false;
        renderRounds(state.rounds || []);
        return;
      }
      const returnButton = closestFromEvent(event, "[data-return-round]");
      if (returnButton) openRoundReviewModal(returnButton.dataset.returnRound);
      const historyButton = closestFromEvent(event, "[data-history]");
      if (historyButton) openHistory(historyButton.dataset.history);
    });
    on("tasksBody", "click", (event) => {
      const taskGroupToggle = closestFromEvent(event, "[data-task-group-toggle]");
      if (taskGroupToggle) {
        const groupKey = taskGroupToggle.dataset.taskGroupToggle || "";
        if (groupKey) state.strategyGroupExpanded[groupKey] = state.strategyGroupExpanded[groupKey] === false;
        renderTasks(state.tasks || []);
        return;
      }
      const denied = closestFromEvent(event, "[data-task-denied]");
      if (denied) {
        showNotice(denied.dataset.taskDenied, { kind: "warning", title: "Acao bloqueada" });
        return;
      }
      const location = closestFromEvent(event, "[data-material-location]");
      if (location) {
        event.preventDefault();
        openMaterialLocationModal(location.dataset.materialLabel, location.dataset.materialLocation);
        return;
      }
      const statusButton = closestFromEvent(event, "[data-task-status]");
      if (statusButton) {
        if (statusButton.dataset.taskStatus === "canceled") {
          openCancelTaskModal(statusButton.dataset.taskId);
          return;
        }
        updateTaskStatus(statusButton.dataset.taskId, statusButton.dataset.taskStatus).catch((error) => showNotice(error.message));
      }
      const completeButton = closestFromEvent(event, "[data-task-complete]");
      if (completeButton) openCompleteTask(completeButton.dataset.taskComplete);
      const historyButton = closestFromEvent(event, "[data-history]");
      if (historyButton) openHistory(historyButton.dataset.history);
    });
    on("tasksBody", "change", (event) => {
      const analysisInput = closestFromEvent(event, "[data-task-analysis-date]");
      if (analysisInput) updateTaskAnalysisDate(analysisInput.dataset.taskAnalysisDate, analysisInput.value, analysisInput);
    });
    $("taskTagsWrap")?.addEventListener("click", (event) => {
      const button = closestFromEvent(event, "[data-remove-create-tag]");
      if (!button) return;
      event.preventDefault();
      removeCreateTag(button.dataset.removeCreateTag);
    });
    $("batchTagsWrap")?.addEventListener("click", (event) => {
      const button = closestFromEvent(event, "[data-remove-batch-tag]");
      if (!button) return;
      event.preventDefault();
      removeBatchTag(button.dataset.removeBatchTag);
    });
    $("watchlistBody")?.addEventListener("click", (event) => {
      const groupToggle = closestFromEvent(event, "[data-watchlist-group-toggle]");
      if (groupToggle) {
        const groupKey = groupToggle.dataset.watchlistGroupToggle || "";
        if (groupKey) state.strategyGroupExpanded[groupKey] = state.strategyGroupExpanded[groupKey] === false;
        renderWatchlist(state.watchlist || []);
        return;
      }
      const denied = closestFromEvent(event, "[data-watchlist-denied]");
      if (denied) {
        showNotice(denied.dataset.watchlistDenied, { kind: "warning", title: "Acao bloqueada" });
        return;
      }
      const actionButton = closestFromEvent(event, "[data-watchlist-action]");
      if (actionButton) return openWatchlistActionModal(actionButton.dataset.watchlistAction);
      const detailButton = closestFromEvent(event, "[data-watchlist-detail]");
      if (detailButton) return openWatchlistDetailModal(detailButton.dataset.watchlistDetail);
      const taskButton = closestFromEvent(event, "[data-watchlist-task]");
      if (taskButton) return openWatchlistTaskModal(taskButton.dataset.watchlistTask);
      const restoreButton = closestFromEvent(event, "[data-watchlist-restore]");
      if (restoreButton) return restoreWatchlistItem(restoreButton.dataset.watchlistRestore);
      const removeButton = closestFromEvent(event, "[data-watchlist-remove]");
      if (removeButton) return openWatchlistRemoveModal(removeButton.dataset.watchlistRemove);
      const historyButton = closestFromEvent(event, "[data-history]");
      if (historyButton) return openHistory(historyButton.dataset.history);
    });
    $("watchlistBody")?.addEventListener("change", (event) => {
      const itemCheck = closestFromEvent(event, "[data-watchlist-select]");
      if (itemCheck) {
        toggleWatchlistItemSelection(itemCheck.dataset.watchlistSelect, itemCheck.checked);
        return;
      }
      const groupCheck = closestFromEvent(event, "[data-watchlist-group-select]");
      if (groupCheck) {
        toggleWatchlistGroupSelection(groupCheck.dataset.watchlistGroupSelect, groupCheck.checked);
      }
    });
    document.addEventListener("click", (event) => {
      handleCopyMlbClick(event);
    }, true);
    setupTooltip();
    loadTaskSectors()
      .then(() => Promise.all([loadDashboard(), reloadTaskWorkspace({ keepSelection: true })]))
      .catch((error) => renderInsights([{ type: "danger", title: "Falha ao carregar", text: error.message }]));
  }
  function boot() {
    try {
      console.info("[estrategicos] inicializando tela");
      init();
    } catch (error) {
      renderStartupError(error);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
