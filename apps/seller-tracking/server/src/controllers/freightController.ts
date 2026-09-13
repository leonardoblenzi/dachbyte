import { Request, Response } from 'express';
import crypto from 'crypto';
import {
  buildProductsHash,
  needsFreightRecalculation,
  normalizeZipCode,
  recalculateStoredOrderFreight,
  safeInteger,
  safeNumber,
  safeString,
} from '../services/freightRecalculationService';
import { dbQuery } from '../lib/db';

const normalizeBoolean = (value: unknown): boolean | null => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'sim'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'nao', 'não'].includes(normalized)) return false;
  return null;
};

/**
 * POST /api/freight/quote/:orderId
 * Cotar frete de um pedido especifico
 */
export const quoteOrderFreight = async (req: Request, res: Response) => {
  try {
    const orderId = String(req.params.orderId);

    if (!req.user?.companyId) {
      return res.status(403).json({ error: 'Usuario sem empresa vinculada' });
    }

    console.log(`Cotando frete para pedido ${orderId}...`);

    const orderResult = await dbQuery<any>(
      `
        SELECT *
        FROM "Order"
        WHERE "id" = $1
        LIMIT 1
      `,
      [orderId],
    );
    const order = orderResult.rows[0] || null;

    if (!order) {
      return res.status(404).json({ error: 'Pedido nao encontrado' });
    }

    const result = await recalculateStoredOrderFreight({
      order,
      companyId: req.user.companyId,
      force: true,
    });

    console.log(
      result.selectedOption
        ? `Frete recalculado: R$ ${result.quotedValue?.toFixed(2)}`
        : 'Nenhuma opcao valida de frete foi retornada pela integradora.',
    );

    return res.json({
      success: true,
      orderId: order.id,
      orderNumber: order.orderNumber,
      freight: {
        paid: order.freightValue || 0,
        original: order.originalQuotedFreightValue ?? order.quotedFreightValue ?? null,
        recalculated: result.quotedValue,
        difference:
          result.quotedValue !== null
            ? (order.freightValue || 0) - result.quotedValue
            : null,
        percentDifference: order.freightValue
          ? result.quotedValue !== null
            ? (((order.freightValue - result.quotedValue) / order.freightValue) * 100).toFixed(2)
            : null
          : 0,
      },
      options: {
        selected: result.selectedOption,
        matched: result.matchedOption,
        cheapest: result.cheapestOption,
        fastest: result.fastestOption,
        all: result.cotationOptions,
      },
      destination:
        (result as any).destination ||
        (result as any).cotationResult?.Shipping?.destination ||
        null,
      products: result.extractedProducts.auditProducts,
    });
  } catch (error) {
    console.error('Erro ao cotar frete:', error);
    return res.status(500).json({
      error: 'Erro ao cotar frete',
      details: error instanceof Error ? error.message : 'Erro desconhecido',
    });
  }
};

/**
 * POST /api/freight/quote-batch
 * Cotar frete de varios pedidos em lote
 */
export const quoteBatchFreight = async (req: Request, res: Response) => {
  try {
    const { orderIds } = req.body;

    if (!req.user?.companyId) {
      return res.status(403).json({ error: 'Usuario sem empresa vinculada' });
    }

    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ error: 'orderIds deve ser um array nao vazio' });
    }

    console.log(`Cotando frete para ${orderIds.length} pedidos...`);

    const results: any[] = [];

    for (const orderId of orderIds) {
      try {
        const orderIdStr = String(orderId);

        const orderResult = await dbQuery<any>(
          `
            SELECT *
            FROM "Order"
            WHERE "id" = $1
            LIMIT 1
          `,
          [orderIdStr],
        );
        const order = orderResult.rows[0] || null;

        const zipcode = normalizeZipCode(order?.zipCode);

        if (!order || !zipcode) {
          results.push({
            orderId: orderIdStr,
            success: false,
            error: 'Pedido nao encontrado ou sem CEP valido',
          });
          continue;
        }

        const result = await recalculateStoredOrderFreight({
          order,
          companyId: req.user.companyId,
          force: true,
        });

        results.push({
          orderId: orderIdStr,
          orderNumber: order.orderNumber,
          success: true,
          paid: order.freightValue || 0,
          original: order.originalQuotedFreightValue ?? order.quotedFreightValue ?? null,
          recalculated: result.quotedValue,
          matchedCarrier: safeString(order.freightType),
          difference:
            result.quotedValue !== null
              ? (order.freightValue || 0) - result.quotedValue
              : null,
        });
      } catch (error) {
        results.push({
          orderId: String(orderId),
          success: false,
          error: error instanceof Error ? error.message : 'Erro desconhecido',
        });
      }
    }

    const successful = results.filter((result) => result.success).length;

    return res.json({
      success: true,
      total: orderIds.length,
      successful,
      failed: orderIds.length - successful,
      results,
    });
  } catch (error) {
    console.error('Erro ao cotar frete em lote:', error);
    return res.status(500).json({
      error: 'Erro ao cotar frete em lote',
      details: error instanceof Error ? error.message : 'Erro desconhecido',
    });
  }
};

