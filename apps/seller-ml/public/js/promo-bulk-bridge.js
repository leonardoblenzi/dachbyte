// promo-bulk-bridge.js
// Ponte leve entre o state da tela e o modulo PromoBulk.
(function initPromoBulkBridge(global) {
  "use strict";

  if (!global || global.PromoBulkBridge) return;

  function sync(state) {
    if (!global.PromoBulk || !state?.selectedCard) return;
    const listMlbs =
      state.operationMode === "list" &&
      state.listMode?.selectedCampaignId &&
      Array.isArray(state.listMode?.mlbs)
        ? state.listMode.mlbs
        : null;

    global.PromoBulk.setContext({
      promotion_id: state.selectedCard.id,
      promotion_type: state.selectedCard.type,
      promotion_name: state.selectedCard.name || state.selectedCard.id,
      filtroParticipacao: state.filtroParticipacao,
      maxDesc: state.maxDesc,
      mlbFilter: state.mlbFilter,
      mlbsFilter: listMlbs,
    });
  }

  global.PromoBulkBridge = { sync };
})(window);
