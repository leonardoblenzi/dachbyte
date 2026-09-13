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

// public/js/admin-meli-tokens.js
(() => {
  const $ = (id) => document.getElementById(id);

  const tbody = $("tbody");
  const search = $("search");
  const btnClear = $("btn-clear");
  const btnRefresh = $("btn-refresh");

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

  function fmtExpiresMin(mins) {
    if (mins === null || mins === undefined) return "—";
    const n = Number(mins);
    if (!Number.isFinite(n)) return "—";
    if (n < 0) return "EXPIRADO";
    if (n <= 10) return `${n} min ⚠️`;
    return `${n} min`;
  }

  function expiresBadge(mins) {
    const n = Number(mins);
    if (!Number.isFinite(n)) return `<span class="pill">—</span>`;
    if (n < 0) return `<span class="pill pill--danger">Expirado</span>`;
    if (n <= 10) return `<span class="pill pill--warn">Expira já</span>`;
    return `<span class="pill">OK</span>`;
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
        const contaId = String(r.meli_conta_id || "");
        const empresaId = String(r.empresa_id || "");
        const empresaNome = String(r.empresa_nome || "").toLowerCase();
        const apelido = String(r.apelido || "").toLowerCase();
        const meliUser = String(r.meli_user_id || "");
        const status = String(r.conta_status || "").toLowerCase();
        const scope = String(r.scope || "").toLowerCase();
        const exp = String(r.expires_in_min ?? "").toLowerCase();
        return (
          contaId.includes(q) ||
          empresaId.includes(q) ||
          empresaNome.includes(q) ||
          apelido.includes(q) ||
          meliUser.includes(q) ||
          status.includes(q) ||
          scope.includes(q) ||
          exp.includes(q)
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

    countPill.textContent = `${total} token${total === 1 ? "" : "s"}`;
    pageInfo.textContent = `${page} / ${pages}`;
    rangeInfo.textContent = total
      ? `Mostrando ${start + 1}–${end} de ${total}`
      : "Nenhum token encontrado";

    btnPrev.disabled = page <= 1;
    btnNext.disabled = page >= pages;

    if (!slice.length) {
      tbody.innerHTML = `<tr><td colspan="11" class="table-empty">Nenhum token encontrado.</td></tr>`;
      return;
    }

    tbody.innerHTML = slice
      .map((r) => {
        const contaId = escapeHtml(r.meli_conta_id);
        const empresaId = escapeHtml(r.empresa_id);
        const empresaNome = escapeHtml(r.empresa_nome || "—");
        const meliUser = escapeHtml(r.meli_user_id);
        const apelido = escapeHtml(r.apelido || "—");
        const status = escapeHtml(r.conta_status || "—");

        const expAt = formatDate(r.access_expires_at);
        const expMin = fmtExpiresMin(r.expires_in_min);
        const expBadge = expiresBadge(r.expires_in_min);

        const lastRefresh = formatDate(r.ultimo_refresh_em || r.refresh_obtido_em);
        const scope = escapeHtml(r.scope || "—");

        return `
          <tr>
            <td>${contaId}</td>
            <td>${empresaId}</td>
            <td>${empresaNome}</td>
            <td>${meliUser}</td>
            <td>${apelido}</td>
            <td>${status}</td>
            <td>${escapeHtml(expAt)}</td>
            <td>${expBadge} <span style="opacity:.85; margin-left:6px;">${escapeHtml(expMin)}</span></td>
            <td>${escapeHtml(lastRefresh)}</td>
            <td style="max-width:260px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${scope}">
              ${scope}
            </td>
            <td>
              <div class="actions">
                <button class="icon-btn danger" data-action="clear" data-id="${contaId}" title="Limpar tokens">🧹</button>
                <button class="icon-btn" data-action="revoke" data-id="${contaId}" title="Marcar conta como revogada">⛔</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  async function load() {
    tbody.innerHTML = `<tr><td colspan="11" class="table-empty">Carregando…</td></tr>`;
    try {
      const data = await api("/api/admin/meli-tokens", { method: "GET" });
      all = Array.isArray(data.tokens) ? data.tokens : [];
      filtered = [...all];
      applyFilter();
      showToast("Lista atualizada.");
    } catch (e) {
      console.error(e);
      tbody.innerHTML = `<tr><td colspan="11" class="table-empty">Erro ao carregar: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  async function clearTokens(meli_conta_id) {
    if (!confirm(`Limpar tokens da conta #${meli_conta_id}?\n\nIsso vai forçar reautenticação/OAuth.`)) return;
    try {
      await api(`/api/admin/meli-tokens/${meli_conta_id}`, { method: "DELETE" });
      showToast("Tokens removidos.");
      await load();
    } catch (e) {
      console.error(e);
      alert(`Erro: ${e.message}`);
    }
  }

  async function revokeConta(meli_conta_id) {
    if (!confirm(`Marcar a conta #${meli_conta_id} como REVOGADA?`)) return;
    try {
      await api(`/api/admin/meli-tokens/${meli_conta_id}/revogar-conta`, { method: "POST" });
      showToast("Conta marcada como revogada.");
      await load();
    } catch (e) {
      console.error(e);
      alert(`Erro: ${e.message}`);
    }
  }

  function bindEvents() {
    btnRefresh.addEventListener("click", load);

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
      const id = Number(btn.getAttribute("data-id"));
      if (!Number.isFinite(id)) return;

      if (action === "clear") clearTokens(id);
      if (action === "revoke") revokeConta(id);
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    bindEvents();
    await load();
  });
})();
