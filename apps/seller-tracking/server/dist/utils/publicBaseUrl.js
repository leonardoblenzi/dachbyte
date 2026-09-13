"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPublicBaseUrl = void 0;
const REPORT_BASE_ENV_KEYS = [
    'REPORTS_BASE_URL',
    'RENDER_EXTERNAL_URL',
    'BACKEND_URL',
    'API_BASE_URL',
    'APP_BASE_URL',
    'FRONTEND_URL',
];
const normalizeBaseUrl = (value) => value.trim().replace(/\/+$/, '');
const getConfiguredBasePath = () => process.env.APP_BASE_PATH || process.env.AVANTRACKING_BASE_PATH || '';
const normalizeBasePath = (value) => {
    const normalized = String(value || '').trim();
    if (!normalized) {
        return '';
    }
    const withLeadingSlash = normalized.startsWith('/')
        ? normalized
        : `/${normalized}`;
    return withLeadingSlash.replace(/\/+$/, '');
};
const appendBasePath = (value) => {
    const normalizedBaseUrl = normalizeBaseUrl(value);
    const basePath = normalizeBasePath(getConfiguredBasePath());
    if (!basePath || normalizedBaseUrl.endsWith(basePath)) {
        return normalizedBaseUrl;
    }
    return `${normalizedBaseUrl}${basePath}`;
};
const getPublicBaseUrl = () => {
    for (const envKey of REPORT_BASE_ENV_KEYS) {
        const configuredBaseUrl = appendBasePath(String(process.env[envKey] || ''));
        if (configuredBaseUrl) {
            return configuredBaseUrl;
        }
    }
    return appendBasePath(`http://localhost:${process.env.PORT || '3000'}`);
};
exports.getPublicBaseUrl = getPublicBaseUrl;
