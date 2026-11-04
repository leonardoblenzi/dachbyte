"use strict";
const accounts = require("../repositories/accountRepository");
const processes = require("../repositories/processPanelRepository");
const { checkAccountAccess } = require("../services/hubResourceAccessService");

async function accountFor(req) {
  const id = Number(req.query?.account_id);
  if (!Number.isSafeInteger(id) || id < 1) { const e = new Error("Selecione uma conta Magalu."); e.status = 400; throw e; }
  const account = await accounts.findAccountByIdForTenant(id, req.magaluIdentity.dachTenantId);
  if (!account) { const e = new Error("Conta não encontrada."); e.status = 404; throw e; }
  const access = await checkAccountAccess(req.magaluIdentity, account, { action: "READ magalu" });
  if (!access.allow) { const e = new Error("Acesso à conta não autorizado."); e.status = 403; throw e; }
  return account;
}
function fail(res,error) { return res.status(error.status || 500).json({ ok:false, message: error.status ? error.message : "Não foi possível consultar processos." }); }
async function list(req,res) { try { const account = await accountFor(req); return res.json({ ok:true, rows:await processes.list(account.id, req.magaluIdentity.dachTenantId) }); } catch(error) { return fail(res,error); } }
async function detail(req,res) { try { const account = await accountFor(req); const rows = await processes.detail(account.id, req.magaluIdentity.dachTenantId, req.params.kind, req.params.id); if (!rows) return res.status(404).json({ok:false,message:"Processo não encontrado nesta conta."}); return res.json({ok:true,rows}); } catch(error) { return fail(res,error); } }
module.exports = { list, detail };
