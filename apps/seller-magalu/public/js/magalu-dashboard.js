(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
  const money = (value) => Number.isFinite(Number(value)) ? new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(Number(value)) : "—";
  const integer = (value) => new Intl.NumberFormat("pt-BR").format(Number(value)||0);
  const dateTime = (value) => { if(!value) return "—"; const d=new Date(value); return Number.isNaN(d.getTime())?"—":new Intl.DateTimeFormat("pt-BR",{dateStyle:"short",timeStyle:"short"}).format(d); };
  const pct = (value) => `${new Intl.NumberFormat("pt-BR",{maximumFractionDigits:1}).format(Number(value)||0)}%`;

  function deltaMeta(current, delta){
    const d=Number(delta); const c=Number(current)||0; if(!Number.isFinite(d)) return {text:"Sem histórico suficiente",tone:"neutral"};
    const previous=c-d; if(previous<=0) return {text:`${d>=0?"+":""}${integer(d)} pedido(s) vs. período anterior`,tone:d>0?"positive":d<0?"negative":"neutral"};
    const percent=(d/previous)*100; return {text:`${percent>=0?"+":""}${pct(percent)} vs. período anterior`,tone:percent>0?"positive":percent<0?"negative":"neutral"};
  }
  function statusTone(status){ const s=String(status||"").toLowerCase(); if(["success","active","succeeded","completed"].includes(s))return"success"; if(["failed","error","divergent","uncertain"].includes(s))return"danger"; if(["partial","warning","queued","running","dispatching"].includes(s))return"warning"; return"neutral"; }

  function renderPriorities(data){
    const host=$("mg-dashboard-priorities"); if(!host)return;
    const catalog=data?.catalog||{}, coverage=data?.margin_coverage||{}, account=data?.account||{}, orders=data?.orders||{};
    const list=[];
    if(["failed","partial"].includes(String(account.catalog_sync_status||""))) list.push({tone:"danger",title:"Sincronização do catálogo precisa de atenção",detail:account.catalog_last_error||"A última leitura não terminou de forma íntegra.",href:"/magalu/integracoes",action:"Abrir integração"});
    if(Number(catalog.zero_stock_count||0)>0) list.push({tone:Number(catalog.zero_stock_count)>100?"danger":"warning",title:"SKUs publicados sem estoque",detail:`${integer(catalog.zero_stock_count)} SKU(s) estão com estoque zerado na réplica local.`,href:"/magalu/estoque",action:"Revisar estoque"});
    const missingCosts=Math.max(0,Number(coverage.priced_skus||0)-Number(coverage.costed_skus||0));
    if(missingCosts>0) list.push({tone:"warning",title:"Cobertura de custos incompleta",detail:`${integer(missingCosts)} SKU(s) com preço ainda não possuem custo cadastrado.`,href:"/magalu/margem?aba=costs",action:"Completar custos"});
    if(Number(orders.total||0)===0) list.push({tone:"neutral",title:"Sem pedidos no período selecionado",detail:"Confira a sincronização de Pedidos antes de interpretar o desempenho comercial.",href:"/magalu/pedidos",action:"Abrir pedidos"});
    if(!list.length) list.push({tone:"success",title:"Nenhuma prioridade crítica no recorte atual",detail:"Estoque, cobertura de custos e sincronizações locais não apresentam alerta imediato.",href:"/magalu/integracoes",action:"Ver saúde da conta"});
    host.innerHTML=list.slice(0,4).map((item,index)=>`<a class="mg-dashboard-priority" data-tone="${esc(item.tone)}" href="${esc(item.href)}"><span class="mg-dashboard-priority__index">${index+1}</span><span class="mg-dashboard-priority__copy"><strong>${esc(item.title)}</strong><span>${esc(item.detail)}</span></span><span class="mg-dashboard-priority__action">${esc(item.action)} →</span></a>`).join("");
  }

  function renderDeliveryStatuses(rows){
    const host=$("mg-dashboard-delivery-statuses"); if(!host)return;
    const values=Array.isArray(rows)?rows:[];
    host.innerHTML=values.length?values.slice(0,5).map((row)=>`<div><span>${esc(row.status||"unknown")}</span><strong>${integer(row.total)}</strong></div>`).join(""):'<div><span>Sem entregas sincronizadas</span><strong>—</strong></div>';
  }

  function render(data){
    if(!document.querySelector('[data-page="/"]') || location.pathname.replace(/\/$/,"")!=="/magalu") return;
    const catalog=data?.catalog||{}, orders=data?.orders||{}, coverage=data?.margin_coverage||{}, account=data?.account||{}, latest=data?.latest_run||{}, comparison=data?.comparison||{};
    const period=data?.period?.label||"Período selecionado";
    const deliveryStatuses=orders.delivery_statuses||[]; const deliveryTotal=deliveryStatuses.reduce((sum,row)=>sum+Number(row.total||0),0);
    const missingCosts=Math.max(0,Number(coverage.priced_skus||0)-Number(coverage.costed_skus||0));
    const stockBase=Math.max(Number(catalog.published_count||0),1); const stockRisk=(Number(catalog.zero_stock_count||0)/stockBase)*100;
    const delta=deltaMeta(orders.total,comparison.orders_delta);

    $("mg-dashboard-period-label") && ($("mg-dashboard-period-label").textContent=period);
    $("mg-dashboard-account-name") && ($("mg-dashboard-account-name").textContent=account.magalu_tenant_name||account.magalu_tenant_id||"Conta Magalu");
    $("mg-dashboard-updated") && ($("mg-dashboard-updated").textContent=account.catalog_last_synced_at?`Catálogo ${dateTime(account.catalog_last_synced_at)}`:"Catálogo sem sincronização");

    $("kpi-gmv-30d") && ($("kpi-gmv-30d").textContent=orders.gross_value_30d!=null?money(orders.gross_value_30d):"—");
    $("kpi-orders-30d") && ($("kpi-orders-30d").textContent=orders.total??"—");
    $("mg-dashboard-orders-delta") && ($("mg-dashboard-orders-delta").textContent=delta.text,$("mg-dashboard-orders-delta").dataset.tone=delta.tone);
    $("mg-dashboard-cost-coverage") && ($("mg-dashboard-cost-coverage").textContent=`${Number(coverage.percent||0)}%`);
    $("mg-dashboard-cost-coverage-meta") && ($("mg-dashboard-cost-coverage-meta").textContent=`${integer(coverage.costed_skus)} de ${integer(coverage.priced_skus)} SKU(s) com preço`);
    $("kpi-zero") && ($("kpi-zero").textContent=integer(catalog.zero_stock_count));
    $("mg-dashboard-stock-meta") && ($("mg-dashboard-stock-meta").textContent=`${pct(stockRisk)} dos SKUs publicados`);
    $("kpi-ticket-30d") && ($("kpi-ticket-30d").textContent=orders.ticket_average_30d!=null?money(orders.ticket_average_30d):"—");
    $("kpi-skus") && ($("kpi-skus").textContent=integer(catalog.published_count));
    $("kpi-prices") && ($("kpi-prices").textContent=integer(catalog.priced_count));
    $("mg-dashboard-deliveries-count") && ($("mg-dashboard-deliveries-count").textContent=deliveryTotal?integer(deliveryTotal):"—");

    $("mg-dashboard-orders-today") && ($("mg-dashboard-orders-today").textContent=integer(orders.today));
    $("mg-dashboard-orders-period") && ($("mg-dashboard-orders-period").textContent=integer(orders.total));
    $("mg-dashboard-commercial-gmv") && ($("mg-dashboard-commercial-gmv").textContent=orders.gross_value_30d!=null?money(orders.gross_value_30d):"—");
    $("mg-dashboard-commercial-ticket") && ($("mg-dashboard-commercial-ticket").textContent=orders.ticket_average_30d!=null?money(orders.ticket_average_30d):"—");
    $("mg-dashboard-commercial-period-orders") && ($("mg-dashboard-commercial-period-orders").textContent=integer(orders.total));
    $("mg-dashboard-commercial-deliveries") && ($("mg-dashboard-commercial-deliveries").textContent=deliveryTotal?integer(deliveryTotal):"—");
    $("mg-dashboard-orders-period-label") && ($("mg-dashboard-orders-period-label").textContent=period);
    $("mg-dashboard-comparison") && ($("mg-dashboard-comparison").textContent=delta.text);
    $("mg-dashboard-scopes") && ($("mg-dashboard-scopes").textContent=`${integer(coverage.costed_skus)} custos cadastrados`);
    $("mg-dashboard-priced-ready") && ($("mg-dashboard-priced-ready").textContent=integer(coverage.priced_skus));
    $("mg-dashboard-token") && ($("mg-dashboard-token").textContent=`${Number(coverage.percent||0)}% de cobertura`);
    $("mg-dashboard-account") && ($("mg-dashboard-account").textContent=account.magalu_tenant_name||account.magalu_tenant_id||"—");
    $("mg-dashboard-account-status") && ($("mg-dashboard-account-status").textContent=account.status||"—",$("mg-dashboard-account-status").dataset.state=account.status||"idle");

    const syncTone=statusTone(account.catalog_sync_status||latest.status); const syncLabel=account.catalog_sync_status||latest.status||"idle";
    $("mg-dashboard-sync-status") && ($("mg-dashboard-sync-status").textContent=syncLabel,$("mg-dashboard-sync-status").dataset.state=syncLabel);
    $("mg-dashboard-run-start") && ($("mg-dashboard-run-start").textContent=dateTime(latest.started_at));
    $("mg-dashboard-run-scanned") && ($("mg-dashboard-run-scanned").textContent=latest.scanned_count??"—");
    $("mg-dashboard-run-pages") && ($("mg-dashboard-run-pages").textContent=latest.result?.pages??"—");
    $("mg-dashboard-run-error") && ($("mg-dashboard-run-error").textContent=latest.error_message||account.catalog_last_error||"Nenhuma");
    $("mg-dashboard-sync-card") && ($("mg-dashboard-sync-card").dataset.tone=syncTone);
    $("mg-dashboard-sync-badge") && ($("mg-dashboard-sync-badge").textContent=syncLabel,$("mg-dashboard-sync-badge").dataset.tone=syncTone);

    const health=$("mg-dashboard-health"); if(health){health.hidden=false;health.dataset.tone=syncTone;const text=$("mg-dashboard-health-text");if(text){text.textContent=syncTone==="danger"?(account.catalog_last_error||"A sincronização do catálogo falhou."):Number(catalog.zero_stock_count||0)>0?`${integer(catalog.zero_stock_count)} SKU(s) publicados estão sem estoque.`:missingCosts>0?`${integer(missingCosts)} SKU(s) com preço ainda estão sem custo cadastrado.`:"A conta não possui alerta crítico local neste recorte.";}}
    const stockTone=Number(catalog.zero_stock_count||0)>0?"warning":"success";
    $("mg-dashboard-stock-card") && ($("mg-dashboard-stock-card").dataset.tone=stockTone);
    $("mg-dashboard-stock-risk-card") && ($("mg-dashboard-stock-risk-card").dataset.tone=stockTone);
    $("mg-dashboard-stock-status") && ($("mg-dashboard-stock-status").textContent=stockTone==="warning"?"Atenção":"Saudável",$("mg-dashboard-stock-status").dataset.tone=stockTone);
    $("mg-dashboard-cost-card") && ($("mg-dashboard-cost-card").dataset.tone=missingCosts>0?"warning":"success");
    $("mg-dashboard-stock-risk") && ($("mg-dashboard-stock-risk").textContent=pct(stockRisk));
    $("mg-dashboard-stock-count") && ($("mg-dashboard-stock-count").textContent=`${integer(catalog.zero_stock_count)} SKU(s) zerados`);
    $("mg-dashboard-cost-missing") && ($("mg-dashboard-cost-missing").textContent=integer(missingCosts));
    $("mg-dashboard-cost-caption") && ($("mg-dashboard-cost-caption").textContent=missingCosts?"SKU(s) precificados ainda sem custo":"Cobertura de custos completa no recorte precificado");
    $("mg-dashboard-delivery-main") && ($("mg-dashboard-delivery-main").textContent=deliveryTotal?integer(deliveryTotal):"—");
    $("mg-dashboard-delivery-badge") && ($("mg-dashboard-delivery-badge").textContent=deliveryTotal?"Sincronizadas":"Aguardando",$("mg-dashboard-delivery-badge").dataset.tone=deliveryTotal?"success":"warning");
    renderDeliveryStatuses(deliveryStatuses); renderPriorities(data);
  }

  window.addEventListener("magalu:dashboarddata",(event)=>render(event.detail?.data||null));
})();
