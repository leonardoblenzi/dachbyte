const express = require("express");
const healthRoutes = require("./health.routes");
const coreRoutes = require("./core.routes");

const router = express.Router();

router.use(healthRoutes);
router.use("/api/core", coreRoutes);

module.exports = router;
