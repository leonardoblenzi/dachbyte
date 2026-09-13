"use strict";

const express = require("express");
const FiscalController = require("../controllers/FiscalController");

const router = express.Router();

router.get("/dashboard", FiscalController.dashboard);
router.get("/reconciliation", FiscalController.reconcilePeriod);

router.get("/documents", FiscalController.listDocuments);
router.get("/documents/legal/:fileId", FiscalController.downloadLegalDocument);
router.get("/documents/order/:orderId/pdf", FiscalController.downloadOrderPdf);
router.get("/perceptions", FiscalController.perceptionsDetails);

router.get("/order/:orderId/billing-info", FiscalController.orderBillingInfo);

router.post("/invoices/orders", FiscalController.issueManualInvoice);
router.get("/invoices/:invoiceId", FiscalController.getInvoiceById);
router.get("/invoices/orders/:orderId", FiscalController.getInvoiceByOrder);
router.get("/invoices/shipments/:shipmentId", FiscalController.getInvoiceByShipment);

router.post("/reports", FiscalController.createReconciliationReport);
router.get("/reports/:fileId/status", FiscalController.reportStatus);
router.get("/reports/:fileId/download", FiscalController.downloadReport);

router.get("/monitor", FiscalController.monitor);
router.get("/sales", FiscalController.sales);

module.exports = router;