/**
 * POST /api/freight/backfill-missing
 * Recalcula fretes pendentes da empresa autenticada.
 */
export const backfillMissingFreightQuotes = async (req: Request, res: Response) => {
  try {
    if (!req.user?.companyId) {
      return res.status(403).json({ error: 'Usuario sem empresa vinculada' });
    }

    const requestedLimit = Number.parseInt(String(req.body?.limit ?? '200'), 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 1000)
      : 200;

    const batchSize = Math.min(Math.max(limit * 3, 100), 3000);
    let cursor: string | null = null;
    const orders: any[] = [];
    const pendingOrders: any[] = [];

    while (pendingOrders.length < limit) {
      const batchResult = await dbQuery<any>(
        `
          SELECT *
          FROM "Order"
          WHERE "companyId" = $1
            AND ($2::text = '' OR "id" > $2)
          ORDER BY "id" ASC
          LIMIT $3
        `,
        [req.user.companyId, cursor || '', batchSize],
      );
      const batch = batchResult.rows;

      if (batch.length === 0) {
        break;
      }

      cursor = batch[batch.length - 1].id;
      orders.push(...batch);

      for (const order of batch) {
        if (!needsFreightRecalculation(order)) {
          continue;
        }

        pendingOrders.push(order);
        if (pendingOrders.length >= limit) {
          break;
        }
      }
    }
    const failures: Array<{ orderId: string; orderNumber: string; error: string }> = [];
    let updated = 0;

    for (const order of pendingOrders) {
      try {
        const result = await recalculateStoredOrderFreight({
          order,
          companyId: req.user.companyId,
        });

        if (!result.skipped) {
          updated += 1;
        }
      } catch (error) {
        failures.push({
          orderId: order.id,
          orderNumber: String(order.orderNumber),
          error: error instanceof Error ? error.message : 'Erro desconhecido',
        });
      }
    }

    return res.json({
      success: true,
      companyId: req.user.companyId,
      scanned: orders.length,
      queued: pendingOrders.length,
      updated,
      failed: failures.length,
      failures: failures.slice(0, 50),
    });
  } catch (error) {
    console.error('Erro ao executar backfill de frete recalculado:', error);
    return res.status(500).json({
      error: 'Erro ao executar backfill de frete recalculado',
      details: error instanceof Error ? error.message : 'Erro desconhecido',
    });
  }
};

/**
 * POST /api/tray/checkout-quotes
 * Salva snapshot da cotacao original do checkout da Tray.
 */
