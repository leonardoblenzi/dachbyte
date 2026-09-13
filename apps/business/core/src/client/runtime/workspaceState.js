import { apiFetch } from "../core/api";
import { mapWorkspaceToAppData } from "../workspace/mapWorkspaceToAppData";

async function fetchCompanyWorkspace(selectedCompanyId) {
  const payload = await apiFetch(`/core/runtime/companies/${selectedCompanyId}/workspace`);
  return payload.workspace;
}

function applyWorkspaceSnapshot(workspace, { setAppData, setRuntimeMode, setWorkspace }) {
  setWorkspace(workspace);
  setRuntimeMode("database");
  setAppData((current) => mapWorkspaceToAppData(workspace, current));
  return workspace;
}

export {
  applyWorkspaceSnapshot,
  fetchCompanyWorkspace,
};
