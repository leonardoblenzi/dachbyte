"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isStoredChannelManagedFreight = exports.isExcludedPlatformFreight = exports.shouldSkipPlatformOrderImport = exports.normalizeExcludedPlatformFreight = exports.shouldApplyChannelLogisticsRules = exports.normalizeCarrierExceptionList = void 0;
const normalizeFreightText = (freightType) => String(freightType || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
const DEFAULT_IMPORT_EXCEPTION_ALIASES = [
    'retirada normal na agencia',
    'retirada na agencia',
];
const normalizeCarrierExceptionList = (value) => {
    if (!Array.isArray(value))
        return [];
    return Array.from(new Set(value
        .map((item) => normalizeFreightText(String(item || '')))
        .filter(Boolean)));
};
exports.normalizeCarrierExceptionList = normalizeCarrierExceptionList;
const shouldApplyChannelLogisticsRules = (companyName) => false;
exports.shouldApplyChannelLogisticsRules = shouldApplyChannelLogisticsRules;
const normalizeExcludedPlatformFreight = (freightType, companyName) => null;
exports.normalizeExcludedPlatformFreight = normalizeExcludedPlatformFreight;
const shouldSkipPlatformOrderImport = ({ freightType, carrierExceptions, }) => {
    const normalized = normalizeFreightText(freightType);
    if (!normalized)
        return false;
    const normalizedExceptions = new Set([
        ...DEFAULT_IMPORT_EXCEPTION_ALIASES,
        ...(0, exports.normalizeCarrierExceptionList)(carrierExceptions),
    ]);
    return normalizedExceptions.has(normalized);
};
exports.shouldSkipPlatformOrderImport = shouldSkipPlatformOrderImport;
const isExcludedPlatformFreight = (freightType, companyName) => false;
exports.isExcludedPlatformFreight = isExcludedPlatformFreight;
const isStoredChannelManagedFreight = (freightType, companyName) => false;
exports.isStoredChannelManagedFreight = isStoredChannelManagedFreight;
