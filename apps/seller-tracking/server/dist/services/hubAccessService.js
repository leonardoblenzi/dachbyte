"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyHubGlobalLogin = exports.evaluateHubLoginAccess = exports.revokeHubModuleIdentity = exports.syncHubModuleIdentity = void 0;
const DEFAULT_TIMEOUT_MS = 5000;
const HUB_DISABLED_VALUES = new Set([
    '',
    '0',
    'false',
    'null',
    'undefined',
    'off',
    'none',
    'disabled',
    '(not set)',
]);
const normalizeHubConfigValue = (raw) => {
    const value = String(raw ?? '').trim();
    if (!value)
        return '';
    if (HUB_DISABLED_VALUES.has(value.toLowerCase()))
        return '';
    return value;
};
const normalizeEnforcement = () => {
    const raw = String(process.env.HUB_AUTH_MODE || process.env.HUB_ENFORCEMENT || 'hybrid')
        .trim()
        .toLowerCase();
    if (raw === 'off' || raw === 'disabled' || raw === 'legacy')
        return 'off';
    if (raw === 'mirror' || raw === 'sync')
        return 'mirror';
    if (raw === 'hybrid')
        return 'hybrid';
    if (raw === 'monitor' || raw === 'warn')
        return 'monitor';
    return 'strict';
};
const isHubLoginFallbackEnabled = () => {
    const mode = String(process.env.HUB_LOGIN_MODE || 'fallback')
        .trim()
        .toLowerCase();
    return mode === 'fallback' || mode === 'mirror';
};
const normalizeEmail = (value) => String(value || '')
    .trim()
    .toLowerCase();
