"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const integrationHealthPolicy_js_1 = require("../services/integrationHealthPolicy.js");
(0, node_test_1.default)('preserves the selected company only for the configured master administrator', () => {
    strict_1.default.equal((0, integrationHealthPolicy_js_1.shouldPreserveMasterCompanySelection)(' CADASTRO6@DROSSIINTERIORES.COM.BR ', 'cadastro6@drossiinteriores.com.br'), true);
    strict_1.default.equal((0, integrationHealthPolicy_js_1.shouldPreserveMasterCompanySelection)('user@drossiinteriores.com.br', 'cadastro6@drossiinteriores.com.br'), false);
});
(0, node_test_1.default)('reports only enabled integrations that are missing their required settings', () => {
    const issues = (0, integrationHealthPolicy_js_1.evaluateIntegrationConfiguration)({
        trayIntegrationEnabled: true,
        hasTrayAuth: false,
        anymarketIntegrationEnabled: true,
        anymarketToken: '',
        magazordIntegrationEnabled: true,
        magazordApiBaseUrl: 'https://api.magazord.example',
        magazordApiUser: '',
        magazordApiPassword: '',
        jetIntegrationEnabled: true,
        jetIntegrationKey: '',
        intelipostIntegrationEnabled: true,
        intelipostClientId: '',
        intelipostApiKey: '',
        sswRequireEnabled: true,
        sswRequireCnpjs: [],
        correiosIntegrationEnabled: true,
    });
    strict_1.default.deepEqual(issues.map((issue) => issue.code), [
        'TRAY_RECONNECT_REQUIRED',
        'ANYMARKET_TOKEN_MISSING',
        'MAGAZORD_CREDENTIALS_MISSING',
        'JET_API_KEY_MISSING',
        'INTELIPOST_CREDENTIALS_MISSING',
        'SSW_CNPJ_MISSING',
    ]);
});
(0, node_test_1.default)('does not report disabled integrations or configured integrations', () => {
    const issues = (0, integrationHealthPolicy_js_1.evaluateIntegrationConfiguration)({
        trayIntegrationEnabled: false,
        hasTrayAuth: false,
        anymarketIntegrationEnabled: false,
        anymarketToken: '',
        magazordIntegrationEnabled: false,
        jetIntegrationEnabled: false,
        intelipostIntegrationEnabled: false,
        sswRequireEnabled: false,
    });
    strict_1.default.deepEqual(issues, []);
});