export const saveTrayCheckoutQuoteSnapshot = async (req: Request, res: Response) => {
  try {
    if (!req.user?.companyId) {
      return res.status(403).json({ error: 'Usuario sem empresa vinculada' });
    }

    const quotationId = safeString(req.body?.quotationId);
    if (!quotationId) {
      return res.status(400).json({ error: 'quotationId e obrigatorio' });
    }

    const productsRaw = req.body?.productsRaw ?? req.body?.products ?? null;
    const snapshotData = req.body?.snapshotData ?? req.body ?? null;

    const data = {
      companyIdValue: req.user.companyId,
      trayStoreId: safeString(req.body?.trayStoreId),
      token: safeString(req.body?.token),
      sessionId: safeString(req.body?.sessionId),
      originZipCode: normalizeZipCode(req.body?.originZipCode),
      destinationZipCode: normalizeZipCode(req.body?.destinationZipCode),
      productsRaw,
      productsHash: safeString(req.body?.productsHash) || buildProductsHash(productsRaw),
      quotationId,
      shippingId: safeString(req.body?.shippingId),
      shipmentType: safeString(req.body?.shipmentType),
      serviceCode: safeString(req.body?.serviceCode),
      serviceName: safeString(req.body?.serviceName),
      integrator: safeString(req.body?.integrator),
      quotedValue: safeNumber(req.body?.quotedValue),
      minPeriod: safeInteger(req.body?.minPeriod),
      maxPeriod: safeInteger(req.body?.maxPeriod),
      selectedPossible: normalizeBoolean(req.body?.selectedPossible),
      snapshotData,
    };

    const savedQuoteResult = await dbQuery<any>(
      `
        INSERT INTO "TrayCheckoutQuote" (
          "id",
          "companyIdValue",
          "trayStoreId",
          "token",
          "sessionId",
          "originZipCode",
          "destinationZipCode",
          "productsRaw",
          "productsHash",
          "quotationId",
          "shippingId",
          "shipmentType",
          "serviceCode",
          "serviceName",
          "integrator",
          "quotedValue",
          "minPeriod",
          "maxPeriod",
          "selectedPossible",
          "snapshotData",
          "createdAt",
          "updatedAt"
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb,
          NOW(), NOW()
        )
        ON CONFLICT ("quotationId")
        DO UPDATE SET
          "companyIdValue" = EXCLUDED."companyIdValue",
          "trayStoreId" = EXCLUDED."trayStoreId",
          "token" = EXCLUDED."token",
          "sessionId" = EXCLUDED."sessionId",
          "originZipCode" = EXCLUDED."originZipCode",
          "destinationZipCode" = EXCLUDED."destinationZipCode",
          "productsRaw" = EXCLUDED."productsRaw",
          "productsHash" = EXCLUDED."productsHash",
          "shippingId" = EXCLUDED."shippingId",
          "shipmentType" = EXCLUDED."shipmentType",
          "serviceCode" = EXCLUDED."serviceCode",
          "serviceName" = EXCLUDED."serviceName",
          "integrator" = EXCLUDED."integrator",
          "quotedValue" = EXCLUDED."quotedValue",
          "minPeriod" = EXCLUDED."minPeriod",
          "maxPeriod" = EXCLUDED."maxPeriod",
          "selectedPossible" = EXCLUDED."selectedPossible",
          "snapshotData" = EXCLUDED."snapshotData",
          "updatedAt" = NOW()
        RETURNING *
      `,
      [
        crypto.randomUUID(),
        data.companyIdValue,
        data.trayStoreId,
        data.token,
        data.sessionId,
        data.originZipCode,
        data.destinationZipCode,
        data.productsRaw === undefined ? null : JSON.stringify(data.productsRaw),
        data.productsHash,
        data.quotationId,
        data.shippingId,
        data.shipmentType,
        data.serviceCode,
        data.serviceName,
        data.integrator,
        data.quotedValue,
        data.minPeriod,
        data.maxPeriod,
        data.selectedPossible,
        data.snapshotData === undefined ? null : JSON.stringify(data.snapshotData),
      ],
    );

    const savedQuote = savedQuoteResult.rows[0] || null;

    return res.json({
      success: true,
      message: 'Snapshot da cotacao original salvo com sucesso.',
      quote: savedQuote,
    });
  } catch (error) {
    console.error('Erro ao salvar snapshot da cotacao original da Tray:', error);
    return res.status(500).json({
      error: 'Erro ao salvar snapshot da cotacao original da Tray',
      details: error instanceof Error ? error.message : 'Erro desconhecido',
    });
  }
};
