"use strict";

function normalizeKey(value) {
  return String(value || "").trim();
}

function normalizeCapabilitySet(configuration = {}) {
  return new Set(
    (Array.isArray(configuration?.capabilities) ? configuration.capabilities : [])
      .map((capability) => normalizeKey(capability))
      .filter(Boolean),
  );
}

function hasMeaningfulValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return Boolean(value.trim());
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(hasMeaningfulValue);
  if (typeof value === "object") return Object.values(value).some(hasMeaningfulValue);
  return false;
}

function freezeDefinition(definition) {
  return Object.freeze({
    ...definition,
    capabilities: Object.freeze([...(definition.capabilities || [])]),
    contributions: Object.freeze({ ...(definition.contributions || {}) }),
    input: Object.freeze({ ...(definition.input || {}) }),
    access: definition.access ? Object.freeze({ ...definition.access }) : null,
    backend: definition.backend ? Object.freeze({ ...definition.backend }) : null,
  });
}

function capabilityDisabledError(capability, extensionKey) {
  return Object.assign(new Error("Recurso nao habilitado para esta empresa"), {
    statusCode: 403,
    code: "CAPABILITY_DISABLED",
    capability,
    extensionKey,
  });
}

class ExtensionRegistry {
  constructor() {
    this._extensions = new Map();
    this._stats = new Map();
  }

  register(definition = {}) {
    const key = normalizeKey(definition.key);
    if (!key) throw new TypeError("Extension key is required");
    if (this._extensions.has(key)) return this._extensions.get(key);

    const normalized = freezeDefinition({
      ...definition,
      key,
      kind: normalizeKey(definition.kind) || "extension",
      activationCapability: normalizeKey(definition.activationCapability) || null,
    });
    this._extensions.set(key, normalized);
    if (!this._stats.has(key)) this._stats.set(key, { hookCalls: 0, hookErrors: 0, totalDurationMs: 0, lastRunAt: null, lastError: null, lastHook: null });
    return normalized;
  }

  get(key) {
    return this._extensions.get(normalizeKey(key)) || null;
  }

  list() {
    return [...this._extensions.values()];
  }

  isEnabled(definitionOrKey, configuration = {}) {
    const definition = typeof definitionOrKey === "string"
      ? this.get(definitionOrKey)
      : definitionOrKey;
    if (!definition) return false;
    if (!definition.activationCapability) return true;
    return normalizeCapabilitySet(configuration).has(definition.activationCapability);
  }

  enabled(configuration = {}) {
    return this.list().filter((definition) => this.isEnabled(definition, configuration));
  }

  contributions(type, configuration = {}) {
    const key = normalizeKey(type);
    if (!key) return [];
    return this.enabled(configuration).flatMap((definition) => {
      const value = definition.contributions?.[key];
      if (value === undefined || value === null) return [];
      return (Array.isArray(value) ? value : [value]).map((entry) => ({
        extensionKey: definition.key,
        kind: definition.kind,
        value: entry,
      }));
    });
  }

  permissionDefinitions() {
    return this.list().flatMap((definition) =>
      (definition.access?.permissions || []).map((permission) => ({ ...permission, extensionKey: definition.key })),
    );
  }

  permissionDefinition(permissionKey) {
    const key = normalizeKey(permissionKey);
    if (!key) return null;
    return this.permissionDefinitions().find((permission) => normalizeKey(permission.key) === key) || null;
  }

  roleAccess(role) {
    const key = normalizeKey(role).toLowerCase();
    const permissions = [];
    const screens = [];
    for (const definition of this.list()) {
      const preset = definition.access?.rolePresets?.[key];
      if (!preset) continue;
      permissions.push(...(preset.permissions || []));
      screens.push(...(preset.screens || []));
    }
    return { permissions: [...new Set(permissions)], screens: [...new Set(screens)] };
  }

  runtimeResource(resource, configuration = {}) {
    const key = normalizeKey(resource);
    if (!key) return null;
    for (const definition of this.enabled(configuration)) {
      const resourceDefinition = definition.backend?.runtimeResources?.[key];
      if (!resourceDefinition) continue;
      const capability = normalizeKey(resourceDefinition.capability);
      if (capability && !normalizeCapabilitySet(configuration).has(capability)) return null;
      return { ...resourceDefinition, extensionKey: definition.key, kind: definition.kind };
    }
    return null;
  }

