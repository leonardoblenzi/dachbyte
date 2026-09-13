"use strict";

const createApp = require("./src/app");
const {
  getCoreRuntimeStatus,
  startCoreRuntime,
  stopCoreRuntime,
} = require("./src/runtime/coreRuntimeLifecycle");

async function createVoltCoreApp() {
  // O Volt Core tambem pode ser montado dentro do servidor conjunto da Volt.
  // Nesse modo src/server.js nao e executado, portanto o lifecycle precisa
  // iniciar aqui para que worker, validacao RLS e bootstrap existam igualmente.
  await startCoreRuntime({ source: "embedded", registerProcessHooks: true });
  const app = createApp();
  app.locals.voltCoreRuntime = {
    status: getCoreRuntimeStatus,
    stop: stopCoreRuntime,
  };
  return app;
}

// O servidor hospedeiro pode encerrar explicitamente o runtime se possuir um
// ciclo de shutdown proprio. Os signal hooks continuam como segunda barreira.
createVoltCoreApp.startRuntime = startCoreRuntime;
createVoltCoreApp.stopRuntime = stopCoreRuntime;
createVoltCoreApp.runtimeStatus = getCoreRuntimeStatus;

module.exports = createVoltCoreApp;
