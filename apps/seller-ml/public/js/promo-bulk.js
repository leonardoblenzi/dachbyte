// =============================================================
// Base path helper (supports deployments under /ml)
// =============================================================
(function initBasePath(){
  if (typeof window === 'undefined') return;
  if (window.__ML_BASE_PATH != null) return;
  const p = window.location && window.location.pathname ? window.location.pathname : '';
  window.__ML_BASE_PATH = (p === '/ml' || p.startsWith('/ml/')) ? '/ml' : '';
})();

function withBase(path) {
  const base = (typeof window !== 'undefined' && window.__ML_BASE_PATH) ? window.__ML_BASE_PATH : '';
  if (!path || typeof path !== 'string') return path;
  if (!base) return path;
  if (path === base || path.startsWith(base + '/')) return path;
  if (path.startsWith('/')) return base + path;
  return path;
}

// promo-bulk.js
// Controle de seleÃ§Ã£o em massa + integraÃ§Ã£o com JobsPanel + criaÃ§Ã£o de jobs locais
//
// Depende de:
//   - (opcional) remover em massa via /api/promocoes/jobs/remove
//
// API exposta:
//   window.PromoBulk = {
//     applyIds(ids),
//     setContext({ promotion_id, promotion_type, filtroParticipacao, maxDesc, mlbFilter, mlbsFilter }),
//     onHeaderToggle(checked),
//     setAccountContext({ key, label })
//   };

