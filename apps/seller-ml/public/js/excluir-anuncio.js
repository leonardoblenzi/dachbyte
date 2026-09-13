// public/js/excluir-anuncio.js
(() => {
  const $ = (selector) => document.querySelector(selector);

  const __APP_BASE__ =
    window.__APP_BASE_PATH__ ||
    ((location.pathname || "").startsWith("/ml/") || (location.pathname || "") === "/ml"
      ? "/ml"
      : "");

  function withBase(path) {
    if (!__APP_BASE__) return path;
    if (!path) return __APP_BASE__;
    return path.startsWith("/") ? __APP_BASE__ + path : __APP_BASE__ + "/" + path;
  }

  const OPERATIONS = [
    {
      id: "ACTIVATE",
      label: "Ativar anuncios",
      description: "Reativa anuncios pausados usando status active.",
      confirmTitle: "Confirmar ativacao",
      confirmButton: "Confirmar ativacao",
      tone: "primary",
      visible: true,
    },
    {
      id: "PAUSE",
      label: "Pausar anuncios",
      description: "Pausa anuncios ativos usando status paused.",
      confirmTitle: "Confirmar pausa",
      confirmButton: "Confirmar pausa",
      tone: "primary",
      visible: true,
    },
    {
      id: "CLOSE",
      label: "Encerrar anuncios",
      description: "Fecha anuncios usando status closed. Anuncios fechados nao voltam para active.",
      confirmTitle: "Confirmar encerramento",
      confirmButton: "Confirmar encerramento",
      tone: "warning",
      visible: true,
    },
    {
      id: "DELETE",
      label: "Excluir anuncios",
      description: "Fecha quando necessario e marca como excluido. Acao irreversivel.",
      confirmTitle: "Confirmar exclusao",
      confirmButton: "Confirmar exclusao",
      tone: "danger",
      visible: true,
      requireTextForBulk: true,
    },
    {
      id: "CLOSE_RELIST",
      label: "Relistar anuncios",
      description: "Encerra e republica, gerando novo MLB quando possivel.",
      tone: "primary",
      visible: false,
    },
    {
      id: "PAUSE_RELIST",
      label: "Pausar e relistar",
      description: "Pausa antes de tentar relistar, com fallback para encerramento.",
      tone: "primary",
      visible: false,
    },
  ];

  const operationById = new Map(OPERATIONS.map((operation) => [operation.id, operation]));

  const listInput = $("#mlb-list");
  const listHelp = $("#mlb-list-help");
  const optionsWrap = $("#operation-options");
  const summary = $("#operation-summary");
  const btnStart = $("#btn-start-operation");
  const btnClear = $("#btn-limpar");
  const painel = $("#result-panel");
  const pre = $("#result-json");
  const friendly = $("#result-friendly");

  const modalConfirm = $("#modal-confirm-exclusao");
  const confirmTitle = $("#exConfirmTitle");
  const confirmEyebrow = $("#confirm-operation-eyebrow");
  const confirmText = $("#confirm-excluir-text");
  const confirmGate = $("#confirm-danger-gate");
  const confirmGateInput = $("#confirm-danger-input");
  const btnConfirm = $("#confirm-excluir-sim");
  const btnCancel = $("#confirm-excluir-nao");
  const btnClose = $("#confirm-excluir-close");

  let selectedOperation = "ACTIVATE";
  let pendingItems = [];
  let currentProcessJobId = null;
  let currentProcessBackendJobId = null;
  let monitorTimer = null;

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function parseMlbs(value) {
    const raw = String(value || "")
      .split(/[\s,;]+/)
      .map((entry) => entry.trim().toUpperCase())
      .filter(Boolean);

    const valid = [];
    const invalid = [];
    const seen = new Set();

    raw.forEach((entry) => {
      if (!/^MLB\d{5,}$/.test(entry)) {
        invalid.push(entry);
        return;
      }
      if (seen.has(entry)) return;
      seen.add(entry);
      valid.push(entry);
    });

    return { valid, invalid, rawCount: raw.length };
  }

  function currentOperation() {
    return operationById.get(selectedOperation) || operationById.get("ACTIVATE");
  }

  function renderOptions() {
    if (!optionsWrap) return;
    optionsWrap.innerHTML = OPERATIONS
      .filter((operation) => operation.visible)
      .map((operation) => {
        const active = operation.id === selectedOperation;
        const danger = operation.tone === "danger";
        return `
          <button
            class="ex-operation-option${active ? " is-active" : ""}${danger ? " is-danger" : ""}"
            type="button"
            role="radio"
            aria-checked="${active ? "true" : "false"}"
            data-operation="${escapeHtml(operation.id)}"
          >
            <span class="ex-operation-option__radio" aria-hidden="true"></span>
            <span>
              <span class="ex-operation-option__title">${escapeHtml(operation.label)}</span>
              <span class="ex-operation-option__text">${escapeHtml(operation.description)}</span>
            </span>
          </button>
        `;
      })
      .join("");
  }

  function updateSummary() {
    const parsed = parseMlbs(listInput?.value || "");
    const operation = currentOperation();
    const validCount = parsed.valid.length;
    const invalidCount = parsed.invalid.length;

    if (listHelp) {
      listHelp.textContent = validCount
        ? `${validCount} MLB(s) valido(s)${invalidCount ? `, ${invalidCount} entrada(s) ignorada(s)` : ""}.`
        : "A validacao remove duplicados e ignora entradas que nao seguem o formato MLB.";
    }

    if (!summary) return;
    summary.classList.toggle("is-danger", operation.tone === "danger");
    summary.innerHTML = `
      <span class="ex-operation-summary__label">Resumo</span>
      <strong>${validCount ? `${validCount} MLB(s) para ${escapeHtml(operation.label.toLowerCase())}` : "Nenhum MLB valido ainda"}</strong>
      <p>${
        validCount
          ? `${invalidCount ? `${invalidCount} entrada(s) serao ignorada(s). ` : ""}Clique em continuar para revisar e confirmar.`
          : "Cole a lista e selecione a operacao para revisar antes de iniciar."
      }</p>
    `;
  }

  function showResult(data, tone = "success") {
    if (!painel || !friendly) return;
    const title = data?.title || (tone === "success" ? "Job iniciado" : "Nao foi possivel iniciar");
    const text =
      data?.message ||
      "Acompanhe o andamento no painel de processos no canto inferior direito.";

    friendly.innerHTML = `
      <div class="result-callout result-callout--${tone === "error" ? "error" : "success"}">
        <h4 class="result-callout__title">${escapeHtml(title)}</h4>
        <p class="result-callout__text">${escapeHtml(text)}</p>
      </div>
    `;
    if (pre) pre.textContent = JSON.stringify(data, null, 2);
    painel.classList.remove("hidden");
  }

  function stopProcessMonitor() {
    if (!monitorTimer) return;
    clearInterval(monitorTimer);
    monitorTimer = null;
  }

  function startProcessMonitor(panelJobId, backendJobId) {
    currentProcessJobId = panelJobId || null;
    currentProcessBackendJobId = backendJobId || panelJobId || null;
    stopProcessMonitor();

    const tick = async () => {
      if (!currentProcessBackendJobId) return;
      try {
        const response = await fetch(
          withBase(`/api/excluir-anuncio/jobs/${encodeURIComponent(currentProcessBackendJobId)}`),
          {
            cache: "no-store",
            credentials: "same-origin",
            headers: { Accept: "application/json" },
          }
        );
        const payload = await response.json().catch(() => ({}));
        const job = payload?.job || payload || {};
        if (!response.ok) {
          throw new Error(payload?.error || payload?.message || `HTTP ${response.status}`);
        }

        const progress = Number(job.progress ?? 0) || 0;
        const processed = Number(job.processed ?? 0) || 0;
        const total = Number(job.total ?? 0) || 0;
        const errors = Number(job.errors ?? job.error_count ?? 0) || 0;
        const success = Number(job.success ?? job.succeeded ?? 0) || 0;
        const state = String(job.state || job.status || "processando");

        showResult({
          title: "Processamento em andamento",
          message: `${state} • ${processed}/${total || "-"} • ${progress}%`,
          jobId: currentProcessJobId,
          backendJobId: currentProcessBackendJobId,
          progress,
          processed,
          total,
          success,
          errors,
          state,
        });

        if (/conclu|finaliz|done|completed|cancel/i.test(state)) {
          stopProcessMonitor();
          showResult({
            title: "Processamento concluido",
            message: `Processados: ${processed}/${total || "-"} • Sucessos: ${success} • Erros: ${errors}`,
            jobId: currentProcessJobId,
            backendJobId: currentProcessBackendJobId,
            progress,
            processed,
            total,
            success,
            errors,
            state,
          });
        } else if (/erro|fail/i.test(state)) {
          stopProcessMonitor();
          showResult({
            title: "Processamento com erro",
            message: `Estado: ${state}. Processados: ${processed}/${total || "-"} • Erros: ${errors}`,
            jobId: currentProcessJobId,
            backendJobId: currentProcessBackendJobId,
            progress,
            processed,
            total,
            success,
            errors,
            state,
          }, "error");
        }
      } catch (error) {
        stopProcessMonitor();
        showResult({ title: "Falha ao acompanhar job", message: error?.message || String(error) }, "error");
      }
    };

    tick();
    monitorTimer = window.setInterval(tick, 3000);
  }

  function clearAll() {
    if (listInput) listInput.value = "";
    stopProcessMonitor();
    currentProcessJobId = null;
    currentProcessBackendJobId = null;
    if (painel) painel.classList.add("hidden");
    if (friendly) friendly.innerHTML = "";
    if (pre) pre.textContent = "{}";
    updateSummary();
  }

  function openConfirmModal(items) {
    const operation = currentOperation();
    pendingItems = items;

    if (confirmTitle) confirmTitle.textContent = operation.confirmTitle || "Confirmar operacao";
    if (confirmEyebrow) {
      confirmEyebrow.textContent = operation.tone === "danger" ? "Acao irreversivel" : "Confirmacao";
    }
    if (confirmText) {
      const countText = items.length === 1 ? "1 anuncio" : `${items.length} anuncios`;
      if (operation.id === "ACTIVATE") {
        confirmText.textContent = `Voce esta prestes a ativar ${countText}. Eles voltarao a ficar visiveis se nao houver bloqueio, moderacao ou falta de estoque.`;
      } else if (operation.id === "PAUSE") {
        confirmText.textContent = `Voce esta prestes a pausar ${countText}. Eles deixarao de ficar visiveis para compra enquanto estiverem pausados.`;
      } else if (operation.id === "CLOSE") {
        confirmText.textContent = `Voce esta prestes a encerrar ${countText}. Anuncios encerrados nao voltam para ativo; para vender novamente, e necessario republicar/relistar.`;
      } else {
        confirmText.textContent = `Voce esta prestes a excluir ${countText}. Essa acao e irreversivel e os anuncios nao poderao voltar para ativo.`;
      }
    }

    const needsGate = operation.requireTextForBulk && items.length > 1;
    if (confirmGate) confirmGate.hidden = !needsGate;
    if (confirmGateInput) confirmGateInput.value = "";
    if (btnConfirm) {
      btnConfirm.textContent = operation.confirmButton || "Confirmar";
      btnConfirm.classList.toggle("btn-danger", operation.tone === "danger");
      btnConfirm.classList.toggle("btn-primary", operation.tone !== "danger");
    }

    if (modalConfirm) {
      modalConfirm.style.display = "flex";
      modalConfirm.setAttribute("aria-hidden", "false");
    }
  }

  function closeConfirmModal() {
    if (modalConfirm) {
      modalConfirm.style.display = "none";
      modalConfirm.setAttribute("aria-hidden", "true");
    }
    pendingItems = [];
  }

  async function startOperation() {
    const operation = currentOperation();
    const itemsToProcess = pendingItems.slice();
    const needsGate = operation.requireTextForBulk && pendingItems.length > 1;
    if (needsGate && String(confirmGateInput?.value || "").trim().toUpperCase() !== "EXCLUIR") {
      confirmGateInput?.focus();
      return;
    }

    closeConfirmModal();

    try {
      if (!window.ExclusaoBulk || typeof window.ExclusaoBulk.enqueue !== "function") {
        throw new Error("Fila de gestao de anuncios nao esta disponivel nesta pagina.");
      }

      await window.ExclusaoBulk.enqueue({
        items: itemsToProcess,
        operation: operation.id,
        delayMs: 250,
        title: `${operation.label} (${itemsToProcess.length})`,
        onJobCreated(panelJobId, meta) {
          showResult({
            ok: true,
            title: "Operacao iniciada",
            message: "Acompanhando processamento nesta tela e no painel de processos.",
            operation: operation.id,
            total_ids: itemsToProcess.length,
            jobId: panelJobId,
            backendJobId: meta?.backendJobId || null,
          });
          startProcessMonitor(panelJobId, meta?.backendJobId || panelJobId);
        },
      });
    } catch (error) {
      showResult({ ok: false, error: error?.message || String(error) }, "error");
    }
  }

  optionsWrap?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-operation]");
    if (!button) return;
    selectedOperation = button.dataset.operation || selectedOperation;
    renderOptions();
    updateSummary();
  });

  listInput?.addEventListener("input", updateSummary);

  btnStart?.addEventListener("click", () => {
    const parsed = parseMlbs(listInput?.value || "");
    if (!parsed.valid.length) {
      showResult({
        ok: false,
        title: "Nenhum MLB valido",
        message: "Cole pelo menos um MLB valido antes de iniciar.",
      }, "error");
      return;
    }
    openConfirmModal(parsed.valid);
  });

  btnConfirm?.addEventListener("click", startOperation);
  btnCancel?.addEventListener("click", closeConfirmModal);
  btnClose?.addEventListener("click", closeConfirmModal);
  btnClear?.addEventListener("click", clearAll);
  window.addEventListener("beforeunload", stopProcessMonitor);

  window.addEventListener("click", (event) => {
    if (event.target === modalConfirm) closeConfirmModal();
  });

  renderOptions();
  updateSummary();
})();
