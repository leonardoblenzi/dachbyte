(function initBasePath() {
  if (typeof window === "undefined") return;
  if (window.__ML_BASE_PATH != null) return;
  const p = window.location && window.location.pathname ? window.location.pathname : "";
  window.__ML_BASE_PATH = p === "/ml" || p.startsWith("/ml/") ? "/ml" : "";
})();

function withBase(path) {
  const base =
    typeof window !== "undefined" && window.__ML_BASE_PATH
      ? window.__ML_BASE_PATH
      : "";
  if (!path || typeof path !== "string") return path;
  if (!base) return path;
  if (path === base || path.startsWith(base + "/")) return path;
  if (path.startsWith("/")) return base + path;
  return path;
}

(() => {
  const $ = (id) => document.getElementById(id);

  const el = {
    version: $("f-version"),
    title: $("f-title"),
    summary: $("f-summary"),
    novidades: $("f-novidades"),
    melhorias: $("f-melhorias"),
    correcoes: $("f-correcoes"),
    ctaLabel: $("f-cta-label"),
    ctaUrl: $("f-cta-url"),
    versionHelp: $("version-help"),
    btnSuggestVersion: $("btn-suggest-version"),
    btnPreview: $("btn-preview"),
    btnSave: $("btn-save"),
    btnSend: $("btn-send"),
    btnNew: $("btn-new"),
    btnDeleteSelected: $("btn-delete-selected"),
    historyList: $("history-list"),
    historyCheckAll: $("history-check-all"),
    previewFrame: $("preview-frame"),
    previewSubject: $("preview-subject"),
    previewStatus: $("preview-status"),
    draftStatusPill: $("draft-status-pill"),
    recipientList: $("recipient-list"),
    recipientSearch: $("recipient-search"),
    btnRecipientClear: $("btn-recipient-clear"),
    btnSelectAllRecipients: $("btn-select-all-recipients"),
    btnClearRecipients: $("btn-clear-recipients"),
    manualRecipientBlock: $("manual-recipient-block"),
    manualEmails: $("f-manual-emails"),
    recipientCountPill: $("recipient-count-pill"),
    toast: $("toast"),
  };

  const state = {
    noteId: null,
    notes: [],
    recipients: [],
    selectedRecipientIds: new Set(),
    selectedNoteIds: new Set(),
    previewHtml: "",
    previewSubject: "",
    audience: "manual",
  };

  function showToast(message, isError = false) {
    if (!el.toast) return;
    el.toast.textContent = message;
    el.toast.style.display = "block";
    el.toast.style.background = isError ? "#7f1d1d" : "#111827";
    el.toast.style.color = "#fff";
    setTimeout(() => {
      el.toast.style.display = "none";
    }, 3200);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleString("pt-BR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  async function api(path, options = {}) {
    const res = await fetch(withBase(path), {
      credentials: "include",
      cache: "no-store",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data?.error || data?.message || `HTTP ${res.status}`);
      error.status = res.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  async function ensureMasterAccess() {
    try {
      const data = await api("/api/auth/me", { method: "GET" });
      const logged = data?.logged === true || !!data?.user;
      const isMaster =
        data?.is_master === true ||
        String(data?.user?.nivel || "").trim().toLowerCase() === "admin_master";

      if (!logged) {
        window.location.href = withBase("/login");
        return false;
      }
      if (!isMaster) {
        window.location.href = withBase("/nao-autorizado");
        return false;
      }
      return true;
    } catch {
      window.location.href = withBase("/login");
      return false;
    }
  }

  function normalizeVersionInput(value) {
    return String(value || "").trim().replace(/^v/i, "");
  }

  function versionLooksValid(value) {
    return /^\d+\.\d+\.\d+$/.test(normalizeVersionInput(value));
  }

  function collectPayload() {
    return {
      id: state.noteId,
      version: normalizeVersionInput(el.version.value),
      title: el.title.value.trim(),
      summary: el.summary.value.trim(),
      novidades_text: el.novidades.value.trim(),
      melhorias_text: el.melhorias.value.trim(),
      correcoes_text: el.correcoes.value.trim(),
      cta_label: el.ctaLabel.value.trim(),
      cta_url: el.ctaUrl.value.trim(),
      audience: state.audience,
    };
  }

  function fillForm(note = {}) {
    state.noteId = note?.id || null;
    el.version.value = note?.version || "";
    el.title.value = note?.title || "";
    el.summary.value = note?.summary || "";
    el.novidades.value = note?.novidades_text || "";
    el.melhorias.value = note?.melhorias_text || "";
    el.correcoes.value = note?.correcoes_text || "";
    el.ctaLabel.value = note?.cta_label || "Abrir plataforma";
    el.ctaUrl.value = note?.cta_url || "";
    state.audience = note?.audience || "manual";

    document.querySelectorAll('input[name="audience"]').forEach((radio) => {
      radio.checked = radio.value === state.audience;
    });

    refreshAudienceUi();
    updateDraftPill(note);
    updateVersionHelp();
  }

  function resetForm() {
    fillForm({
      cta_label: "Abrir plataforma",
      audience: "manual",
    });
    state.selectedRecipientIds.clear();
    el.manualEmails.value = "";
    el.previewFrame.srcdoc = "";
    el.previewSubject.textContent = "—";
    el.previewStatus.textContent = "Ainda nao gerado";
    state.previewHtml = "";
    state.previewSubject = "";
    renderRecipients();
  }

  function updateDraftPill(note) {
    if (!el.draftStatusPill) return;
    if (!note?.id) {
      el.draftStatusPill.textContent = "Rascunho local";
      return;
    }
    const status =
      String(note.status || "draft").toLowerCase() === "sent"
        ? "Enviado"
        : "Rascunho salvo";
    el.draftStatusPill.textContent = `${status}${note.version ? ` • ${note.version}` : ""}`;
  }

  function updateVersionHelp() {
    const version = el.version.value;
    if (!version) {
      el.versionHelp.textContent = "Formato padrao: major.minor.patch";
      return;
    }
    el.versionHelp.textContent = versionLooksValid(version)
      ? "Versao valida. Padrao aceito: x.y.z"
      : "Versao invalida. Use o formato x.y.z, por exemplo 1.8.0.";
  }

  function suggestNextVersion() {
    const versions = state.notes
      .map((note) => String(note.version || ""))
      .filter((version) => /^\d+\.\d+\.\d+$/.test(version))
      .sort((a, b) => {
        const pa = a.split(".").map(Number);
        const pb = b.split(".").map(Number);
        for (let i = 0; i < 3; i += 1) {
          if (pa[i] !== pb[i]) return pb[i] - pa[i];
        }
        return 0;
      });

    const base = versions[0] || "1.0.0";
    const [major, minor, patch] = base.split(".").map(Number);
    el.version.value = `${major}.${minor}.${patch + 1}`;
    updateVersionHelp();
  }

  function refreshAudienceUi() {
    const manual = state.audience === "manual";
    if (el.manualRecipientBlock) {
      el.manualRecipientBlock.style.display = manual ? "block" : "none";
    }
    updateRecipientCount();
  }

  function updateRecipientCount() {
    const manualEmails = String(el.manualEmails.value || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    let count = 0;
    if (state.audience === "manual") {
      count = state.selectedRecipientIds.size + manualEmails.length;
    } else if (state.audience === "all_active") {
      count = state.recipients.length;
    } else if (state.audience === "admins") {
      count = state.recipients.filter((user) =>
        ["administrador", "admin_master"].includes(String(user.nivel || "").toLowerCase()),
      ).length;
    }

    el.recipientCountPill.textContent = `${count} selecionado${count === 1 ? "" : "s"}`;
  }

  function renderRecipients() {
    const query = String(el.recipientSearch.value || "").trim().toLowerCase();
    const filtered = state.recipients.filter((user) => {
      const hay = `${user.nome || ""} ${user.email || ""}`.toLowerCase();
      return !query || hay.includes(query);
    });

    if (!filtered.length) {
      el.recipientList.innerHTML = `<div class="table-empty">Nenhum destinatario encontrado.</div>`;
      updateRecipientCount();
      return;
    }

    el.recipientList.innerHTML = filtered
      .map((user) => {
        const checked = state.selectedRecipientIds.has(Number(user.id));
        const nivel = String(user.nivel || "usuario").toLowerCase();
        return `
          <label class="recipient-row">
            <input type="checkbox" data-recipient-id="${Number(user.id)}" ${checked ? "checked" : ""}>
            <div class="recipient-row__meta">
              <div class="recipient-row__name">${escapeHtml(user.nome || "Sem nome")}</div>
              <div class="recipient-row__email">${escapeHtml(user.email)}</div>
              <div class="recipient-row__tags">
                <span class="mini-badge">${escapeHtml(nivel)}</span>
                <span class="mini-badge">${escapeHtml(user.status || "ativo")}</span>
              </div>
            </div>
          </label>
        `;
      })
      .join("");

    el.recipientList.querySelectorAll("input[data-recipient-id]").forEach((input) => {
      input.addEventListener("change", () => {
        const id = Number(input.dataset.recipientId);
        if (input.checked) state.selectedRecipientIds.add(id);
        else state.selectedRecipientIds.delete(id);
        updateRecipientCount();
      });
    });

    updateRecipientCount();
  }

  function syncHistoryCheckAll() {
    if (!el.historyCheckAll) return;
    if (!state.notes.length) {
      el.historyCheckAll.checked = false;
      return;
    }
    el.historyCheckAll.checked = state.notes.every((note) =>
      state.selectedNoteIds.has(Number(note.id)),
    );
  }

  function renderHistory() {
    if (!state.notes.length) {
      el.historyList.innerHTML = `<tr><td colspan="6" class="table-empty">Nenhum patch note salvo ainda.</td></tr>`;
      syncHistoryCheckAll();
      return;
    }

    el.historyList.innerHTML = state.notes
      .map((note) => {
        const sent = String(note.status || "draft").toLowerCase() === "sent";
        const checked = state.selectedNoteIds.has(Number(note.id));
        return `
          <tr>
            <td style="text-align:center;">
              <input type="checkbox" data-history-id="${Number(note.id)}" ${checked ? "checked" : ""} aria-label="Selecionar patch note ${escapeHtml(note.version)}" />
            </td>
            <td><strong>${escapeHtml(note.version)}</strong></td>
            <td>
              <div class="history-item__title">${escapeHtml(note.title)}</div>
              <div class="history-item__summary">${escapeHtml(note.summary || "Sem resumo curto.")}</div>
            </td>
            <td><span class="pill">${escapeHtml(sent ? "Enviado" : "Rascunho")}</span></td>
            <td>${escapeHtml(formatDate(note.updated_at))}</td>
            <td>
              <div class="history-item__actions">
                <button class="btn-lite" type="button" data-open-note="${Number(note.id)}">Abrir</button>
                <button class="btn-lite" type="button" data-preview-note="${Number(note.id)}">Visualizar</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");

    el.historyList.querySelectorAll("[data-history-id]").forEach((input) => {
      input.addEventListener("change", () => {
        const id = Number(input.dataset.historyId);
        if (input.checked) state.selectedNoteIds.add(id);
        else state.selectedNoteIds.delete(id);
        syncHistoryCheckAll();
      });
    });

    el.historyList.querySelectorAll("[data-open-note]").forEach((button) => {
      button.addEventListener("click", async () => {
        await openNote(Number(button.dataset.openNote));
      });
    });

    el.historyList.querySelectorAll("[data-preview-note]").forEach((button) => {
      button.addEventListener("click", async () => {
        await openNote(Number(button.dataset.previewNote));
        await previewCurrent();
      });
    });

    syncHistoryCheckAll();
  }

  async function loadRecipients() {
    const data = await api("/api/admin/patch-notes/recipients");
    state.recipients = Array.isArray(data.recipients) ? data.recipients : [];
    renderRecipients();
  }

  async function loadHistory() {
    const data = await api("/api/admin/patch-notes?limit=30");
    state.notes = Array.isArray(data.notes) ? data.notes : [];
    state.selectedNoteIds.forEach((id) => {
      if (!state.notes.some((note) => Number(note.id) === id)) {
        state.selectedNoteIds.delete(id);
      }
    });
    renderHistory();
  }

  async function openNote(id) {
    const data = await api(`/api/admin/patch-notes/${id}`);
    fillForm(data.note);
    if (state.audience !== "manual") {
      state.selectedRecipientIds.clear();
    }
    updateRecipientCount();
  }

  async function saveCurrent() {
    const payload = collectPayload();
    if (!payload.version || !payload.title) {
      throw new Error("Preencha ao menos a versao e o titulo.");
    }

    const data = await api("/api/admin/patch-notes", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    fillForm(data.note);
    await loadHistory();
    return data.note;
  }

  async function previewCurrent() {
    const payload = collectPayload();
    const data = await api("/api/admin/patch-notes/preview", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    state.previewHtml = data.html || "";
    state.previewSubject = data.subject || "";
    el.previewSubject.textContent = state.previewSubject || "—";
    el.previewStatus.textContent = "Preview atualizado";
    el.previewFrame.srcdoc =
      state.previewHtml || "<p style='font-family:Arial;padding:24px'>Sem preview.</p>";
    return data;
  }

  function collectManualEmails() {
    return String(el.manualEmails.value || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((email) => ({ email }));
  }

  async function sendCurrent() {
    let noteId = state.noteId;
    if (!noteId) {
      const saved = await saveCurrent();
      noteId = saved.id;
    }

    const payload = {
      audience: state.audience,
      recipient_ids: [...state.selectedRecipientIds],
      manual_emails: collectManualEmails(),
    };

    const data = await api(`/api/admin/patch-notes/${noteId}/send`, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    await loadHistory();
    if (state.noteId) {
      const refreshed = await api(`/api/admin/patch-notes/${state.noteId}`);
      fillForm(refreshed.note);
    }
    return data;
  }

  async function deleteSelectedNotes() {
    const ids = [...state.selectedNoteIds];
    if (!ids.length) {
      throw new Error("Selecione ao menos um patch note para excluir.");
    }

    const confirmed = window.confirm(
      `Excluir ${ids.length} patch note(s) selecionado(s)? Essa acao nao pode ser desfeita.`,
    );
    if (!confirmed) return null;

    const data = await api("/api/admin/patch-notes/delete", {
      method: "POST",
      body: JSON.stringify({ ids }),
    });

    state.selectedNoteIds.clear();
    if (state.noteId && data.deletedIds?.includes(Number(state.noteId))) {
      resetForm();
    }
    await loadHistory();
    return data;
  }

  function bindEvents() {
    el.btnSuggestVersion.addEventListener("click", suggestNextVersion);
    el.btnNew.addEventListener("click", resetForm);

    el.btnPreview.addEventListener("click", async () => {
      try {
        await previewCurrent();
        showToast("Preview atualizado.");
      } catch (err) {
        showToast(err.message || "Falha ao gerar preview.", true);
      }
    });

    el.btnSave.addEventListener("click", async () => {
      try {
        const saved = await saveCurrent();
        showToast(`Patch note ${saved.version} salvo com sucesso.`);
      } catch (err) {
        showToast(err.message || "Falha ao salvar patch note.", true);
      }
    });

    el.btnSend.addEventListener("click", async () => {
      try {
        if (
          state.audience === "manual" &&
          !state.selectedRecipientIds.size &&
          !collectManualEmails().length
        ) {
          throw new Error("Selecione ao menos um destinatario ou informe emails extras.");
        }
        const result = await sendCurrent();
        showToast(
          `Envio concluido: ${result.sent_count} enviado(s), ${result.failed_count} falha(s), ${result.skipped_count} ignorado(s).`,
          result.failed_count > 0,
        );
      } catch (err) {
        showToast(err.message || "Falha ao enviar patch notes.", true);
      }
    });

    el.btnDeleteSelected.addEventListener("click", async () => {
      try {
        const result = await deleteSelectedNotes();
        if (!result) return;
        showToast(`${result.deletedCount} patch note(s) excluido(s).`);
      } catch (err) {
        showToast(err.message || "Falha ao excluir patch notes.", true);
      }
    });

    el.version.addEventListener("input", updateVersionHelp);
    el.recipientSearch.addEventListener("input", renderRecipients);
    el.btnRecipientClear.addEventListener("click", () => {
      el.recipientSearch.value = "";
      renderRecipients();
    });
    el.manualEmails.addEventListener("input", updateRecipientCount);

    el.btnSelectAllRecipients.addEventListener("click", () => {
      const query = String(el.recipientSearch.value || "").trim().toLowerCase();
      state.recipients.forEach((user) => {
        const hay = `${user.nome || ""} ${user.email || ""}`.toLowerCase();
        if (!query || hay.includes(query)) {
          state.selectedRecipientIds.add(Number(user.id));
        }
      });
      renderRecipients();
    });

    el.btnClearRecipients.addEventListener("click", () => {
      state.selectedRecipientIds.clear();
      renderRecipients();
    });

    el.historyCheckAll.addEventListener("change", () => {
      if (el.historyCheckAll.checked) {
        state.notes.forEach((note) => state.selectedNoteIds.add(Number(note.id)));
      } else {
        state.selectedNoteIds.clear();
      }
      renderHistory();
    });

    document.querySelectorAll('input[name="audience"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        state.audience = radio.value;
        refreshAudienceUi();
      });
    });
  }

  async function init() {
    const ok = await ensureMasterAccess();
    if (!ok) return;

    bindEvents();
    resetForm();
    await Promise.all([loadRecipients(), loadHistory()]);
  }

  init().catch((err) => {
    console.error("admin-patch-notes init erro:", err);
    showToast("Falha ao carregar a tela de patch notes.", true);
  });
})();
