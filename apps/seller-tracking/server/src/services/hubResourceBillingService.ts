type HubResourceBillingMode = 'off' | 'monitor' | 'enforce';

type TrackingResourceInput = {
  tenantId?: string | null;
  companyId?: string | number | null;
  companyName?: string | null;
  status?: string | null;
  billingMode?: string | null;
  rangeEnforcement?: boolean | null;
  planCode?: string | null;
  orderRangeCode?: string | null;
  lastClosedPeriodOrders?: number | null;
};

type HubResourceAccess = {
  allow: boolean;
  reason?: string | null;
  status?: string | null;
  requires_subscription?: boolean;
  requires_upgrade?: boolean;
  billing_context?: Record<string, unknown>;
};

const DEFAULT_TIMEOUT_MS = 5000;
const MODULE_SLUG = 'tracking';
const DEFAULT_PLAN_CODE = 'tracking_pro';
const DEFAULT_RANGE_CODE = 'up_to_200';
const DISABLED_VALUES = new Set(['', '0', 'false', 'off', 'none', 'disabled', 'null', 'undefined']);

class HubResourceBillingError extends Error {
  statusCode: number;
  code: string;
  details: unknown;

  constructor(message: string, options: { statusCode?: number; code?: string; details?: unknown } = {}) {
    super(message);
    this.name = 'HubResourceBillingError';
    this.statusCode = options.statusCode || 503;
    this.code = options.code || 'hub_resource_billing_error';
    this.details = options.details || null;
  }
}

const normalizeConfigValue = (value: unknown) => {
  const normalized = String(value ?? '').trim();
  return DISABLED_VALUES.has(normalized.toLowerCase()) ? '' : normalized;
};

const billingMode = (): HubResourceBillingMode => {
  const value = String(process.env.HUB_RESOURCE_BILLING_MODE || 'monitor')
    .trim()
    .toLowerCase();
  if (['off', 'disabled', 'legacy'].includes(value)) return 'off';
  if (['strict', 'enforce', 'enabled'].includes(value)) return 'enforce';
  return 'monitor';
};

const hubConfig = () => ({
  baseUrl: normalizeConfigValue(process.env.HUB_BASE_URL).replace(/\/+$/, ''),
  token: normalizeConfigValue(process.env.HUB_INTERNAL_TOKEN),
});

const parseResponseBody = (text: string) => {
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const requestHub = async (
  method: string,
  pathname: string,
  payload: Record<string, unknown> | null = null,
) => {
  const config = hubConfig();
  if (!config.baseUrl || !config.token) {
    throw new HubResourceBillingError('Hub de billing nao configurado.', {
      code: 'hub_billing_not_configured',
    });
  }

  const fetchRef = (globalThis as any).fetch;
  if (typeof fetchRef !== 'function') {
    throw new HubResourceBillingError('fetch_not_available', { code: 'fetch_not_available' });
  }

  const timeoutMs = Math.max(500, Number(process.env.HUB_REQUEST_TIMEOUT_MS || DEFAULT_TIMEOUT_MS));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchRef(`${config.baseUrl}${pathname}`, {
      method,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${config.token}`,
      },
      body: payload === null ? undefined : JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      data: parseResponseBody(text),
    };
  } finally {
    clearTimeout(timer);
  }
};

const responseError = (response: { status: number; data: Record<string, unknown> }, fallbackMessage: string) => {
  const code = String(response?.data?.error || response?.data?.reason || 'hub_resource_billing_request_failed');
  return new HubResourceBillingError(fallbackMessage, {
    statusCode: Number(response?.status || 503),
    code,
    details: response?.data || null,
  });
};

const buildTrackingResourceContext = (input: TrackingResourceInput) => {
  const tenantId = String(input.tenantId || '').trim();
  const externalAccountId = tenantId || `tracking_company_${String(input.companyId || '').trim()}`;
  return {
    tenantId,
    moduleSlug: MODULE_SLUG,
    accountId: externalAccountId,
    label: String(input.companyName || externalAccountId || 'Rastreio').trim(),
    status: String(input.status || 'legacy_active').trim(),
    billingMode: String(input.billingMode || 'legacy').trim(),
    usagePolicy: 'unlimited',
    rangeEnforcement: Boolean(input.rangeEnforcement),
    planCode: input.planCode || DEFAULT_PLAN_CODE,
    orderRangeCode: input.orderRangeCode || DEFAULT_RANGE_CODE,
    lastClosedPeriodOrders: input.lastClosedPeriodOrders ?? null,
  };
};

export const syncTrackingResource = async (input: TrackingResourceInput) => {
  const mode = billingMode();
  if (mode === 'off') return { bypass: true, reason: 'billing_off' };

  const context = buildTrackingResourceContext(input);
  if (!context.tenantId || !context.accountId) {
    throw new HubResourceBillingError('Empresa sem identidade global para billing do Rastreio.', {
      statusCode: 409,
      code: 'billing_identity_missing',
    });
  }

  try {
    const response = await requestHub('POST', '/v1/internal/resources/sync', {
      tenant_id: context.tenantId,
      module_slug: MODULE_SLUG,
      account_id: context.accountId,
      label: context.label,
      status: context.status,
      billing_mode: context.billingMode,
      usage_policy: 'unlimited',
      range_enforcement: context.rangeEnforcement,
      plan_code: context.planCode,
      order_range_code: context.orderRangeCode,
      metadata: { tracking_company_id: input.companyId || null },
    });
    if (!response.ok) throw responseError(response, 'Nao foi possivel sincronizar o Rastreio com o Hub.');
    return { context, resource: response.data?.resource || null, bypass: false };
  } catch (error: any) {
    if (mode === 'monitor') {
      console.warn('[tracking.billing] sync em modo monitor:', error?.code || error?.message || error);
      return { context, bypass: true, reason: error?.code || 'monitor_bypass' };
    }
    throw error;
  }
};

export const checkTrackingResourceAccess = async (
  input: TrackingResourceInput,
): Promise<HubResourceAccess> => {
  const mode = billingMode();
  if (mode === 'off') return { allow: true, reason: 'billing_off' };

  const context = buildTrackingResourceContext(input);
  try {
    await syncTrackingResource(input);
    const response = await requestHub('POST', '/v1/internal/resources/access', {
      module_slug: MODULE_SLUG,
      account_id: context.accountId,
    });
    if (!response.ok) throw responseError(response, 'Nao foi possivel validar acesso do Rastreio no Hub.');
    const access = (response.data?.access || response.data || {}) as HubResourceAccess;
    if (access.allow === false && mode === 'monitor') {
      return { ...access, allow: true, reason: access.reason || 'hub_denied_monitor', billing_context: context };
    }
    return { ...access, allow: access.allow !== false, billing_context: context };
  } catch (error: any) {
    if (mode === 'monitor') {
      console.warn('[tracking.billing] access em modo monitor:', error?.code || error?.message || error);
      return { allow: true, reason: error?.code || 'monitor_bypass', billing_context: context };
    }
    throw error;
  }
};

export { HubResourceBillingError, buildTrackingResourceContext };
