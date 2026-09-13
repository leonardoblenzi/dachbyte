"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const db_1 = require("../lib/db");
const trackingService_1 = require("../services/trackingService");
const trackingService = new trackingService_1.TrackingService();
const startFromCompanyName = String(process.env.START_FROM_COMPANY_NAME || '')
    .trim()
    .toUpperCase();
const formatError = (error) => error instanceof Error ? error.message : 'Erro desconhecido';
async function main() {
    const companiesResult = await (0, db_1.dbQuery)(`
      SELECT c."id", c."name"
      FROM "Company" c
      ORDER BY c."name" ASC
    `);
    const companies = companiesResult.rows;
    const filteredCompanies = startFromCompanyName
        ? companies.filter((company) => String(company.name || '').trim().toUpperCase() >= startFromCompanyName)
        : companies;
    if (filteredCompanies.length === 0) {
        console.log('Nenhuma empresa encontrada para sincronizacao.');
        return;
    }
    if (startFromCompanyName) {
        console.log(`Retomando sincronizacao a partir de: ${startFromCompanyName}`);
    }
    let grandTotal = 0;
    let grandSuccess = 0;
    let grandFailed = 0;
    for (const company of filteredCompanies) {
        console.log(`\nEmpresa: ${company.name}`);
        const result = await trackingService.syncAllActive(company.id, { forceFinalized: true }, {
            onStart: ({ total }) => {
                console.log(`  Pedidos na fila: ${total}`);
            },
            onOrderStart: ({ orderNumber, index, total }) => {
                console.log(`  [${index}/${total}] Sincronizando pedido ${orderNumber}...`);
            },
            onOrderFinish: ({ orderNumber, success, message, durationMs }) => {
                console.log(`  ${success ? 'OK' : 'ERRO'} ${orderNumber} (${durationMs}ms): ${message}`);
            },
        });
        grandTotal += result.total;
        grandSuccess += result.success;
        grandFailed += result.failed;
        console.log(`  Resumo ${company.name}: ${result.success} sucesso(s), ${result.failed} falha(s), ${result.total} total.`);
        if (result.warnings.length > 0) {
            console.log(`  Avisos: ${result.warnings.join(' | ')}`);
        }
    }
    console.log('\nReprocessamento global de rastreio concluido.');
    console.log(`Pedidos processados: ${grandTotal}`);
    console.log(`Sucesso: ${grandSuccess}`);
    console.log(`Falhas: ${grandFailed}`);
}
main()
    .catch((error) => {
    console.error('Falha no reprocessamento global de rastreio:', formatError(error));
    process.exitCode = 1;
});
