"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.integrationOrderStatusService = exports.IntegrationOrderStatusService = exports.normalizeAnymarketStatusValue = void 0;
const db_1 = require("../lib/db");
const trayAuthService_1 = require("./trayAuthService");
const trayApiService_1 = require("./trayApiService");
const TRAY_FALLBACK_STATUSES = [
    'pedido cadastrado',
    'a enviar',
    '5- aguardando faturamento',
    'enviado',
    'finalizado',
    'entregue',
    'cancelado',
    'aguardando envio',
];
const MAGAZORD_STATUSES = [
    { value: '1', label: 'Aguardando Pagamento', code: 1, category: 'Normal' },
    { value: '2', label: 'Cancelado Pagamento', code: 2, category: 'Cancelado' },
    { value: '3', label: 'Em analise Pagamento', code: 3, category: 'Aguardando Terceiro' },
    { value: '4', label: 'Aprovado', code: 4, category: 'Normal' },
    { value: '5', label: 'Aprovado e Integrado', code: 5, category: 'Normal' },
    { value: '6', label: 'Nota Fiscal Emitida', code: 6, category: 'Normal' },
    { value: '7', label: 'Transporte', code: 7, category: 'Normal' },
    { value: '8', label: 'Entregue', code: 8, category: 'Normal' },
    { value: '9', label: 'Fraude', code: 9, category: 'Normal' },
    { value: '10', label: 'Chargeback', code: 10, category: 'Normal' },
    { value: '11', label: 'Disputa', code: 11, category: 'Normal' },
    { value: '12', label: 'Aprovado Analise de Pagamento', code: 12, category: 'Normal' },
    { value: '13', label: 'Cancelado Pagamento Analise', code: 13, category: 'Cancelado' },
    { value: '14', label: 'Aguardando Pagamento (Diferenciado)', code: 14, category: 'Normal' },
    { value: '15', label: 'Separacao', code: 15, category: 'Normal' },
    { value: '16', label: 'Embalado', code: 16, category: 'Normal' },
    { value: '17', label: 'Coleta Solicitada', code: 17, category: 'Aguardando Terceiro' },
    { value: '18', label: 'Aguardando Atualizacao de Dados', code: 18, category: 'Aguardando Terceiro' },
    { value: '19', label: 'Aguardando Chegada do Produto', code: 19, category: 'Aguardando Terceiro' },
    { value: '20', label: 'Devolvido Estoque (Dep. 1)', code: 20, category: 'Anomalia' },
    { value: '21', label: 'Devolvido Estoque (Outros Dep.)', code: 21, category: 'Anomalia' },
    { value: '22', label: 'Suspenso Temporariamente', code: 22, category: 'Anomalia' },
    { value: '23', label: 'Faturamento Iniciado', code: 23, category: 'Normal' },
    { value: '24', label: 'Em Cancelamento', code: 24, category: 'Cancelado' },
    { value: '25', label: 'Tratamento Pos-Vendas', code: 25, category: 'Anomalia' },
    { value: '26', label: 'Nota Fiscal Cancelada', code: 26, category: 'Normal' },
    { value: '27', label: 'Credito por Troca', code: 27, category: 'Normal' },
    { value: '28', label: 'Nota Fiscal Denegada', code: 28, category: 'Anomalia' },
    { value: '29', label: 'Chargeback Pago', code: 29, category: 'Normal' },
    { value: '30', label: 'Aprovado Parcial', code: 30, category: 'Normal' },
    { value: '31', label: 'Em Logistica Reversa', code: 31, category: 'Anomalia' },
];
const ANYMARKET_STATUSES = [
    { value: 'PENDING', label: 'Pendente' },
    { value: 'DELIVERY_ISSUE', label: 'Problema na entrega' },
    { value: 'PAID_WAITING_SHIP', label: 'Pago aguardando envio' },
    { value: 'INVOICED', label: 'Faturado' },
    { value: 'PAID_WAITING_DELIVERY', label: 'Enviado aguardando entrega' },
    { value: 'CONCLUDED', label: 'Concluido / Entregue' },
    { value: 'CANCELED', label: 'Cancelado' },
];
const normalizeText = (value) => String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
const normalizeAnymarketStatusKey = (value) => normalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
const ANYMARKET_STATUS_ALIASES = {
    PENDENTE: 'PENDING',
    'PROBLEMA NA ENTREGA': 'DELIVERY_ISSUE',
    'PAGO AGUARDANDO ENVIO': 'PAID_WAITING_SHIP',
    FATURADO: 'INVOICED',
    ENVIADO: 'PAID_WAITING_DELIVERY',
    'ENVIADO AGUARDANDO ENTREGA': 'PAID_WAITING_DELIVERY',
    CONCLUIDO: 'CONCLUDED',
    'CONCLUIDO / ENTREGUE': 'CONCLUDED',
    ENTREGUE: 'CONCLUDED',
    CANCELADO: 'CANCELED',
};
const normalizeAnymarketStatusValue = (value) => {
    const normalized = normalizeAnymarketStatusKey(value);
    return ANYMARKET_STATUS_ALIASES[normalized] || normalized;
};
exports.normalizeAnymarketStatusValue = normalizeAnymarketStatusValue;
const normalizeTrayStatusValue = (value) => normalizeText(value).toLowerCase();
const titleCase = (value) => value.replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
const buildTrayOption = (value) => ({
    value,
    label: titleCase(value),
});
const sortTrayStatuses = (statuses) => {
    const fallbackOrder = new Map(TRAY_FALLBACK_STATUSES.map((status, index) => [status, index]));
    return [...statuses].sort((left, right) => {
        const leftOrder = fallbackOrder.get(left);
        const rightOrder = fallbackOrder.get(right);
        if (leftOrder !== undefined && rightOrder !== undefined) {
            return leftOrder - rightOrder;
        }
        if (leftOrder !== undefined)
            return -1;
        if (rightOrder !== undefined)
            return 1;
        return left.localeCompare(right, 'pt-BR', {
            sensitivity: 'base',
            numeric: true,
        });
    });
};
const getRecentTrayStatuses = async (companyId) => {
    const auth = await trayAuthService_1.trayAuthService.getCurrentAuth(companyId);
    if (!auth) {
        return [];
    }
    const trayApi = new trayApiService_1.TrayApiService(companyId);
    const modified = new Date();
    modified.setDate(modified.getDate() - 180);
    modified.setHours(0, 0, 0, 0);
    const foundStatuses = new Set();
    let currentPage = 1;
    let totalPages = 1;
    while (currentPage <= totalPages && currentPage <= 5) {
        const response = await trayApi.listOrders({
            page: currentPage,
            limit: 50,
            modified: modified.toISOString().slice(0, 10),
        });
        const orders = response.Orders || [];
        orders.forEach((orderWrapper) => {
            const status = normalizeTrayStatusValue(orderWrapper?.Order?.status);
            if (status) {
                foundStatuses.add(status);
            }
        });
        const paging = response.paging;
        const limit = Number(paging?.limit || 50);
        const total = Number(paging?.total || 0);
        totalPages = Math.max(1, Math.ceil(total / limit));
        currentPage += 1;
    }
    return [...foundStatuses];
};
class IntegrationOrderStatusService {
    async getOrderImportStatuses(companyId) {
        const companyResult = await (0, db_1.dbQuery)(`
        SELECT
          c."trayIntegrationEnabled",
          c."anymarketIntegrationEnabled",
          c."blingIntegrationEnabled",
          c."magazordIntegrationEnabled",
          c."jetIntegrationEnabled",
          c."sysempIntegrationEnabled"
        FROM "Company" c
        WHERE c."id" = $1
        LIMIT 1
      `, [companyId]);
        const company = companyResult.rows[0] || null;
        if (!company) {
            throw new Error('Empresa nao encontrada.');
        }
        if (company.trayIntegrationEnabled) {
            let trayStatuses = [];
            try {
                trayStatuses = await getRecentTrayStatuses(companyId);
            }
            catch (error) {
                console.error('Falha ao consultar status recentes da Tray:', error);
            }
            const mergedStatuses = sortTrayStatuses(Array.from(new Set([
                ...TRAY_FALLBACK_STATUSES.map((status) => normalizeTrayStatusValue(status)),
                ...trayStatuses,
            ])).filter(Boolean));
            return {
                integration: 'tray',
                integrationLabel: 'Tray',
                statuses: mergedStatuses.map(buildTrayOption),
                cancelStatusValues: mergedStatuses.filter((status) => status.includes('cancel')),
            };
        }
        if (company.magazordIntegrationEnabled) {
            return {
                integration: 'magazord',
                integrationLabel: 'Magazord',
                statuses: MAGAZORD_STATUSES,
                cancelStatusValues: MAGAZORD_STATUSES.filter((status) => normalizeText(status.category).toLowerCase() === 'cancelado' ||
                    normalizeText(status.label).toLowerCase().includes('cancel')).map((status) => status.value),
            };
        }
        if (company.anymarketIntegrationEnabled) {
            return {
                integration: 'anymarket',
                integrationLabel: 'ANYMARKET',
                statuses: [...ANYMARKET_STATUSES],
                cancelStatusValues: ['CANCELED'],
            };
        }
        if (company.jetIntegrationEnabled) {
            return {
                integration: 'jet',
                integrationLabel: 'JET',
                statuses: [],
                cancelStatusValues: [],
            };
        }
        if (company.blingIntegrationEnabled) {
            return {
                integration: 'bling',
                integrationLabel: 'Bling ERP',
                statuses: [],
                cancelStatusValues: [],
            };
        }
        if (company.sysempIntegrationEnabled) {
            return {
                integration: 'sysemp',
                integrationLabel: 'SYSEMP',
                statuses: [],
                cancelStatusValues: [],
            };
        }
        return {
            integration: null,
            integrationLabel: 'Integradora',
            statuses: [],
            cancelStatusValues: [],
        };
    }
}
exports.IntegrationOrderStatusService = IntegrationOrderStatusService;
exports.integrationOrderStatusService = new IntegrationOrderStatusService();