const normalizeDocumentType = (value) => {
    const normalized = String(value || '')
        .trim()
        .toUpperCase();
    if (normalized === 'CPF' || normalized === 'CNPJ')
        return normalized;
    return null;
};
const normalizeDocumentNumber = (value) => {
    const digits = String(value || '').replace(/\D/g, '');
    return digits || null;
};
const parseResponseBody = (text) => {
    if (!text)
        return {};
    try {
        return JSON.parse(text);
    }
    catch {
        return {};
    }
};
const postJson = async (url, token, payload) => {
    const fetchRef = globalThis.fetch;
    if (typeof fetchRef !== 'function') {
        throw new Error('fetch_not_available');
    }
    const timeoutMs = Number(process.env.HUB_REQUEST_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS);
    try {
        const response = await fetchRef(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        const text = await response.text();
        return {
            ok: response.ok,
            status: response.status,
            data: parseResponseBody(text),
        };
    }
    finally {
        clearTimeout(timer);
    }
};
const buildIdentity = (input) => {
    const user = input.user;
    const company = input.company || null;
    if (!user?.id || !user?.email) {
        return { ok: false, reason: 'identity_user_missing' };
    }
    if (!company?.id) {
        if (user.isSuperAdmin) {
            return { ok: true, bypass: true, reason: 'super_admin_bypass_without_company' };
        }
        return { ok: false, reason: 'identity_company_missing' };
    }
    const tenantGlobalId = String(company.tenantGlobalId || '').trim();
    const tenantId = tenantGlobalId || `tracking_company_${company.id}`;
    const companyName = String(company.name || '').trim();
    const userId = `tracking_user_${user.id}`;
    const fullName = String(user.name || '').trim() || normalizeEmail(user.email);
    const email = normalizeEmail(user.email);
    if (!tenantId || !companyName || !userId || !fullName || !email) {
        return { ok: false, reason: 'identity_required_fields_missing' };
    }
    return {
        ok: true,
        payload: {
            tenant_id: tenantId,
            company_name: companyName,
            document_type: normalizeDocumentType(company.documentType),
            document_number: normalizeDocumentNumber(company.documentNumber),
            user_id: userId,
            full_name: fullName,
            email,
            role: String(user.role || 'member').toLowerCase(),
            module: input.moduleSlug,
            modules: [input.moduleSlug],
        },
    };
};
const syncHubModuleIdentity = async (input, options = {}) => {
    const hubBaseUrl = normalizeHubConfigValue(process.env.HUB_BASE_URL).replace(/\/+$/, '');
    const hubToken = normalizeHubConfigValue(process.env.HUB_INTERNAL_TOKEN);
    if (!hubBaseUrl || !hubToken) {
        return { ok: false, skipped: true, reason: 'hub_not_configured' };
    }
    const identity = buildIdentity(input);
    if (!identity.ok || identity.bypass) {
        return { ok: false, skipped: true, reason: identity.reason || 'identity_not_ready' };
    }
    try {
        const response = await postJson(`${hubBaseUrl}/v1/internal/identity/sync`, hubToken, {
            ...identity.payload,
            access_policy: options.explicit ? 'explicit' : null,
        });
        return response.ok
            ? { ok: true, skipped: false, payload: response.data }
            : { ok: false, skipped: false, reason: response.data?.error || 'hub_identity_sync_failed' };
    }
    catch (error) {
        return { ok: false, skipped: false, reason: error?.message || 'hub_unreachable' };
    }
};
exports.syncHubModuleIdentity = syncHubModuleIdentity;
const revokeHubModuleIdentity = async (input) => {
    const hubBaseUrl = normalizeHubConfigValue(process.env.HUB_BASE_URL).replace(/\/+$/, '');
    const hubToken = normalizeHubConfigValue(process.env.HUB_INTERNAL_TOKEN);
    if (!hubBaseUrl || !hubToken) {
        return { ok: false, skipped: true, reason: 'hub_not_configured' };
    }
    const identity = buildIdentity(input);
    if (!identity.ok || identity.bypass) {
        return { ok: false, skipped: true, reason: identity.reason || 'identity_not_ready' };
    }
    try {
        const response = await postJson(`${hubBaseUrl}/v1/internal/identity/module-access/revoke`, hubToken, {
            tenant_id: identity.payload.tenant_id,
            user_id: identity.payload.user_id,
            email: identity.payload.email,
            module: input.moduleSlug,
            note: `Usuario removido no modulo ${input.moduleSlug}`,
        });
        return response.ok
            ? { ok: true, skipped: false, payload: response.data }
            : { ok: false, skipped: false, reason: response.data?.error || 'hub_module_revoke_failed' };
    }
    catch (error) {
        return { ok: false, skipped: false, reason: error?.message || 'hub_unreachable' };
    }
};
exports.revokeHubModuleIdentity = revokeHubModuleIdentity;
const evaluateHubLoginAccess = async (input) => {
    const enforcement = normalizeEnforcement();
    if (enforcement === 'off') {
        return { allow: true, reason: 'hub_enforcement_off' };
    }
    const hubBaseUrl = normalizeHubConfigValue(process.env.HUB_BASE_URL).replace(/\/+$/, '');
    const hubToken = normalizeHubConfigValue(process.env.HUB_INTERNAL_TOKEN);
    const strict = enforcement === 'strict';
    const enforceHubDecision = enforcement === 'strict' || enforcement === 'hybrid';
    const mirrorOnly = enforcement === 'mirror';
    if (!hubBaseUrl || !hubToken) {
        return { allow: true, reason: 'hub_not_configured' };
    }
    const identity = buildIdentity(input);
    if (!identity.ok) {
        if (identity.bypass) {
            return { allow: true, reason: identity.reason || 'hub_bypass' };
        }
        if (!strict) {
            return { allow: true, reason: identity.reason || 'identity_not_ready_monitor' };
        }
        return {
            allow: false,
            reason: identity.reason || 'identity_not_ready',
            message: 'Identidade da conta nao esta configurada para validacao no Hub.',
        };
    }
    try {
        const syncResponse = await postJson(`${hubBaseUrl}/v1/internal/identity/sync`, hubToken, identity.payload);
        if (!syncResponse.ok && (syncResponse.status === 401 || syncResponse.status === 403)) {
            return { allow: true, reason: 'hub_auth_invalid_bypass' };
        }
        if (!syncResponse.ok && strict) {
            return {
                allow: false,
                reason: 'hub_identity_sync_failed',
                message: 'Nao foi possivel validar identidade da conta no Hub.',
            };
        }
        if (mirrorOnly) {
            return { allow: true, reason: syncResponse.ok ? 'hub_identity_synced_mirror' : 'hub_identity_sync_failed_mirror' };
        }
        const syncedIdentity = syncResponse.ok ? syncResponse.data || {} : {};
        const effectiveTenantId = String(syncedIdentity.tenant_id || identity.payload.tenant_id).trim();
        const effectiveUserId = String(syncedIdentity.user_id || identity.payload.user_id).trim();
        const checkResponse = await postJson(`${hubBaseUrl}/v1/access/check`, hubToken, {
            tenant_id: effectiveTenantId,
            user_id: effectiveUserId,
            module: input.moduleSlug,
            action: 'login',
        });
        if (!checkResponse.ok) {
            if (checkResponse.status === 401 || checkResponse.status === 403) {
                return { allow: true, reason: 'hub_auth_invalid_bypass' };
            }
            if (strict) {
                return {
                    allow: false,
                    reason: 'hub_access_check_failed',
                    message: 'Nao foi possivel validar permissao de acesso no Hub.',
                };
            }
            return { allow: true, reason: 'hub_access_check_failed_monitor' };
        }
        const data = checkResponse.data || {};
        if (!data.allow && !enforceHubDecision) {
            return { allow: true, reason: data.reason || 'hub_denied_monitor', message: data.message || null };
        }
        return {
            allow: Boolean(data.allow),
            reason: data.reason || (data.allow ? 'ok' : 'hub_denied'),
            message: data.message || null,
            status: data.status || null,
            tenant_status: data.tenant_status || null,
        };
    }
    catch (error) {
        if (!strict) {
            return { allow: true, reason: 'hub_unreachable_monitor' };
        }
        return {
            allow: false,
            reason: 'hub_unreachable',
            message: 'Hub indisponivel no momento para validar o acesso.',
            detail: error instanceof Error ? error.message : String(error || 'unknown_error'),
        };
    }
};
exports.evaluateHubLoginAccess = evaluateHubLoginAccess;
const verifyHubGlobalLogin = async (input) => {
    if (!isHubLoginFallbackEnabled()) {
        return { allow: false, reason: 'hub_login_disabled' };
    }
    const hubBaseUrl = normalizeHubConfigValue(process.env.HUB_BASE_URL).replace(/\/+$/, '');
    const hubToken = normalizeHubConfigValue(process.env.HUB_INTERNAL_TOKEN);
    if (!hubBaseUrl || !hubToken) {
        return { allow: false, reason: 'hub_not_configured' };
    }
    try {
        const response = await postJson(`${hubBaseUrl}/v1/internal/auth/verify`, hubToken, {
            email: normalizeEmail(input.email),
            password: String(input.password || ''),
            module: input.moduleSlug,
        });
        if (!response.ok) {
            return {
                allow: false,
                reason: response.data?.reason || response.data?.error || `hub_auth_${response.status}`,
            };
        }
        return response.data?.allow
            ? { allow: true, reason: 'ok', payload: response.data }
            : { allow: false, reason: response.data?.reason || 'hub_denied', payload: response.data };
    }
    catch (error) {
        return { allow: false, reason: error?.message || 'hub_unreachable' };
    }
};
exports.verifyHubGlobalLogin = verifyHubGlobalLogin;
