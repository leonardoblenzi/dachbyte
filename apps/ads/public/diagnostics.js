"use strict";

(() => {
  const host = document.querySelector("[data-findings-list]");
  const status = document.querySelector("[data-diagnostics-status]");
  if (!host || !status) return;
  const state = { range: 30 };

  async function request(url, options = {}) {
    const response = await fetch(url, { credentials: "include", headers: { accept: "application/json", ...(options.body ? { "content-type": "application/json" } : {}) }, ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
    return payload;
  }
  function setStatus(text, tone = "info") { status.textContent = text; status.className = `ads-alert ads-alert--${tone}`; }
  function money(value) { return Number.isFinite(Number(value)) ? Number(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : String(value ?? "—"); }
  function evidenceText(evidence) {
    if (!evidence || typeof evidence !== "object") return "Sem evidência estruturada.";
    const pairs = [];
    for (const [key, value] of Object.entries(evidence)) {
      if (key === "topTerms" && Array.isArray(value)) { pairs.push(`${value.length} termos destacados`); continue; }
      if (typeof value === "number") pairs.push(`${key}: ${key.toLowerCase().includes("spend") || key.toLowerCase().includes("cpa") ? money(value) : value.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}`);
      else if (value !== null && typeof value !== "object") pairs.push(`${key}: ${value}`);
    }
    return pairs.join(" · ") || "Evidência disponível nos dados sincronizados.";
  }
  function severityLabel(value) { return ({ critical:"Crítico", high:"Alto", medium:"Médio", low:"Baixo", info:"Informativo" })[value] || value; }
  function field(label, text) {
    const node = document.createElement("div"); node.className = "ads-finding-field";
    const strong = document.createElement("strong"); strong.textContent = label;
    const p = document.createElement("p"); p.textContent = text || "—"; node.append(strong,p); return node;
  }
  async function changeStatus(id, nextStatus) {
    await request(`/ads/api/diagnostics/${encodeURIComponent(id)}/status`, { method: "PATCH", body: JSON.stringify({ status: nextStatus }) });
    await load();
  }
  function render(payload) {
    host.replaceChildren(); const findings = payload.findings || [];
    const version = document.querySelector("[data-rules-version]"); if (version) version.textContent = payload.rulesVersion || "—";
    const counts = { high:0, medium:0, info:0 };
    findings.forEach((item) => { if (["critical","high"].includes(item.severity)) counts.high += 1; else if (item.severity === "medium") counts.medium += 1; else counts.info += 1; });
    Object.entries(counts).forEach(([key,value]) => { const node=document.querySelector(`[data-finding-count="${key}"]`); if(node) node.textContent=String(value); });
    if (!findings.length) { const empty=document.createElement("div"); empty.className="ads-loading-row"; empty.textContent="Nenhum finding ativo. Rode o diagnóstico após sincronizar dados e definir as referências do negócio."; host.append(empty); return; }
    findings.forEach((item) => {
      const card=document.createElement("article"); card.className=`ads-finding-card ads-finding-card--${item.severity}`;
      const head=document.createElement("header");
      const copy=document.createElement("div"); const eyebrow=document.createElement("span"); eyebrow.className="ads-eyebrow"; eyebrow.textContent=`${item.provider || "multicanal"} · ${item.rule_id}`; const title=document.createElement("h3"); title.textContent=item.title; copy.append(eyebrow,title);
      const badge=document.createElement("span"); badge.className=`ads-severity ads-severity--${item.severity}`; badge.textContent=severityLabel(item.severity); head.append(copy,badge);
      const diag=document.createElement("p"); diag.className="ads-finding-diagnosis"; diag.textContent=item.diagnosis;
      const evidence=document.createElement("div"); evidence.className="ads-finding-evidence"; evidence.textContent=evidenceText(item.evidence);
      const grid=document.createElement("div"); grid.className="ads-finding-grid"; grid.append(field("Ação recomendada",item.recommended_action),field("O que não alterar",item.do_not_change),field("Observação",item.observation),field("Próxima decisão",item.next_decision));
      const actions=document.createElement("div"); actions.className="ads-finding-actions";
      if (item.status !== "acknowledged") { const ack=document.createElement("button"); ack.type="button"; ack.className="ads-secondary-button"; ack.textContent="Marcar como visto"; ack.addEventListener("click",()=>void changeStatus(item.id,"acknowledged")); actions.append(ack); }
      if (item.status !== "dismissed") { const dismiss=document.createElement("button"); dismiss.type="button"; dismiss.className="ads-icon-text-button"; dismiss.textContent="Dispensar"; dismiss.addEventListener("click",()=>void changeStatus(item.id,"dismissed")); actions.append(dismiss); }
      card.append(head,diag,evidence,grid,actions); host.append(card);
    });
  }
  async function load() {
    try { const payload=await request("/ads/api/diagnostics/"); render(payload); setStatus(`${payload.findings?.length || 0} finding(s) ativo(s). Os diagnósticos não alteram campanhas automaticamente.`, "info"); }
    catch(error){ setStatus(error.message,"danger"); }
  }
  document.querySelectorAll("[data-diagnostic-range]").forEach((button)=>button.addEventListener("click",()=>{ document.querySelectorAll("[data-diagnostic-range]").forEach((node)=>node.classList.remove("is-active")); button.classList.add("is-active"); state.range=Number(button.dataset.diagnosticRange||30); }));
  document.querySelector("[data-run-diagnostics]")?.addEventListener("click", async (event) => {
    const button=event.currentTarget; button.disabled=true; setStatus("Executando regras FZ sobre os dados sincronizados…","info");
    try { const payload=await request("/ads/api/diagnostics/run",{method:"POST",body:JSON.stringify({range:state.range})}); render(payload); setStatus(`Diagnóstico concluído: ${payload.findings?.length || 0} finding(s) ativo(s).`,"success"); }
    catch(error){ setStatus(error.message,"danger"); }
    finally { button.disabled=false; }
  });
  void load();
})();
