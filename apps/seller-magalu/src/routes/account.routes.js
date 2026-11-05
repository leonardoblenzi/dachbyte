"use strict";

const express = require("express");
const accountController = require("../controllers/accountController");
const userAccess = require("../services/userAccessService");

const router = express.Router();

router.get("/context", accountController.context);
router.post("/accounts/:accountId/unlink", userAccess.requireAdmin, accountController.unlink);
router.post("/help", accountController.help);

// Usuarios e permissoes por modulo: so administrador da empresa.
router.get("/users/metadata", userAccess.requireAdmin, accountController.usersMetadata);
router.get("/users", userAccess.requireAdmin, accountController.listUsers);
router.put("/users/:userId/access", userAccess.requireAdmin, accountController.updateUserAccess);

module.exports = router;
