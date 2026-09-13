import { dbQuery } from '../lib/db';

const REVISIT_PENDING_ONE_MORE = 'PENDING_ONE_MORE';
const REVISIT_DONE_NO_XML = 'DONE_NO_XML';

const normalizeText = (value: unknown) => String(value || '').trim();
const normalizeState = (value: unknown) => normalizeText(value).toUpperCase();

export const isBlankIdentifier = (value: unknown) => normalizeText(value).length === 0;

const shouldRevisitInvoiceXml = (input: {
  invoiceNumber: unknown;
  invoiceAccessKey: unknown;
  invoiceXmlRevisitState: unknown;
}) => {
  const hasInvoice = !isBlankIdentifier(input.invoiceNumber);
  const hasAccessKey = !isBlankIdentifier(input.invoiceAccessKey);
  const state = normalizeState(input.invoiceXmlRevisitState);

  if (!hasInvoice && !hasAccessKey) {
    return true;
  }

  return hasInvoice && !hasAccessKey && state === REVISIT_PENDING_ONE_MORE;
};

const resolveNextState = (input: {
  invoiceNumber: unknown;
  invoiceAccessKey: unknown;
  invoiceXmlRevisitState: unknown;
}) => {
  const hasInvoice = !isBlankIdentifier(input.invoiceNumber);
  const hasAccessKey = !isBlankIdentifier(input.invoiceAccessKey);
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

export const refreshInvoiceXmlRevisitState = async (
  companyId: string,
  orderNumbers: string[],
) => {
  if (!orderNumbers.length) {
    return {
      pendingOrderNumbers: new Set<string>(),
      pendingCount: 0,
      updatedStateCount: 0,
    };
  }

  const rowsResult = await dbQuery<{
    orderNumber: string;
    invoiceNumber: string | null;
    invoiceAccessKey: string | null;
    invoiceXmlRevisitState: string | null;
  }>(
    `
      SELECT
        o."orderNumber",
        o."invoiceNumber",
        o."invoiceAccessKey",
        o."invoiceXmlRevisitState"
      FROM "Order" o
      WHERE o."companyId" = $1
        AND o."orderNumber" = ANY($2::text[])
    `,
    [companyId, orderNumbers],
  );

  const pendingOrderNumbers = new Set<string>();
  let updatedStateCount = 0;

  for (const row of rowsResult.rows) {
    const previousState = normalizeState(row.invoiceXmlRevisitState) || null;
    const nextState = resolveNextState(row);

    if ((nextState || null) !== (previousState || null)) {
      await dbQuery(
        `
          UPDATE "Order"
          SET
            "invoiceXmlRevisitState" = $3,
            "lastUpdate" = NOW()
          WHERE "companyId" = $1
            AND "orderNumber" = $2
        `,
        [companyId, row.orderNumber, nextState],
      );
      updatedStateCount += 1;
    }

    if (
      shouldRevisitInvoiceXml({
        ...row,
        invoiceXmlRevisitState: nextState,
      })
    ) {
      pendingOrderNumbers.add(String(row.orderNumber));
    }
  }

  return {
    pendingOrderNumbers,
    pendingCount: pendingOrderNumbers.size,
    updatedStateCount,
  };
};

