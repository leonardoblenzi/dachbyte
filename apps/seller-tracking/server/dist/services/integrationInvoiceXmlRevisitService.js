"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.refreshInvoiceXmlRevisitState = exports.isBlankIdentifier = void 0;
const db_1 = require("../lib/db");
const REVISIT_PENDING_ONE_MORE = 'PENDING_ONE_MORE';
const REVISIT_DONE_NO_XML = 'DONE_NO_XML';
const normalizeText = (value) => String(value || '').trim();
const normalizeState = (value) => normalizeText(value).toUpperCase();
const isBlankIdentifier = (value) => normalizeText(value).length === 0;
exports.isBlankIdentifier = isBlankIdentifier;
const shouldRevisitInvoiceXml = (input) => {
    const hasInvoice = !(0, exports.isBlankIdentifier)(input.invoiceNumber);
    const hasAccessKey = !(0, exports.isBlankIdentifier)(input.invoiceAccessKey);
    const state = normalizeState(input.invoiceXmlRevisitState);
    if (!hasInvoice && !hasAccessKey) {
        return true;
    }
    return hasInvoice && !hasAccessKey && state === REVISIT_PENDING_ONE_MORE;
};
const resolveNextState = (input) => {
    const hasInvoice = !(0, exports.isBlankIdentifier)(input.invoiceNumber);
    const hasAccessKey = !(0, exports.isBlankIdentifier)(input.invoiceAccessKey);
    const state = normalizeState(input.invoiceXmlRevisitState);
    if (hasAccessKey) {
        return null;
    }
    if (!hasInvoice) {
        return null;
    }
    if (state === REVISIT_PENDING_ONE_MORE) {
        return REVISIT_DONE_NO_XML;
    }
    if (state === REVISIT_DONE_NO_XML) {
        return REVISIT_DONE_NO_XML;
    }
    return REVISIT_PENDING_ONE_MORE;
};
const refreshInvoiceXmlRevisitState = async (companyId, orderNumbers) => {
    if (!orderNumbers.length) {
        return {
            pendingOrderNumbers: new Set(),
            pendingCount: 0,
            updatedStateCount: 0,
        };
    }
    const rowsResult = await (0, db_1.dbQuery)(`
      SELECT
        o."orderNumber",
        o."invoiceNumber",
        o."invoiceAccessKey",
        o."invoiceXmlRevisitState"
      FROM "Order" o
      WHERE o."companyId" = $1
        AND o."orderNumber" = ANY($2::text[])
    `, [companyId, orderNumbers]);
    const pendingOrderNumbers = new Set();
    let updatedStateCount = 0;
    for (const row of rowsResult.rows) {
        const previousState = normalizeState(row.invoiceXmlRevisitState) || null;
        const nextState = resolveNextState(row);
        if ((nextState || null) !== (previousState || null)) {
            await (0, db_1.dbQuery)(`
          UPDATE "Order"
          SET
            "invoiceXmlRevisitState" = $3,
            "lastUpdate" = NOW()
          WHERE "companyId" = $1
            AND "orderNumber" = $2
        `, [companyId, row.orderNumber, nextState]);
            updatedStateCount += 1;
        }
        if (shouldRevisitInvoiceXml({
            ...row,
            invoiceXmlRevisitState: nextState,
        })) {
            pendingOrderNumbers.add(String(row.orderNumber));
        }
    }
    return {
        pendingOrderNumbers,
        pendingCount: pendingOrderNumbers.size,
        updatedStateCount,
    };
};
exports.refreshInvoiceXmlRevisitState = refreshInvoiceXmlRevisitState;
