"use strict";

const integrations = require("../modules/integrations/integrationService");
const { getGlobalObservability } = require("../modules/integrations/observabilityService");

function actor(req) { return req.user?.uid || req.user?.id || null; }

async function globalObservability(_req, res) { return res.json({ observability: await getGlobalObservability() }); }
async function summary(req, res) { return res.json({ summary: await integrations.getIntegrationSummary(req.params.companyId) }); }
async function accounts(req, res) { return res.json({ accounts: await integrations.listIntegrationAccounts(req.params.companyId) }); }
async function saveAccount(req, res) {
  return res.status(201).json({ account: await integrations.saveIntegrationAccount(req.params.companyId, { ...(req.body || {}), actorUserId: actor(req) }) });
}
async function setAccountStatus(req, res) {
  return res.json({ account: await integrations.setIntegrationAccountStatus(req.params.companyId, req.params.accountId, req.body?.status, actor(req)) });
}
async function mappings(req, res) { return res.json(await integrations.listMappings(req.params.companyId, req.query || {})); }
async function saveMapping(req, res) { return res.json({ mapping: await integrations.upsertMapping(req.params.companyId, { ...(req.body || {}), actorUserId: actor(req) }) }); }
async function jobs(req, res) { return res.json(await integrations.listJobs(req.params.companyId, req.query || {})); }
async function retryJob(req, res) { return res.json({ job: await integrations.retryJob(req.params.companyId, req.params.jobId, actor(req)) }); }
async function outbox(req, res) { return res.json(await integrations.listOutbox(req.params.companyId, req.query || {})); }
async function retryOutbox(req, res) { return res.json({ event: await integrations.retryOutbox(req.params.companyId, req.params.eventId, actor(req)) }); }
async function webhooks(req, res) { return res.json(await integrations.listWebhooks(req.params.companyId, req.query || {})); }

module.exports = { accounts, globalObservability, jobs, mappings, outbox, retryJob, retryOutbox, saveAccount, saveMapping, setAccountStatus, summary, webhooks };
