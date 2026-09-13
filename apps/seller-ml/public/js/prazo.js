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

// public/js/prazo.js
(() => {
  console.log("⏱️ prazo.js carregado");

  // ===== Config (agora alinhado com as rotas reais do backend)
  const API_LOOKUP = "/anuncios/prazo-producao/consultar";
  const API_LOOKUP_ACTIVE_JOB = "/anuncios/prazo-producao/consultar-ativos-job";
  const API_SINGLE = "/anuncio/prazo-producao";
  const API_BULK_LEGACY = "/anuncios/prazo-producao-lote"; // fallback sem painel
  const API_STATUS = (id) =>
    `/anuncios/status-prazo-producao/${encodeURIComponent(id)}`;
  const API_JOB_DETAIL = (id) =>
    `/anuncios/jobs-prazo/${encodeURIComponent(id)}`;

  const DEFAULT_DELAY_MS = 250;
  const LOOKUP_PAGE_SIZE = 25;

  // ===== State
  let currentProcessId = null;
  let monitorInterval = null;
  let lookupRows = [];
  let lookupPage = 1;

  // ===== Helpers DOM
  const $ = (s) => document.querySelector(s);

  const elMlbSingle = () => $("#prazoMlbId");
  const elDiasSingle = () => $("#prazoDiasSingle");
  const elDiasBulk = () => $("#prazoDiasBulk");
  const elMlbsBulk = () => $("#prazoMlbIds");
  const elConsultaMlbs = () => $("#consultaMlbIds");
  const elConsultaMaxAtivos = () => $("#consultaMaxAtivos");
  const elRes = () => $("#resultado");

  // ===== Parse MLBs
  function parseFirstMlb(text) {
    const m = String(text || "")
      .toUpperCase()
      .match(/MLB\d{6,}/);
    return m ? m[0] : null;
  }

  function parseMlbs(text) {
    return Array.from(
      new Set(
        String(text || "")
          .toUpperCase()
          .match(/MLB\d{6,}/g) || []
      )
    );
  }

  function parseDays(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    if (!Number.isInteger(n)) return null;
    if (n < 0) return null;
    return n;
  }

  function parseOptionalPositiveInt(v) {
    const raw = String(v ?? "").trim();
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
    return n;
  }

  function getConsultaFonte() {
    return (
      document.querySelector('input[name="consultaFonte"]:checked')?.value ||
      "manual"
    );
  }

  function syncConsultaFonteUi() {
    const active = getConsultaFonte() === "active";
    const manualField = $("#consultaManualField");
    const activeOptions = $("#consultaAtivosOptions");
    const textarea = elConsultaMlbs();
    const btn = $("#btnConsultarPrazo");
    if (manualField) manualField.hidden = active;
    if (activeOptions) activeOptions.hidden = !active;
    if (textarea) textarea.disabled = active;
    if (btn) btn.textContent = active ? "Consultar ativos" : "Consultar prazos";
  }

  // ===== UI result
  function box(type, msg) {
    elRes().innerHTML = `<div class="result ${type}">${msg}</div>`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function fmtDate(value) {
    const raw = String(value || "").trim();
    if (!raw) return "-";
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return escapeHtml(raw);
    return escapeHtml(
      date.toLocaleString("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
      })
    );
  }

  function prazoLabel(row) {
    const prazo = row?.prazo || {};
    if (!prazo.has_prazo) return "Sem prazo";
    if (prazo.days != null && prazo.unit) return `${prazo.days} ${prazo.unit}`;
    return prazo.value_name || "Preenchido";
  }

  function envioLabel(row) {
    return [row?.shipping_mode, row?.logistic_type]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(" / ") || "-";
  }

  // ===== Notifications (simples)
  function notify(type, message) {
    // remove antigas
    document.querySelectorAll(".pz-notification").forEach((n) => n.remove());

    const icons = { success: "✅", error: "❌", warning: "⚠️", info: "ℹ️" };
    const n = document.createElement("div");
    n.className = `pz-notification pz-notification--${type}`;
    n.style.cssText = `
      position: fixed;
      top: 18px;
      right: 18px;
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 10px 30px rgba(0,0,0,.18);
      border-left: 4px solid ${
        type === "success"
          ? "#16a34a"
          : type === "error"
          ? "#dc2626"
          : type === "warning"
          ? "#f59e0b"
          : "#6d28d9"
      };
      padding: 12px 14px;
      max-width: 360px;
      z-index: 2000;
      animation: pzSlideIn .25s ease-out;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    `;
    n.innerHTML = `
      <div style="display:flex; gap:10px; align-items:flex-start;">
        <div style="font-size:18px; line-height:1;">${
          icons[type] || icons.info
        }</div>
        <div style="flex:1; color:#111827; font-size:14px; line-height:1.35;">${message}</div>
        <button aria-label="Fechar" style="border:none;background:none;cursor:pointer;font-size:18px;line-height:1;color:#9ca3af;">×</button>
      </div>
    `;
    n.querySelector("button").addEventListener("click", () => n.remove());
    document.body.appendChild(n);

    setTimeout(() => {
      if (!n.parentElement) return;
      n.style.animation = "pzSlideOut .25s ease-out";
      setTimeout(() => n.remove(), 240);
    }, 4500);
  }

  function injectNotifKeyframes() {
    if (document.getElementById("pzNotifKeyframes")) return;
    const st = document.createElement("style");
    st.id = "pzNotifKeyframes";
    st.textContent = `
      @keyframes pzSlideIn { from{ transform: translateX(100%); opacity: 0 } to{ transform: translateX(0); opacity: 1 } }
      @keyframes pzSlideOut { from{ transform: translateX(0); opacity: 1 } to{ transform: translateX(100%); opacity: 0 } }
    `;
    document.head.appendChild(st);
  }

  // ===== API calls
  async function postJson(url, body) {
    const r = await fetch(withBase(url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = data?.error || data?.message || `HTTP ${r.status}`;
      throw new Error(msg);
    }
    return data;
  }

  function setActiveTab(tab) {
    const wanted = String(tab || "consultar");
    document.querySelectorAll("[data-pz-tab]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.pzTab === wanted);
    });
    document.querySelectorAll("[data-pz-panel]").forEach((panel) => {
      const active = panel.dataset.pzPanel === wanted;
      panel.classList.toggle("is-active", active);
      panel.hidden = !active;
    });
  }

  function renderLookupStats(payload = {}) {
    const host = $("#consultaResumo");
    if (!host) return;
    host.hidden = false;
    $("#statConsultados").textContent = String(payload.total || 0);
    $("#statComPrazo").textContent = String(payload.with_prazo || 0);
    $("#statSemPrazo").textContent = String(payload.without_prazo || 0);
    $("#statPrazoMedio").textContent =
      payload.average_days == null ? "-" : `${Math.round(Number(payload.average_days) * 10) / 10} dias`;
    $("#statMaiorPrazo").textContent =
      payload.max_days == null ? "-" : `${payload.max_days} dias`;
  }

  function renderLookupPager() {
    const el = $("#consultaPager");
    if (!el) return;

    const total = lookupRows.length;
    if (!total) {
      el.innerHTML = "";
      return;
    }

    const pages = Math.max(1, Math.ceil(total / LOOKUP_PAGE_SIZE));
    lookupPage = Math.min(Math.max(1, lookupPage), pages);
    const from = (lookupPage - 1) * LOOKUP_PAGE_SIZE + 1;
    const to = Math.min(total, lookupPage * LOOKUP_PAGE_SIZE);

    const mkBtn = (label, page, disabled = false, active = false) => {
      const cls = ["pz-pg-btn", disabled ? "disabled" : "", active ? "active" : ""]
        .filter(Boolean)
        .join(" ");
      return `<button class="${cls}" data-page="${page}" ${disabled ? "disabled" : ""} type="button">${label}</button>`;
    };

    const windowSize = 7;
    let start = Math.max(1, lookupPage - Math.floor(windowSize / 2));
    let end = Math.min(pages, start + windowSize - 1);
    start = Math.max(1, end - windowSize + 1);

    const parts = [];
    parts.push('<div class="pz-pager-row">');
    parts.push(`<div>Mostrando <b>${from}</b>-<b>${to}</b> de <b>${total}</b></div>`);
    parts.push('<div class="pz-paginator">');
    parts.push(mkBtn("&laquo;", 1, lookupPage <= 1));
    parts.push(mkBtn("&lsaquo;", lookupPage - 1, lookupPage <= 1));

    if (start > 1) {
      parts.push(mkBtn("1", 1, false, lookupPage === 1));
      if (start > 2) parts.push('<span class="pz-pager-ellipsis">...</span>');
    }

    for (let page = start; page <= end; page += 1) {
      parts.push(mkBtn(String(page), page, false, page === lookupPage));
    }

    if (end < pages) {
      if (end < pages - 1) parts.push('<span class="pz-pager-ellipsis">...</span>');
      parts.push(mkBtn(String(pages), pages, false, lookupPage === pages));
    }

    parts.push(mkBtn("&rsaquo;", lookupPage + 1, lookupPage >= pages));
    parts.push(mkBtn("&raquo;", pages, lookupPage >= pages));
    parts.push("</div></div>");

    el.innerHTML = parts.join("");
    el.querySelectorAll(".pz-pg-btn").forEach((button) => {
      button.addEventListener("click", () => {
        if (button.classList.contains("disabled") || button.classList.contains("active")) return;
        const nextPage = Number(button.dataset.page || 1);
        if (!Number.isFinite(nextPage) || nextPage < 1) return;
        lookupPage = nextPage;
        renderLookupRows(lookupRows, { preservePage: true });
      });
    });
  }

  function renderLookupRows(rows = [], options = {}) {
    const shell = $("#consultaTabelaShell");
    const body = $("#consultaPrazoBody");
    const info = $("#consultaInfo");
    if (!shell || !body) return;
    shell.hidden = false;
    if (!options.preservePage) {
      lookupRows = Array.isArray(rows) ? rows : [];
      lookupPage = 1;
    }

    if (info) {
      const total = lookupRows.length;
      const errors = lookupRows.filter((row) => !row.success).length;
      info.textContent = errors
        ? `${total} anuncio(s) consultado(s), ${errors} com erro.`
        : `${total} anuncio(s) consultado(s).`;
    }

    if (!lookupRows.length) {
      body.innerHTML = '<tr><td colspan="7" class="pz-empty">Nenhum prazo encontrado.</td></tr>';
      renderLookupPager();
      return;
    }

    const pages = Math.max(1, Math.ceil(lookupRows.length / LOOKUP_PAGE_SIZE));
    lookupPage = Math.min(Math.max(1, lookupPage), pages);
    const start = (lookupPage - 1) * LOOKUP_PAGE_SIZE;
    const pageRows = lookupRows.slice(start, start + LOOKUP_PAGE_SIZE);

    body.innerHTML = pageRows.map((row) => {
      const prazoClass = row?.prazo?.has_prazo ? "ok" : "empty";
      const statusClass = row.success ? "ok" : "error";
      const title = row.permalink
        ? `<a href="${escapeHtml(row.permalink)}" target="_blank" rel="noreferrer">${escapeHtml(row.title || "-")}</a>`
        : escapeHtml(row.title || row.error || "-");

      return `
        <tr>
          <td><strong>${escapeHtml(row.mlb_id || "-")}</strong></td>
          <td>${title}</td>
          <td><span class="pz-pill pz-pill--${statusClass}">${escapeHtml(row.status || (row.success ? "ok" : "erro"))}</span></td>
          <td><span class="pz-pill pz-pill--${prazoClass}">${escapeHtml(prazoLabel(row))}</span></td>
          <td>${escapeHtml(envioLabel(row))}</td>
          <td>${fmtDate(row.last_updated)}</td>
          <td>
            <button class="btn btn-secondary pz-table-action" type="button" data-use-mlb="${escapeHtml(row.mlb_id || "")}" ${row.success ? "" : "disabled"}>
              Usar no unitario
            </button>
          </td>
        </tr>
      `;
    }).join("");
    renderLookupPager();
  }

  async function consultarPrazos() {
    injectNotifKeyframes();
    if (getConsultaFonte() === "active") {
      await consultarPrazosAtivos();
      return;
    }

    const mlbs = parseMlbs(elConsultaMlbs()?.value || "");
    if (!mlbs.length) {
      notify("error", "Informe ao menos um MLB valido para consultar.");
      return;
    }

    const btn = $("#btnConsultarPrazo");
    if (btn) {
      btn.disabled = true;
      btn.style.opacity = "0.75";
    }

    try {
      box("info", `Consultando prazo de producao...\n\nItens: ${mlbs.length}`);
      const payload = await postJson(API_LOOKUP, { mlb_ids: mlbs });
      renderLookupStats(payload);
      renderLookupRows(payload.rows || []);
      box("success", `Consulta finalizada.\n\nItens: ${payload.total || mlbs.length}\nCom prazo: ${payload.with_prazo || 0}\nSem prazo: ${payload.without_prazo || 0}`);
      notify("success", `Consulta concluida: ${payload.total || mlbs.length} anuncio(s).`);
    } catch (e) {
      box("error", `Erro ao consultar prazos.\n\n${e.message}`);
      notify("error", `Erro: ${e.message}`);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.style.opacity = "";
      }
    }
  }

  async function consultarPrazosAtivos() {
    const maxItems = parseOptionalPositiveInt(elConsultaMaxAtivos()?.value || "");
    const btn = $("#btnConsultarPrazo");
    if (btn) {
      btn.disabled = true;
      btn.style.opacity = "0.75";
    }

    try {
      box(
        "info",
        `Consulta enviada para o painel de processos.\n\nFonte: anuncios ativos da conta${maxItems ? `\nLimite: ${maxItems}` : "\nLimite: todos"}`
      );
      const payload = await postJson(API_LOOKUP_ACTIVE_JOB, {
        max_items: maxItems,
      });
      const jobId = payload.process_id || payload.job_id;
      notify("info", "Consulta dos ativos enviada para o painel.");
      window.PrazoBulk?.syncJobsPanel?.();
      window.PrazoBulk?.startPanelSync?.();
      if (jobId) monitorConsultaAtivos(jobId);
    } catch (e) {
      box("error", `Erro ao iniciar consulta dos ativos.\n\n${e.message}`);
      notify("error", `Erro: ${e.message}`);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.style.opacity = "";
      }
    }
  }

  function monitorConsultaAtivos(jobId) {
    const id = String(jobId || "").trim();
    if (!id) return;
    let tries = 0;
    const timer = setInterval(async () => {
      tries += 1;
      try {
        const r = await fetch(withBase(API_JOB_DETAIL(id)), {
          cache: "no-store",
          credentials: "same-origin",
        });
        const data = await r.json().catch(() => ({}));
        const job = data?.job || data;
        const completed =
          job?.completed === true ||
          /^conclu|^erro|^falh|^cancel/i.test(String(job?.state || job?.status || ""));

        if (!completed && tries < 720) return;
        clearInterval(timer);

        const result = job?.result || {};
        if (Array.isArray(result.rows)) {
          renderLookupStats(result);
          renderLookupRows(result.rows);
          box(
            "success",
            `Consulta dos ativos finalizada.\n\nItens: ${result.total || result.rows.length}\nCom prazo: ${result.with_prazo || 0}\nSem prazo: ${result.without_prazo || 0}`
          );
          notify("success", `Consulta dos ativos concluida: ${result.total || result.rows.length} anuncio(s).`);
        } else if (result?.success === false || /^erro|^falh/i.test(String(job?.state || job?.status || ""))) {
          const msg = result?.error || job?.state || job?.status || "Falha ao consultar ativos.";
          box("error", `Consulta dos ativos falhou.\n\n${msg}`);
          notify("error", `Consulta dos ativos falhou: ${msg}`);
        } else if (completed) {
          box(
            "info",
            "Consulta finalizada no painel. Use o CSV do card para baixar os resultados."
          );
        }
      } catch (_e) {
        if (tries >= 720) clearInterval(timer);
      }
    }, 3000);
  }

  function csvEscape(value) {
    const text = String(value ?? "");
    if (/[;"\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  }

  function exportarConsultaPrazo() {
    if (!lookupRows.length) {
      notify("warning", "Consulte alguns MLBs antes de exportar.");
      return;
    }

    const headers = ["MLB", "Titulo", "Status", "Prazo atual", "Envio", "Atualizado em", "Erro"];
    const lines = [headers.join(";")].concat(
      lookupRows.map((row) => [
        row.mlb_id || "",
        row.title || "",
        row.status || "",
        prazoLabel(row),
        envioLabel(row),
        row.last_updated || "",
        row.error || "",
      ].map(csvEscape).join(";"))
    );
    const blob = new Blob([`\uFEFF${lines.join("\r\n")}`], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `consulta-prazo-producao-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    notify("success", "CSV da consulta exportado.");
  }

  function limparConsulta() {
    if (elConsultaMlbs()) elConsultaMlbs().value = "";
    lookupRows = [];
    lookupPage = 1;
    const resumo = $("#consultaResumo");
    const shell = $("#consultaTabelaShell");
    const pager = $("#consultaPager");
    if (resumo) resumo.hidden = true;
    if (shell) shell.hidden = true;
    if (pager) pager.innerHTML = "";
    notify("info", "Consulta limpa.");
  }

  // ===== Single
  async function prazoSingle() {
    injectNotifKeyframes();

    const rawMlb = elMlbSingle().value;
    const mlb = parseFirstMlb(rawMlb);
    const days = parseDays(elDiasSingle().value);

    if (!mlb) {
      notify("error", "Informe um MLB válido (ex: MLB1234567890).");
      return;
    }
    if (days === null) {
      notify("error", "Informe um prazo válido (dias inteiros, >= 0).");
      return;
    }

    const btn = $("#btnPrazoSingle");
    if (btn) {
      btn.disabled = true;
      btn.style.opacity = "0.75";
    }

    box(
      "info",
      `🔄 Atualizando prazo...\n\nMLB: ${mlb}\nNovo prazo: ${days} dia(s)`
    );

    try {
      const data = await postJson(API_SINGLE, { mlb_id: mlb, days });

      const ok = data.ok ?? data.success ?? true;
      if (!ok)
        throw new Error(data.error || data.message || "Falha ao atualizar");

      box(
        "success",
        `✅ Prazo atualizado!\n\nMLB: ${data.mlb_id || mlb}\nPrazo: ${
          data.days ?? days
        } dia(s)\n${data.message ? `\n${data.message}` : ""}`
      );
      notify("success", `Prazo atualizado: ${mlb} → ${days} dia(s)`);
    } catch (e) {
      box("error", `❌ Erro ao atualizar prazo.\n\n${e.message}`);
      notify("error", `Erro: ${e.message}`);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.style.opacity = "";
      }
    }
  }

  // ===== Bulk
  async function prazoBulk() {
    injectNotifKeyframes();

    const days = parseDays(elDiasBulk().value);
    if (days === null) {
      notify("error", "Informe um prazo válido (dias inteiros, >= 0).");
      return;
    }

    const mlbs = parseMlbs(elMlbsBulk().value);
    if (!mlbs.length) {
      notify("error", "Informe ao menos um MLB válido (um por linha).");
      return;
    }

    const btn = $("#btnPrazoBulk");
    if (btn) {
      btn.disabled = true;
      btn.style.opacity = "0.75";
    }

    // Preferência: painel/fila (PrazoBulk + JobsPanel)
if (window.PrazoBulk && typeof window.PrazoBulk.enqueue === "function") {
      try {
        await window.PrazoBulk.enqueue({
          items: mlbs,
          days,
          delayMs: DEFAULT_DELAY_MS,
          title: `Prazo – ${days} dia(s) • ${mlbs.length} itens`,
          onJobCreated(jobId) {
            currentProcessId = jobId;
            box(
              "info",
              `🚀 Processo iniciado.\n\nProcess ID: ${jobId}\nItens: ${mlbs.length}\nPrazo: ${days} dia(s)\n\nAcompanhando processamento...`
            );
            monitorarProgresso(jobId);
          },
        });

        notify(
          "info",
          "Processo enviado para o painel (canto inferior direito)."
        );
      } catch (e) {
        box("error", `❌ Falha ao enfileirar no painel.\n\n${e.message}`);
        notify("error", `Falha no painel: ${e.message}`);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.style.opacity = "";
        }
      }
      return;
    }

    // Fallback legado
    box(
      "info",
      `🚀 Iniciando atualização em lote (modo legado)...\n\nItens: ${mlbs.length}\nPrazo: ${days} dia(s)`
    );

    try {
      const data = await postJson(API_BULK_LEGACY, {
        mlb_ids: mlbs,
        days,
        delay_ms: 3000,
      });

      if (data.process_id) {
        currentProcessId = data.process_id;
        monitorarProgresso(currentProcessId);
      } else {
        box(
          "success",
          `✅ Lote enviado!\n\nItens: ${mlbs.length}\nPrazo: ${days} dia(s)\n${
            data.message ? `\n${data.message}` : ""
          }`
        );
      }

      notify("info", `Lote iniciado: ${mlbs.length} itens`);
    } catch (e) {
      box("error", `❌ Erro ao iniciar lote.\n\n${e.message}`);
      notify("error", `Erro: ${e.message}`);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.style.opacity = "";
      }
    }
  }

  // ===== Status legado
  async function verificarStatus() {
    injectNotifKeyframes();

    if (
      window.PrazoBulk &&
      typeof window.PrazoBulk.hasActiveProcess === "function" &&
      window.PrazoBulk.hasActiveProcess() &&
      typeof window.PrazoBulk.verificarStatus === "function"
    ) {
      try {
        const data = await window.PrazoBulk.verificarStatus();
        box(
          "info",
          `📊 STATUS\n\nProcess ID: ${data.id || "—"}\nStatus: ${
            data.status || "—"
          }\nProgresso: ${data.progresso ?? "—"}%\nProcessados: ${
            data.processados ?? "—"
          }/${data.total_anuncios ?? "—"}\nSucessos: ${
            data.sucessos ?? "—"
          }\nErros: ${data.erros ?? "—"}`
        );
        notify("info", "Status do painel atualizado.");
      } catch (e) {
        box("error", `❌ Erro ao buscar status.\n\n${e.message}`);
        notify("error", `Erro status: ${e.message}`);
      }
      return;
    }

    if (!currentProcessId) {
      notify("warning", "Nenhum processamento ativo (modo legado).");
      return;
    }

    try {
      const r = await fetch(withBase(API_STATUS(currentProcessId)), {
        cache: "no-store",
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok)
        throw new Error(data.error || data.message || `HTTP ${r.status}`);

      const concluido =
        data.status === "concluido"
          ? `\nConcluído: ${new Date(data.concluido_em).toLocaleString(
              "pt-BR"
            )}`
          : "";

      box(
        "info",
        `📊 STATUS (LEGADO)\n\nProcess ID: ${
          data.id || currentProcessId
        }\nStatus: ${data.status || "—"}\nProgresso: ${
          data.progresso ?? "—"
        }%\nProcessados: ${data.processados ?? "—"}/${
          data.total_anuncios ?? "—"
        }\nSucessos: ${data.sucessos ?? "—"}\nErros: ${
          data.erros ?? "—"
        }\nIniciado: ${
          data.iniciado_em
            ? new Date(data.iniciado_em).toLocaleString("pt-BR")
            : "—"
        }${concluido}`
      );

      notify("info", "Status atualizado.");
    } catch (e) {
      box("error", `❌ Erro ao buscar status.\n\n${e.message}`);
      notify("error", `Erro status: ${e.message}`);
    }
  }

function monitorarProgresso(processId) {
    if (monitorInterval) clearInterval(monitorInterval);
    currentProcessId = processId;

    monitorInterval = setInterval(async () => {
      try {
        if (
          window.PrazoBulk &&
          typeof window.PrazoBulk.hasActiveProcess === "function" &&
          window.PrazoBulk.hasActiveProcess() &&
          typeof window.PrazoBulk.verificarStatus === "function"
        ) {
          const data = await window.PrazoBulk.verificarStatus();
          box(
            "info",
            `📊 STATUS\n\nProcess ID: ${data.id || processId || "—"}\nStatus: ${
              data.state || data.status || "—"
            }\nProgresso: ${data.progress ?? data.progresso ?? "—"}%\nProcessados: ${
              data.processed ?? data.processados ?? "—"
            }/${data.total ?? data.total_anuncios ?? "—"}\nSucessos: ${
              data.success ?? data.sucessos ?? "—"
            }\nErros: ${data.errors ?? data.erros ?? "—"}`
          );
          const normalizedState = String(data.state || data.status || "").toLowerCase();
          if (/conclu|finaliz|done|completed|erro|fail|cancel/.test(normalizedState)) {
            clearInterval(monitorInterval);
            monitorInterval = null;
            verificarStatus();
          }
          return;
        }

        const r = await fetch(withBase(API_STATUS(processId)), { cache: "no-store" });
        const data = await r.json().catch(() => ({}));
        if (!r.ok)
          throw new Error(data.error || data.message || `HTTP ${r.status}`);

        if (data.status === "concluido" || data.status === "erro") {
          clearInterval(monitorInterval);
          monitorInterval = null;
          verificarStatus();
        }
      } catch (_e) {
        clearInterval(monitorInterval);
        monitorInterval = null;
      }
    }, 3000);
  }

  // ===== Clear
  function limparSingle() {
    elMlbSingle().value = "";
    elDiasSingle().value = "";
    notify("info", "Campos unitários limpos.");
  }

  function limparBulk() {
    elDiasBulk().value = "";
    elMlbsBulk().value = "";
    notify("info", "Campos do lote limpos.");
  }

  function limparTudo() {
    elRes().innerHTML = "";
    if (monitorInterval) {
      clearInterval(monitorInterval);
      monitorInterval = null;
    }
    currentProcessId = null;
    notify("info", "Tudo limpo.");
  }

  document.querySelectorAll("[data-pz-tab]").forEach((button) => {
    button.addEventListener("click", () => setActiveTab(button.dataset.pzTab));
  });

  document.querySelectorAll('input[name="consultaFonte"]').forEach((input) => {
    input.addEventListener("change", syncConsultaFonteUi);
  });
  syncConsultaFonteUi();

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-use-mlb]");
    if (!button) return;
    const mlb = String(button.dataset.useMlb || "").trim();
    if (!mlb) return;
    if (elMlbSingle()) elMlbSingle().value = mlb;
    setActiveTab("unitario");
    notify("info", `${mlb} enviado para alteracao unitaria.`);
  });


  // ===== Expose
  window.consultarPrazos = consultarPrazos;
  window.exportarConsultaPrazo = exportarConsultaPrazo;
  window.limparConsulta = limparConsulta;
  window.prazoSingle = prazoSingle;
  window.prazoBulk = prazoBulk;
  window.verificarStatus = verificarStatus;
  window.limparSingle = limparSingle;
  window.limparBulk = limparBulk;

  console.log("✅ prazo.js pronto");
})();
