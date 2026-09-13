(() => {
  const state = {
    isProcessing: false,
    pendingBulkItems: [],
  };

  const apiUrl = (path) => (window.mlUrl ? window.mlUrl(path) : path);
  const $ = (id) => document.getElementById(id);

  function normalizeMlb(value) {
    return String(value || "").trim().toUpperCase();
  }

  function isValidMlb(value) {
    return /^MLB\d{6,}$/.test(normalizeMlb(value));
  }

  function tokenizeMlbs(text) {
    return String(text || "")
      .toUpperCase()
      .split(/[\s,;]+/)
      .map((value) => value.trim())
      .filter(Boolean);
  }

  function parseBulk(text) {
    const raw = tokenizeMlbs(text);
    const unique = Array.from(new Set(raw));
    const valid = unique.filter(isValidMlb);
    return {
      identified: unique.length,
      valid,
      invalid: unique.length - valid.length,
    };
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      button.dataset.label = button.textContent;
      button.textContent = label || "Processando...";
      button.disabled = true;
      return;
    }
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
  }

  function setResult(type, html) {
    const node = $("resultado");
    if (!node) return;
    node.hidden = false;
    node.innerHTML = `<div class="result ${type}">${html}</div>`;
  }

  function clearResult() {
    const node = $("resultado");
    if (!node) return;
    node.hidden = true;
    node.innerHTML = "";
  }

  function switchMode(mode) {
    const single = mode !== "bulk";
    $("removeModeSingle")?.classList.toggle("is-active", single);
    $("removeModeBulk")?.classList.toggle("is-active", !single);
    $("removeModeSingle")?.setAttribute("aria-selected", String(single));
    $("removeModeBulk")?.setAttribute("aria-selected", String(!single));

    const singlePanel = $("removeSinglePanel");
    const bulkPanel = $("removeBulkPanel");
    singlePanel?.classList.toggle("is-active", single);
    bulkPanel?.classList.toggle("is-active", !single);
    if (singlePanel) singlePanel.hidden = !single;
    if (bulkPanel) bulkPanel.hidden = single;
    clearResult();
  }

  function renderSingleSuccess(data) {
    const details = [
      data.titulo ? `Anúncio: ${data.titulo}` : "",
      data.mlb_id ? `MLB: ${data.mlb_id}` : "",
      data.message ? `Status: ${data.message}` : "",
      data.preco_antes ? `Preço antes: R$ ${data.preco_antes}` : "",
      data.preco_depois ? `Preço depois: R$ ${data.preco_depois}` : "",
      data.ainda_tem_promocao !== undefined
        ? `Ainda possui promoção: ${data.ainda_tem_promocao ? "SIM" : "NÃO"}`
        : "",
    ].filter(Boolean);

    return `<strong>Promoção removida com sucesso.</strong>${details.length ? `<br>${details.join("<br>")}` : ""}`;
  }

  async function removerUnico() {
    if (state.isProcessing) return;

    const input = $("mlbId");
    const mlbId = normalizeMlb(input?.value);
    if (!isValidMlb(mlbId)) {
      input?.focus();
      setResult("error", "<strong>MLB inválido.</strong><br>Use o formato MLB1234567890.");
      return;
    }

    const button = $("btnRemoveSingle");
    state.isProcessing = true;
    setBusy(button, true, "Removendo...");
    setResult("info", "<strong>Removendo promoção...</strong><br>Aguarde o retorno da API.");

    try {
      const response = await fetch(apiUrl("/anuncio/remover-promocao"), {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ mlb_id: mlbId }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) {
        setResult(
          "error",
          `<strong>Falha ao remover promoção.</strong><br>${data.message || data.error || `HTTP ${response.status}`}`,
        );
        return;
      }

      setResult("success", renderSingleSuccess(data));
    } catch (error) {
      setResult("error", `<strong>Erro de conexão.</strong><br>${error?.message || error}`);
    } finally {
      state.isProcessing = false;
      setBusy(button, false);
    }
  }

  function updateBulkStats() {
    const parsed = parseBulk($("mlbIds")?.value);
    $("bulkIdentifiedCount").textContent = String(parsed.identified);
    $("bulkValidCount").textContent = String(parsed.valid.length);
    $("bulkInvalidCount").textContent = String(parsed.invalid);

    const textarea = $("mlbIds");
    textarea?.classList.toggle("is-valid", parsed.identified > 0 && parsed.invalid === 0);
    textarea?.classList.toggle("is-invalid", parsed.invalid > 0);

    const button = $("btnRemoveBulk");
    if (button && !state.isProcessing) button.disabled = parsed.valid.length === 0;
    return parsed;
  }

  function openBulkConfirmation() {
    if (state.isProcessing) return;
    const parsed = updateBulkStats();
    if (!parsed.valid.length) {
      $("mlbIds")?.focus();
      return;
    }

    state.pendingBulkItems = parsed.valid;
    $("bulkConfirmSummary").innerHTML = `
      <strong>${parsed.valid.length} anúncio(s)</strong> serão enviados para remoção.<br>
      ${parsed.invalid ? `${parsed.invalid} entrada(s) inválida(s) serão ignoradas.` : "Todos os MLBs identificados são válidos."}
    `;
    const modal = $("bulkConfirmModal");
    if (modal) {
      modal.hidden = false;
      modal.setAttribute("aria-hidden", "false");
    }
  }

  function closeBulkConfirmation() {
    const modal = $("bulkConfirmModal");
    if (modal) {
      modal.hidden = true;
      modal.setAttribute("aria-hidden", "true");
    }
  }

  async function confirmarRemocaoLote() {
    if (state.isProcessing || !state.pendingBulkItems.length) return;
    if (!window.RemocaoBulk || typeof window.RemocaoBulk.enqueue !== "function") {
      closeBulkConfirmation();
      setResult("error", "<strong>Fila de remoção indisponível.</strong><br>Recarregue a página e tente novamente.");
      return;
    }

    const items = [...state.pendingBulkItems];
    const button = $("btnConfirmBulkRemove");
    state.isProcessing = true;
    setBusy(button, true, "Enviando...");

    try {
      await window.RemocaoBulk.enqueue({
        items,
        delayMs: 250,
        title: `Remoção - ${items.length} itens`,
        onJobCreated(jobId) {
          setResult(
            "success",
            `<strong>Remoção enviada para processamento.</strong><br>${items.length} anúncio(s) no lote${jobId ? ` · Job ${jobId}` : ""}. Acompanhe pelo Painel de Processos.`,
          );
          window.JobsPanel?.show?.();
        },
      });
      closeBulkConfirmation();
      window.JobsPanel?.show?.();
    } catch (error) {
      closeBulkConfirmation();
      setResult("error", `<strong>Falha ao iniciar o lote.</strong><br>${error?.message || error}`);
    } finally {
      state.isProcessing = false;
      state.pendingBulkItems = [];
      setBusy(button, false);
      updateBulkStats();
    }
  }

  function bindValidation() {
    const single = $("mlbId");
    single?.addEventListener("input", () => {
      const value = normalizeMlb(single.value);
      single.classList.toggle("is-valid", !!value && isValidMlb(value));
      single.classList.toggle("is-invalid", !!value && !isValidMlb(value));
    });

    $("mlbIds")?.addEventListener("input", updateBulkStats);
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-remove-mode]").forEach((button) => {
      button.addEventListener("click", () => switchMode(button.dataset.removeMode));
    });

    $("btnRemoveSingle")?.addEventListener("click", removerUnico);
    $("btnRemoveBulk")?.addEventListener("click", openBulkConfirmation);
    $("btnCancelBulkRemove")?.addEventListener("click", closeBulkConfirmation);
    $("btnConfirmBulkRemove")?.addEventListener("click", confirmarRemocaoLote);
    $("bulkConfirmModal")?.addEventListener("click", (event) => {
      if (event.target === $("bulkConfirmModal")) closeBulkConfirmation();
    });

    bindValidation();
    updateBulkStats();
    window.RemocaoBulk?.startWatcher?.();

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeBulkConfirmation();
      if (event.ctrlKey && !event.shiftKey && event.key === "Enter") {
        event.preventDefault();
        removerUnico();
      }
      if (event.ctrlKey && event.shiftKey && event.key === "Enter") {
        event.preventDefault();
        openBulkConfirmation();
      }
    });
  });
})();
