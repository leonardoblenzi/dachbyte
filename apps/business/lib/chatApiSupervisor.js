"use strict";

/**
 * Keeps the Node gateway and the internal VoltChat API as one availability
 * unit. Serving the gateway after the API has exited only produces 502s and
 * failed WebSocket upgrades, so the platform must restart the whole service.
 */
function createChatApiExitHandler({ isShuttingDown, onChatApiExit, terminateSuite, log = console.error }) {
  return (code, signal) => {
    const exit = { code, signal };
    onChatApiExit(exit);

    if (isShuttingDown()) return;

    log(`[volt-corp] API interna do VoltChat encerrou (code=${code}, signal=${signal}). Reiniciando o servico para restabelecer o chat.`);
    terminateSuite(exit);
  };
}

module.exports = { createChatApiExitHandler };
