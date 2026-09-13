"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const trayAuthService_js_1 = require("../services/trayAuthService.js");
(0, node_test_1.default)('preserves the Tray HTTP response when a refresh token request fails', () => {
    const message = (0, trayAuthService_js_1.formatTrayRefreshFailure)({
        response: {
            status: 400,
            data: {
                message: 'Refresh token invalido ou expirado.',
                code: '1099',
            },
        },
    });
    strict_1.default.equal(message, 'Tray recusou a renovacao do token (HTTP 400, codigo 1099): Refresh token invalido ou expirado.');
});
