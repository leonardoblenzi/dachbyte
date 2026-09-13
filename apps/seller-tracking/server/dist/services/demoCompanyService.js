"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureDemoCompanyData = exports.isDemoCompanyById = exports.isDemoCompany = exports.DEMO_COMPANY_CNPJ = exports.DEMO_COMPANY_NAME = void 0;
const crypto_1 = __importDefault(require("crypto"));
const db_1 = require("../lib/db");
const orderStatus_1 = require("../types/orderStatus");
exports.DEMO_COMPANY_NAME = 'Empresa Teste - Apresentacao';
exports.DEMO_COMPANY_CNPJ = '12.345.678/0001-90';
const DEMO_COMPANY_CNPJ_DIGITS = exports.DEMO_COMPANY_CNPJ.replace(/\D/g, '');
const DEMO_COMPANY_CACHE_TTL_MS = 5 * 60 * 1000;
const demoCompanyByIdCache = new Map();
const normalizeText = (value) => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
const normalizeDigits = (value) => String(value || '').replace(/\D/g, '').trim();
const isDemoCompany = (company) => {
    if (!company)
        return false;
    const digits = normalizeDigits(company.cnpj || company.documentNumber);
    if (digits && digits === DEMO_COMPANY_CNPJ_DIGITS) {
        return true;
    }
    const normalizedName = normalizeText(company.name);
    if (!normalizedName)
        return false;
    const hasDemoPrefix = normalizedName.includes('EMPRESA TESTE');
    const hasDemoSuffix = normalizedName.includes('APRESENTACAO') ||
        normalizedName.includes('DEMONSTRACAO');
    return hasDemoPrefix && hasDemoSuffix;
};
exports.isDemoCompany = isDemoCompany;
const isDemoCompanyById = async (companyId) => {
    if (!companyId)
        return false;
    const cached = demoCompanyByIdCache.get(companyId);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.isDemo;
    }
    const companyResult = await (0, db_1.dbQuery)(`
      SELECT
        c."name",
        c."cnpj",
        c."documentNumber"
      FROM "Company" c
      WHERE c."id" = $1
      LIMIT 1
    `, [companyId]);
    const company = companyResult.rows[0] || null;
    const isDemo = (0, exports.isDemoCompany)(company);
    demoCompanyByIdCache.set(companyId, {
        isDemo,
        expiresAt: Date.now() + DEMO_COMPANY_CACHE_TTL_MS,
    });
    return isDemo;
};
exports.isDemoCompanyById = isDemoCompanyById;
const daysAgo = (days, hour = 10) => {
    const date = new Date();
    date.setHours(hour, 0, 0, 0);
    date.setDate(date.getDate() - days);
    return date;
};
const daysFromNow = (days, hour = 18) => {
    const date = new Date();
    date.setHours(hour, 0, 0, 0);
    date.setDate(date.getDate() + days);
    return date;
};
const withTime = (base, hour, minute) => {
    const date = new Date(base);
    date.setHours(hour, minute, 0, 0);
    return date;
};
const buildDemoOrders = () => {
    const shippedBase = daysAgo(5);
    const onRouteBase = daysAgo(2);
    const deliveredOnTimeBase = daysAgo(6);
    const deliveredLateBase = daysAgo(10);
    const failureBase = daysAgo(4);
    const returnedBase = daysAgo(8);
    const pendingBase = daysAgo(1);
    const createdBase = daysAgo(2);
    const channelBase = daysAgo(3);
    return [
        {
            orderNumber: 'DEMO-1001',
            invoiceNumber: 'NF-900001',
            trackingCode: 'TRKDEMO1001',
            customerName: 'Mariana Souza',
            corporateName: 'Studio Essencial Decor',
            cpf: '123.456.789-09',
            phone: '(11) 3333-1001',
            mobile: '(11) 98888-1001',
            salesChannel: 'Loja Online',
            freightType: 'Transportadora Horizonte',
            freightValue: 34.9,
            shippingDate: pendingBase,
            address: 'Rua das Acacias',
            number: '145',
            complement: 'Apto 32',
            neighborhood: 'Jardim Primavera',
            city: 'Sao Paulo',
            state: 'SP',
            zipCode: '01311-000',
            totalValue: 389.9,
            recipient: 'Mariana Souza',
            maxShippingDeadline: daysAgo(0),
            estimatedDeliveryDate: daysFromNow(2),
            status: orderStatus_1.OrderStatus.PENDING,
            isDelayed: false,
            trackingEvents: [
                {
                    status: 'PENDING',
                    description: 'Pedido importado para demonstracao e aguardando expedicao.',
                    eventDate: withTime(pendingBase, 9, 20),
                    city: 'Sao Paulo',
                    state: 'SP',
                },
            ],
        },
        {
            orderNumber: 'DEMO-1002',
            invoiceNumber: 'NF-900002',
            trackingCode: 'TRKDEMO1002',
            customerName: 'Carlos Henrique',
            cpf: '234.567.890-10',
            phone: '(21) 3333-1002',
            mobile: '(21) 97777-1002',
            salesChannel: 'Televendas',
            freightType: 'Transportadora Atlas',
            freightValue: 28.5,
            shippingDate: createdBase,
            address: 'Avenida Central',
            number: '802',
            neighborhood: 'Centro',
            city: 'Rio de Janeiro',
            state: 'RJ',
            zipCode: '20040-002',
            totalValue: 249.0,
            recipient: 'Carlos Henrique',
            maxShippingDeadline: daysAgo(1),
            estimatedDeliveryDate: daysFromNow(1),
            status: orderStatus_1.OrderStatus.CREATED,
            isDelayed: false,
            trackingEvents: [
                {
                    status: 'CREATED',
                    description: 'Etiqueta gerada na transportadora e coleta agendada.',
                    eventDate: withTime(createdBase, 14, 10),
                    city: 'Rio de Janeiro',
                    state: 'RJ',
                },
            ],
        },
        {
            orderNumber: 'DEMO-1003',
            invoiceNumber: 'NF-900003',
            trackingCode: 'TRKDEMO1003',
            customerName: 'Luciana Prado',
            cpf: '345.678.901-21',
            phone: '(31) 3333-1003',
            mobile: '(31) 96666-1003',
            salesChannel: 'Marketplace B2B',
            freightType: 'Transportadora Aurora',
            freightValue: 42.0,
            shippingDate: shippedBase,
            address: 'Rua Serra Azul',
            number: '77',
            neighborhood: 'Funcionarios',
            city: 'Belo Horizonte',
            state: 'MG',
            zipCode: '30130-110',
            totalValue: 579.9,
            recipient: 'Luciana Prado',
            maxShippingDeadline: daysAgo(4),
            estimatedDeliveryDate: daysFromNow(1),
            status: orderStatus_1.OrderStatus.SHIPPED,
            isDelayed: false,
            trackingEvents: [
                {
                    status: 'CREATED',
                    description: 'Pedido coletado no CD da empresa.',
                    eventDate: withTime(shippedBase, 8, 45),
                    city: 'Belo Horizonte',
                    state: 'MG',
                },
                {
                    status: 'SHIPPED',
                    description: 'Carga em transferencia para a unidade de destino.',
                    eventDate: withTime(daysAgo(3), 16, 5),
                    city: 'Contagem',
                    state: 'MG',
                },
            ],
        },
        {
            orderNumber: 'DEMO-1004',
            invoiceNumber: 'NF-900004',
            trackingCode: 'TRKDEMO1004',
            customerName: 'Fernanda Lima',
            cpf: '456.789.012-32',
            phone: '(41) 3333-1004',
            mobile: '(41) 95555-1004',
            salesChannel: 'App Vendas',
            freightType: 'Transportadora Rota Sul',
            freightValue: 31.75,
            shippingDate: onRouteBase,
            address: 'Rua das Laranjeiras',
            number: '550',
            complement: 'Casa 2',
            neighborhood: 'Batel',
            city: 'Curitiba',
            state: 'PR',
            zipCode: '80420-090',
            totalValue: 312.4,
            recipient: 'Fernanda Lima',
            maxShippingDeadline: daysAgo(1),
            estimatedDeliveryDate: daysFromNow(0),
            status: orderStatus_1.OrderStatus.DELIVERY_ATTEMPT,
            isDelayed: false,
            trackingEvents: [
                {
                    status: 'SHIPPED',
                    description: 'Objeto em rota para a unidade de distribuicao.',
                    eventDate: withTime(onRouteBase, 7, 30),
                    city: 'Curitiba',
                    state: 'PR',
                },
                {
                    status: 'TO_BE_DELIVERED',
                    description: 'Saiu para entrega ao destinatario.',
                    eventDate: withTime(daysAgo(0), 8, 10),
                    city: 'Curitiba',
                    state: 'PR',
                },
            ],
        },
        {
            orderNumber: 'DEMO-1005',
            invoiceNumber: 'NF-900005',
            trackingCode: 'TRKDEMO1005',
            customerName: 'Ricardo Nogueira',
            cpf: '567.890.123-43',
            phone: '(51) 3333-1005',
            mobile: '(51) 94444-1005',
            salesChannel: 'Loja Fisica',
            freightType: 'Transportadora Delta',
            freightValue: 19.9,
            shippingDate: deliveredOnTimeBase,
            address: 'Avenida Atlantica',
            number: '98',
            neighborhood: 'Menino Deus',
            city: 'Porto Alegre',
            state: 'RS',
            zipCode: '90110-120',
            totalValue: 189.5,
            recipient: 'Ricardo Nogueira',
            maxShippingDeadline: daysAgo(5),
            estimatedDeliveryDate: daysAgo(3, 18),
            status: orderStatus_1.OrderStatus.DELIVERED,
            isDelayed: false,
            trackingEvents: [
                {
                    status: 'CREATED',
                    description: 'Pedido separado e faturado.',
                    eventDate: withTime(deliveredOnTimeBase, 9, 0),
                    city: 'Porto Alegre',
                    state: 'RS',
                },
                {
                    status: 'SHIPPED',
                    description: 'Em transito para a cidade do destinatario.',
                    eventDate: withTime(daysAgo(5), 11, 40),
                    city: 'Porto Alegre',
                    state: 'RS',
                },
                {
                    status: 'DELIVERED',
                    description: 'Entrega concluida dentro do prazo previsto.',
                    eventDate: withTime(daysAgo(3), 15, 25),
                    city: 'Porto Alegre',
                    state: 'RS',
                },
            ],
        },
        {
            orderNumber: 'DEMO-1006',
            invoiceNumber: 'NF-900006',
            trackingCode: 'TRKDEMO1006',
            customerName: 'Patricia Gomes',
            cpf: '678.901.234-54',
            phone: '(62) 3333-1006',
            mobile: '(62) 93333-1006',
            salesChannel: 'Marketplace Premium',
            freightType: 'Transportadora Via Norte',
            freightValue: 46.2,
            shippingDate: deliveredLateBase,
            address: 'Rua do Mercado',
            number: '401',
            neighborhood: 'Setor Bueno',
            city: 'Goiania',
            state: 'GO',
            zipCode: '74215-040',
            totalValue: 649.0,
            recipient: 'Patricia Gomes',
            maxShippingDeadline: daysAgo(9),
            estimatedDeliveryDate: daysAgo(6, 18),
            status: orderStatus_1.OrderStatus.DELIVERED,
            isDelayed: true,
            trackingEvents: [
                {
                    status: 'CREATED',
                    description: 'Coleta realizada pela transportadora.',
                    eventDate: withTime(deliveredLateBase, 10, 10),
                    city: 'Goiania',
                    state: 'GO',
                },
                {
                    status: 'SHIPPED',
                    description: 'Carga em transferencia interestadual.',
                    eventDate: withTime(daysAgo(8), 13, 50),
                    city: 'Anapolis',
                    state: 'GO',
                },
                {
                    status: 'DELIVERED',
                    description: 'Entrega concluida apos o prazo prometido.',
                    eventDate: withTime(daysAgo(4), 17, 35),
                    city: 'Goiania',
                    state: 'GO',
                },
            ],
        },
        {
            orderNumber: 'DEMO-1007',
            invoiceNumber: 'NF-900007',
            trackingCode: 'TRKDEMO1007',
            customerName: 'Bruno Tavares',
            cpf: '789.012.345-65',
            phone: '(71) 3333-1007',
            mobile: '(71) 92222-1007',
            salesChannel: 'Site Institucional',
            freightType: 'Transportadora Costa Leste',
            freightValue: 37.3,
            shippingDate: failureBase,
            address: 'Travessa do Porto',
            number: '24',
            neighborhood: 'Pituba',
            city: 'Salvador',
            state: 'BA',
            zipCode: '41810-020',
            totalValue: 278.9,
            recipient: 'Bruno Tavares',
            maxShippingDeadline: daysAgo(3),
            estimatedDeliveryDate: daysAgo(1, 18),
            status: orderStatus_1.OrderStatus.FAILURE,
            isDelayed: true,
            trackingEvents: [
                {
                    status: 'SHIPPED',
                    description: 'Mercadoria em rota para a base local.',
                    eventDate: withTime(failureBase, 9, 45),
                    city: 'Salvador',
                    state: 'BA',
                },
                {
                    status: 'CLARIFY_DELIVERY_FAIL',
                    description: 'Falha na entrega por destinatario ausente. Reagendamento necessario.',
                    eventDate: withTime(daysAgo(1), 14, 15),
                    city: 'Salvador',
                    state: 'BA',
                },
            ],
        },
        {
            orderNumber: 'DEMO-1008',
            invoiceNumber: 'NF-900008',
            trackingCode: 'TRKDEMO1008',
            customerName: 'Aline Martins',
            cpf: '890.123.456-76',
            phone: '(81) 3333-1008',
            mobile: '(81) 91111-1008',
            salesChannel: 'Representante Comercial',
            freightType: 'Transportadora Ponte Aerea',
            freightValue: 54.9,
            shippingDate: returnedBase,
            address: 'Rua da Aurora',
            number: '889',
            neighborhood: 'Boa Vista',
            city: 'Recife',
            state: 'PE',
            zipCode: '50050-000',
            totalValue: 719.0,
            recipient: 'Aline Martins',
            maxShippingDeadline: daysAgo(7),
            estimatedDeliveryDate: daysAgo(4, 18),
            status: orderStatus_1.OrderStatus.RETURNED,
            isDelayed: true,
            trackingEvents: [
                {
                    status: 'SHIPPED',
                    description: 'Pedido expedido para o destino final.',
                    eventDate: withTime(returnedBase, 8, 35),
                    city: 'Recife',
                    state: 'PE',
                },
                {
                    status: 'RETURNED',
                    description: 'Volume devolvido ao remetente apos recusado no destino.',
                    eventDate: withTime(daysAgo(5), 16, 20),
                    city: 'Recife',
                    state: 'PE',
                },
            ],
        },
        {
            orderNumber: 'DEMO-1009',
            invoiceNumber: 'NF-900009',
            trackingCode: 'TRKDEMO1009',
            customerName: 'Julio Cesar',
            cpf: '901.234.567-87',
            phone: '(85) 3333-1009',
            mobile: '(85) 90000-1009',
            salesChannel: 'Marketplace Canal',
            freightType: 'Canal Marketplace',
            freightValue: 0,
            shippingDate: channelBase,
            address: 'Rua do Sol',
            number: '62',
            neighborhood: 'Aldeota',
            city: 'Fortaleza',
            state: 'CE',
            zipCode: '60150-160',
            totalValue: 129.9,
            recipient: 'Julio Cesar',
            maxShippingDeadline: daysAgo(2),
            estimatedDeliveryDate: daysFromNow(1),
            status: orderStatus_1.OrderStatus.CHANNEL_LOGISTICS,
            isDelayed: false,
            trackingEvents: [
                {
                    status: 'CHANNEL_LOGISTICS',
                    description: 'Logistica gerenciada pelo canal de venda para fins de demonstracao.',
                    eventDate: withTime(channelBase, 12, 0),
                    city: 'Fortaleza',
                    state: 'CE',
                },
            ],
        },
    ];
};
const ensureDemoCompanyData = async () => {
    let companyResult = await (0, db_1.dbQuery)(`
      SELECT
        c."id",
        c."name",
        c."cnpj",
        c."trayIntegrationEnabled",
        c."anymarketIntegrationEnabled",
        c."intelipostIntegrationEnabled"
      FROM "Company" c
      WHERE c."name" = $1
      ORDER BY c."createdAt" ASC
      LIMIT 1
    `, [exports.DEMO_COMPANY_NAME]);
    let company = companyResult.rows[0] || null;
    if (!company) {
        const createdId = crypto_1.default.randomUUID();
        const createdResult = await (0, db_1.dbQuery)(`
        INSERT INTO "Company" (
          "id",
          "name",
          "cnpj",
          "trayIntegrationEnabled",
          "anymarketIntegrationEnabled",
          "intelipostIntegrationEnabled",
          "createdAt",
          "updatedAt"
        )
        VALUES (
          $1,
          $2,
          $3,
          FALSE,
          FALSE,
          FALSE,
          NOW(),
          NOW()
        )
        RETURNING *
      `, [createdId, exports.DEMO_COMPANY_NAME, exports.DEMO_COMPANY_CNPJ]);
        company = createdResult.rows[0];
    }
    else if (company.cnpj !== exports.DEMO_COMPANY_CNPJ ||
        company.trayIntegrationEnabled !== false ||
        company.anymarketIntegrationEnabled !== false ||
        company.intelipostIntegrationEnabled !== false) {
        const updatedResult = await (0, db_1.dbQuery)(`
        UPDATE "Company" c
        SET
          "cnpj" = $2,
          "trayIntegrationEnabled" = FALSE,
          "anymarketIntegrationEnabled" = FALSE,
          "intelipostIntegrationEnabled" = FALSE,
          "updatedAt" = NOW()
        WHERE c."id" = $1
        RETURNING *
      `, [company.id, exports.DEMO_COMPANY_CNPJ]);
        company = updatedResult.rows[0];
    }
    const demoOrders = buildDemoOrders();
    for (const order of demoOrders) {
        const { trackingEvents, ...orderData } = order;
        const orderId = `${company.id}:${order.orderNumber}`;
        await (0, db_1.dbQuery)(`
        INSERT INTO "Order" (
          "id",
          "companyId",
          "orderNumber",
          "invoiceNumber",
          "trackingCode",
          "customerName",
          "corporateName",
          "cpf",
          "phone",
          "mobile",
          "salesChannel",
          "freightType",
          "freightValue",
          "shippingDate",
          "address",
          "number",
          "complement",
          "neighborhood",
          "city",
          "state",
          "zipCode",
          "totalValue",
          "recipient",
          "maxShippingDeadline",
          "estimatedDeliveryDate",
          "status",
          "isDelayed",
          "createdById",
          "lastApiSync",
          "lastApiError",
          "apiRawPayload",
          "lastUpdate",
          "createdAt"
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
          $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, NULL, NULL, NULL, NULL, NOW(), NOW()
        )
        ON CONFLICT ("id")
        DO UPDATE SET
          "companyId" = EXCLUDED."companyId",
          "orderNumber" = EXCLUDED."orderNumber",
          "invoiceNumber" = EXCLUDED."invoiceNumber",
          "trackingCode" = EXCLUDED."trackingCode",
          "customerName" = EXCLUDED."customerName",
          "corporateName" = EXCLUDED."corporateName",
          "cpf" = EXCLUDED."cpf",
          "phone" = EXCLUDED."phone",
          "mobile" = EXCLUDED."mobile",
          "salesChannel" = EXCLUDED."salesChannel",
          "freightType" = EXCLUDED."freightType",
          "freightValue" = EXCLUDED."freightValue",
          "shippingDate" = EXCLUDED."shippingDate",
          "address" = EXCLUDED."address",
          "number" = EXCLUDED."number",
          "complement" = EXCLUDED."complement",
          "neighborhood" = EXCLUDED."neighborhood",
          "city" = EXCLUDED."city",
          "state" = EXCLUDED."state",
          "zipCode" = EXCLUDED."zipCode",
          "totalValue" = EXCLUDED."totalValue",
          "recipient" = EXCLUDED."recipient",
          "maxShippingDeadline" = EXCLUDED."maxShippingDeadline",
          "estimatedDeliveryDate" = EXCLUDED."estimatedDeliveryDate",
          "status" = EXCLUDED."status",
          "isDelayed" = EXCLUDED."isDelayed",
          "createdById" = NULL,
          "lastApiSync" = NULL,
          "lastApiError" = NULL,
          "apiRawPayload" = NULL,
          "lastUpdate" = NOW()
      `, [
            orderId,
            company.id,
            orderData.orderNumber,
            orderData.invoiceNumber,
            orderData.trackingCode,
            orderData.customerName,
            orderData.corporateName || null,
            orderData.cpf,
            orderData.phone,
            orderData.mobile,
            orderData.salesChannel,
            orderData.freightType,
            orderData.freightValue,
            orderData.shippingDate,
            orderData.address,
            orderData.number,
            orderData.complement || null,
            orderData.neighborhood,
            orderData.city,
            orderData.state,
            orderData.zipCode,
            orderData.totalValue,
            orderData.recipient,
            orderData.maxShippingDeadline,
            orderData.estimatedDeliveryDate,
            orderData.status,
            orderData.isDelayed,
        ]);
        await (0, db_1.dbQuery)(`
        DELETE FROM "TrackingEvent" te
        WHERE te."orderId" = $1
      `, [orderId]);
        for (const event of trackingEvents) {
            await (0, db_1.dbQuery)(`
          INSERT INTO "TrackingEvent" (
            "id",
            "orderId",
            "status",
            "description",
            "city",
            "state",
            "eventDate",
            "createdAt"
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        `, [
                crypto_1.default.randomUUID(),
                orderId,
                event.status,
                event.description,
                event.city || null,
                event.state || null,
                event.eventDate,
            ]);
        }
    }
    return company;
};
exports.ensureDemoCompanyData = ensureDemoCompanyData;
