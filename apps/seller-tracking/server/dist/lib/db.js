"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.withDbTransaction = exports.dbQuery = exports.dbPool = exports.attachPoolErrorHandler = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const dotenv_1 = __importDefault(require("dotenv"));
const pg_1 = require("pg");
const { resolveAvantrackingDatabaseUrl } = require('../../../databaseTarget.cjs');
const globalForDbPool = globalThis;
const loadEnvFiles = () => {
    const candidates = [
        path_1.default.resolve(process.cwd(), '.env'),
        path_1.default.resolve(process.cwd(), '.env.local'),
        path_1.default.resolve(process.cwd(), '..', '.env'),
        path_1.default.resolve(process.cwd(), '..', '.env.local'),
    ];
    for (const filePath of candidates) {
        if (!fs_1.default.existsSync(filePath)) {
            continue;
        }
        dotenv_1.default.config({
            path: filePath,
            override: false,
            quiet: true,
        });
    }
};
loadEnvFiles();
const attachPoolErrorHandler = (pool) => {
    pool.on('error', (error) => {
        console.error('[AVANTRACKING][DB] Conexao do PostgreSQL encerrada; o pool abrira outra quando necessario.', {
            code: error.code || null,
            message: error.message,
        });
    });
    return pool;
};
exports.attachPoolErrorHandler = attachPoolErrorHandler;
const createPool = () => (0, exports.attachPoolErrorHandler)(new pg_1.Pool({
    connectionString: resolveAvantrackingDatabaseUrl(process.env),
}));
exports.dbPool = globalForDbPool.__avantrackingDbPool || createPool();
if (process.env.NODE_ENV !== 'production') {
    globalForDbPool.__avantrackingDbPool = exports.dbPool;
}
const dbQuery = (text, params = []) => exports.dbPool.query(text, params);
exports.dbQuery = dbQuery;
const withDbTransaction = async (callback) => {
    const client = await exports.dbPool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    }
    catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
    finally {
        client.release();
    }
};
exports.withDbTransaction = withDbTransaction;
