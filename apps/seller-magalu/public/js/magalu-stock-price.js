(() => {
  "use strict";
  const $=(id)=>document.getElementById(id);
  const shell=()=>window.MagaluSellerShell;
  const state={days:30,view:"all",loadedFor:null};
  const esc=(v)=>String(v==null?"":v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const num=(v)=>new Intl.NumberFormat("pt-BR",{maximumFractionDigits:1}).format(Number(v)||0);
  const money=(v)=>v==null?"—":new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(Number(v)||0);
  const days=(v)=>v==null?"Sem giro":`${num(v)} dias`;
  function account(){return Number(shell()?.getSelectedAccountId?.())||null;}
  async function api(path){return shell().fetchJson(`/magalu/api/ux-analytics${path}`);}
  function isStock(){return shell()?.route?.()==="/estoque";}
  function setPanel(name){document.querySelectorAll("[data-stock-workspace]").forEach(b=>b.classList.toggle("is-active",b.dataset.stockWorkspace===name));document.querySelectorAll("[data-stock-panel]").forEach(p=>p.hidden=p.dataset.stockPanel!==name);}
  function riskLabel(r){return r==="critical"?"Crítico":r==="attention"?"Atenção":r==="no_sales"?"Sem giro":"Saudável";}
  function renderStock(data){
    const s=data.summary||{};
    $("mg-stock-critical").textContent=num(s.critical);$("mg-stock-attention").textContent=num(s.attention);$("mg-stock-coverage").textContent=s.average_coverage_days==null?"—":`${num(s.average_coverage_days)} dias`;$("mg-stock-suggested").textContent=num(s.suggested_units);
    $("mg-stock-critical-meta").textContent=`${num(s.zero_stock)} com estoque zerado`;$("mg-stock-attention-meta").textContent="cobertura entre 8 e 15 dias";$("mg-stock-coverage-meta").textContent="média dos SKUs com giro";$("mg-stock-suggested-meta").textContent=s.suggested_value_known?`${money(s.suggested_value)} em custo conhecido`:"valor depende de custos cadastrados";
    const banner=$("mg-stock-priority");
    if(Number(s.critical)>0){banner.dataset.tone="critical";banner.innerHTML=`<span class="mg-priority-banner__index">!</span><div><strong>${num(s.critical)} produto(s) em risco crítico</strong><span>Estoque zerado ou cobertura estimada de até 7 dias. Reposição sugerida: ${num(s.suggested_units)} unidade(s).</span></div><button class="mg-secondary-btn" type="button" data-stock-view-jump="replacement">Ver reposição</button>`;}
    else if(Number(s.attention)>0){banner.dataset.tone="warning";banner.innerHTML=`<span class="mg-priority-banner__index">!</span><div><strong>${num(s.attention)} produto(s) pedem atenção</strong><span>Cobertura estimada entre 8 e 15 dias no período analisado.</span></div><button class="mg-secondary-btn" type="button" data-stock-view-jump="replacement">Revisar</button>`;}
    else{banner.dataset.tone="healthy";banner.innerHTML=`<span class="mg-priority-banner__index">✓</span><div><strong>Nenhuma ruptura próxima identificada</strong><span>A leitura usa vendas sincronizadas dos últimos ${data.days} dias e o estoque atual.</span></div>`;}
    $("mg-stock-action-critical").textContent=`${num(s.critical)} produto(s)`;$("mg-stock-action-attention").textContent=`${num(s.attention)} produto(s)`;$("mg-stock-action-nosales").textContent=`${num(s.no_sales)} produto(s)`;$("mg-stock-action-value").textContent=s.suggested_value_known?money(s.suggested_value):`${num(s.suggested_units)} un.`;
    const body=$("mg-stock-analysis-body");
    body.innerHTML=(data.rows||[]).map(r=>`<tr><td><strong>${esc(r.sku)}</strong><small>${esc(r.title||"Sem título")}</small></td><td>${num(r.stock_quantity)}</td><td>${num(r.sold_units)}</td><td>${days(r.coverage_days)}</td><td>${num(r.suggested_units)}</td><td><span class="mg-risk-badge" data-tone="${esc(r.risk)}">${riskLabel(r.risk)}</span></td><td><button class="mg-secondary-btn" type="button" data-stock-edit-sku="${esc(r.sku)}">Atualizar</button></td></tr>`).join("")||'<tr><td colspan="7" class="mg-empty-state">Nenhum SKU neste recorte.</td></tr>';
    $("mg-stock-analysis-meta").textContent=`${num(data.total)} SKU(s) · ${data.days} dias`;
  }
  async function loadStock(){if(!isStock()||!account())return;try{const data=await api(`/stock?account_id=${account()}&days=${state.days}&view=${encodeURIComponent(state.view)}&limit=100`);state.loadedFor=account();renderStock(data);}catch(e){shell()?.showAlert?.(e.message,"danger");}}
  function setView(view){state.view=view;document.querySelectorAll("[data-stock-view]").forEach(b=>b.classList.toggle("is-active",b.dataset.stockView===view));void loadStock();}
  function editSku(sku){setPanel("update");$("mg-stock-mode-single")?.click();const input=$("mg-stock-sku-input");if(input)input.value=sku;$("mg-stock-resolve")?.click();}
  function bind(){
    document.querySelectorAll("[data-stock-workspace]").forEach(b=>b.addEventListener("click",()=>setPanel(b.dataset.stockWorkspace)));
    document.querySelectorAll("[data-stock-view]").forEach(b=>b.addEventListener("click",()=>setView(b.dataset.stockView)));
    document.querySelectorAll("[data-stock-days]").forEach(b=>b.addEventListener("click",()=>{state.days=Number(b.dataset.stockDays)||30;document.querySelectorAll("[data-stock-days]").forEach(x=>x.classList.toggle("is-active",x===b));void loadStock();}));
    $("mg-stock-analysis-refresh")?.addEventListener("click",()=>void loadStock());
    document.addEventListener("click",e=>{const jump=e.target.closest?.("[data-stock-view-jump]");if(jump)setView(jump.dataset.stockViewJump);const edit=e.target.closest?.("[data-stock-edit-sku]");if(edit)editSku(edit.dataset.stockEditSku);});
    window.addEventListener("magalu:accountchange",()=>void loadStock());window.addEventListener("magalu:shellready",()=>void loadStock());
  }
  document.addEventListener("DOMContentLoaded",()=>{bind();setPanel("analysis");if(shell()?.isReady?.())void loadStock();});
})();
