// @ts-check
"use strict";

const { CHANNEL_DEFINITIONS, validateDefinition } = require("./channels");

/**
 * Cria os conectores a partir do catálogo de canais (./channels.js) e da configuração.
 * @param {Record<string, Record<string, any>>} settings configuração por canal (config.channels)
 * @param {typeof fetch} [fetchImpl]
 * @param {readonly import("./channels").ChannelDefinition[]} [definitions]
 */
function createConnectors(settings, fetchImpl = fetch, definitions = CHANNEL_DEFINITIONS) {
  /** @type {Map<string, { def: import("./channels").ChannelDefinition, connector: import("./contract").ChannelConnector }>} */
  const entries = new Map();
  for (const def of definitions) {
    const problems = validateDefinition(def);
    if (problems.length) throw new Error(`Canal ${def?.id || "?"} inválido: ${problems.join("; ")}`);
    if (entries.has(def.id)) throw new Error(`Canal ${def.id} duplicado.`);
    entries.set(def.id, { def, connector: def.create(settings?.[def.id] || {}, fetchImpl) });
  }
  /** @param {string} channel */
  const entry = (channel) => {
    const found = entries.get(channel);
    if (!found) throw Object.assign(new Error("Canal desconhecido."), { status: 404, code: "unknown_channel" });
    return found;
  };
  return {
    /** @param {string} channel */
    get: (channel) => entry(channel).connector,
    /** @param {string} channel */
    definition: (channel) => entry(channel).def,
    /** @param {string} channel */
    has: (channel) => entries.has(channel),
    /** Dados públicos dos canais para a tela (sem segredos). */
    list() {
      return [...entries.values()].map(({ def, connector }) => ({
        id: def.id,
        label: def.label,
        kind: def.kind,
        auth: def.auth,
        capabilities: { ...def.capabilities },
        credentialFields: def.auth === "credentials" ? (def.credentialFields || []).map((f) => ({ name: f.name, label: f.label, type: f.type || "text", placeholder: f.placeholder || "" })) : [],
        available: Boolean(connector.configured),
      }));
    },
  };
}

module.exports = { createConnectors };
