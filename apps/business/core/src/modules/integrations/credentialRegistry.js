"use strict";

const resolvers = new Map();

function registerCredentialResolver(scheme, resolver) {
  const key = String(scheme || "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9+.-]{1,31}$/.test(key) || typeof resolver !== "function") throw new Error("Credential resolver invalido.");
  resolvers.set(key, resolver);
  return () => resolvers.delete(key);
}

async function resolveCredentialRef(reference, context = {}) {
  const value = String(reference || "").trim();
  const separator = value.indexOf(":");
  if (separator <= 0) {
    const error = new Error("credentialRef invalido.");
    error.code = "INTEGRATION_CREDENTIAL_REF_INVALID";
    throw error;
  }
  const scheme = value.slice(0, separator).toLowerCase();
  const locator = value.slice(separator + 1);
  const resolver = resolvers.get(scheme);
  if (!resolver) {
    const error = new Error(`Resolver de credencial nao registrado: ${scheme}.`);
    error.code = "INTEGRATION_CREDENTIAL_RESOLVER_NOT_FOUND";
    throw error;
  }
  return resolver(locator, context);
}

registerCredentialResolver("env", async (locator) => {
  const key = String(locator || "").trim();
  if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(key)) {
    const error = new Error("Nome de variavel de ambiente invalido em credentialRef.");
    error.code = "INTEGRATION_CREDENTIAL_ENV_INVALID";
    throw error;
  }
  const secret = process.env[key];
  if (!secret) {
    const error = new Error(`Credencial ${key} nao configurada no ambiente.`);
    error.code = "INTEGRATION_CREDENTIAL_MISSING";
    throw error;
  }
  return secret;
});

module.exports = { registerCredentialResolver, resolveCredentialRef };
