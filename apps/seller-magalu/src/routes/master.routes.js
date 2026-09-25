"use strict";

const express = require("express");
const masterController = require("../controllers/masterController");
const { requireMagaluMasterDestructive } = require("../middlewares/masterAuth");

const router = express.Router();

router.get("/session", masterController.session);
router.get("/overview", masterController.overview);
router.get("/accounts", masterController.accounts);
router.get("/accounts/:accountId", masterController.account);
router.post("/accounts/:accountId/test", masterController.testConnection);
router.post("/accounts/:accountId/sync", masterController.forceSync);
router.post("/accounts/:accountId/reconcile", masterController.reconcile);
router.post("/accounts/:accountId/unlink", requireMagaluMasterDestructive, masterController.unlink);

router.get("/operations", masterController.operations);
router.get("/operations/export.csv", masterController.exportOperations);
router.get("/operations/:batchId", masterController.operation);
router.post("/operations/write/:operationId/reverify", masterController.reverify);
router.post("/operations/mass/:itemId/reverify", masterController.reverifyMass);

router.get("/audit/events", masterController.auditEvents);
router.get("/audit/events/export.csv", masterController.exportAuditCsv);
router.get("/audit/events/export.xlsx", masterController.exportAuditXlsx);
router.get("/audit/events/:eventId", masterController.auditEvent);
router.get("/retention", masterController.retention);
router.post("/retention/dry-run", masterController.retentionDryRun);
router.put("/retention/rules", requireMagaluMasterDestructive, masterController.retentionUpdate);
router.post("/retention/cleanup", requireMagaluMasterDestructive, masterController.retentionCleanup);

router.get("/workers", masterController.workers);
router.get("/integrations", masterController.integrations);
router.get("/readiness", masterController.readiness);

module.exports = router;