  inputPayloads(scope, input = {}, configuration = {}) {
    const result = {};
    const capabilities = normalizeCapabilitySet(configuration);
    const namespace = input?.extensions && typeof input.extensions === "object" && !Array.isArray(input.extensions)
      ? input.extensions
      : {};

    for (const definition of this.list()) {
      const inputDefinition = definition.input?.[scope];
      if (!inputDefinition) continue;
      let payload = null;
      if (Object.prototype.hasOwnProperty.call(namespace, definition.key)) {
        payload = namespace[definition.key];
      } else if (typeof inputDefinition.extract === "function") {
        payload = inputDefinition.extract(input || {});
      } else {
        const candidates = [];
        for (const legacyKey of inputDefinition.legacyKeys || []) {
          if (Object.prototype.hasOwnProperty.call(input || {}, legacyKey)) candidates.push(input[legacyKey]);
        }
        payload = candidates.find(hasMeaningfulValue);
      }
      if (!hasMeaningfulValue(payload)) continue;

      const requiredCapability = normalizeKey(inputDefinition.capability || definition.activationCapability);
      if (!this.isEnabled(definition, configuration) || (requiredCapability && !capabilities.has(requiredCapability))) {
        throw capabilityDisabledError(requiredCapability || definition.activationCapability, definition.key);
      }
      result[definition.key] = payload;
    }

    return result;
  }

  runtimeStatus() {
    return this.list().map((definition) => {
      const stats = this._stats.get(definition.key) || {};
      const hookCalls = Number(stats.hookCalls || 0);
      return {
        key: definition.key,
        kind: definition.kind,
        version: definition.version || null,
        activationCapability: definition.activationCapability || null,
        hooks: Object.keys(definition.backend?.hooks || {}),
        runtimeResources: Object.keys(definition.backend?.runtimeResources || {}),
        hookCalls,
        hookErrors: Number(stats.hookErrors || 0),
        averageHookDurationMs: hookCalls ? Number((Number(stats.totalDurationMs || 0) / hookCalls).toFixed(2)) : 0,
        lastRunAt: stats.lastRunAt || null,
        lastHook: stats.lastHook || null,
        lastError: stats.lastError || null,
      };
    });
  }

  async runHook(hookName, context = {}, configuration = {}) {
    const results = [];
    for (const definition of this.list()) {
      const hookDefinition = definition.backend?.hooks?.[hookName];
      const handler = typeof hookDefinition === "function" ? hookDefinition : hookDefinition?.handler;
      if (typeof handler !== "function") continue;
      const runWhenDisabled = Boolean(hookDefinition?.runWhenDisabled);
      if (!runWhenDisabled && !this.isEnabled(definition, configuration)) continue;
      const startedAt = Date.now();
      const stats = this._stats.get(definition.key) || { hookCalls: 0, hookErrors: 0, totalDurationMs: 0 };
      try {
        const value = await handler({ ...context, extension: definition });
        const durationMs = Date.now() - startedAt;
        stats.hookCalls = Number(stats.hookCalls || 0) + 1;
        stats.totalDurationMs = Number(stats.totalDurationMs || 0) + durationMs;
        stats.lastRunAt = new Date().toISOString();
        stats.lastHook = hookName;
        stats.lastError = null;
        this._stats.set(definition.key, stats);
        if (value !== undefined && value !== null) {
          results.push({ extensionKey: definition.key, value, durationMs });
        }
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        stats.hookCalls = Number(stats.hookCalls || 0) + 1;
        stats.hookErrors = Number(stats.hookErrors || 0) + 1;
        stats.totalDurationMs = Number(stats.totalDurationMs || 0) + durationMs;
        stats.lastRunAt = new Date().toISOString();
        stats.lastHook = hookName;
        stats.lastError = { code: error?.code || null, message: error?.message || "Extension hook failed" };
        this._stats.set(definition.key, stats);
        error.extensionKey = error.extensionKey || definition.key;
        error.extensionHook = error.extensionHook || hookName;
        throw error;
      }
    }
    return results;
  }

  routeRegistrars() {
    return this.list()
      .map((definition) => ({ extensionKey: definition.key, register: definition.backend?.registerRoutes }))
      .filter((entry) => typeof entry.register === "function");
  }

  clear() {
    this._extensions.clear();
    this._stats.clear();
  }
}

const extensionRegistry = new ExtensionRegistry();

module.exports = {
  ExtensionRegistry,
  capabilityDisabledError,
  extensionRegistry,
  hasMeaningfulValue,
};
