"use strict";

const { workflows: registry } = require("./workflowRegistry");
const { badRequest } = require("../errors");

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function normalizeWorkflow(definition = {}) {
  const states = [...new Set((definition.states || []).map(normalizeStatus).filter(Boolean))];
  const transitions = {};
  for (const state of states) {
    transitions[state] = [...new Set((definition.transitions?.[state] || []).map(normalizeStatus).filter((target) => states.includes(target)))];
  }
  return {
    key: normalizeStatus(definition.key),
    name: String(definition.name || definition.key || "Workflow").trim(),
    initial: states.includes(normalizeStatus(definition.initial)) ? normalizeStatus(definition.initial) : states[0],
    states,
    transitions,
  };
}

function customWorkflow(configuration, key) {
  const configured = Array.isArray(configuration?.settings?.workflows) ? configuration.settings.workflows : [];
  return configured.find((item) => normalizeStatus(item.key || item.entity) === normalizeStatus(key));
}

function resolveWorkflow(configuration, key) {
  const normalizedKey = normalizeStatus(key);
  const fallback = registry[normalizedKey];
  const custom = customWorkflow(configuration, normalizedKey);
  if (!custom) return fallback ? normalizeWorkflow(fallback) : null;
  const merged = fallback ? { ...fallback, ...custom, transitions: custom.transitions || fallback.transitions } : custom;
  return normalizeWorkflow({ ...merged, key: normalizedKey });
}

function validateWorkflowDefinition(input = {}) {
  const requestedInitial = normalizeStatus(input.initial);
  const workflow = normalizeWorkflow(input);
  if (!workflow.key) throw badRequest("Chave do workflow e obrigatoria", "WORKFLOW_KEY_REQUIRED");
  if (workflow.states.length < 2) throw badRequest("Workflow precisa ter ao menos dois estados", "WORKFLOW_STATES_REQUIRED");
  if (!requestedInitial) throw badRequest("Estado inicial do workflow e obrigatorio", "WORKFLOW_INITIAL_REQUIRED");
  if (!workflow.states.includes(requestedInitial)) throw badRequest("Estado inicial precisa existir na lista de estados", "WORKFLOW_INITIAL_INVALID");
  workflow.initial = requestedInitial;
  return workflow;
}

function assertTransition(configuration, key, fromStatus, toStatus, { allowSame = true, force = false } = {}) {
  const workflow = resolveWorkflow(configuration, key);
  const from = normalizeStatus(fromStatus);
  const to = normalizeStatus(toStatus);
  if (!workflow || force) return { allowed: true, from, to, workflow };
  if (!workflow.states.includes(to)) throw badRequest(`Status invalido para ${workflow.name}: ${toStatus}`, "WORKFLOW_STATUS_INVALID");
  if (!from || (allowSame && from === to)) return { allowed: true, from, to, workflow };
  if (!(workflow.transitions[from] || []).includes(to)) {
    const error = badRequest(`Transicao nao permitida: ${fromStatus} -> ${toStatus}`, "WORKFLOW_TRANSITION_INVALID");
    error.workflow = workflow.key;
    error.from = from;
    error.to = to;
    throw error;
  }
  return { allowed: true, from, to, workflow };
}

module.exports = {
  assertTransition,
  normalizeStatus,
  resolveWorkflow,
  validateWorkflowDefinition,
};
