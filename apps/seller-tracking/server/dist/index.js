"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startAvantrackingServer = exports.initializeAvantrackingSchedules = exports.createAvantrackingApp = void 0;
const path_1 = __importDefault(require("path"));
const express_1 = __importDefault(require("express"));
const orders_1 = __importDefault(require("./routes/orders"));
const users_1 = __importDefault(require("./routes/users"));
const companies_1 = __importDefault(require("./routes/companies"));
const releaseNotes_1 = __importDefault(require("./routes/releaseNotes"));
const support_1 = __importDefault(require("./routes/support"));
const notifications_1 = __importDefault(require("./routes/notifications"));
const webhooks_1 = __importDefault(require("./routes/webhooks"));
const trayAuthController_1 = require("./controllers/trayAuthController");
const traySyncController_1 = require("./controllers/traySyncController");
const anymarketController_1 = require("./controllers/anymarketController");
const rateLimiter_1 = require("./services/rateLimiter");
const freightController_1 = require("./controllers/freightController");
const auth_1 = require("./middleware/auth");
const traySyncJobService_1 = require("./services/traySyncJobService");
const anymarketSyncJobService_1 = require("./services/anymarketSyncJobService");
const syncJobService_1 = require("./services/syncJobService");
const weeklyMovementReportService_1 = require("./services/weeklyMovementReportService");
const monthlyMovementReportService_1 = require("./services/monthlyMovementReportService");
const chatAssistantService_1 = require("./services/chatAssistantService");
const db_1 = require("./lib/db");
const modSituation_1 = require("./utils/modSituation");
const hubUsageReporter_1 = require("./services/hubUsageReporter");
const integrationHealthService_1 = require("./services/integrationHealthService");
const app = (0, express_1.default)();
app.set('trust proxy', true);
app.use(express_1.default.json({ limit: '50mb' }));
// ==================== API ROUTES ====================
// ✅ ROTA DE CHAT (protegida com autenticação)
app.post("/api/chat", auth_1.authenticateToken, async (req, res) => {
    try {
        const ollamaUrl = (process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/+$/, "");
        const ollamaModel = process.env.OLLAMA_MODEL || "qwen3:0.6b";
        const input = typeof req.body?.input === "string" ? req.body.input : "";
        const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
        if (!input.trim()) {
            return res.status(400).json({ error: "Mensagem vazia." });
        }
        const trackingResult = await chatAssistantService_1.chatAssistantService.tryHandleTrackingRequest({
            companyId: req.user?.companyId,
            text: input,
        });
        if (trackingResult.handled && trackingResult.text) {
            return res.json({
                text: trackingResult.text,
                actions: Array.isArray(trackingResult.actions)
                    ? trackingResult.actions
                    : [],
            });
        }
        const structuredResult = await chatAssistantService_1.chatAssistantService.tryHandleStructuredRequest({
            companyId: req.user?.companyId,
            userId: req.user?.id,
            text: input,
            messages,
        });
        if (structuredResult.handled && structuredResult.text) {
            return res.json({
                text: structuredResult.text,
                actions: Array.isArray(structuredResult.actions)
                    ? structuredResult.actions
                    : [],
            });
        }
        const history = messages
            .slice(-12)
            .map((m) => ({
            role: m?.role === "user" ? "user" : "model",
            text: typeof m?.text === "string" ? m.text : "",
        }))
            .filter((m) => m.text.trim().length > 0);
        const SYSTEM = [
            "Você é a Muriçoca, assistente da plataforma Avantracking.",
            "Ajude usuários a operar o sistema de ponta a ponta com instruções curtas e práticas.",
            "Não invente telas, botões ou integrações que você não tenha certeza; quando faltar contexto, faça 1-2 perguntas objetivas.",
            "Responda em PT-BR.",
            "",
            "Contexto do Avantracking (resumo funcional):",
            "- Autenticação: Login (usuário precisa estar autenticado para acessar a aplicação).",
            "- Navegação: Sidebar com visões: Dashboard, Pedidos, Pedidos sem movimentação, Importação, Alertas, Falhas na Entrega, Admin (para ADMIN).",
            "- Dashboard: KPIs e gráficos; permite clicar e filtrar para abrir a lista de pedidos com filtros aplicados.",
            "- Pedidos: lista com filtros; permite buscar um pedido único via API (Intelipost) e atualizar/adicionar na lista.",
            "- Importação: envio de CSV/XLSX; pedidos CANCELADOS são ignorados; alguns fretes do canal (ColetasME2, Shopee Xpress, 'priorit') viram status Logística do Canal.",
            "- Sincronização: atualização manual e automática (a cada 1 hora) com a Intelipost para pedidos ativos; recalcula status efetivo e atraso.",
            "- Alertas: monitora riscos de atraso (data atual > previsão; não entregue).",
            "- Falhas na entrega: visão focada em ocorrências/entregas com problema.",
            "- Integracao da Integradora: rotas /api/tray/* para autenticacao e sincronizacao.",
            "- Cotação de frete: rotas /api/freight/quote/:orderId e /api/freight/quote-batch.",
            "",
            "Regras de resposta:",
            "- Quando o usuário pedir 'como faço', entregue um passo a passo curto.",
            "- Quando o usuário reportar erro, explique a causa provável e o que checar.",
            "- Se o usuário pedir algo que exige permissão (ex: Admin), aponte isso.",
            "- REGRA CRÍTICA DE FALLBACK: Se você não souber a resposta, ou se o usuário disser que 'não está funcionando', 'deu erro', 'não consigo' ou relatar falhas técnicas persistentes, peça para ele entrar em contato com o desenvolvedor para resolução.",
        ].join("\n");
        const enrichedSystem = [
            SYSTEM,
            "Base complementar de conhecimento atual:",
            "- Dashboard com KPIs, graficos, ranking e atalhos para filtros.",
            "- Pedidos com filtros, ordenacao por colunas, detalhes, exportacao HTML e CSV e abertura de rastreio.",
            "- Alertas de risco, Falhas na Entrega e Sem Movimentacao.",
            "- Integracao da Integradora, sincronizacao de pedidos e frete recalculado.",
            "- Administracao de usuarios, empresas, integracoes e release notes.",
            "- Ultimas Atualizacoes com historico dos release notes enviados.",
            "Se a pergunta nao estiver coberta com seguranca ou se o usuario relatar erro persistente, oriente contato com o desenvolvedor da plataforma.",
        ].join("\n");
        const ollamaMessages = [
            { role: "system", content: enrichedSystem },
            ...history.map((m) => ({
                role: m.role === "user" ? "user" : "assistant",
                content: m.text,
            })),
            { role: "user", content: input },
        ];
        const response = await fetch(`${ollamaUrl}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: ollamaModel,
                stream: false,
                messages: ollamaMessages,
                options: {
                    temperature: 0.3,
                },
            }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const details = typeof data?.error === "string"
                ? data.error
                : `HTTP ${response.status}`;
            return res.status(502).json({
                error: "Falha ao consultar o Ollama.",
                details,
                ollamaUrl,
                model: ollamaModel,
            });
        }
        const text = typeof data?.message?.content === "string" ? data.message.content.trim() : "";
        if (!text) {
            return res.status(502).json({ error: "Resposta vazia do modelo." });
        }
        return res.json({ text });
    }
    catch (error) {
        return res.status(500).json({
            error: "Falha ao consultar IA.",
            details: typeof error?.message === "string" ? error.message : String(error),
        });
    }
});
// Health check
app.get("/api/health", (req, res) => {
    res.json({
        ok: true,
        modSituation: (0, modSituation_1.getModSituation)(),
        automaticProcessesEnabled: (0, modSituation_1.shouldRunAutomaticProcesses)(),
    });
});
// Webhooks publicos (Intelipost)
app.use('/api/webhooks', webhooks_1.default);
// DEBUG: Test database connection
app.get("/api/debug/users-count", auth_1.authenticateToken, async (req, res) => {
    try {
        const countResult = await (0, db_1.dbQuery)(`SELECT COUNT(*)::int AS "total" FROM "User"`);
        const usersResult = await (0, db_1.dbQuery)(`
        SELECT "id", "name", "email", "role", "companyId"
        FROM "User"
        ORDER BY "createdAt" DESC
        LIMIT 5
      `);
        const count = Number(countResult.rows[0]?.total || 0);
        const users = usersResult.rows;
        res.json({
            success: true,
            totalUsers: count,
            sample: users,
            message: `Total de ${count} usuários no banco de dados`
        });
    }
    catch (error) {
        console.error('Erro ao contar usuários:', error);
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Erro ao consultar banco de dados'
        });
    }
});
// Users API (algumas rotas protegidas, algumas não - ver routes/users.ts)
app.use("/api/users", users_1.default);
// Companies API (protegida)
app.use("/api/companies", auth_1.authenticateToken, companies_1.default);
// Release Notes API (protegida)
app.use("/api/release-notes", auth_1.authenticateToken, releaseNotes_1.default);
// Support API (protegida)
app.use("/api/support", auth_1.authenticateToken, support_1.default);
// Notifications API (protegida)
app.use("/api/notifications", auth_1.authenticateToken, notifications_1.default);
// Orders API (protegida)
app.use("/api/orders", auth_1.authenticateToken, orders_1.default);
// ✅ ROTAS OAUTH TRAY (sem autenticação obrigatória)
app.get('/api/tray/connect', auth_1.authenticateToken, trayAuthController_1.startTrayAuthorization);
app.get('/api/tray/callback', trayAuthController_1.showInstallPage);
app.get('/api/tray/callback/auth', trayAuthController_1.handleAuthCallback);
app.get('/api/tray/status', auth_1.authenticateToken, trayAuthController_1.checkAuthStatus);
app.post('/api/tray/sync', auth_1.authenticateToken, traySyncController_1.syncTrayOrders);
app.post('/api/tray/sync/start', auth_1.authenticateToken, traySyncController_1.startTraySyncJob);
app.get('/api/tray/sync/status', auth_1.authenticateToken, traySyncController_1.getTraySyncStatus);
app.get('/api/integrations/order-status-options', auth_1.authenticateToken, traySyncController_1.getOrderImportStatusOptions);
app.post('/api/integrations/sync/start', auth_1.authenticateToken, traySyncController_1.startIntegrationSyncJob);
app.get('/api/integrations/sync/status', auth_1.authenticateToken, traySyncController_1.getIntegrationSyncStatus);
app.post('/api/integrations/sync/cancel', auth_1.authenticateToken, traySyncController_1.cancelIntegrationSyncJob);
app.get('/api/anymarket/status', auth_1.authenticateToken, anymarketController_1.checkAnymarketStatus);
app.post('/api/anymarket/sync', auth_1.authenticateToken, anymarketController_1.syncAnymarketOrders);
app.get('/tray/callback', trayAuthController_1.showInstallPage);
app.get('/tray/callback/auth', trayAuthController_1.handleAuthCallback);
// ✅ ROTAS DE COTAÇÃO DE FRETE (protegidas)
app.post('/api/freight/quote/:orderId', auth_1.authenticateToken, freightController_1.quoteOrderFreight);
app.post('/api/freight/quote-batch', auth_1.authenticateToken, freightController_1.quoteBatchFreight);
app.post('/api/freight/backfill-missing', auth_1.authenticateToken, freightController_1.backfillMissingFreightQuotes);
app.post('/api/tray/checkout-quotes', auth_1.authenticateToken, freightController_1.saveTrayCheckoutQuoteSnapshot);
// ✅ ENDPOINT PARA MONITORAR RATE LIMIT (MOVIDO PARA ANTES DO FALLBACK)
app.get('/api/tray/rate-limit-stats', (req, res) => {
    const stats = rateLimiter_1.trayRateLimiter.getStats();
    return res.json({
        success: true,
        rateLimiter: {
            ...stats,
            status: stats.utilizationPercent > 90 ? 'CRITICAL' :
                stats.utilizationPercent > 70 ? 'WARNING' : 'OK'
        }
    });
});
// ==================== FRONTEND ====================
// Servir frontend
const frontendPath = path_1.default.join(__dirname, "../public");
const reportsPath = path_1.default.join(frontendPath, 'reports');
app.get('/reports/:scope/:fileName', (req, res, next) => {
    const scope = String(req.params.scope || '').trim();
    const fileName = path_1.default.basename(String(req.params.fileName || '').trim());
    if (!scope || !fileName) {
        return next();
    }
    const isValidScope = /^[a-z0-9][a-z0-9_-]*$/i.test(scope);
    const isValidFileName = /^[a-z0-9._-]+$/i.test(fileName);
    if (!isValidScope || !isValidFileName) {
        return res.status(400).json({ error: 'Invalid report path' });
    }
    const scopeRootPath = path_1.default.resolve(reportsPath, scope);
    const filePath = path_1.default.resolve(scopeRootPath, fileName);
    if (!filePath.startsWith(`${scopeRootPath}${path_1.default.sep}`)) {
        return res.status(400).json({ error: 'Invalid report path' });
    }
    const extension = path_1.default.extname(fileName).toLowerCase();
    const downloadParam = String(req.query.download || '').toLowerCase();
    const forceDownload = extension === '.csv' ||
        extension === '.xls' ||
        extension === '.xlsx' ||
        (extension === '.html' &&
            (downloadParam === '1' || downloadParam === 'true' || downloadParam === 'yes'));
    if (forceDownload) {
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    }
    if (extension === '.csv') {
        res.type('text/csv; charset=utf-8');
    }
    return res.sendFile(filePath, (error) => {
        if (!error) {
            return;
        }
        const typedError = error;
        if (typedError.code === 'ENOENT' ||
            typedError.status === 404 ||
            typedError.statusCode === 404) {
            return next();
        }
        return next(typedError);
    });
});
app.get('/api/anymarket/rate-limit-stats', auth_1.authenticateToken, anymarketController_1.getAnymarketRateLimitStats);
app.use(express_1.default.static(frontendPath));
// ⚠️ FALLBACK DEVE SER SEMPRE A ÚLTIMA ROTA!
app.get(/.*/, (req, res) => {
    // Verificar se é uma rota API que não existe
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'API route not found' });
    }
    // Servir frontend para todas as outras rotas
    res.sendFile(path_1.default.join(frontendPath, "index.html"));
});
// ==================== START SERVER ====================
const createAvantrackingApp = () => {
    (0, hubUsageReporter_1.startHubUsageReporter)();
    return app;
};
exports.createAvantrackingApp = createAvantrackingApp;
const initializeAvantrackingSchedules = async () => {
    if (!(0, modSituation_1.shouldRunAutomaticProcesses)()) {
        console.log(`[AUTO] Processos automaticos desabilitados por MOD_SITUATION=${(0, modSituation_1.getModSituation)()}.`);
        return;
    }
    const initializers = [
        ['rastreio', () => syncJobService_1.syncJobService.initializeSchedules()],
        ['pedidos Tray', () => traySyncJobService_1.traySyncJobService.initializeSchedules()],
        ['pedidos ANYMARKET', () => anymarketSyncJobService_1.anymarketSyncJobService.initializeSchedules()],
        ['saude das integracoes', () => integrationHealthService_1.integrationHealthService.initialize()],
        ['relatorio semanal', () => weeklyMovementReportService_1.weeklyMovementReportService.initializeSchedule()],
        ['relatorio mensal', () => monthlyMovementReportService_1.monthlyMovementReportService.initializeSchedule()],
    ];
    for (const [label, initialize] of initializers) {
        try {
            await initialize();
            console.log(`[AUTO] Agendador de ${label} inicializado.`);
        }
        catch (error) {
            console.error(`[AUTO] Falha ao inicializar agendador de ${label}:`, error);
        }
    }
};
exports.initializeAvantrackingSchedules = initializeAvantrackingSchedules;
const startAvantrackingServer = async () => {
    const port = process.env.PORT || 3000;
    const server = app.listen(port, () => {
        console.log(`Server running on port ${port}`);
    });
    (0, hubUsageReporter_1.startHubUsageReporter)();
    try {
        await (0, exports.initializeAvantrackingSchedules)();
    }
    catch (error) {
        console.error('Erro ao inicializar tarefas automaticas do Avantracking:', error);
    }
    return server;
};
exports.startAvantrackingServer = startAvantrackingServer;
if (require.main === module) {
    void (0, exports.startAvantrackingServer)();
}
