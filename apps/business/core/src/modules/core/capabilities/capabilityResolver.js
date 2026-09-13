"use strict";

const { modules: moduleRegistry } = require("../registries/modules");
const { screens: screenRegistry } = require("../registries/screens");
const { getPlan } = require("../registries/plans");
const { getPermission } = require("../registries/permissions");
const { extensionRegistry } = require("../../../platform/extensions/extensionRegistry");
const {
  commercialCapabilities,
  commercialLimits,
  commercialModuleGrants,
  commercialScreenGrants,
  isCommerciallyAllowedModule,
  isCommerciallyAllowedScreen,
} = require("../commercial/commercialResolver");
const { products: commercialProductCatalog } = require("../commercial/productCatalog");

const moduleByKey = Object.freeze(Object.fromEntries(moduleRegistry.map((item) => [item.key, item])));
const screenByKey = Object.freeze(Object.fromEntries(screenRegistry.map((item) => [item.key, item])));
const moduleCommercialOwner = new Map();
for (const product of commercialProductCatalog) {
  for (const moduleKey of product.ownedModuleKeys || []) moduleCommercialOwner.set(moduleKey, product.key);
}

function unique(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function normalizeOverrides(overrides = {}) {
  return {
    enabledModules: unique(overrides.enabledModules),
    disabledModules: unique(overrides.disabledModules),
    enabledScreens: unique(overrides.enabledScreens),
    disabledScreens: unique(overrides.disabledScreens),
    customFields: Array.isArray(overrides.customFields) ? overrides.customFields : [],
    customStatuses: Array.isArray(overrides.customStatuses) ? overrides.customStatuses : [],
    enabledCapabilities: unique(overrides.enabledCapabilities),
    disabledCapabilities: unique(overrides.disabledCapabilities),
    limits: overrides.limits && typeof overrides.limits === "object" && !Array.isArray(overrides.limits) ? { ...overrides.limits } : {},
  };
}

function addModuleWithDependencies(target, moduleKey) {
  const definition = moduleByKey[moduleKey];
  if (!definition || target.has(moduleKey)) return;
  for (const dependency of definition.dependencies || []) addModuleWithDependencies(target, dependency);
  target.add(moduleKey);
}

function resolveModules(configuration = {}) {
  const overrides = normalizeOverrides(configuration.overrides);
  const plan = getPlan(configuration.planKey);
  const disabled = new Set([...overrides.disabledModules, ...(plan.disabledModules || [])]);
  const selected = new Set();

  for (const item of moduleRegistry.filter((module) => module.required)) addModuleWithDependencies(selected, item.key);
  for (const moduleKey of unique(configuration.modules)) addModuleWithDependencies(selected, moduleKey);
  for (const moduleKey of overrides.enabledModules) addModuleWithDependencies(selected, moduleKey);
  for (const moduleKey of disabled) selected.delete(moduleKey);

  // Commercial products are authoritative for the modules they own. Activating
  // a product installs its dependencies; without a subscription the owned
  // module cannot be enabled through a generic module override.
  for (const moduleKey of commercialModuleGrants(configuration)) addModuleWithDependencies(selected, moduleKey);
  for (const moduleKey of [...selected]) {
    if (!isCommerciallyAllowedModule(configuration, moduleKey)) selected.delete(moduleKey);
  }

  // A disabled/missing dependency invalidates modules that depend on it.
  let changed = true;
  while (changed) {
    changed = false;
    for (const moduleKey of [...selected]) {
      const definition = moduleByKey[moduleKey];
      if ((definition?.dependencies || []).some((dependency) => !selected.has(dependency))) {
        selected.delete(moduleKey);
        changed = true;
      }
    }
  }

  return [...selected];
}

function resolveScreens(configuration = {}, effectiveModules = resolveModules(configuration)) {
  const overrides = normalizeOverrides(configuration.overrides);
  const enabledModules = new Set(effectiveModules);
  const disabled = new Set(overrides.disabledScreens);
  const commercialGrants = new Set(commercialScreenGrants(configuration));
  const requested = unique([...(configuration.screens || []), ...overrides.enabledScreens, ...commercialGrants]);

  return requested.filter((screenKey) => {
    const definition = screenByKey[screenKey];
    if (!definition || !enabledModules.has(definition.moduleKey)) return false;
    if (!isCommerciallyAllowedScreen(configuration, screenKey)) return false;
    if (disabled.has(screenKey) && !commercialGrants.has(screenKey)) return false;
    return true;
  });
}

function resolveCapabilities(configuration = {}) {
  const effectiveModules = resolveModules(configuration);
  const effectiveScreens = resolveScreens(configuration, effectiveModules);
  const overrides = normalizeOverrides(configuration.overrides);
  const disabledCapabilities = new Set(overrides.disabledCapabilities);
  const capabilities = unique([
    ...effectiveModules.flatMap((moduleKey) => moduleByKey[moduleKey]?.capabilities || []),
    ...commercialCapabilities(configuration),
    ...overrides.enabledCapabilities,
  ]).filter((capability) => !disabledCapabilities.has(capability));
  return {
    modules: effectiveModules,
    screens: effectiveScreens,
    capabilities,
    plan: getPlan(configuration.planKey),
  };
}

function hasModule(configuration, moduleKey) {
  return resolveModules(configuration).includes(moduleKey);
}

function hasCapability(configuration, capabilityKey) {
  return resolveCapabilities(configuration).capabilities.includes(capabilityKey);
}

function permissionModule(permissionKey) {
  return (getPermission(permissionKey) || extensionRegistry.permissionDefinition(permissionKey))?.moduleKey || null;
}

function isPermissionEnabled(configuration, permissionKey) {
  const moduleKey = permissionModule(permissionKey);
  return !moduleKey || hasModule(configuration, moduleKey);
}

function withEffectiveConfiguration(configuration = {}) {
  const resolved = resolveCapabilities(configuration);
  const overrides = normalizeOverrides(configuration.overrides);
  const serviceLimits = commercialLimits(configuration);
  return {
    ...configuration,
    baseModules: unique(configuration.modules),
    baseScreens: unique(configuration.screens),
    modules: resolved.modules,
    screens: resolved.screens,
    capabilities: resolved.capabilities,
    availableModules: moduleRegistry.map(({ key, name, layer, required, dependencies }) => ({
      key,
      name,
      layer,
      required: Boolean(required),
      dependencies: [...(dependencies || [])],
      commercialProductKey: moduleCommercialOwner.get(key) || null,
      managedByProduct: moduleCommercialOwner.has(key),
    })),
    availableScreens: screenRegistry.filter((screen) => !screen.masterOnly).map(({ key, name, moduleKey }) => ({ key, name, moduleKey })),
    entitlements: {
      planKey: resolved.plan.key,
      limits: { ...(resolved.plan.limits || {}), ...serviceLimits, ...(overrides.limits || {}) },
    },
    overrides,
  };
}

module.exports = {
  hasCapability,
  hasModule,
  isPermissionEnabled,
  normalizeOverrides,
  permissionModule,
  resolveCapabilities,
  resolveModules,
  resolveScreens,
  withEffectiveConfiguration,
};
