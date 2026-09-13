// routes/itemsRoutes.js
const express = require("express");
const ItemsController = require("../controllers/ItemsController");
const router = express.Router();

// Pega dados de 1 item (para preview/enriquecimento)
router.get("/api/items/:id", ItemsController.getOne);

// ✅ Compat / aliases (alguns front-ends antigos chamam assim)
router.get("/api/ml/items/:id", ItemsController.getOne);
router.get("/api/mercadolivre/items/:id", ItemsController.getOne);

module.exports = router;
