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

(() => {
  const $ = (id) => document.getElementById(id);

  const tbody = $("tbody");
  const search = $("search");
  const btnClear = $("btn-clear");
  const btnCreate = $("btn-create");
  const btnRefresh = $("btn-refresh");

  const btnPrev = $("btn-prev");
  const btnNext = $("btn-next");
  const pageInfo = $("page-info");
  const rangeInfo = $("range-info");
  const countPill = $("count-pill");

  const modal = $("modal-empresa");
  const modalTitle = $("modal-title");
  const modalClose = $("modal-close");
  const btnCancel = $("btn-cancel");
  const btnSave = $("btn-save");

  const fNome = $("f-nome");
  const fDocumentType = $("f-document-type");
  const fDocumentNumber = $("f-document-number");
  const fTenantGlobalId = $("f-tenant-global-id");
  const formError = $("form-error");
  const toast = $("toast");
  const deleteModal = $("modal-delete");
  const deleteTitle = $("delete-title");
  const deleteClose = $("delete-close");
  const deleteCancel = $("delete-cancel");
  const deleteConfirm = $("delete-confirm");
  const deleteRefresh = $("delete-refresh");
  const deleteSummary = $("delete-summary");
  const deleteImpactBody = $("delete-impact-body");
  const deleteError = $("delete-error");
  const deletionHistorySearch = $("deletion-history-search");
  const deletionHistoryFrom = $("deletion-history-from");
  const deletionHistoryTo = $("deletion-history-to");
  const deletionHistoryOperator = $("deletion-history-operator");
  const deletionHistoryRefresh = $("deletion-history-refresh");
  const deletionHistoryBody = $("deletion-history-body");
  const deletionHistoryInfo = $("deletion-history-info");
  const deletionHistoryPage = $("deletion-history-page");
  const deletionHistoryPrev = $("deletion-history-prev");
  const deletionHistoryNext = $("deletion-history-next");

  let all = [];
  let filtered = [];
  let page = 1;
  const perPage = 25;

  let mode = "create";
  let editingId = null;
  let deletingId = null;
  let deleteImpact = null;
  let deletionHistoryCurrentPage = 1;
  let deletionHistoryTotal = 0;
  const deletionHistoryPageSize = 25;

  function showToast(msg) {
    toast.textContent = msg;
    toast.style.display = "block";
    setTimeout(() => (toast.style.display = "none"), 2400);
  }

  function showModal() {
    modal.style.display = "flex";
    modal.setAttribute("aria-hidden", "false");
  }

  function hideModal() {
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
  }

  function showDeleteModal() {
    deleteModal.style.display = "flex";
    deleteModal.setAttribute("aria-hidden", "false");
  }

  function hideDeleteModal() {
    deleteModal.style.display = "none";
    deleteModal.setAttribute("aria-hidden", "true");
    deletingId = null;
    deleteImpact = null;
    if (deleteError) {
      deleteError.style.display = "none";
      deleteError.textContent = "";
    }
  }

  function setError(msg) {
    if (!msg) {
      formError.style.display = "none";
      formError.textContent = "";
      return;
    }
    formError.style.display = "block";
    formError.textContent = msg;
  }

  function setDeleteError(msg) {
    if (!deleteError) return;
    deleteError.style.display = msg ? "block" : "none";
    deleteError.textContent = msg || "";
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatDate(v) {
    if (!v) return "-";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return "-";
    return d.toLocaleString("pt-BR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function normalizeDigits(value) {
    return String(value || "").replace(/\D+/g, "");
  }

  function formatDocument(type, value) {
    const digits = normalizeDigits(value);
    if (!digits) return "-";
    if (type === "CPF" && digits.length === 11) {
      return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
    }
    if (type === "CNPJ" && digits.length === 14) {
      return digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
    }
    return digits;
  }

  function formatUser(user) {
    const name = user?.nome || user?.email || `Usuario #${user?.id || "-"}`;
    const email = user?.email ? ` (${user.email})` : "";
    return `${name}${email}`;
  }

  function renderImpactList(label, rows, emptyText) {
    const values = Array.isArray(rows) ? rows : [];
    const content = values.length
      ? `<ul class="impact-list">${values.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
      : `<span class="muted">${escapeHtml(emptyText)}</span>`;
    return `
      <tr>
        <td><strong>${escapeHtml(label)}</strong></td>
        <td>${content}</td>
      </tr>
    `;
  }

  function renderDeleteImpact() {
    if (!deleteImpact) return;
    const empresa = deleteImpact.empresa || {};
    const counts = deleteImpact.counts || {};
    const usersDeleted = (deleteImpact.usersToDelete || []).map(formatUser);
    const usersUnlinked = (deleteImpact.usersToUnlink || []).map((user) =>
      `${formatUser(user)} - sera mantido por possuir outro vinculo`,
    );
    const accounts = (deleteImpact.accounts || []).map((account) =>
      `${account.apelido || "Conta ML"} - ML ${account.meli_user_id || account.id}`,
    );

    deleteTitle.textContent = `Excluir ${empresa.nome || `empresa #${deletingId}`}`;
    deleteSummary.textContent =
      `Ao confirmar, ${Number(counts.usersToDelete || 0)} usuario(s) serao excluido(s), ` +
      `${Number(counts.usersToUnlink || 0)} usuario(s) serao apenas desvinculado(s), ` +
      `${Number(counts.accounts || 0)} conta(s) ML e ${Number(counts.auditEvents || 0)} evento(s) de auditoria serao removidos.`;

    const activeJobs = Array.isArray(deleteImpact.activeJobs) ? deleteImpact.activeJobs : [];
    const inspectionFailures = Array.isArray(deleteImpact.inspectionFailures) ? deleteImpact.inspectionFailures : [];
    const blockedRows = [
      ...activeJobs.map((job) => `${job.provider || "provider desconhecido"} — conta ${job.accountKey || "-"} — ${job.status || "status desconhecido"}`),
      ...inspectionFailures.map((failure) => `Falha ao inspecionar jobs: ${failure.provider || "provider desconhecido"} — conta ${failure.accountKey || "-"}`),
    ];

    deleteImpactBody.innerHTML = [
      renderImpactList("Usuarios excluidos", usersDeleted, "Nenhum usuario sera excluido."),
      renderImpactList("Usuarios mantidos", usersUnlinked, "Nenhum usuario compartilhado com outra empresa."),
      renderImpactList("Contas ML removidas", accounts, "Nenhuma conta ML vinculada."),
      renderImpactList("Eventos de auditoria removidos", [String(Number(counts.auditEvents || 0))], "Nenhum evento de auditoria vinculado."),
      ...(blockedRows.length ? [renderImpactList("Jobs ativos impedem a exclusao", blockedRows, "")] : []),
    ].join("");

    const blocked = deleteImpact.canDelete === false || deleteImpact.blocked;
    deleteConfirm.disabled = blocked;
    if (blocked) {
      setDeleteError("A exclusao esta bloqueada porque ha jobs ativos ou uma falha ao inspecionar jobs. Atualize o impacto apos resolver os bloqueios.");
    }
  }

  function deletionHistoryFilters() {
    const params = new URLSearchParams({
      page: String(deletionHistoryCurrentPage),
      pageSize: String(deletionHistoryPageSize),
    });
    const values = {
      search: deletionHistorySearch?.value,
      from: deletionHistoryFrom?.value,
      to: deletionHistoryTo?.value,
      operator: deletionHistoryOperator?.value,
    };
    Object.entries(values).forEach(([key, value]) => {
      const clean = String(value || "").trim();
      if (clean) params.set(key, clean);
    });
    return params;
  }

  function renderDeletionHistory(receipts = []) {
    if (!deletionHistoryBody) return;
    if (!receipts.length) {
      deletionHistoryBody.innerHTML = '<tr><td colspan="5" class="table-empty">Nenhuma exclusao encontrada.</td></tr>';
      return;
    }
    deletionHistoryBody.innerHTML = receipts.map((receipt) => {
      const companyName = escapeHtml(receipt.empresa_nome || "Empresa removida");
      const companyId = escapeHtml(receipt.deleted_empresa_id || "-");
      const operator = receipt.operator_email
        ? escapeHtml(receipt.operator_email)
        : receipt.actor_user_id ? `Usuario #${escapeHtml(receipt.actor_user_id)}` : "-";
      const impact = [
        `${Number(receipt.users_deleted_count || 0)} usuario(s) excluido(s)`,
        `${Number(receipt.users_unlinked_count || 0)} desvinculado(s)`,
        `${Number(receipt.accounts_deleted_count || 0)} conta(s) ML`,
        `${Number(receipt.audit_events_deleted_count || 0)} evento(s) de auditoria`,
      ].map(escapeHtml).join("<br>");
      return `<tr>
        <td><strong>${companyName}</strong><br><span class="muted">ID ${companyId}</span></td>
        <td>${escapeHtml(formatDate(receipt.deleted_at))}</td>
        <td>${operator}</td>
        <td>${impact}</td>
        <td>${escapeHtml(receipt.status || "-")}<br><code>${escapeHtml(receipt.request_id || "-")}</code></td>
      </tr>`;
    }).join("");
  }

  async function loadDeletionHistory() {
    if (!deletionHistoryBody) return;
    deletionHistoryBody.innerHTML = '<tr><td colspan="5" class="table-empty">Carregando historico...</td></tr>';
    try {
      const data = await api(`/api/admin/empresas/deletion-receipts?${deletionHistoryFilters().toString()}`, { method: "GET" });
      const receipts = Array.isArray(data.receipts) ? data.receipts : [];
      deletionHistoryCurrentPage = Number(data.page || deletionHistoryCurrentPage);
      deletionHistoryTotal = Number(data.total || 0);
      const pages = Math.max(1, Math.ceil(deletionHistoryTotal / deletionHistoryPageSize));
      renderDeletionHistory(receipts);
      deletionHistoryInfo.textContent = deletionHistoryTotal ? `${deletionHistoryTotal} exclusao(oes) registrada(s)` : "Nenhuma exclusao registrada";
      deletionHistoryPage.textContent = `${deletionHistoryCurrentPage} / ${pages}`;
      deletionHistoryPrev.disabled = deletionHistoryCurrentPage <= 1;
      deletionHistoryNext.disabled = deletionHistoryCurrentPage >= pages;
    } catch (e) {
      console.error(e);
      deletionHistoryBody.innerHTML = `<tr><td colspan="5" class="table-empty">Erro ao carregar historico: ${escapeHtml(e.message)}</td></tr>`;
      deletionHistoryInfo.textContent = "Historico indisponivel";
      deletionHistoryPrev.disabled = true;
      deletionHistoryNext.disabled = true;
    }
  }

  function applyDocumentMask() {
    const type = String(fDocumentType.value || "").trim().toUpperCase();
    const digits = normalizeDigits(fDocumentNumber.value);
    if (!digits) {
      fDocumentNumber.value = "";
      return;
    }

    if (type === "CPF") {
      fDocumentNumber.value = digits
        .slice(0, 11)
        .replace(/(\d{3})(\d)/, "$1.$2")
        .replace(/(\d{3})(\d)/, "$1.$2")
        .replace(/(\d{3})(\d{1,2})$/, "$1-$2");
      return;
    }

    if (type === "CNPJ") {
      fDocumentNumber.value = digits
        .slice(0, 14)
        .replace(/(\d{2})(\d)/, "$1.$2")
        .replace(/(\d{3})(\d)/, "$1.$2")
        .replace(/(\d{3})(\d)/, "$1/$2")
        .replace(/(\d{4})(\d{1,2})$/, "$1-$2");
      return;
    }

    fDocumentNumber.value = digits;
  }

  function applyFilter() {
    const q = String(search.value || "").trim().toLowerCase();
    if (!q) {
      filtered = [...all];
    } else {
      filtered = all.filter((e) => {
        const nome = String(e.nome || "").toLowerCase();
        const tenant = String(e.tenant_global_id || "").toLowerCase();
        const document = `${String(e.document_type || "")} ${String(e.document_number || "")}`.toLowerCase();
        return (
          nome.includes(q) ||
          tenant.includes(q) ||
          document.includes(q) ||
          String(e.id).includes(q)
        );
      });
    }
    page = 1;
    render();
  }

  function paginate(list) {
    const total = list.length;
    const pages = Math.max(1, Math.ceil(total / perPage));
    page = Math.min(Math.max(1, page), pages);

    const start = (page - 1) * perPage;
    const end = Math.min(start + perPage, total);
    const slice = list.slice(start, end);

    return { total, pages, start, end, slice };
  }

  function render() {
    const { total, pages, start, end, slice } = paginate(filtered);

    countPill.textContent = `${total} empresa${total === 1 ? "" : "s"}`;
    pageInfo.textContent = `${page} / ${pages}`;
    rangeInfo.textContent = total
      ? `Mostrando ${start + 1}-${end} de ${total}`
      : "Nenhuma empresa encontrada";

    btnPrev.disabled = page <= 1;
    btnNext.disabled = page >= pages;

    if (!slice.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="table-empty">Nenhuma empresa encontrada.</td></tr>`;
      return;
    }

    tbody.innerHTML = slice
      .map((e) => {
        const id = e.id;
        const nome = escapeHtml(e.nome || "-");
        const document = e.document_number
          ? `${escapeHtml(e.document_type || "")}: ${escapeHtml(formatDocument(e.document_type, e.document_number))}`
          : "-";
        const tenant = escapeHtml(e.tenant_global_id || "-");
        const users = Number(e.usuarios_count || 0);
        const contas = Number(e.contas_ml_count || 0);

        return `
          <tr>
            <td>${id}</td>
            <td>${nome}</td>
            <td>${document}</td>
            <td><code>${tenant}</code></td>
            <td style="text-align:center;">${users}</td>
            <td style="text-align:center;">${contas}</td>
            <td>${formatDate(e.criado_em)}</td>
            <td>
              <div class="actions">
                <button class="icon-btn" data-action="edit" data-id="${id}" title="Editar">✏️</button>
                <button class="icon-btn danger" data-action="delete" data-id="${id}" title="Remover">🗑️</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  async function api(path, options = {}) {
    const res = await fetch(withBase(path), {
      credentials: "include",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error || data?.message || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  async function loadEmpresas() {
    tbody.innerHTML = `<tr><td colspan="8" class="table-empty">Carregando...</td></tr>`;
    try {
      const data = await api("/api/admin/empresas", { method: "GET" });
      all = Array.isArray(data.empresas) ? data.empresas : [];
      filtered = [...all];
      applyFilter();
      showToast("Lista atualizada.");
    } catch (e) {
      console.error(e);
      tbody.innerHTML = `<tr><td colspan="8" class="table-empty">Erro ao carregar: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  function openCreate() {
    mode = "create";
    editingId = null;

    modalTitle.textContent = "Cadastrar empresa";
    fNome.value = "";
    fDocumentType.value = "";
    fDocumentNumber.value = "";
    fTenantGlobalId.value = "";
    setError("");
    showModal();
    fNome.focus();
  }

  function openEdit(row) {
    mode = "edit";
    editingId = row.id;

    modalTitle.textContent = `Editar empresa #${row.id}`;
    fNome.value = row.nome || "";
    fDocumentType.value = row.document_type || "";
    fDocumentNumber.value = formatDocument(row.document_type, row.document_number || "");
    fTenantGlobalId.value = row.tenant_global_id || "";
    setError("");
    showModal();
    fNome.focus();
  }

  async function saveEmpresa() {
    setError("");

    const nome = String(fNome.value || "").trim();
    const documentType = String(fDocumentType.value || "").trim().toUpperCase();
    const documentNumber = normalizeDigits(fDocumentNumber.value);
    const tenantGlobalId = String(fTenantGlobalId.value || "").trim();

    if (!nome) return setError("Informe o nome da empresa.");
    if (documentNumber && !documentType) return setError("Selecione o tipo do documento.");
    if (documentType === "CPF" && documentNumber && documentNumber.length !== 11) {
      return setError("CPF deve ter 11 digitos.");
    }
    if (documentType === "CNPJ" && documentNumber && documentNumber.length !== 14) {
      return setError("CNPJ deve ter 14 digitos.");
    }

    btnSave.disabled = true;
    btnSave.textContent = "Salvando...";

    try {
      const payload = {
        nome,
        document_type: documentType || null,
        document_number: documentNumber || null,
        tenant_global_id: tenantGlobalId || null,
      };

      if (mode === "create") {
        await api("/api/admin/empresas", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        showToast("Empresa criada.");
      } else {
        await api(`/api/admin/empresas/${editingId}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        showToast("Empresa atualizada.");
      }

      hideModal();
      await loadEmpresas();
    } catch (e) {
      console.error(e);
      setError(e.message || "Erro ao salvar.");
    } finally {
      btnSave.disabled = false;
      btnSave.textContent = "Salvar";
    }
  }

  async function openDeleteEmpresa(id) {
    deletingId = Number(id);
    deleteImpact = null;
    setDeleteError("");
    deleteTitle.textContent = "Confirmar exclusao";
    deleteSummary.textContent = "Carregando impacto da exclusao...";
    deleteImpactBody.innerHTML = `<tr><td colspan="2" class="table-empty">Carregando...</td></tr>`;
    deleteConfirm.disabled = true;
    showDeleteModal();

    try {
      deleteImpact = await api(`/api/admin/empresas/${deletingId}/delete-preview`, { method: "GET" });
      renderDeleteImpact();
      deleteConfirm.disabled = deleteImpact.canDelete === false || deleteImpact.blocked;
    } catch (e) {
      console.error(e);
      setDeleteError(e.message || "Erro ao calcular impacto da exclusao.");
      deleteImpactBody.innerHTML = `<tr><td colspan="2" class="table-empty">Nao foi possivel carregar o impacto.</td></tr>`;
    }
  }

  async function confirmDeleteEmpresa() {
    if (!deletingId) return;
    deleteConfirm.disabled = true;
    deleteConfirm.textContent = "Excluindo...";
    setDeleteError("");

    try {
      await api(`/api/admin/empresas/${deletingId}`, {
        method: "DELETE",
        body: JSON.stringify({ cascade: true }),
      });
      hideDeleteModal();
      showToast("Empresa removida.");
      await Promise.all([loadEmpresas(), loadDeletionHistory()]);
    } catch (e) {
      console.error(e);
      if (e.status === 409) {
        setDeleteError(e.message || "A exclusao foi bloqueada por jobs ativos ou indisponiveis.");
        await openDeleteEmpresa(deletingId);
        return;
      }
      if (e.status === 404) {
        setDeleteError("A empresa nao foi encontrada. Atualize a lista antes de tentar novamente.");
        deleteImpact = null;
        deleteConfirm.disabled = true;
        return;
      }
      setDeleteError(e.message || "Erro ao remover empresa.");
    } finally {
      if (deleteImpact && deleteImpact.canDelete !== false && !deleteImpact.blocked) {
        deleteConfirm.disabled = false;
      }
      deleteConfirm.textContent = "Excluir em cascata";
    }
  }

  function bindEvents() {
    btnCreate.addEventListener("click", openCreate);
    btnRefresh.addEventListener("click", loadEmpresas);

    btnClear.addEventListener("click", () => {
      search.value = "";
      applyFilter();
      search.focus();
    });

    search.addEventListener("input", applyFilter);

    btnPrev.addEventListener("click", () => {
      page--;
      render();
    });
    btnNext.addEventListener("click", () => {
      page++;
      render();
    });

    modalClose.addEventListener("click", hideModal);
    btnCancel.addEventListener("click", hideModal);
    btnSave.addEventListener("click", saveEmpresa);
    deleteClose.addEventListener("click", hideDeleteModal);
    deleteCancel.addEventListener("click", hideDeleteModal);
    deleteConfirm.addEventListener("click", confirmDeleteEmpresa);
    deleteRefresh.addEventListener("click", () => {
      if (deletingId) openDeleteEmpresa(deletingId);
    });
    fDocumentType.addEventListener("change", applyDocumentMask);
    fDocumentNumber.addEventListener("input", applyDocumentMask);

    modal.addEventListener("click", (e) => {
      if (e.target === modal) hideModal();
    });
    deleteModal.addEventListener("click", (e) => {
      if (e.target === deleteModal) hideDeleteModal();
    });

    const refreshDeletionHistory = () => {
      deletionHistoryCurrentPage = 1;
      loadDeletionHistory();
    };
    deletionHistoryRefresh.addEventListener("click", refreshDeletionHistory);
    [deletionHistorySearch, deletionHistoryFrom, deletionHistoryTo, deletionHistoryOperator].forEach((input) => {
      input.addEventListener("change", refreshDeletionHistory);
      if (input.type === "search") input.addEventListener("search", refreshDeletionHistory);
    });
    deletionHistoryPrev.addEventListener("click", () => {
      if (deletionHistoryCurrentPage <= 1) return;
      deletionHistoryCurrentPage -= 1;
      loadDeletionHistory();
    });
    deletionHistoryNext.addEventListener("click", () => {
      const pages = Math.max(1, Math.ceil(deletionHistoryTotal / deletionHistoryPageSize));
      if (deletionHistoryCurrentPage >= pages) return;
      deletionHistoryCurrentPage += 1;
      loadDeletionHistory();
    });

    tbody.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;

      const action = btn.getAttribute("data-action");
      const id = Number(btn.getAttribute("data-id"));

      if (action === "edit") {
        const row = all.find((x) => Number(x.id) === id);
        if (row) openEdit(row);
      }

      if (action === "delete") openDeleteEmpresa(id);
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal.style.display === "flex") hideModal();
      if (e.key === "Escape" && deleteModal.style.display === "flex") hideDeleteModal();
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    bindEvents();
    loadEmpresas();
    loadDeletionHistory();
  });
})();
