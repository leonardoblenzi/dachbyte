"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.acknowledgeMonitoringFailureAlert = exports.listMonitoringFailureAcks = exports.receiveAnymarketWebhook = exports.reprocessWebhookFailureLogs = exports.clearWebhookFailureLogs = exports.listAnymarketWebhookLogs = exports.listIntelipostWebhookLogs = exports.receiveIntelipostWebhook = void 0;
const crypto_1 = __importDefault(require("crypto"));
const intelipostWebhookService_1 = require("../services/intelipostWebhookService");
const anymarketWebhookService_1 = require("../services/anymarketWebhookService");
const db_1 = require("../lib/db");
const readApiKeyFromRequest = (req) => {
    const directHeader = req.header('api-key');
    if (directHeader) {
        return String(directHeader).trim();
    }
    const altHeader = req.header('x-api-key');
    if (altHeader) {
        return String(altHeader).trim();
    }
    const authorization = String(req.header('authorization') || '').trim();
    if (/^basic\s+/i.test(authorization)) {
        const encoded = authorization.replace(/^basic\s+/i, '').trim();
        if (encoded) {
            try {
                const decoded = Buffer.from(encoded, 'base64').toString('utf8');
                const separatorIndex = decoded.indexOf(':');
                if (separatorIndex >= 0) {
                    const username = decoded.slice(0, separatorIndex).trim();
                    const password = decoded.slice(separatorIndex + 1).trim();
                    return password || username || '';
                }
                return decoded.trim();
            }
            catch {
                return '';
            }
        }
    }
    return '';
};
const receiveIntelipostWebhook = async (req, res) => {
    try {
        const apiKey = readApiKeyFromRequest(req);
        const payload = req.body || {};
        const requestIp = req.ip || null;
        const userAgent = String(req.header('user-agent') || '').trim() || null;
        res.status(200).json({
            success: true,
            message: 'Webhook Intelipost recebido para processamento assincrono.',
            queued: true,
        });
        setImmediate(() => {
            void intelipostWebhookService_1.intelipostWebhookService
                .processWebhook({
                apiKey,
                payload,
                requestIp,
                userAgent,
            })
                .catch((error) => {
                console.error('Erro ao processar webhook Intelipost em segundo plano:', error);
            });
        });
        return undefined;
    }
    catch (error) {
        console.error('Erro ao receber webhook Intelipost:', error);
        return res.status(200).json({
            success: true,
            message: 'Webhook Intelipost recebido.',
            queued: false,
        });
    }
};
exports.receiveIntelipostWebhook = receiveIntelipostWebhook;
const listIntelipostWebhookLogs = async (req, res) => {
    try {
        const companyId = req.user?.companyId;
        if (!companyId) {
            return res.status(403).json({ error: 'Acesso negado. Usuario sem empresa.' });
        }
        const limitRaw = Number(req.query?.limit || 100);
        const limit = Number.isFinite(limitRaw) ? limitRaw : 100;
        const logs = await intelipostWebhookService_1.intelipostWebhookService.listWebhookLogs(companyId, limit);
        return res.json({
            success: true,
            total: logs.length,
            logs,
        });
    }
    catch (error) {
        console.error('Erro ao listar logs de webhook Intelipost:', error);
        return res.status(500).json({
            success: false,
            error: 'Erro ao listar logs de webhook Intelipost',
        });
    }
};
exports.listIntelipostWebhookLogs = listIntelipostWebhookLogs;
const listAnymarketWebhookLogs = async (req, res) => {
    try {
        const companyId = req.user?.companyId;
        if (!companyId) {
            return res.status(403).json({ error: 'Acesso negado. Usuario sem empresa.' });
        }
        const limitRaw = Number(req.query?.limit || 100);
        const limit = Number.isFinite(limitRaw) ? limitRaw : 100;
        const logs = await anymarketWebhookService_1.anymarketWebhookService.listWebhookLogs(companyId, limit);
        return res.json({
            success: true,
            total: logs.length,
            logs,
        });
    }
    catch (error) {
        console.error('Erro ao listar logs de webhook ANYMARKET:', error);
        return res.status(500).json({
            success: false,
            error: 'Erro ao listar logs de webhook ANYMARKET',
        });
    }
};
exports.listAnymarketWebhookLogs = listAnymarketWebhookLogs;
const clearWebhookFailureLogs = async (req, res) => {
    try {
        const companyId = req.user?.companyId;
        if (!companyId) {
            return res.status(403).json({ error: 'Acesso negado. Usuario sem empresa.' });
        }
        const provider = String(req.params?.provider || '').trim().toLowerCase();
        if (provider !== 'intelipost' && provider !== 'anymarket') {
            return res.status(400).json({ error: 'Provider de webhook invalido.' });
        }
        const result = provider === 'intelipost'
            ? await intelipostWebhookService_1.intelipostWebhookService.clearFailureLogs(companyId)
            : await anymarketWebhookService_1.anymarketWebhookService.clearFailureLogs(companyId);
        return res.json({
            success: true,
            provider,
            removed: Number(result.removed || 0),
            message: `Fila de falhas do webhook ${provider} limpa com sucesso.`,
        });
    }
    catch (error) {
        console.error('Erro ao limpar fila de falhas de webhook:', error);
        return res.status(500).json({
            success: false,
            error: 'Erro ao limpar fila de falhas de webhook',
        });
    }
};
exports.clearWebhookFailureLogs = clearWebhookFailureLogs;
const reprocessWebhookFailureLogs = async (req, res) => {
    try {
        const companyId = req.user?.companyId;
        if (!companyId) {
            return res.status(403).json({ error: 'Acesso negado. Usuario sem empresa.' });
        }
        const provider = String(req.params?.provider || '').trim().toLowerCase();
        if (provider !== 'intelipost' && provider !== 'anymarket') {
            return res.status(400).json({ error: 'Provider de webhook invalido.' });
        }
        const limitRaw = Number(req.body?.limit || req.query?.limit || 120);
        const limit = Number.isFinite(limitRaw) ? limitRaw : 120;
        const result = provider === 'intelipost'
            ? await intelipostWebhookService_1.intelipostWebhookService.reprocessFailureLogs(companyId, limit)
            : await anymarketWebhookService_1.anymarketWebhookService.reprocessFailureLogs(companyId, limit);
        return res.json({
            success: true,
            provider,
            ...result,
            message: `Reprocessamento manual do webhook ${provider} concluido.`,
        });
    }
    catch (error) {
        console.error('Erro ao reprocessar fila de falhas de webhook:', error);
        return res.status(500).json({
            success: false,
            error: 'Erro ao reprocessar fila de falhas de webhook',
        });
    }
};
exports.reprocessWebhookFailureLogs = reprocessWebhookFailureLogs;
const receiveAnymarketWebhook = async (req, res) => {
    try {
        const result = await anymarketWebhookService_1.anymarketWebhookService.processWebhook({
            payload: req.body || {},
            requestIp: req.ip || null,
            userAgent: String(req.header('user-agent') || '').trim() || null,
        });
        return res.status(result.statusCode).json({
            success: result.success,
            message: result.message,
            companyId: result.companyId || null,
            orderId: result.orderId || null,
            changed: Boolean(result.changed),
        });
    }
    catch (error) {
        console.error('Erro ao processar webhook ANYMARKET:', error);
        return res.status(500).json({
            success: false,
            message: 'Erro interno ao processar webhook ANYMARKET',
        });
    }
};
exports.receiveAnymarketWebhook = receiveAnymarketWebhook;
const listMonitoringFailureAcks = async (req, res) => {
    try {
        const companyId = req.user?.companyId;
        if (!companyId) {
            return res.status(403).json({ error: 'Acesso negado. Usuario sem empresa.' });
        }
        const limitRaw = Number(req.query?.limit || 300);
        const limit = Math.max(1, Math.min(1000, Number.isFinite(limitRaw) ? limitRaw : 300));
        const result = await (0, db_1.dbQuery)(`
        SELECT DISTINCT ON ((sn."payload"->>'orderId'))
          sn."id",
          sn."createdAt",
          sn."payload"
        FROM "SyncNotification" sn
        WHERE sn."companyId" = $1
          AND sn."category" = 'WEBHOOK'
          AND sn."type" = 'MONITORING_FAILURE_ACK'
          AND COALESCE(sn."payload"->>'orderId', '') <> ''
        ORDER BY (sn."payload"->>'orderId') ASC, sn."createdAt" DESC
        LIMIT $2
      `, [companyId, limit]);
        const acks = result.rows.map((row) => {
            const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
            const ackDate = row.createdAt instanceof Date ? row.createdAt : new Date(String(row.createdAt || ''));
            return {
                id: String(row.id || ''),
                orderId: String(payload.orderId || '').trim(),
                orderNumber: String(payload.orderNumber || '').trim() || null,
                acknowledgedAt: Number.isNaN(ackDate.getTime()) ? null : ackDate.toISOString(),
                acknowledgedByUserId: String(payload.userId || '').trim() || null,
                acknowledgedByEmail: String(payload.userEmail || '').trim() || null,
            };
        });
        return res.json({
            success: true,
            total: acks.length,
            acks,
        });
    }
    catch (error) {
        console.error('Erro ao listar confirmacoes de alerta de falha:', error);
        return res.status(500).json({
            success: false,
            error: 'Erro ao listar confirmacoes de alerta de falha',
        });
    }
};
exports.listMonitoringFailureAcks = listMonitoringFailureAcks;
const acknowledgeMonitoringFailureAlert = async (req, res) => {
    try {
        const companyId = req.user?.companyId;
        if (!companyId) {
            return res.status(403).json({ error: 'Acesso negado. Usuario sem empresa.' });
        }
        const orderId = String(req.body?.orderId || '').trim();
        if (!orderId) {
            return res.status(400).json({ error: 'orderId e obrigatorio.' });
        }
        const orderResult = await (0, db_1.dbQuery)(`
        SELECT o."id", o."orderNumber", o."status"
        FROM "Order" o
        WHERE o."id" = $1
          AND o."companyId" = $2
        LIMIT $3
      `, [orderId, companyId, 1]);
        const order = orderResult.rows[0] || null;
        if (!order) {
            return res.status(404).json({ error: 'Pedido nao encontrado para esta empresa.' });
        }
        await (0, db_1.dbQuery)(`
        INSERT INTO "SyncNotification" (
          "id",
          "companyId",
          "category",
          "type",
          "title",
          "message",
          "payload",
          "createdAt"
        ) VALUES ($1, $2, 'WEBHOOK', 'MONITORING_FAILURE_ACK', $3, $4, $5::jsonb, NOW())
      `, [
            crypto_1.default.randomUUID(),
            companyId,
            'Falha na entrega marcada como atendida',
            `Pedido #${order.orderNumber} marcado como atendido no painel.`,
            JSON.stringify({
                orderId: order.id,
                orderNumber: order.orderNumber,
                userId: req.user?.id || null,
                userEmail: req.user?.email || null,
                source: 'monitoring-panel',
            }),
        ]);
        return res.json({
            success: true,
            message: 'Alerta marcado como atendido.',
            orderId: order.id,
            orderNumber: order.orderNumber,
        });
    }
    catch (error) {
        console.error('Erro ao confirmar alerta de falha:', error);
        return res.status(500).json({
            success: false,
            error: 'Erro ao confirmar alerta de falha',
        });
    }
};
exports.acknowledgeMonitoringFailureAlert = acknowledgeMonitoringFailureAlert;
