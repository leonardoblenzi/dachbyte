"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const supportController_1 = require("../controllers/supportController");
const router = (0, express_1.Router)();
router.post('/contact', supportController_1.sendSupportRequest);
exports.default = router;
