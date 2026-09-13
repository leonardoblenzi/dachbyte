"use strict";

const { modules } = require("../registries/modules");
const { screens } = require("../registries/screens");
const { normalizeOverrides, withEffectiveConfiguration } = require("../capabilities/capabilityResolver");
const { badRequest } = require("../errors");

const moduleKeys = new Set(modules.map((item) => item.key));
const screenKeys = new Set(screens.map((item) => item.key));

function normalizeCompanyOverrides(current = {}, input = {}) {
  const merged = normalizeOverrides({ ...current, ...input });
  const invalidModule = [...merged.enabledModules, ...merged.disabledModules].find((key) => !moduleKeys.has(key));
  const invalidScreen = [...merged.enabledScreens, ...merged.disabledScreens].find((key) => !screenKeys.has(key));
  if (invalidModule) throw badRequest(`Modulo desconhecido: ${invalidModule}`, "MODULE_OVERRIDE_INVALID");
  if (invalidScreen) throw badRequest(`Tela desconhecida: ${invalidScreen}`, "SCREEN_OVERRIDE_INVALID");
  const enabled = new Set(merged.enabledModules);
  merged.disabledModules = merged.disabledModules.filter((key) => !enabled.has(key));
  const enabledScreens = new Set(merged.enabledScreens);
  merged.disabledScreens = merged.disabledScreens.filter((key) => !enabledScreens.has(key));
  return merged;
}

function resolveConfiguration(configuration = {}) {
  return withEffectiveConfiguration(configuration);
}

function effectiveLimit(configuration, limitKey, fallback = null) {
  const resolved = resolveConfiguration(configuration);
  const override = resolved.overrides?.limits?.[limitKey];
  if (override !== undefined && override !== null) return override;
  return resolved.entitlements?.limits?.[limitKey] ?? fallback;
}

module.exports = {
  effectiveLimit,
  normalizeCompanyOverrides,
  resolveConfiguration,
};
