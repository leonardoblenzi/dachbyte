import { createAdminSubmitHandlers } from "./handlers/admin";
import { createCatalogSubmitHandlers } from "./handlers/catalog";
import { createFinanceSubmitHandlers } from "./handlers/finance";
import { createOperationsSubmitHandlers } from "./handlers/operations";
import { createSharedSubmitHandlers } from "./handlers/shared";
import { loadExtensionSubmitHandlers } from "../extensions/registry";

function createCoreSubmitActionHandlers(context) {
  return { ...createSharedSubmitHandlers(context), ...createCatalogSubmitHandlers(context), ...createFinanceSubmitHandlers(context), ...createOperationsSubmitHandlers(context), ...createAdminSubmitHandlers(context) };
}

async function createSubmitActionHandlers(context) {
  return { ...createCoreSubmitActionHandlers(context), ...(await loadExtensionSubmitHandlers(context)) };
}

async function submitAction(type, values, context) {
  const handlers = await createSubmitActionHandlers(context);
  const handler = handlers[type];
  if (!handler) return false;
  return await handler(values);
}

export { createCoreSubmitActionHandlers, createSubmitActionHandlers, submitAction };