(function () {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const ui = {
    wrap: null,
    btnSel: null,
    btnApp: null,
    btnRem: null,
    selBar: null,
    selMsg: null,
    selHint: null,
    selAllCampaignBtn: null,
    selApplyBtn: null,
    selRemoveBtn: null,
    delayInput: null,
    dryRunToggle: null,
    selectionStatusPill: null,
    selectionPageCount: null,
    selectionFilteredCount: null,
    selectionDiscountValue: null,
    selectionActionHint: null,
  };

  const ctx = {
    promotion_id: null,
    promotion_type: null,
    promotion_name: null,
    filtros: { status: "all", maxDesc: null, mlb: null, mlbs: null },
    headerChecked: false,

    // seleÃ§Ã£o global (toda campanha filtrada)
    global: {
      selectedAll: false,
      token: null,
      total: 0,
      ids: null, // IDs preparados pelo backend quando nao houver token
    },

    account: {
      key: null,
      label: null,
    },

    meta: {
      filteredTotal: null,
      manualPercent: null,
      manualFlow: false,
      filterLimit: null,
      lightningStock: null,
    },

    // novo estado de "preparando seleÃ§Ã£o"
    isPreparingSelection: false,

    // trava visual/local para impedir varios POSTs enquanto o backend
    // ainda esta criando ou reutilizando o job real.
    isSubmittingApply: false,
  };

  function hasReadableAccountText(value) {
    return /[A-Za-z\u00C0-\u00FF]/.test(String(value || "").trim());
  }

  function readShellAccountLabel() {
    const raw = String(document.getElementById("account-current")?.textContent || "").trim();
    if (!raw) return "";
    if (/carregando|indispon|nenhuma selecionada/i.test(raw)) return "";
    return raw;
  }

  function normalizeAccountContext(acc = {}) {
    const rawKey = String(acc?.key || acc?.accountKey || "").trim();
    const key = rawKey && rawKey.toLowerCase() !== "default" ? rawKey : "";
    const rawLabel = String(acc?.label || acc?.accountLabel || "").trim();
    const label = rawLabel || (hasReadableAccountText(key) ? key : "");
    return {
      key: key || null,
      label: label || null,
    };
  }

  function resolveAccountContext() {
    const shellLabel = readShellAccountLabel();
    const fromCtx = normalizeAccountContext(ctx.account || {});
    if (fromCtx.key || fromCtx.label) {
      const resolved = {
        key: fromCtx.key,
        label: shellLabel || fromCtx.label,
      };
      ctx.account.key = resolved.key;
      ctx.account.label = resolved.label;
      return resolved;
    }

    const fromWindow = normalizeAccountContext(window.__ACCOUNT__ || {});
    if (fromWindow.key || fromWindow.label) {
      ctx.account.key = fromWindow.key;
      ctx.account.label = shellLabel || fromWindow.label;
      return {
        key: fromWindow.key,
        label: ctx.account.label,
      };
    }

    if (shellLabel) {
      ctx.account.key = null;
      ctx.account.label = shellLabel;
      return {
        key: null,
        label: shellLabel,
      };
    }

    return { key: null, label: null };
  }

  /* ====================== Mensagem de "seleÃ§Ã£o preparada" ====================== */

  function showPreparedMessage(total) {
    const selBar = document.getElementById("selectionBar");
    const selMsg = document.getElementById("selMsg");
    if (!selBar || !selMsg) return;
    selBar.classList.remove("hidden");
    selMsg.textContent =
      `Lote filtrado preparado com ${total} item${total === 1 ? "" : "s"}. Nada foi enviado ao ML ainda.`;
    setTimeout(() => {
      updateSelectionBar();
    }, 4000);
    return;

    selBar.classList.remove("hidden");
    const original = selMsg.textContent;

    selMsg.textContent =
      `SeleÃ§Ã£o preparada: ${total} anÃºncio${total === 1 ? "" : "s"} ` +
      `filtrado${total === 1 ? "" : "s"} na campanha.`;

    // volta ao texto anterior depois de alguns segundos
    setTimeout(() => {
      selMsg.textContent = original;
    }, 4000);
  }

  /* ====================== Helpers ====================== */

  function countVisible() {
    return $$('#tbody input[type="checkbox"][data-mlb]').length;
  }

  function countSelected() {
    return $$('#tbody input[type="checkbox"][data-mlb]:checked').length;
  }

  function getSelectedMLBs() {
    return $$('#tbody input[type="checkbox"][data-mlb]:checked').map(
      (x) => x.dataset.mlb
    );
  }

  function getAllPageMLBs() {
    return $$('#tbody input[type="checkbox"][data-mlb]').map(
      (x) => x.dataset.mlb
    );
  }

  function getCampanhaNome() {
    return (
      document.getElementById("campName")?.textContent || "Campanha"
    ).trim();
  }

  function getDelayMs() {
    if (!ui.delayInput) return 900;
    const v = Number(String(ui.delayInput.value || "").replace(",", "."));
    if (Number.isNaN(v) || v < 0) return 900;
    return v;
  }

  function getDryRun() {
    return !!(ui.dryRunToggle && ui.dryRunToggle.checked);
  }

  function setApplySubmissionPending(isOn) {
    ensureUI();
    ctx.isSubmittingApply = !!isOn;

    const buttons = [
      ui.btnApp,
      ui.selApplyBtn,
      document.getElementById("manualWizardApplyBtn"),
      ...Array.from(document.querySelectorAll(".smart-apply-btn")),
    ].filter(Boolean);

    buttons.forEach((button) => {
      if (isOn) {
        if (!button.dataset.promoSubmitText) {
          button.dataset.promoSubmitText = button.textContent || "";
        }
        button.dataset.promoSubmitWasDisabled = button.disabled ? "1" : "0";
        button.disabled = true;
        button.classList.add("is-loading");
        if (
          button === ui.btnApp ||
          button === ui.selApplyBtn ||
          button.id === "manualWizardApplyBtn"
        ) {
          button.textContent = "Criando job...";
        }
      } else {
        const originalText = button.dataset.promoSubmitText;
        const wasDisabled = button.dataset.promoSubmitWasDisabled === "1";
        if (originalText != null && originalText !== "") {
          button.textContent = originalText;
        }
        button.disabled = wasDisabled;
        button.classList.remove("is-loading");
        delete button.dataset.promoSubmitText;
        delete button.dataset.promoSubmitWasDisabled;
      }
    });
  }

  function acquireApplySubmission() {
    if (ctx.isSubmittingApply) {
      window.notifyPromocoes?.(
        "Esta aplicacao ja esta sendo enviada. Aguarde o numero do job aparecer no painel.",
      );
      return false;
    }
    setApplySubmissionPending(true);
    return true;
  }

  function formatItems(count) {
    const n = Number(count || 0);
    return `${n} ${n === 1 ? "item" : "itens"}`;
  }

  function formatPercent(value) {
    const n = Number(value);
    return Number.isFinite(n) ? `${n.toFixed(2)}%` : "Nao definido";
  }

  function setStatusPill(text, tone = "pending") {
    if (!ui.selectionStatusPill) return;
    ui.selectionStatusPill.textContent = text;
    ui.selectionStatusPill.classList.remove(
      "selection-status-pill--pending",
      "selection-status-pill--active",
      "selection-status-pill--ready",
    );
    if (tone === "ready") ui.selectionStatusPill.classList.add("selection-status-pill--ready");
    else if (tone === "active") ui.selectionStatusPill.classList.add("selection-status-pill--active");
    else ui.selectionStatusPill.classList.add("selection-status-pill--pending");
  }

  function setMetricValue(el, value, muted = false) {
    if (!el) return;
    el.textContent = value;
    el.classList.toggle("selection-metric__value--muted", !!muted);
  }

  function ensureUI() {
    if (!ui.wrap) {
      ui.wrap = document.getElementById("bulkControls");
      ui.btnSel = document.getElementById("bulkSelectAllBtn");
      ui.btnApp = document.getElementById("bulkApplyAllBtn");
      ui.btnRem = document.getElementById("bulkRemoveAllBtn");

      if (ui.btnSel) ui.btnSel.addEventListener("click", onSelectAllPage);
      if (ui.btnApp) ui.btnApp.addEventListener("click", onApplyPageBtn);
      if (ui.btnRem) ui.btnRem.addEventListener("click", onRemovePageBtn);
    }

    if (!ui.selBar) {
      ui.selBar = document.getElementById("selectionBar");
      ui.selMsg = document.getElementById("selMsg");
      ui.selHint = document.getElementById("selHint");
      ui.selAllCampaignBtn = document.getElementById("selAllCampaignBtn");
      ui.selApplyBtn = document.getElementById("selApplyBtn");
      ui.selRemoveBtn = document.getElementById("selRemoveBtn");
      ui.delayInput = document.getElementById("bulkDelayMs");
      ui.dryRunToggle = document.getElementById("dryRunToggle");
      ui.selectionStatusPill = document.getElementById("selectionStatusPill");
      ui.selectionPageCount = document.getElementById("selectionPageCount");
      ui.selectionFilteredCount = document.getElementById("selectionFilteredCount");
      ui.selectionDiscountValue = document.getElementById("selectionDiscountValue");
      ui.selectionActionHint = document.getElementById("selectionActionHint");

      if (ui.selAllCampaignBtn)
        ui.selAllCampaignBtn.addEventListener("click", onSelectWholeCampaign);
      if (ui.selApplyBtn)
        ui.selApplyBtn.addEventListener("click", onApplyClick);
      if (ui.selRemoveBtn)
        ui.selRemoveBtn.addEventListener("click", onRemoveClick);
    }
  }

  /* ============ Controle de loading da seleÃ§Ã£o por campanha ============ */

  function setPreparingSelection(isOn) {
    ensureUI();
    ctx.isPreparingSelection = !!isOn;

    // desabilita botÃµes da barra de seleÃ§Ã£o
    if (ui.selAllCampaignBtn) {
      ui.selAllCampaignBtn.disabled = isOn;
      if (isOn) {
        ui.selAllCampaignBtn.classList.add("is-loading");
      } else {
        ui.selAllCampaignBtn.classList.remove("is-loading");
      }
    }
    if (ui.selApplyBtn) ui.selApplyBtn.disabled = isOn;
    if (ui.selRemoveBtn) ui.selRemoveBtn.disabled = isOn;

    // desabilita checkboxes da tabela (header + linhas)
    $$('#tbody input[type="checkbox"][data-mlb]').forEach((ch) => {
      ch.disabled = isOn;
    });
    const headerChk =
      document.querySelector("#checkAll") ||
      document.querySelector(
        'input[type="checkbox"][data-role="select-all"]'
      ) ||
      document.querySelector("#chkSelectAll");
    if (headerChk) headerChk.disabled = isOn;

    // mensagem amigÃ¡vel na faixa
    if (ui.selBar && ui.selMsg) {
      if (isOn) {
        ui.selBar.classList.remove("hidden");
        ui.selBar.classList.add("is-loading");
        ui.selMsg.textContent =
          "Preparando seleÃ§Ã£o da campanha (coletando itens filtrados)â€¦ " +
          "Em campanhas grandes isso pode levar alguns segundos.";
        if (ui.selHint) {
          ui.selHint.textContent =
            "Esse passo apenas separa os itens elegiveis no lote. O desconto ainda nao e enviado ao ML.";
        }
        setStatusPill("Preparando lote filtrado...", "active");
      } else {
        ui.selBar.classList.remove("is-loading");
        // o texto normal serÃ¡ recalculado pelo updateSelectionBar()
        updateSelectionBar();
      }
    }
  }

  /* ====================== Jobs helpers ====================== */

  function noteLocalJobStart(title) {
    try {
      const account = resolveAccountContext();
      const id = window.JobsPanel?.addLocalJob?.({
        title,
        accountKey: account.key,
        accountLabel: account.label,
      });
      window.JobsPanel?.show?.();
      return id || null;
    } catch {
      return null;
    }
  }

  function csvEscape(value) {
    const text = value == null ? "" : String(value);
    if (/[;"\n\r]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }

  function buildLocalCsvUrl(filename, header, rows) {
    const lines = [header, ...(Array.isArray(rows) ? rows : [])]
      .map((cols) => (Array.isArray(cols) ? cols : []).map(csvEscape).join(";"))
      .join("\r\n");
    const blob = new Blob(["\uFEFF", lines], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    return {
      filename,
      url,
    };
  }

  function updateLocalJobProgress(id, progress, state) {
    if (!id || !window.JobsPanel?.updateLocalJob) return;
    window.JobsPanel.updateLocalJob(id, { progress, state });
  }

  function bindLocalJobToServer(localJobId, realJobId, { title, total } = {}) {
    const nextId = String(realJobId || "").trim();
    if (!localJobId || !nextId) return nextId || localJobId;
    const account = resolveAccountContext();

    try {
      window.JobsPanel?.replaceId?.(localJobId, nextId);
      window.JobsPanel?.updateLocalJob?.(nextId, {
        title,
      });
      window.JobsPanel?.updateLocalJob?.(nextId, {
        progress: 0,
        state:
          total && Number(total) > 0
            ? `queued 0/${Number(total)}`
            : "queued",
        accountKey: account.key,
        accountLabel: account.label,
      });
    } catch {}

    return nextId;
  }

  /* ====================== Render / UI ====================== */

  function renderTopControls() {
    ensureUI();
    if (!ui.wrap || !ui.btnSel) return;

    const total = countVisible();
    if (!ctx.headerChecked || total === 0) {
      ui.wrap.classList.add("hidden");
    } else {
      ui.wrap.classList.remove("hidden");
      ui.btnSel.textContent = `Selecionar todos (${total} exibidos)`;
      ui.btnApp.disabled = false;
      ui.btnRem.disabled = false;
    }
  }

  function updateSelectionBar() {
    ensureUI();
    if (!ui.selBar || !ui.selMsg) return;

    // se estÃ¡ preparando seleÃ§Ã£o, nÃ£o mexe no texto/labels aqui
    if (ctx.isPreparingSelection) {
      ui.selBar.classList.remove("hidden");
      return;
    }

    const pageSel = countSelected();
    const isGlobal = !!ctx.global.selectedAll;
    const globTotal = Number(ctx.global.total || 0);
    const filteredTotal =
      ctx.meta.filteredTotal == null || Number.isNaN(Number(ctx.meta.filteredTotal))
        ? null
        : Number(ctx.meta.filteredTotal);
    const filteredReady = filteredTotal != null;
    const hasFilteredEligible = filteredReady && filteredTotal > 0;
    const manualPercent =
      ctx.meta.manualPercent == null || Number.isNaN(Number(ctx.meta.manualPercent))
        ? null
        : Number(ctx.meta.manualPercent);
    const manualFlow = !!ctx.meta.manualFlow;
    const applyBtnLabel = manualFlow ? "Aplicar no ML" : "Aplicar desconto";

    setMetricValue(ui.selectionPageCount, formatItems(pageSel), pageSel === 0);
    setMetricValue(
      ui.selectionFilteredCount,
      filteredTotal == null ? "Calculando..." : formatItems(filteredTotal),
      filteredTotal == null,
    );
    setMetricValue(
      ui.selectionDiscountValue,
      manualPercent != null ? formatPercent(manualPercent) : "Nao definido",
      manualPercent == null,
    );

    let summaryMsg = "";
    let summaryHint = "";
    let summaryActionHint =
      'Preparar lote apenas separa os itens elegiveis. O desconto so e enviado ao ML quando voce clicar em "Aplicar desconto".';

    if (isGlobal) {
      summaryMsg = `Lote filtrado preparado com ${formatItems(globTotal)}. Nada foi aplicado no ML ainda.`;
      if (manualPercent != null) {
        summaryHint = `Desconto pronto: ${formatPercent(manualPercent)}. Proximo passo: clique em "${applyBtnLabel}" para iniciar o job.`;
        setStatusPill(`Lote pronto: ${formatItems(globTotal)} aguardando envio ao ML`, "ready");
      } else if (manualFlow) {
        summaryHint = "O lote ja esta separado, mas ainda falta definir o desconto a aplicar abaixo antes de seguir.";
        setStatusPill(`Lote pronto: ${formatItems(globTotal)} aguardando configuracao`, "active");
      } else {
        summaryHint = `O lote ja esta separado. Clique em "${applyBtnLabel}" para iniciar a acao.`;
        setStatusPill(`Lote pronto: ${formatItems(globTotal)}`, "ready");
      }
      summaryActionHint = `Os ${formatItems(globTotal)} do lote ja foram separados. Nenhum desconto foi enviado ao ML ainda.`;
    } else {
      if (pageSel > 0 && filteredTotal != null) {
        summaryMsg = `${formatItems(pageSel)} marcados nesta pagina. ${formatItems(filteredTotal)} atendem ao filtro atual da campanha.`;
      } else if (pageSel > 0) {
        summaryMsg = `${formatItems(pageSel)} marcados nesta pagina.`;
      } else if (filteredTotal != null) {
        summaryMsg = `${formatItems(filteredTotal)} atendem ao filtro atual da campanha.`;
      }

      if (manualFlow) {
        if (filteredTotal != null && manualPercent != null) {
          summaryHint = `O filtro apenas separa os elegiveis. O desconto de ${formatPercent(manualPercent)} ainda nao foi enviado ao ML.`;
          summaryActionHint =
            pageSel > 0
              ? `Voce pode aplicar so nos ${formatItems(pageSel)} marcados desta pagina ou clicar em "Preparar lote filtrado" para montar o lote completo.`
              : `Clique em "Preparar lote filtrado" para montar o lote completo com os ${formatItems(filteredTotal)} elegiveis.`;
          setStatusPill(
            `Fluxo pronto: ${filteredTotal != null ? formatItems(filteredTotal) : "elegiveis"} e ${formatPercent(manualPercent)} definidos`,
            "active",
          );
        } else if (filteredTotal != null) {
          summaryHint = `Esses ${formatItems(filteredTotal)} sao apenas os elegiveis pelo filtro. Falta salvar o desconto a aplicar abaixo.`;
          summaryActionHint = "Depois de salvar o desconto, voce pode aplicar so na pagina atual ou preparar o lote completo filtrado.";
          setStatusPill(`Filtro pronto: ${formatItems(filteredTotal)} elegiveis encontrados`, "pending");
        } else if (manualPercent != null) {
          summaryHint = `Desconto pronto: ${formatPercent(manualPercent)}. Agora filtre a lista acima ou marque itens na tabela.`;
          summaryActionHint = "Quando houver itens elegiveis, use \"Preparar lote filtrado\" para montar o lote completo ou siga apenas com os marcados na pagina.";
          setStatusPill(`Desconto pronto: ${formatPercent(manualPercent)}`, "active");
        } else {
          summaryHint = `Passo a passo: 1. Filtre a lista acima. 2. Salve o desconto abaixo. 3. Prepare o lote filtrado. 4. Clique em "${applyBtnLabel}".`;
          summaryActionHint = `Nada foi aplicado ainda. O filtro so reduz os elegiveis, e o envio ao ML so comeca em "${applyBtnLabel}".`;
          setStatusPill("Passo 1: filtre a lista e defina o desconto do lote", "pending");
        }
      } else {
        summaryHint =
          filteredTotal != null
            ? `Esses ${formatItems(filteredTotal)} atendem ao filtro atual. Prepare o lote completo ou siga apenas com os itens marcados na pagina.`
            : "Marque os itens da pagina atual ou prepare o lote completo filtrado para seguir.";
        setStatusPill(
          filteredTotal != null
            ? `Filtro pronto: ${formatItems(filteredTotal)} disponiveis`
            : "Selecione itens para continuar",
          filteredTotal != null ? "active" : "pending",
        );
      }
    }

    ui.selMsg.textContent = summaryMsg || "Nenhum item selecionado.";
    if (ui.selHint) ui.selHint.textContent = summaryHint || ui.selHint.textContent;
    if (ui.selectionActionHint) ui.selectionActionHint.textContent = summaryActionHint;

    if (pageSel > 0 || isGlobal) ui.selBar.classList.remove("hidden");
    else ui.selBar.classList.add("hidden");

    if (ui.selAllCampaignBtn) {
      if (isGlobal) {
        ui.selAllCampaignBtn.textContent = `Lote filtrado pronto (${globTotal} itens)`;
        ui.selAllCampaignBtn.classList.remove("danger");
        ui.selAllCampaignBtn.classList.add("success");
        ui.selAllCampaignBtn.title =
          "O lote filtrado ja foi preparado. Clique novamente se quiser desfazer essa selecao completa.";
        ui.selAllCampaignBtn.disabled = !!ctx.isPreparingSelection;
      } else {
        ui.selAllCampaignBtn.textContent = "Preparar lote filtrado";
        ui.selAllCampaignBtn.classList.remove("danger");
        ui.selAllCampaignBtn.classList.remove("success");
        if (!filteredReady) {
          ui.selAllCampaignBtn.title =
            'Aguarde o calculo de "Elegiveis pelo filtro" terminar para preparar o lote.';
        } else if (!hasFilteredEligible) {
          ui.selAllCampaignBtn.title =
            "Nao ha itens elegiveis no filtro atual para preparar o lote.";
        } else {
          ui.selAllCampaignBtn.title =
            "Prepara no backend o lote completo dos itens que atendem aos filtros atuais. Isso ainda nao aplica o desconto no ML.";
        }
        ui.selAllCampaignBtn.disabled =
          !!ctx.isPreparingSelection || !hasFilteredEligible;
      }
    }

    if (ui.selApplyBtn) {
      ui.selApplyBtn.textContent = applyBtnLabel;
      ui.selApplyBtn.title = manualFlow
        ? "Inicia o envio do desconto configurado para os itens selecionados ou para o lote filtrado preparado."
        : "Inicia a aplicacao do desconto nos itens selecionados nesta pagina ou no lote preparado.";
    }

    const disableActions = pageSel === 0 && !isGlobal;
    if (ui.selApplyBtn) ui.selApplyBtn.disabled = disableActions;
    if (ui.selRemoveBtn) ui.selRemoveBtn.disabled = disableActions;
    return;

    let msg = "";
    if (pageSel > 0) {
      msg =
        `${pageSel} anÃºncio${pageSel > 1 ? "s" : ""} ` +
        `selecionado${pageSel > 1 ? "s" : ""} nesta pÃ¡gina`;
    }
    if (isGlobal) {
      const tail = "(filtrados na campanha)";
      msg = msg
        ? `${msg} â€¢ toda a campanha: ${globTotal} selecionado${
            globTotal === 1 ? "" : "s"
          } ${tail}`
        : `Toda a campanha: ${globTotal} selecionado${
            globTotal === 1 ? "" : "s"
          } ${tail}`;
    }

    ui.selMsg.textContent = msg || "Nenhum item selecionado.";

    if (pageSel > 0 || isGlobal) ui.selBar.classList.remove("hidden");
    else ui.selBar.classList.add("hidden");

    if (ui.selAllCampaignBtn) {
      if (isGlobal) {
        ui.selAllCampaignBtn.textContent = `Campanha filtrada pronta (${globTotal} itens)`;
        ui.selAllCampaignBtn.classList.remove("danger");
        ui.selAllCampaignBtn.classList.add("success");
      } else {
        ui.selAllCampaignBtn.textContent =
          "Selecionar campanha filtrada";
        ui.selAllCampaignBtn.classList.remove("danger");
        ui.selAllCampaignBtn.classList.remove("success");
      }
    }

    const nothing = pageSel === 0 && !isGlobal;
    if (ui.selApplyBtn) ui.selApplyBtn.disabled = nothing;
    if (ui.selRemoveBtn) ui.selRemoveBtn.disabled = nothing;
  }

  function render() {
    renderTopControls();
    updateSelectionBar();
  }

  /* ====================== SeleÃ§Ãµes ====================== */

  function onSelectAllPage() {
    $$('#tbody input[type="checkbox"][data-mlb]').forEach((ch) => {
      ch.checked = true;
    });
    render();
  }

  // Helper para mapear status interno -> status da API de seleÃ§Ã£o
  function mapStatusForPrepare(v) {
    if (v === "started" || v === "candidate" || v === "pending") return v;
    if (v === "yes") return "started";
    if (v === "non") return "candidate";
    if (v === "prog" || v === "scheduled") return "pending";
    return null; // all
  }

  // Preparacao server-side obrigatoria; falhas encerram o fluxo sem aplicar localmente.
  // - tenta window.coletarTodosIdsFiltrados()
  // - se nÃ£o existir, usa MLBs da pÃ¡gina atual
  async function prepareWholeCampaign() {
    if (!ctx.promotion_id || !ctx.promotion_type) {
      window.notifyPromocoes(
        "Selecione uma campanha antes de usar a selecao da campanha toda.",
      );
      return null;
    }

    try {
      const maxDesc =
        ctx.filtros.maxDesc == null || ctx.filtros.maxDesc === ""
          ? null
          : Number(ctx.filtros.maxDesc);

      const body = {
        promotion_id: ctx.promotion_id,
        promotion_type: ctx.promotion_type,
        promotion_name: ctx.promotion_name,
        status: mapStatusForPrepare(ctx.filtros.status),
        mlb: ctx.filtros.mlb || null,
        mlbs: Array.isArray(ctx.filtros.mlbs) ? ctx.filtros.mlbs : null,
        percent_max: maxDesc,
        discount_max: maxDesc,
      };

      if (String(ctx.promotion_type || "").toUpperCase() === "LIGHTNING") {
        body.lightning_stock =
          ctx.meta.lightningStock == null ? null : Number(ctx.meta.lightningStock);
      }

      const prepResult = await window.PromoHttp?.postSelectionPrepare?.(body);
      const js = prepResult?.data || {};
      if (!prepResult?.ok || js.ok === false) {
        throw new Error(
          js.error ||
            prepResult?.error ||
            `Nao foi possivel validar a selecao no servidor (HTTP ${prepResult?.status || 0}).`,
        );
      }

      const idsFromApi = Array.isArray(js.ids)
        ? js.ids.map((v) => String(v || "").trim().toUpperCase()).filter(Boolean)
        : null;
      const total =
        js.total != null && !Number.isNaN(Number(js.total))
          ? Number(js.total)
          : idsFromApi?.length || 0;

      if (js.token) {
        return {
          token: String(js.token),
          total,
          ids: idsFromApi && idsFromApi.length ? idsFromApi : null,
        };
      }

      if (idsFromApi && idsFromApi.length) {
        return {
          token: null,
          total,
          ids: idsFromApi,
        };
      }

      if (total === 0) {
        return { token: null, total: 0, ids: [] };
      }

      throw new Error(
        "O servidor informou itens elegiveis, mas nao retornou um token/seleção segura. Nenhum anuncio sera alterado.",
      );
    } catch (e) {
      console.error("prepareWholeCampaign falhou:", e);
      window.notifyPromocoes(
        e?.message ||
          "Nao foi possivel preparar a selecao no servidor. Nenhum fallback local foi executado.",
      );
      return null;
    }
  }

  async function onSelectWholeCampaign() {
    const filteredTotal =
      ctx.meta.filteredTotal == null || Number.isNaN(Number(ctx.meta.filteredTotal))
        ? null
        : Number(ctx.meta.filteredTotal);
    const hasFilteredEligible = filteredTotal != null && filteredTotal > 0;
    // se jÃ¡ estava em modo "toda campanha", o clique desliga
    if (ctx.global.selectedAll && !ctx.isPreparingSelection) {
      ctx.global.selectedAll = false;
      ctx.global.token = null;
      ctx.global.total = 0;
      ctx.global.ids = null;
      render();
      window.atualizarFaixaSelecaoCampanha?.();
      return;
    }

    // evita duplo clique enquanto prepara
    if (ctx.isPreparingSelection) return;
    if (!ctx.global.selectedAll && !hasFilteredEligible) {
      window.notifyPromocoes(
        'Aguarde o total de "Elegiveis pelo filtro" carregar antes de preparar o lote.',
      );
      return;
    }

    setPreparingSelection(true);
    let prep = null;

    try {
      prep = await prepareWholeCampaign();
    } finally {
      setPreparingSelection(false);
    }

    if (!prep) return;

    ctx.global.selectedAll = true;
    ctx.global.token = prep.token;
    ctx.global.total = prep.total;
    ctx.global.ids = prep.ids || null;

    render();
    window.atualizarFaixaSelecaoCampanha?.();
    showPreparedMessage(ctx.global.total);
  }

  /* ====================== Aplicacao segura por lista ====================== */

  async function applyQueue(ids, overrides = {}) {
    const normalizedIds = [
      ...new Set(
        (Array.isArray(ids) ? ids : [])
          .map((id) => String(id || "").trim().toUpperCase())
          .filter(Boolean),
      ),
    ];
    if (!normalizedIds.length) return false;

    const promotionId = String(overrides.promotion_id || ctx.promotion_id || "").trim();
    const promotionType = String(
      overrides.promotion_type || ctx.promotion_type || "",
    ).toUpperCase();
    if (promotionType === "PRICE_MATCHING_MELI_ALL") {
      window.notifyPromocoes(
        "Esta campanha e gerida pelo Mercado Livre. Aplicacao manual indisponivel.",
      );
      return false;
    }
    if (!promotionId || !promotionType) {
      window.notifyPromocoes("Selecione uma campanha antes de aplicar.");
      return false;
    }

    const camp =
      String(overrides.promotion_name || "").trim() || getCampanhaNome();
    if (!acquireApplySubmission()) return false;

    let localJobId = null;
    try {
      localJobId = noteLocalJobStart(
        `Aplicacao - ${camp} (${normalizedIds.length} itens)`,
      );
      const rawManualPercent =
        overrides.manualPercent ?? overrides.manual_percent ?? ctx.meta.manualPercent;
      const manualPercent =
        rawManualPercent == null || Number.isNaN(Number(rawManualPercent))
          ? null
          : Number(rawManualPercent);
      const options = {
        dryRun: getDryRun(),
        expected_total: normalizedIds.length,
      };

      if (promotionType === "SELLER_CAMPAIGN") {
        if (!(manualPercent > 0)) {
          throw new Error("Defina o percentual da Seller Campaign antes de aplicar.");
        }
        options.seller_manual_percent = manualPercent;
      } else if (["DEAL", "LIGHTNING", "PRICE_DISCOUNT", "DOD"].includes(promotionType)) {
        if (!(manualPercent > 0)) {
          throw new Error("Defina o percentual da promocao antes de aplicar.");
        }
        options.deal_manual_percent = manualPercent;
      }

      if (promotionType === "LIGHTNING") {
        const stock = Number(
          overrides.lightningStock ?? overrides.lightning_stock ?? ctx.meta.lightningStock,
        );
        if (!Number.isInteger(stock) || stock < 5) {
          throw new Error(
            "Informe uma quantidade promocional valida (minimo 5) para a oferta relampago.",
          );
        }
        options.lightning_stock = stock;
      }

      const payload = {
        promotion_id: promotionId,
        promotion_type: promotionType,
        promotion_name:
          String(overrides.promotion_name || "").trim() ||
          ctx.promotion_name ||
          camp,
        status:
          overrides.status !== undefined
            ? overrides.status
            : mapStatusForPrepare(ctx.filtros.status),
        percent_max:
          overrides.percentMax != null
            ? Number(overrides.percentMax)
            : ctx.filtros.maxDesc == null || ctx.filtros.maxDesc === ""
              ? manualPercent
              : Number(ctx.filtros.maxDesc),
        selection_ids: normalizedIds,
        options,
      };

      const response = await fetch(withBase("/api/promocoes/jobs/apply-list"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.ok === false || !data?.job_id) {
        throw new Error(
          data?.error ||
            data?.message ||
            `Nao foi possivel iniciar o job seguro (HTTP ${response.status}).`,
        );
      }

      bindLocalJobToServer(localJobId, data.job_id, {
        title: `Aplicando ${promotionType} - ${camp}`,
        total: normalizedIds.length,
      });
      window.JobsPanel?.show?.();
      window.PromoJobsWatcher?.start?.();
      window.__JobsWatcher?.start?.();
      if (data?.reused === true) {
        window.notifyPromocoes(
          data?.reused_reason === "campaign_busy"
            ? `Esta campanha ja possui uma operacao aberta no job ${data.job_id}. O job existente foi mantido.`
            : `Esta aplicacao ja estava na fila no job ${data.job_id}. Nenhum job duplicado foi criado.`,
        );
      } else {
        window.notifyPromocoes(
          `Aplicacao enviada para a fila para ${normalizedIds.length} item(ns). Acompanhe no painel de processos.`,
        );
      }
      return true;
    } catch (e) {
      console.error("Falha ao iniciar aplicacao segura por lista:", e);
      if (localJobId) {
        window.JobsPanel?.updateLocalJob?.(localJobId, {
          state: "falhou ao iniciar",
          completed: true,
          error: e?.message || "Falha ao iniciar aplicacao.",
        });
      }
      window.notifyPromocoes(
        e?.message ||
          "Nao foi possivel iniciar a aplicacao. Nenhum item foi aplicado localmente.",
      );
      return false;
    } finally {
      setApplySubmissionPending(false);
    }
  }

  /* ====================== AÃ§Ãµes (Aplicar / Remover) ====================== */

  async function onApplyClick() {
    // Toda campanha delega ao fluxo seguro do criar-promocao.js/PROMO jobs.
    if (
      ctx.global.selectedAll &&
      typeof window.aplicarTodosFiltrados === "function"
    ) {
      await window.aplicarTodosFiltrados();
      return;
    }

    // CenÃ¡rio 1 (legado): toda campanha via token -> tenta job massivo
    if (ctx.global.selectedAll && ctx.global.token) {
      if (!acquireApplySubmission()) return;
      const camp = getCampanhaNome();
      const qtd = Number(ctx.global.total || 0);
      const localJobId = noteLocalJobStart(
        `AplicaÃ§Ã£o (job) â€“ ${camp} (${qtd} itens)`
      );
      let massStarted = false;

      try {
        const body = {
          token: ctx.global.token,
          action: "apply",
          promotion_name: ctx.promotion_name,
          values: {
            dryRun: getDryRun(),
          },
        };
        const r = await fetch(withBase("/api/promocoes/jobs/apply-mass"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(body),
        });
        const js = await r.json().catch(() => ({}));
        if (!r.ok || js.ok === false) {
          throw new Error(js.error || `HTTP ${r.status}`);
        }

        bindLocalJobToServer(localJobId, js.job_id, {
          title: `AplicaÃ§Ã£o (job) â€“ ${camp} (${qtd} itens)`,
          total: qtd,
        });
        window.JobsPanel?.show?.();
        window.PromoJobsWatcher?.start?.();
        window.__JobsWatcher?.start?.();
        massStarted = true;
        if (js?.reused === true) {
          window.notifyPromocoes?.(
            js?.reused_reason === "campaign_busy"
              ? `Esta campanha ja possui uma operacao aberta no job ${js.job_id}. O job existente foi mantido.`
              : `Esta aplicacao ja estava na fila no job ${js.job_id}. Nenhum job duplicado foi criado.`,
          );
        }
      } catch (e) {
        updateLocalJobProgress(localJobId, 0, `erro ao iniciar: ${e.message}`);
        console.error(
          "apply-mass falhou; tentando job apply-list com IDs ja preparados, se disponiveis:",
          e
        );
      } finally {
        setApplySubmissionPending(false);
      }
      if (massStarted) return;
    }

    // Cenario 2: IDs ja preparados -> mesmo worker seguro via apply-list
    if (
      ctx.global.selectedAll &&
      Array.isArray(ctx.global.ids) &&
      ctx.global.ids.length
    ) {
      await applyQueue(ctx.global.ids);
      render();
      return;
    }

    // Cenario 3: selecionados da pagina -> job seguro via apply-list
    const mlbs = getSelectedMLBs();
    if (!mlbs.length) {
      window.notifyPromocoes("Selecione ao menos um item na tabela.");
      return;
    }
    await applyQueue(mlbs);
    render();
  }

  async function onRemoveClick() {
    // ðŸ”¹ NOVO opcional: se vocÃª criar removerTodosFiltrados() no criar-promocao.js,
    // dÃ¡ pra delegar a remoÃ§Ã£o da campanha inteira por lÃ¡ tambÃ©m.
    if (
      ctx.global.selectedAll &&
      typeof window.removerTodosFiltrados === "function"
    ) {
      await window.removerTodosFiltrados();
      return;
    }

    // CenÃ¡rio 1: toda campanha via token
    if (ctx.global.selectedAll && ctx.global.token) {
      const camp = getCampanhaNome();
      const qtd = Number(ctx.global.total || 0);
      const localJobId = noteLocalJobStart(
        `RemoÃ§Ã£o (job) â€“ ${camp} (${qtd} itens)`
      );

      try {
        const body = {
          token: ctx.global.token,
          action: "remove",
          promotion_name: ctx.promotion_name,
        };
        const r = await fetch(withBase("/api/promocoes/jobs/apply-mass"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(body),
        });
        const js = await r.json().catch(() => ({}));
        if (!r.ok || js.ok === false) {
          throw new Error(js.error || `HTTP ${r.status}`);
        }

        bindLocalJobToServer(localJobId, js.job_id, {
          title: `RemoÃ§Ã£o (job) â€“ ${camp} (${qtd} itens)`,
          total: qtd,
        });
        window.JobsPanel?.show?.();
        window.__JobsWatcher?.start?.();
        return;
      } catch (e) {
        updateLocalJobProgress(localJobId, 0, `erro ao iniciar: ${e.message}`);
        console.error(
          "apply-mass/remove falhou, tentando fallback de IDs locais se houver:",
          e
        );
      }
    }

    // CenÃ¡rio 2: ids locais (fallback da campanha inteira)
    if (
      ctx.global.selectedAll &&
      Array.isArray(ctx.global.ids) &&
      ctx.global.ids.length
    ) {
      const camp = getCampanhaNome();
      const qtd = ctx.global.ids.length;
      const localJobId = noteLocalJobStart(`RemoÃ§Ã£o â€“ ${camp} (${qtd} itens)`);

      try {
        const r = await fetch(withBase("/api/promocoes/jobs/remove"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ items: ctx.global.ids, delay_ms: 250 }),
        });
        const js = await r.json().catch(() => ({}));
        if (!r.ok || js.ok === false) {
          throw new Error(js.error || `HTTP ${r.status}`);
        }

        bindLocalJobToServer(localJobId, js.job_id, {
          title: `RemoÃ§Ã£o â€“ ${camp} (${qtd} itens)`,
          total: qtd,
        });
        window.JobsPanel?.show?.();
        window.__JobsWatcher?.start?.();
        return;
      } catch (e) {
        updateLocalJobProgress(localJobId, 0, `erro ao iniciar: ${e.message}`);
        console.error("Erro ao iniciar remoÃ§Ã£o em massa com IDs locais:", e);
        window.notifyPromocoes("Erro ao iniciar remoÃ§Ã£o em massa da campanha (fallback local).");
        return;
      }
    }

    // CenÃ¡rio 3: apenas selecionados da pÃ¡gina
    const mlbs = getSelectedMLBs();
    if (!mlbs.length) {
      window.notifyPromocoes("Selecione ao menos um item na tabela.");
      return;
    }

    const camp = getCampanhaNome();
    const qtd = mlbs.length;
    const localJobId = noteLocalJobStart(`RemoÃ§Ã£o â€“ ${camp} (${qtd} itens)`);

    try {

      const r = await fetch(withBase("/api/promocoes/jobs/remove"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ items: mlbs, delay_ms: 250 }),
      });
      const js = await r.json().catch(() => ({}));
      if (!r.ok || js.ok === false) {
        throw new Error(js.error || `HTTP ${r.status}`);
      }

      bindLocalJobToServer(localJobId, js.job_id, {
        title: `RemoÃ§Ã£o â€“ ${camp} (${qtd} itens)`,
        total: qtd,
      });
      window.JobsPanel?.show?.();
      window.__JobsWatcher?.start?.();
    } catch (e) {
      updateLocalJobProgress(localJobId, 0, `erro ao iniciar: ${e.message}`);
      console.error("Erro ao iniciar remoÃ§Ã£o em massa (selecionados):", e);
      window.notifyPromocoes("Erro ao iniciar remoÃ§Ã£o em massa dos selecionados.");
    }
  }

  // BotÃµes da barra superior: "Aplicar a todos" / "Remover todos" da PÃGINA atual
  async function onApplyPageBtn() {
    const mlbs = getAllPageMLBs();
    if (!mlbs.length) {
      window.notifyPromocoes("Nenhum item na pÃ¡gina atual.");
      return;
    }
    await applyQueue(mlbs);
    render();
  }

  async function onRemovePageBtn() {
    const mlbs = getAllPageMLBs();
    if (!mlbs.length) {
      window.notifyPromocoes("Nenhum item na pÃ¡gina atual.");
      return;
    }

    const camp = getCampanhaNome();
    const qtd = mlbs.length;
    const localJobId = noteLocalJobStart(`RemoÃ§Ã£o â€“ ${camp} (${qtd} itens)`);

    try {

      const r = await fetch(withBase("/api/promocoes/jobs/remove"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ items: mlbs, delay_ms: 250 }),
      });
      const js = await r.json().catch(() => ({}));
      if (!r.ok || js.ok === false) {
        throw new Error(js.error || `HTTP ${r.status}`);
      }

      bindLocalJobToServer(localJobId, js.job_id, {
        title: `RemoÃ§Ã£o â€“ ${camp} (${qtd} itens)`,
        total: qtd,
      });
      window.JobsPanel?.show?.();
      window.__JobsWatcher?.start?.();
    } catch (e) {
      updateLocalJobProgress(localJobId, 0, `erro ao iniciar: ${e.message}`);
      console.error("Erro ao iniciar remoÃ§Ã£o em massa da pÃ¡gina:", e);
      window.notifyPromocoes("Erro ao iniciar remoÃ§Ã£o em massa da pÃ¡gina.");
    }
  }

  /* ====================== API PÃºblica ====================== */

  window.PromoBulk = {
    applyIds(ids, overrides = {}) {
      return applyQueue(ids, overrides);
    },

    setContext({
      promotion_id,
      promotion_type,
      promotion_name,
      filtroParticipacao,
      maxDesc,
      mlbFilter,
      mlbsFilter,
    }) {
      ctx.promotion_id = promotion_id;
      ctx.promotion_type = promotion_type;
      ctx.promotion_name = promotion_name || promotion_id || null;

      // mapeia filtro da tela -> estado interno amigÃ¡vel para mapStatusForPrepare
      ctx.filtros.status =
        filtroParticipacao === "yes"
          ? "yes"
          : filtroParticipacao === "non"
          ? "non"
          : filtroParticipacao === "prog"
          ? "prog"
          : "all";

      ctx.filtros.maxDesc =
        maxDesc == null || maxDesc === "" ? null : Number(maxDesc);
      ctx.filtros.mlb = (mlbFilter || "").trim() || null;
      ctx.filtros.mlbs = Array.isArray(mlbsFilter)
        ? mlbsFilter.map((id) => String(id || "").trim().toUpperCase()).filter(Boolean)
        : null;
      ctx.meta.filteredTotal = null;
      ctx.meta.filterLimit = ctx.filtros.maxDesc;
      ctx.meta.manualFlow = [
        "DEAL",
        "SELLER_CAMPAIGN",
        "SMART",
        "PRE_NEGOTIATED",
        "PRICE_MATCHING",
        "DOD",
        "LIGHTNING",
      ].includes(String(promotion_type || "").toUpperCase());

      // se os filtros mudam, cancelamos seleÃ§Ã£o global
      ctx.global.selectedAll = false;
      ctx.global.token = null;
      ctx.global.total = 0;
      ctx.global.ids = null;

      render();
    },

    setMeta(meta = {}) {
      if (Object.prototype.hasOwnProperty.call(meta, "filteredTotal")) {
        ctx.meta.filteredTotal = meta.filteredTotal;
      }
      if (Object.prototype.hasOwnProperty.call(meta, "manualPercent")) {
        ctx.meta.manualPercent = meta.manualPercent;
      }
      if (Object.prototype.hasOwnProperty.call(meta, "manualFlow")) {
        ctx.meta.manualFlow = !!meta.manualFlow;
      }
      if (Object.prototype.hasOwnProperty.call(meta, "filterLimit")) {
        ctx.meta.filterLimit = meta.filterLimit;
      }
      if (Object.prototype.hasOwnProperty.call(meta, "lightningStock")) {
        ctx.meta.lightningStock = meta.lightningStock;
      }
      render();
    },

    onHeaderToggle(checked) {
      ctx.headerChecked = !!checked;
      render();
    },

    getState() {
      return {
        promotion_id: ctx.promotion_id,
        promotion_type: ctx.promotion_type,
        filtros: {
          ...ctx.filtros,
          mlbs: Array.isArray(ctx.filtros.mlbs) ? ctx.filtros.mlbs.slice() : null,
        },
        headerChecked: !!ctx.headerChecked,
        global: {
          selectedAll: !!ctx.global.selectedAll,
          token: ctx.global.token || null,
          total: Number(ctx.global.total || 0),
          ids: Array.isArray(ctx.global.ids) ? ctx.global.ids.slice() : null,
        },
        meta: {
          filteredTotal: ctx.meta.filteredTotal,
          manualPercent: ctx.meta.manualPercent,
          manualFlow: !!ctx.meta.manualFlow,
          filterLimit: ctx.meta.filterLimit,
          lightningStock: ctx.meta.lightningStock,
        },
      };
    },

    setAccountContext(acc) {
      const normalized = normalizeAccountContext(acc);
      ctx.account.key = normalized.key;
      ctx.account.label = normalized.label;
      render();
    },
  };

  // Atualiza seleÃ§Ã£o quando os checkboxes da tabela mudarem
  document.addEventListener("change", (ev) => {
    if (ev.target?.matches?.('#tbody input[type="checkbox"][data-mlb]')) {
      render();
    }
  });

  // Re-render ao trocar linhas da tabela
  document.addEventListener("DOMContentLoaded", () => {
    ensureUI();
    render();
    const tbody = document.getElementById("tbody");
    if (tbody && "MutationObserver" in window) {
      const obs = new MutationObserver(() => render());
      obs.observe(tbody, { childList: true, subtree: false });
    }
  });
})();
