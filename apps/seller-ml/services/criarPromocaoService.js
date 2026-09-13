// services/criarPromocaoService.js
// Fluxo legado mantido apenas para compatibilidade de import.

class CriarPromocaoService {
  static async aplicarDescontoUnico(mlbId, percent) {
    return {
      success: false,
      ok: false,
      mlb_id: mlbId,
      error: 'legacy_promotion_flow_removed',
      message:
        'Fluxo legado de PRICE_DISCOUNT removido. Use a Central de Promocoes / Criar promocoes para aplicar campanhas com job e travas de percentual.',
      requested_percent: Number(percent),
      applied_percent: null,
    };
  }
}

module.exports = CriarPromocaoService;
