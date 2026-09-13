import { apiFetch } from "../core/api";
import { resolveRuntimeResource } from "../extensions/registry";

function buildQueryString(query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

async function fetchRuntimeCollection(companyId, resource, query = {}, configuration = null) {
  const definition = resolveRuntimeResource(resource, configuration);
  if (!definition) {
    const error = new Error(`Recurso indisponivel para esta empresa: ${resource}`);
    error.code = "RUNTIME_RESOURCE_CAPABILITY_DISABLED";
    throw error;
  }
  return apiFetch(`/core/runtime/companies/${companyId}/data/${definition.path}${buildQueryString(query)}`);
}

async function fetchRuntimeReports(companyId, filters = {}) {
  const payload = await apiFetch(`/core/runtime/companies/${companyId}/reports/summary${buildQueryString(filters)}`);
  return payload.report;
}

export {
  fetchRuntimeCollection,
  fetchRuntimeReports,
};
