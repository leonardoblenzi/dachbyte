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

// public/js/admin-oauth-states.js
(() => {
  const $ = (id) => document.getElementById(id);

  const tbody = $("tbody");
  const search = $("search");
  const btnClear = $("btn-clear");
  const btnRefresh = $("btn-refresh");
  const btnCleanup = $("btn-cleanup");

  const btnPrev = $("btn-prev");
  const btnNext = $("btn-next");
  const pageInfo = $("page-info");
  const rangeInfo = $("range-info");
  const countPill = $("count-pill");

  const toast = $("toast");

  let all = [];
  let filtered = [];
  let page = 1;
  const perPage = 25;

  function showToast(msg) {
    toast.textContent = msg;
    toast.style.display = "block";
    setTimeout(() => (toast.style.display = "none"), 2400);
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

  function statusPill(expirado) {
    if (expirado === true) return `<span class="pill pill--warn">Expirado</span>`;
    return `<span class="pill">Ativo</span>`;
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
        const state = String(r.state || "").toLowerCase();
        const empresaId = String(r.empresa_id || "");
        const empresaNome = String(r.empresa_nome || "").toLowerCase();
        const usuarioId = String(r.usuario_id || "");
        const usuarioEmail = String(r.usuario_email || "").toLowerCase();
        const usuarioNome = String(r.usuario_nome || "").toLowerCase();
        const returnTo = String(r.return_to || "").toLowerCase();
        const expirado = String(r.expirado ? "expirado" : "ativo");
        return (
          state.includes(q) ||
          empresaId.includes(q) ||
          empresaNome.includes(q) ||
          usuarioId.includes(q) ||
          usuarioEmail.includes(q) ||
          usuarioNome.includes(q) ||
          returnTo.includes(q) ||
          expirado.includes(q)
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

    countPill.textContent = `${total} state${total === 1 ? "" : "s"}`;
    pageInfo.textContent = `${page} / ${pages}`;
    rangeInfo.textContent = total
      ? `Mostrando ${start + 1}–${end} de ${total}`
      : "Nenhum state encontrado";

    btnPrev.disabled = page <= 1;
    btnNext.disabled = page >= pages;

    if (!slice.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="table-empty">Nenhum state encontrado.</td></tr>`;
      return;
    }

    tbody.innerHTML = slice
      .map((r) => {
        const state = escapeHtml(r.state || "");
        const empresaId = escapeHtml(r.empresa_id);
        const empresaNome = escapeHtml(r.empresa_nome || "—");
        const usuarioId = escapeHtml(r.usuario_id);
        const usuarioEmail = escapeHtml(r.usuario_email || "—");
        const expiraEm = escapeHtml(formatDate(r.expira_em));
        const pill = statusPill(r.expirado === true);
        const returnTo = escapeHtml(r.return_to || "—");

        return `
          <tr>
            <td style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size:.88rem;">
              ${state}
            </td>
            <td>${empresaId}</td>
            <td>${empresaNome}</td>
            <td>${usuarioId}</td>
            <td>${usuarioEmail}</td>
            <td>${expiraEm}</td>
            <td>${pill}</td>
            <td style="max-width:380px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${returnTo}">
              ${returnTo}
            </td>
            <td>
              <div class="actions">
                <button class="icon-btn danger" data-action="delete" data-state="${state}" title="Remover state">🗑️</button>
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
      const data = await api("/api/admin/oauth-states", { method: "GET" });
      all = Array.isArray(data.states) ? data.states : [];
      filtered = [...all];
      applyFilter();
      showToast("Lista atualizada.");
    } catch (e) {
      console.error(e);
      tbody.innerHTML = `<tr><td colspan="9" class="table-empty">Erro ao carregar: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  async function cleanupExpired() {
    if (!confirm("Limpar TODOS os oauth_states expirados?")) return;
    try {
      const data = await api("/api/admin/oauth-states/cleanup", { method: "POST" });
      showToast(`Expirados removidos: ${Number(data.deleted || 0)}`);
      await load();
    } catch (e) {
      console.error(e);
      alert(`Erro: ${e.message}`);
    }
  }

  async function deleteState(state) {
    if (!confirm("Remover este state?\n\nIsso só afeta a tentativa atual de OAuth/PKCE.")) return;
    try {
      await api(`/api/admin/oauth-states/${encodeURIComponent(state)}`, { method: "DELETE" });
      showToast("State removido.");
      await load();
    } catch (e) {
      console.error(e);
      alert(`Erro: ${e.message}`);
    }
  }

  function bindEvents() {
    btnRefresh.addEventListener("click", load);
    btnCleanup.addEventListener("click", cleanupExpired);

    btnClear.addEventListener("click", () => {
      search.value = "";
      applyFilter();
      search.focus();
    });

    search.addEventListener("input", applyFilter);

    btnPrev.addEventListener("click", () => { page--; render(); });
    btnNext.addEventListener("click", () => { page++; render(); });

    tbody.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;

      const action = btn.getAttribute("data-action");
      if (action !== "delete") return;

      const st = btn.getAttribute("data-state") || "";
      if (!st) return;

      deleteState(st);
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    bindEvents();
    await load();
  });
})();
