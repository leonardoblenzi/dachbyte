"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTenantPrisma = exports.mainPrisma = exports.syncToAllTenants = exports.getTenantDbPool = exports.mainDbPool = void 0;
const pg_1 = require("pg");
const db_1 = require("../lib/db");
exports.mainDbPool = db_1.dbPool;
const tenantPools = new Map();
const buildTenantPool = (connectionString) => new pg_1.Pool({
    connectionString,
});
const getTenantDbPool = async (companyId) => {
    if (!companyId) {
        return exports.mainDbPool;
    }
    try {
        const companyResult = await (0, db_1.dbQuery)(`
        SELECT c."databaseUrl"
        FROM "Company" c
        WHERE c."id" = $1
        LIMIT 1
      `, [companyId]);
        const databaseUrl = String(companyResult.rows[0]?.databaseUrl || '').trim();
        if (!databaseUrl) {
            return exports.mainDbPool;
        }
        if (!tenantPools.has(databaseUrl)) {
            tenantPools.set(databaseUrl, buildTenantPool(databaseUrl));
        }
        return tenantPools.get(databaseUrl) || exports.mainDbPool;
    }
    catch (error) {
        console.error('Erro ao buscar pool tenant:', error);
        return exports.mainDbPool;
    }
};
exports.getTenantDbPool = getTenantDbPool;
const syncToAllTenants = async (action) => {
    try {
        const companiesResult = await (0, db_1.dbQuery)(`
        SELECT c."databaseUrl"
        FROM "Company" c
        WHERE c."databaseUrl" IS NOT NULL
      `);
        const urls = Array.from(new Set(companiesResult.rows
            .map((row) => String(row.databaseUrl || '').trim())
            .filter(Boolean)));
        await action(exports.mainDbPool);
        for (const url of urls) {
            if (!tenantPools.has(url)) {
                tenantPools.set(url, buildTenantPool(url));
            }
            const tenantPool = tenantPools.get(url);
            if (!tenantPool) {
                continue;
            }
            try {
                await action(tenantPool);
            }
            catch (error) {
                console.error(`Erro ao sincronizar tenant ${url}:`, error);
            }
        }
    }
    catch (error) {
        console.error('Erro geral no syncToAllTenants:', error);
    }
};
exports.syncToAllTenants = syncToAllTenants;
// Compatibilidade com assinatura antiga baseada em Prisma.
exports.mainPrisma = exports.mainDbPool;
exports.getTenantPrisma = exports.getTenantDbPool;
