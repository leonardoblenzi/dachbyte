// controllers/ItemsController.js
const ItemsService = require('../services/itemsService');

class ItemsController {
  static async getOne(req, res) {
    try {
      const { id } = req.params;
      if (!id) return res.status(400).json({ success:false, error:'MLB ausente' });

      const data = await ItemsService.obterItemBasico(id, {
        mlCreds: res.locals?.mlCreds || {},
        accountKey: res.locals?.accountKey,
      });

      return res.json({ success:true, item: data });
    } catch (e) {
      return res.status(400).json({ success:false, error: e?.message || 'Erro' });
    }
  }
}

module.exports = ItemsController;
