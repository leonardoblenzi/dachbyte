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

  const btnRefresh = $("btn-refresh");
  const btnRun = $("btn-run");

  const pillFiles = $("pill-files");
  const pillApplied = $("pill-applied");
  const pillPending = $("pill-pending");

  const tbodyFiles = $("tbody-files");
  const tbodyApplied = $("tbody-applied");

  const toast = $("toast");

  const modal = $("modal-sql");
  const modalTitle = $("modal-title");
  const modalClose = $("modal-close");
  const btnClose = $("btn-close");
  const sqlBox = $("sql-box");

  let lastStatus = null;

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

  function renderLegacyBadge(item) {
    if (!item?.legacy) return "";
    const reason = escapeHtml(item.legacy_reason || "Migracao legada.");
    return ` <span class="badge legacy" title="${reason}">LEGADO</span>`;
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
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
      const msg = data?.error || data?.message || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function showModal(title, content) {
    modalTitle.textContent = title;
    sqlBox.textContent = content || "—";
    modal.style.display = "flex";
    modal.setAttribute("aria-hidden", "false");
  }

  function hideModal() {
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
  }

  function render() {
    const st = lastStatus;
    if (!st) return;

    const totals = st.totals || {};
    pillFiles.textContent = `${totals.files || 0} arquivos`;
    pillApplied.textContent = `${totals.applied || 0} aplicadas`;
    pillPending.textContent = `${totals.pending || 0} pendentes`;

    // Files table
    const files = Array.isArray(st.files) ? st.files : [];
    if (!files.length) {
      tbodyFiles.innerHTML = `<tr><td colspan="3" class="table-empty">Nenhum arquivo de migração encontrado.</td></tr>`;
    } else {
      tbodyFiles.innerHTML = files
        .map((f) => {
          const applied = !!f.applied;
          const badge = applied
            ? `<span class="badge ok">APLICADA</span>`
            : `<span class="badge warn">PENDENTE</span>`;

          const actions = `
            <div class="actions">
              <button class="icon-btn" data-action="preview" data-file="${escapeHtml(
                f.arquivo
              )}" title="Ver SQL">👁️</button>
            </div>
          `;

          return `
            <tr>
              <td><code>${escapeHtml(f.arquivo)}</code>${renderLegacyBadge(f)}</td>
              <td>${badge}</td>
              <td style="text-align:right;">${actions}</td>
            </tr>
          `;
        })
        .join("");
    }

    // Applied table
    const applied = Array.isArray(st.applied) ? st.applied : [];
    if (!applied.length) {
      tbodyApplied.innerHTML = `<tr><td colspan="3" class="table-empty">Nenhuma migração aplicada ainda.</td></tr>`;
    } else {
      tbodyApplied.innerHTML = applied
        .map((m) => {
          return `
            <tr>
              <td>${escapeHtml(m.id)}</td>
              <td><code>${escapeHtml(m.arquivo)}</code>${renderLegacyBadge(m)}</td>
              <td>${escapeHtml(formatDate(m.aplicado_em))}</td>
            </tr>
          `;
        })
        .join("");
    }

    // Botão run: só habilita se houver pendentes
    const pending = Array.isArray(st.pending) ? st.pending : [];
    btnRun.disabled = pending.length === 0;
  }

  async function loadStatus() {
    tbodyFiles.innerHTML = `<tr><td colspan="3" class="table-empty">Carregando…</td></tr>`;
    tbodyApplied.innerHTML = `<tr><td colspan="3" class="table-empty">Carregando…</td></tr>`;
    try {
      lastStatus = await api("/api/admin/migracoes/status", { method: "GET" });
      render();
      showToast("Status atualizado.");
    } catch (e) {
      console.error(e);
      tbodyFiles.innerHTML = `<tr><td colspan="3" class="table-empty">Erro: ${escapeHtml(
        e.message
      )}</td></tr>`;
      tbodyApplied.innerHTML = `<tr><td colspan="3" class="table-empty">—</td></tr>`;
    }
  }

  async function previewFile(name) {
    try {
      const data = await api(`/api/admin/migracoes/file?name=${encodeURIComponent(name)}`, {
        method: "GET",
      });
      showModal(`Preview • ${name}`, data.sql || "");
    } catch (e) {
      console.error(e);
      showToast(`Falha ao abrir: ${e.message}`);
    }
  }

  async function runPending() {
    const st = lastStatus;
    const pending = Array.isArray(st?.pending) ? st.pending : [];

    if (!pending.length) {
      showToast("Nenhuma pendente.");
      return;
    }

    const ok = confirm(
      `Você tem ${pending.length} migração(ões) pendente(s).\n\nIsso vai executar SQL no banco.\n\nDigite OK para continuar.`
    );
    if (!ok) return;

    btnRun.disabled = true;
    const old = btnRun.textContent;
    btnRun.textContent = "Rodando…";

    try {
      const data = await api("/api/admin/migracoes/run", {
        method: "POST",
        body: JSON.stringify({ confirm: "rodar" }),
      });

      showToast(data.message || "Concluído.");
      await loadStatus();
    } catch (e) {
      console.error(e);
      alert(`Erro ao rodar migrações: ${e.message}`);
    } finally {
      btnRun.disabled = false;
      btnRun.textContent = old;
    }
  }

  function bindEvents() {
    btnRefresh?.addEventListener("click", loadStatus);
    btnRun?.addEventListener("click", runPending);

    tbodyFiles?.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-action");
      const file = btn.getAttribute("data-file");
      if (action === "preview" && file) previewFile(file);
    });

    modalClose?.addEventListener("click", hideModal);
    btnClose?.addEventListener("click", hideModal);
    modal?.addEventListener("click", (e) => {
      if (e.target === modal) hideModal();
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal.style.display === "flex") hideModal();
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    bindEvents();
    loadStatus();
  });
})();
