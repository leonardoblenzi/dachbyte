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

// public/js/admin-meli-contas.js
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

  const modal = $("modal-ml");
  const modalTitle = $("modal-title");
  const modalClose = $("modal-close");
  const btnCancel = $("btn-cancel");
  const btnSave = $("btn-save");

  const fEmpresaId = $("f-empresa-id");
  const fMeliUserId = $("f-meli-user-id");
  const fApelido = $("f-apelido");
  const fSiteId = $("f-site-id");
  const fStatus = $("f-status");
  const formError = $("form-error");

  const toast = $("toast");

  let all = [];
  let filtered = [];
  let page = 1;
  const perPage = 25;

  let mode = "create"; // create | edit
  let editingId = null;

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

  function setError(msg) {
    if (!msg) {
      formError.style.display = "none";
      formError.textContent = "";
      return;
    }
    formError.style.display = "block";
    formError.textContent = msg;
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
    if (!v) return "—";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("pt-BR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
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

  function applyFilter() {
    const q = String(search.value || "").trim().toLowerCase();
    if (!q) {
      filtered = [...all];
    } else {
      filtered = all.filter((r) => {
        const id = String(r.id || "");
        const empresaId = String(r.empresa_id || "");
        const empresaNome = String(r.empresa_nome || "").toLowerCase();
        const apelido = String(r.apelido || "").toLowerCase();
        const meliUser = String(r.meli_user_id || "");
        const status = String(r.status || "").toLowerCase();
        return (
          id.includes(q) ||
          empresaId.includes(q) ||
          empresaNome.includes(q) ||
          apelido.includes(q) ||
          meliUser.includes(q) ||
          status.includes(q)
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

    countPill.textContent = `${total} conta${total === 1 ? "" : "s"}`;
    pageInfo.textContent = `${page} / ${pages}`;
    rangeInfo.textContent = total
      ? `Mostrando ${start + 1}–${end} de ${total}`
      : "Nenhuma conta encontrada";

    btnPrev.disabled = page <= 1;
    btnNext.disabled = page >= pages;

    if (!slice.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="table-empty">Nenhuma conta encontrada.</td></tr>`;
      return;
    }

    tbody.innerHTML = slice
      .map((r) => {
        const apelido = escapeHtml(r.apelido || "—");
        const empresaNome = escapeHtml(r.empresa_nome || "—");
        const status = escapeHtml(r.status || "—");
        const site = escapeHtml(r.site_id || "MLB");

        return `
          <tr>
            <td>${escapeHtml(r.id)}</td>
            <td>${escapeHtml(r.empresa_id)}</td>
            <td>${empresaNome}</td>
            <td>${escapeHtml(r.meli_user_id)}</td>
            <td>${apelido}</td>
            <td>${site}</td>
            <td>${status}</td>
            <td>${escapeHtml(formatDate(r.atualizado_em || r.criado_em))}</td>
            <td>
              <div class="actions">
                <button class="icon-btn" data-action="edit" data-id="${r.id}" title="Editar">✏️</button>
                <button class="icon-btn danger" data-action="delete" data-id="${r.id}" title="Remover">🗑️</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  async function load() {
    tbody.innerHTML = `<tr><td colspan="9" class="table-empty">Carregando…</td></tr>`;
    try {
      const data = await api("/api/admin/meli-contas", { method: "GET" });
      all = Array.isArray(data.contas) ? data.contas : [];
      filtered = [...all];
      applyFilter();
      showToast("Lista atualizada.");
    } catch (e) {
      console.error(e);
      tbody.innerHTML = `<tr><td colspan="9" class="table-empty">Erro ao carregar: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  function openCreate() {
    mode = "create";
    editingId = null;

    modalTitle.textContent = "Nova conta ML";
    setError("");

    fEmpresaId.value = "";
    fMeliUserId.value = "";
    fApelido.value = "";
    fSiteId.value = "MLB";
    fStatus.value = "ativa";

    showModal();
    setTimeout(() => fEmpresaId?.focus(), 50);
  }

  function openEdit(row) {
    mode = "edit";
    editingId = Number(row.id);

    modalTitle.textContent = `Editar conta #${row.id}`;
    setError("");

    // por segurança, não edita empresa_id e meli_user_id (evita bagunçar chaves/constraints)
    fEmpresaId.value = String(row.empresa_id ?? "");
    fMeliUserId.value = String(row.meli_user_id ?? "");
    fEmpresaId.disabled = true;
    fMeliUserId.disabled = true;

    fApelido.value = String(row.apelido ?? "");
    fSiteId.value = String(row.site_id ?? "MLB");
    fSiteId.disabled = true; // evita alterar site_id sem necessidade
    fStatus.value = String(row.status ?? "ativa");

    showModal();
    setTimeout(() => fApelido?.focus(), 50);
  }

  function resetDisabledFields() {
    fEmpresaId.disabled = false;
    fMeliUserId.disabled = false;
    fSiteId.disabled = false;
  }

  async function save() {
    setError("");

    const empresa_id = Number(String(fEmpresaId.value || "").trim());
    const meli_user_id = Number(String(fMeliUserId.value || "").trim());
    const apelido = String(fApelido.value || "").trim() || null;
    const site_id = String(fSiteId.value || "MLB").trim() || "MLB";
    const status = String(fStatus.value || "ativa").trim().toLowerCase();

    if (mode === "create") {
      if (!Number.isFinite(empresa_id)) return setError("Informe um empresa_id válido.");
      if (!Number.isFinite(meli_user_id)) return setError("Informe um meli_user_id válido.");
    }

    btnSave.disabled = true;
    btnSave.textContent = "Salvando…";

    try {
      if (mode === "create") {
        await api("/api/admin/meli-contas", {
          method: "POST",
          body: JSON.stringify({ empresa_id, meli_user_id, apelido, site_id, status }),
        });
        showToast("Conta criada.");
      } else {
        await api(`/api/admin/meli-contas/${editingId}`, {
          method: "PUT",
          body: JSON.stringify({ apelido, status }),
        });
        showToast("Conta atualizada.");
      }

      hideModal();
      resetDisabledFields();
      await load();
    } catch (e) {
      console.error(e);
      setError(e.message || "Erro ao salvar.");
    } finally {
      btnSave.disabled = false;
      btnSave.textContent = "Salvar";
    }
  }

  async function del(id) {
    const row = all.find((x) => Number(x.id) === Number(id));
    const label = row
      ? `${row.apelido || "Conta"} (ML ${row.meli_user_id}) • Empresa #${row.empresa_id}`
      : `#${id}`;

    if (!confirm(`Remover conta ${label}?\n\nObs: pode falhar se houver tokens/refs dependentes.`)) return;

    try {
      await api(`/api/admin/meli-contas/${id}`, { method: "DELETE" });
      showToast("Conta removida.");
      await load();
    } catch (e) {
      console.error(e);
      alert(`Erro ao remover: ${e.message}`);
    }
  }

  function bindEvents() {
    btnCreate.addEventListener("click", () => {
      resetDisabledFields();
      openCreate();
    });

    btnRefresh.addEventListener("click", load);

    btnClear.addEventListener("click", () => {
      search.value = "";
      applyFilter();
      search.focus();
    });

    search.addEventListener("input", applyFilter);

    btnPrev.addEventListener("click", () => { page--; render(); });
    btnNext.addEventListener("click", () => { page++; render(); });

    modalClose.addEventListener("click", () => {
      hideModal();
      resetDisabledFields();
    });

    btnCancel.addEventListener("click", () => {
      hideModal();
      resetDisabledFields();
    });

    btnSave.addEventListener("click", save);

    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        hideModal();
        resetDisabledFields();
      }
    });

    tbody.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;

      const action = btn.getAttribute("data-action");
      const id = Number(btn.getAttribute("data-id"));
      if (!Number.isFinite(id)) return;

      if (action === "edit") {
        const row = all.find((x) => Number(x.id) === id);
        if (row) openEdit(row);
      }

      if (action === "delete") {
        del(id);
      }
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal.style.display === "flex") {
        hideModal();
        resetDisabledFields();
      }
      if (e.key === "Enter" && modal.style.display === "flex") save();
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    bindEvents();
    await load();
  });
})();
