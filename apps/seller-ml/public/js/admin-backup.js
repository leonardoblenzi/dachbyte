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

  const btnExport = $("btn-export");
  const btnImport = $("btn-import");
  const fileInp = $("file");
  const msg = $("msg");

  function show(content, type = "ok", opts = {}) {
    const { allowHtml = false } = opts;

    msg.style.display = "block";
    msg.dataset.tone = ["ok", "warn", "err"].includes(type) ? type : "ok";

    if (allowHtml) msg.innerHTML = content;
    else msg.textContent = String(content ?? "");
  }

  function hide() {
    msg.style.display = "none";
    msg.textContent = "";
    msg.innerHTML = "";
  }

  async function fetchJson(url, opts = {}) {
    const r = await fetch(url, {
      credentials: "include",
      cache: "no-store",
      ...opts,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok)
      throw new Error(data?.error || data?.message || `HTTP ${r.status}`);
    return data;
  }

  function esc(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function fmtNumber(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "0";
    return x.toLocaleString("pt-BR");
  }

  function formatInsertedHtml(resp) {
    // Esperado do backend:
    // { ok:true, inserted:{ usuarios:X, ... }, total_inserted:N, truncated:[...]? }
    const inserted =
      resp?.inserted && typeof resp.inserted === "object" ? resp.inserted : {};
    const total = Number(resp?.total_inserted);
    const hasTotal = Number.isFinite(total);

    const entries = Object.entries(inserted)
      .map(([k, v]) => [k, Number(v) || 0])
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "pt-BR"));

    const nonZero = entries.filter(([, v]) => v > 0);
    const top = nonZero.slice(0, 20);
    const rest = nonZero.length - top.length;
    const createdAt = resp?.restored_at || resp?.created_at || null;

    const title = `
      <div class="backup-result__head">
        <div class="backup-result__title-wrap">
          <div class="backup-result__title">Backup restaurado com sucesso</div>
          <div class="backup-result__meta">
            ${
              createdAt
                ? `Processado em: <strong>${esc(createdAt)}</strong>`
                : "Import finalizado."
            }
          </div>
        </div>
        ${
          hasTotal
            ? `<div class="backup-result__pill">Total inserido: ${fmtNumber(total)}</div>`
            : ""
        }
      </div>
    `;

    const list = top.length
      ? `
        <div class="backup-result__section">
          <div class="backup-result__section-title">Inseridos por tabela</div>
          <div class="backup-result__list">
            ${top
              .map(
                ([t, n]) => `
                <div class="backup-result__row">
                  <div class="backup-result__table">${esc(t)}</div>
                  <div class="backup-result__count">${fmtNumber(n)}</div>
                </div>
              `,
              )
              .join("")}
          </div>
          ${
            rest > 0
              ? `<div class="backup-result__more">+${rest} tabelas com insercoes (nao exibidas)</div>`
              : ""
          }
        </div>
      `
      : `
        <div class="backup-result__empty">
          Nenhum registro foi inserido (backup vazio ou sem dados).
        </div>
      `;

    const truncated =
      Array.isArray(resp?.truncated) && resp.truncated.length
        ? `
        <div class="backup-result__warning">
          <strong>Atencao:</strong> algumas tabelas foram ignoradas/truncadas no restore:
          <div class="backup-result__warning-list">${esc(resp.truncated.join(", "))}</div>
        </div>
      `
        : "";

    return `
      <div class="backup-result">
        ${title}
        ${list}
        ${truncated}
      </div>
    `;
  }

  btnExport?.addEventListener("click", () => {
    hide();
    window.location.href = withBase("/api/admin/backup/export.json");
  });

  btnImport?.addEventListener("click", async () => {
    hide();

    const f = fileInp?.files?.[0];
    if (!f) return show("Selecione um arquivo .json primeiro.", "warn");

    const sure = confirm(
      "ATENÇÃO: Isso vai apagar os dados atuais e restaurar o backup.\n\nDeseja continuar?"
    );
    if (!sure) return;

    try {
      btnImport.disabled = true;
      btnImport.textContent = "Restaurando…";

      const text = await f.text();
      const backup = JSON.parse(text);

      const resp = await fetchJson("/api/admin/backup/import.json", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backup }),
      });

      // ✅ mensagem bonita
      show(formatInsertedHtml(resp), "ok", { allowHtml: true });
    } catch (e) {
      console.error(e);
      show(
        `<div class="backup-result backup-result--error">
          <div class="backup-result__title">Falha ao restaurar</div>
          <div class="backup-result__meta">${esc(e.message)}</div>
        </div>`,
        "err",
        { allowHtml: true },
      );
    } finally {
      btnImport.disabled = false;
      btnImport.textContent = "♻ Restaurar backup selecionado";
    }
  });
})();
