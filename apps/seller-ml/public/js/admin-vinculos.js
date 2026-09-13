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

// public/js/admin-vinculos.js (PK composta: empresa_id + usuario_id)
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

  const modal = $("modal-link");
  const modalTitle = $("modal-title");
  const modalClose = $("modal-close");
  const btnCancel = $("btn-cancel");
  const btnSave = $("btn-save");

  const fEmpresa = $("f-empresa");
  const fUsuario = $("f-usuario");
  const fPapel = $("f-papel");
  const formError = $("form-error");

  const toast = $("toast");

  let all = [];
  let filtered = [];
  let page = 1;
  const perPage = 25;

  let empresas = [];
  let usuarios = [];

  let mode = "create"; // create | edit
  let editingKey = null; // { empresa_id, usuario_id }

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
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
  }

  function badgePapel(papel) {
    const p = String(papel || "").toLowerCase();
    if (p === "owner") return `<span class="badge admin">OWNER</span>`;
    if (p === "admin") return `<span class="badge user">ADMIN</span>`;
    return `<span class="badge user">OPERADOR</span>`;
  }

  function visualIdKey(row) {
    // "ID" visual na tabela (não existe coluna id)
    return `${row.empresa_id}:${row.usuario_id}`;
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
        const empresa = String(r.empresa_nome || "").toLowerCase();
        const usuario = String(r.usuario_nome || "").toLowerCase();
        const email = String(r.usuario_email || "").toLowerCase();
        const papel = String(r.papel || "").toLowerCase();
        const key = visualIdKey(r);
        return (
          empresa.includes(q) ||
          usuario.includes(q) ||
          email.includes(q) ||
          papel.includes(q) ||
          key.includes(q) ||
          String(r.empresa_id).includes(q) ||
          String(r.usuario_id).includes(q)
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

    countPill.textContent = `${total} vínculo${total === 1 ? "" : "s"}`;
    pageInfo.textContent = `${page} / ${pages}`;
    rangeInfo.textContent = total
      ? `Mostrando ${start + 1}–${end} de ${total}`
      : "Nenhum vínculo encontrado";

    btnPrev.disabled = page <= 1;
    btnNext.disabled = page >= pages;

    if (!slice.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="table-empty">Nenhum vínculo encontrado.</td></tr>`;
      return;
    }

    tbody.innerHTML = slice
      .map((r) => {
        const key = visualIdKey(r);

        return `
          <tr>
            <td>${escapeHtml(key)}</td>
            <td>${escapeHtml(r.empresa_nome || "—")}<br><span style="opacity:.8; font-size:.92rem;">#${r.empresa_id}</span></td>
            <td>
              ${escapeHtml(r.usuario_nome || "—")}<br>
              <span style="opacity:.8; font-size:.92rem;">${escapeHtml(r.usuario_email || "—")} • #${r.usuario_id}</span>
            </td>
            <td>${badgePapel(r.papel)}</td>
            <td>${formatDate(r.criado_em)}</td>
            <td>
              <div class="actions">
                <button
                  class="icon-btn"
                  data-action="edit"
                  data-empresa="${r.empresa_id}"
                  data-usuario="${r.usuario_id}"
                  title="Editar"
                >✏️</button>

                <button
                  class="icon-btn danger"
                  data-action="delete"
                  data-empresa="${r.empresa_id}"
                  data-usuario="${r.usuario_id}"
                  title="Remover"
                >🗑️</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  function fillSelects() {
    fEmpresa.innerHTML = empresas
      .map((e) => `<option value="${e.id}">${escapeHtml(e.nome)} (#${e.id})</option>`)
      .join("");

    fUsuario.innerHTML = usuarios
      .map((u) => {
        const label = `${u.email} • ${u.nome || "—"} (#${u.id})`;
        return `<option value="${u.id}">${escapeHtml(label)}</option>`;
      })
      .join("");
  }

  async function loadLookups() {
    const data = await api("/api/admin/vinculos/lookups", { method: "GET" });
    empresas = Array.isArray(data.empresas) ? data.empresas : [];
    usuarios = Array.isArray(data.usuarios) ? data.usuarios : [];
    fillSelects();
  }

  async function loadVinculos() {
    tbody.innerHTML = `<tr><td colspan="6" class="table-empty">Carregando…</td></tr>`;
    try {
      const data = await api("/api/admin/vinculos", { method: "GET" });
      all = Array.isArray(data.vinculos) ? data.vinculos : [];
      filtered = [...all];
      applyFilter();
      showToast("Lista atualizada.");
    } catch (e) {
      console.error(e);
      tbody.innerHTML = `<tr><td colspan="6" class="table-empty">Erro ao carregar: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  function openCreate() {
    mode = "create";
    editingKey = null;

    modalTitle.textContent = "Vincular usuário";
    fPapel.value = "operador";
    fEmpresa.disabled = false;
    fUsuario.disabled = false;

    setError("");
    showModal();
  }

  function openEdit(row) {
    mode = "edit";
    editingKey = { empresa_id: Number(row.empresa_id), usuario_id: Number(row.usuario_id) };

    modalTitle.textContent = `Editar vínculo ${row.empresa_id}:${row.usuario_id}`;
    fEmpresa.value = String(row.empresa_id);
    fUsuario.value = String(row.usuario_id);
    fPapel.value = String(row.papel || "operador");

    // Você pode permitir “mover” (trocar empresa/usuário).
    // Se quiser travar, é só setar disabled=true.
    fEmpresa.disabled = false;
    fUsuario.disabled = false;

    setError("");
    showModal();
  }

  async function save() {
    setError("");

    const empresa_id = Number(fEmpresa.value);
    const usuario_id = Number(fUsuario.value);
    const papel = String(fPapel.value || "").trim().toLowerCase();

    if (!Number.isFinite(empresa_id)) return setError("Selecione uma empresa.");
    if (!Number.isFinite(usuario_id)) return setError("Selecione um usuário.");
    if (!["owner", "admin", "operador"].includes(papel)) return setError("Papel inválido.");

    btnSave.disabled = true;
    btnSave.textContent = "Salvando…";

    try {
      const payload = { empresa_id, usuario_id, papel };

      if (mode === "create") {
        await api("/api/admin/vinculos", { method: "POST", body: JSON.stringify(payload) });
        showToast("Vínculo criado.");
      } else {
        const oldEmpresa = editingKey?.empresa_id;
        const oldUsuario = editingKey?.usuario_id;
        await api(`/api/admin/vinculos/${oldEmpresa}/${oldUsuario}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        showToast("Vínculo atualizado.");
      }

      hideModal();
      await loadVinculos();
    } catch (e) {
      console.error(e);
      setError(e.message || "Erro ao salvar.");
    } finally {
      btnSave.disabled = false;
      btnSave.textContent = "Salvar";
    }
  }

  async function del(empresa_id, usuario_id) {
    const row = all.find(
      (x) => Number(x.empresa_id) === Number(empresa_id) && Number(x.usuario_id) === Number(usuario_id)
    );
    const label = row
      ? `${row.usuario_email} → ${row.empresa_nome} (${row.papel})`
      : `${empresa_id}:${usuario_id}`;

    if (!confirm(`Remover o vínculo ${label}?`)) return;

    try {
      await api(`/api/admin/vinculos/${empresa_id}/${usuario_id}`, { method: "DELETE" });
      showToast("Vínculo removido.");
      await loadVinculos();
    } catch (e) {
      console.error(e);
      alert(`Erro ao remover: ${e.message}`);
    }
  }

  function bindEvents() {
    btnCreate.addEventListener("click", openCreate);
    btnRefresh.addEventListener("click", loadVinculos);

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
    btnSave.addEventListener("click", save);

    modal.addEventListener("click", (e) => {
      if (e.target === modal) hideModal();
    });

    tbody.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;

      const action = btn.getAttribute("data-action");
      const empresa_id = Number(btn.getAttribute("data-empresa"));
      const usuario_id = Number(btn.getAttribute("data-usuario"));

      if (!Number.isFinite(empresa_id) || !Number.isFinite(usuario_id)) return;

      if (action === "edit") {
        const row = all.find(
          (x) => Number(x.empresa_id) === empresa_id && Number(x.usuario_id) === usuario_id
        );
        if (row) openEdit(row);
      }

      if (action === "delete") {
        del(empresa_id, usuario_id);
      }
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal.style.display === "flex") hideModal();
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    bindEvents();
    await loadLookups();
    await loadVinculos();
  });
})();
