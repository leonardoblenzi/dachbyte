"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_events_1 = require("node:events");
const node_test_1 = __importDefault(require("node:test"));
(0, node_test_1.default)('keeps the process alive when PostgreSQL closes an idle pool connection', async () => {
    process.env.AVANTRACKING_DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    const { attachPoolErrorHandler } = await import('../lib/db.js');
    const pool = new node_events_1.EventEmitter();
    attachPoolErrorHandler(pool);
    strict_1.default.doesNotThrow(() => {
        pool.emit('error', Object.assign(new Error('terminating connection due to administrator command'), {
            code: '57P01',
        }));
    });
});
