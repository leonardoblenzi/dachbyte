const router = require("express").Router();
const SeoController = require("../controllers/seoController");

// MVP sem auth (se quiser travar por sessão, me diga onde está seu middleware)
router.get("/seo/suggest", SeoController.suggest);
router.get("/seo/keywords", SeoController.keywords);
router.get("/seo/compare", SeoController.compare);

module.exports = router;
