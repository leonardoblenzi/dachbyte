"use strict";

(function cashWorkspaceEnhancement() {
  let loading = false;

  function optionRows(rows, label) {
    return `<option value="">${label}</option>${rows.map((row) => `<option value="${row.id}">${escapeHtml(row.name || row.code)}</option>`).join("")}`;
  }

  async function renderCash(force = false) {
    const root = document.querySelector("#content");
    if (!root || document.querySelector("#pageTitle")?.textContent !== "Cash" || loading) return;
    if (!force && root.querySelector("#cashWorkspace")) return;
    loading = true;
    try {
      const data = await api("/cash");
      const summary = data.summary || {};
      const base = summary.scenarios?.base || [];
      root.innerHTML = `<div id="cashWorkspace">
        <div class="pagehead"><div><h1>Cash</h1><div class="sub">Fluxo de caixa, recebíveis e compromissos financeiros</div></div><span class="chip ${summary.overdueCount?"red":"green"}">${summary.overdueCount?`${summary.overdueCount} vencido(s)`:"Sem vencidos"}</span></div>
        <div class="grid kpis">
          <div class="card kpi"><small>Caixa atual</small><strong>${money(summary.currentBalance)}</strong></div>
          <div class="card kpi"><small>Comprometido</small><strong>${money(summary.committed)}</strong></div>
          <div class="card kpi"><small>Caixa livre</small><strong>${money(summary.freeCash)}</strong></div>
          <div class="card kpi"><small>A receber</small><strong>${money(summary.receivable)}</strong></div>
        </div>
        ${summary.overdueCount ? `<div class="notice danger-note" style="margin-top:16px">${summary.overdueCount} lançamento(s) vencido(s), total ${money(summary.overdueAmount)}.</div>` : ""}
        <div class="toolbar" style="margin-top:16px">
          <button class="primary" id="cashEntryNew">+ Conta</button><button id="cashAccountNew">+ Banco</button>
          <button id="cashCategoryNew">+ Categoria</button><button id="cashCenterNew">+ Centro de custo</button>
          <button id="cashRecurrenceNew">+ Recorrência</button><button id="cashReceivableNew">+ Recebível marketplace</button>
        </div>
        <div id="cashEditor"></div>
        <div class="grid two" style="margin-top:16px">
          <div class="card section"><div class="section-title"><h2>Projeção base</h2><span class="chip">5 horizontes</span></div>${base.map((point) => `<div class="scenario metric-row"><span>D+${point.days}</span><strong>${money(point.balance)}</strong></div>`).join("") || '<p class="muted">Cadastre contas com vencimento para projetar o caixa.</p>'}</div>
          <div class="card section"><div class="section-title"><h2>Caixa realmente livre</h2></div><div class="cash-line metric-row"><span>Saldo atual</span><strong>${money(summary.currentBalance)}</strong></div><div class="cash-line metric-row"><span>(-) Comprometido</span><strong>${money(summary.committed)}</strong></div><div class="cash-line metric-row"><span>Caixa livre</span><strong>${money(summary.freeCash)}</strong></div><div class="section-title"><h2>Recebíveis para projeção</h2></div><div class="cash-line metric-row"><span>A receber pendente</span><strong>${money(summary.receivable)}</strong></div><div class="section-title"><h2>Cenários em D+30</h2></div><div class="scenarios">${["conservative","base","expansion"].map((scenario) => { const point=(summary.scenarios?.[scenario]||[]).find((item)=>item.days===30); return `<div class="scenario metric-row"><span>${scenario === "conservative" ? "Conservador" : scenario === "expansion" ? "Expansão" : "Base"}</span><strong>${point?money(point.balance):"—"}</strong></div>`; }).join("")}</div></div>
        </div>
        <div class="card section" style="margin-top:16px"><div class="section-title"><h2>Contas bancárias</h2><span class="chip">${(data.accounts||[]).length}</span></div>${(data.accounts||[]).map((account)=>`<div class="list-row"><span>${escapeHtml(account.name)}</span><strong>${money(account.current_balance)}</strong></div>`).join("")||'<p class="muted">Nenhuma conta cadastrada.</p>'}</div>
        <div class="section-title"><h2>Contas a pagar e receber</h2></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Vencimento</th><th>Descrição</th><th>Direção</th><th>Status</th><th>Parcela</th><th>Valor</th><th>Realizado</th><th>Ações</th></tr></thead><tbody>
          ${(data.entries || []).map((entry) => `<tr><td>${escapeHtml(entry.expected_date || entry.due_date || "—")}</td><td>${escapeHtml(entry.description || entry.entry_type)}</td><td>${entry.direction === "inflow" ? "Entrada" : "Saída"}</td><td><span class="chip ${entry.status==="paid"?"green":entry.status==="cancelled"?"red":"amber"}">${escapeHtml(entry.status)}</span></td><td>${entry.installment_total > 1 ? `${entry.installment_number}/${entry.installment_total}` : "—"}</td><td>${money(entry.amount)}</td><td>${money(entry.realized_amount)}</td><td>${!["paid","cancelled"].includes(entry.status) ? `<button data-settle="${entry.id}" data-remaining="${Number(entry.amount)-Number(entry.realized_amount||0)}">Liquidar</button> <button class="danger" data-cancel="${entry.id}">Cancelar</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="8" class="muted">Nenhum lançamento financeiro.</td></tr>'}
        </tbody></table></div>
        <div class="grid two" style="margin-top:16px">
          <div class="card section"><h3>DRE por competência</h3>${(data.dre || []).slice(0,12).map((row) => `<div class="list-row"><span>${escapeHtml(row.period)} · Receita ${money(row.revenue)} · Despesa ${money(row.expenses)}</span><strong>${money(row.result)}</strong></div>`).join("") || '<p class="muted">Sem competências cadastradas.</p>'}</div>
          <div class="card section"><h3>Recebíveis de marketplaces</h3>${(data.receivables || []).slice(0,15).map((row) => `<div class="list-row"><span>${escapeHtml(row.channel)} · ${escapeHtml(row.external_order_id)} · ${escapeHtml(row.expected_date || "sem data")}</span><strong>${money(row.net_amount)}</strong></div>`).join("") || '<p class="muted">Nenhum recebível importado.</p>'}</div>
        </div>
      </div>`;

      const editor = root.querySelector("#cashEditor");
      root.querySelector("#cashEntryNew").onclick = () => {
        editor.innerHTML = `<div class="card"><h3>Novo lançamento</h3><div class="form-grid">
          <label>Direção<select id="ceDirection"><option value="outflow">Conta a pagar</option><option value="inflow">Conta a receber</option></select></label>
          <label>Valor<input id="ceAmount" type="number" step=".01"></label><label>Vencimento<input id="ceDue" type="date"></label>
          <label>Competência<input id="ceCompetence" type="date"></label><label>Parcelas<input id="ceInstallments" type="number" min="1" value="1"></label>
          <label>Banco<select id="ceAccount">${optionRows(data.accounts || [], "Sem conta")}</select></label>
          <label>Categoria<select id="ceCategory">${optionRows(data.categories || [], "Sem categoria")}</select></label>
          <label>Centro de custo<select id="ceCenter">${optionRows(data.costCenters || [], "Sem centro")}</select></label>
          <label class="wide">Descrição<input id="ceDescription"></label><label><input id="ceFixed" type="checkbox"> Despesa/receita fixa</label>
        </div><button class="primary" id="ceSave">Salvar</button></div>`;
        editor.querySelector("#ceSave").onclick = async () => { try { await api("/cash",{method:"POST",body:JSON.stringify({direction:editor.querySelector("#ceDirection").value,amount:editor.querySelector("#ceAmount").value,firstDueDate:editor.querySelector("#ceDue").value,competenceDate:editor.querySelector("#ceCompetence").value||null,installments:editor.querySelector("#ceInstallments").value,bankAccountId:editor.querySelector("#ceAccount").value||null,categoryId:editor.querySelector("#ceCategory").value||null,costCenterId:editor.querySelector("#ceCenter").value||null,description:editor.querySelector("#ceDescription").value,isFixed:editor.querySelector("#ceFixed").checked})}); toast("Lançamento criado."); renderCash(true); } catch(error){toast(error.message,true);} };
      };

      root.querySelector("#cashAccountNew").onclick = () => quickForm(editor,"Nova conta bancária",[{id:"refName",label:"Nome"},{id:"refInstitution",label:"Instituição"},{id:"refBalance",label:"Saldo inicial",type:"number"}],async()=>api("/cash/accounts",{method:"POST",body:JSON.stringify({name:editor.querySelector("#refName").value,institution:editor.querySelector("#refInstitution").value,openingBalance:editor.querySelector("#refBalance").value})}));
      root.querySelector("#cashCategoryNew").onclick = () => quickForm(editor,"Nova categoria",[{id:"refName",label:"Nome"},{id:"refDre",label:"Grupo DRE"}],async()=>api("/cash/categories",{method:"POST",body:JSON.stringify({name:editor.querySelector("#refName").value,direction:"both",dreGroup:editor.querySelector("#refDre").value})}));
      root.querySelector("#cashCenterNew").onclick = () => quickForm(editor,"Novo centro de custo",[{id:"refCode",label:"Código"},{id:"refName",label:"Nome"}],async()=>api("/cash/cost-centers",{method:"POST",body:JSON.stringify({code:editor.querySelector("#refCode").value,name:editor.querySelector("#refName").value})}));
      root.querySelector("#cashRecurrenceNew").onclick = () => quickForm(editor,"Nova recorrência",[{id:"refName",label:"Nome"},{id:"refAmount",label:"Valor",type:"number"},{id:"refDue",label:"Primeiro vencimento",type:"date"}],async()=>api("/cash/recurrences",{method:"POST",body:JSON.stringify({name:editor.querySelector("#refName").value,direction:"outflow",amount:editor.querySelector("#refAmount").value,frequency:"monthly",nextDueDate:editor.querySelector("#refDue").value})}));
      root.querySelector("#cashReceivableNew").onclick = () => quickForm(editor,"Recebível de marketplace",[{id:"refChannel",label:"Canal"},{id:"refOrder",label:"Pedido externo"},{id:"refAmount",label:"Valor líquido",type:"number"},{id:"refDue",label:"Previsão",type:"date"}],async()=>api("/cash/receivables",{method:"POST",body:JSON.stringify({channel:editor.querySelector("#refChannel").value,externalOrderId:editor.querySelector("#refOrder").value,netAmount:editor.querySelector("#refAmount").value,expectedDate:editor.querySelector("#refDue").value})}));

      root.querySelectorAll("[data-settle]").forEach((button) => button.onclick = async () => { const amountValue=prompt("Valor a liquidar",button.dataset.remaining); if(!amountValue)return; try{await api(`/cash/${button.dataset.settle}/settlements`,{method:"POST",body:JSON.stringify({amount:amountValue})});toast("Liquidação registrada.");renderCash(true);}catch(error){toast(error.message,true);} });
      root.querySelectorAll("[data-cancel]").forEach((button) => button.onclick = async () => { if(!confirm("Cancelar este lançamento?"))return; try{await api(`/cash/${button.dataset.cancel}`,{method:"DELETE",body:"{}"});toast("Lançamento cancelado.");renderCash(true);}catch(error){toast(error.message,true);} });
    } catch (error) {
      root.innerHTML = `<div id="cashWorkspace" class="notice danger-note">Cash indisponível: ${escapeHtml(error.message)}</div>`;
    } finally { loading = false; }
  }

  function quickForm(editor,title,fields,save) {
    editor.innerHTML=`<div class="card"><h3>${escapeHtml(title)}</h3><div class="form-grid">${fields.map((field)=>`<label>${escapeHtml(field.label)}<input id="${field.id}" type="${field.type||"text"}"></label>`).join("")}</div><button class="primary" id="refSave">Salvar</button></div>`;
    editor.querySelector("#refSave").onclick=async()=>{try{await save();toast("Cadastro salvo.");renderCash(true);}catch(error){toast(error.message,true);}};
  }

  function install() {
    if (document.querySelector("#pageTitle")?.textContent === "Cash" && document.querySelector("#cashNew")) renderCash();
  }
  new MutationObserver(install).observe(document.documentElement,{childList:true,subtree:true});
  install();
})();
