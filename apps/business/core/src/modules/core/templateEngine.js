"use strict";

const { withEffectiveConfiguration } = require("./capabilities/capabilityResolver");
const { buildDefaultCommercialSnapshot } = require("./commercial/commercialResolver");

function buildConfiguration({ companyId, planKey, requestedBy, template }) {
  const configuration = {
    companyId,
    segmentKey: template.segmentKey,
    planKey,
    modules: [...template.defaultModules],
    screens: [...template.defaultScreens],
    roles: template.defaultRoles.map((role) => ({
      ...role,
      permissions: [...role.permissions],
    })),
    settings: {
      categories: [...template.defaultCategories],
      statuses: [...template.defaultStatuses],
      fields: template.defaultFields.map((field) => ({ ...field })),
      customFields: Array.isArray(template.defaultCustomFields) ? template.defaultCustomFields.map((field) => ({ ...field })) : [],
      workflows: Array.isArray(template.defaultWorkflows) ? template.defaultWorkflows.map((workflow) => ({ ...workflow, states: [...(workflow.states || [])], transitions: Object.fromEntries(Object.entries(workflow.transitions || {}).map(([key, value]) => [key, [...value]])) })) : [],
    },
    commercial: buildDefaultCommercialSnapshot({ segmentKey: template.segmentKey, corePlanKey: planKey }),
    overrides: {
      enabledModules: [],
      disabledModules: [],
      enabledScreens: [],
      disabledScreens: [],
      customFields: [],
      customStatuses: [],
    },
    createdBy: requestedBy,
    updatedBy: requestedBy,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  return withEffectiveConfiguration(configuration);
}

module.exports = { buildConfiguration };
