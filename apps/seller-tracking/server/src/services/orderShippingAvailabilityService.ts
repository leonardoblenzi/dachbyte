export type ShippingDeadlineDayMode = 'BUSINESS' | 'CALENDAR' | 'UNKNOWN';

export type ProductAvailabilitySnapshot = {
  productRef: string;
  days: number;
  mode: ShippingDeadlineDayMode;
  source: string;
};

export type ShippingAvailabilityResolution = {
  maxDays: number | null;
  mode: ShippingDeadlineDayMode;
  sendDate: Date | null;
  items: ProductAvailabilitySnapshot[];
};

export type IntegrationProductReference = {
  productRef: string;
};

const BUSINESS_DAY_PATTERNS = [
  'DIAS UTEIS',
  'DIAS ÚTEIS',
  'BUSINESS DAY',
  'WORKING DAY',
];

const CALENDAR_DAY_PATTERNS = ['DIAS CORRIDOS', 'CALENDAR DAY'];

const BRAZIL_FIXED_HOLIDAYS = new Set([
  '01-01', // Confraternizacao Universal
  '04-21', // Tiradentes
  '05-01', // Dia do Trabalho
  '09-07', // Independencia do Brasil
  '10-12', // Nossa Senhora Aparecida
  '11-02', // Finados
  '11-15', // Proclamacao da Republica
  '11-20', // Dia da Consciencia Negra
  '12-25', // Natal
]);

const EXTRA_HOLIDAY_TOKENS = String(process.env.SHIPPING_BUSINESS_HOLIDAYS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const yearHolidayCache = new Map<number, Set<string>>();

const normalizeText = (value: unknown) =>
  String(value || '')
    .trim()
    .toUpperCase();

const toPositiveInteger = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const normalized = String(value).replace(/[^\d-]/g, '').trim();
  if (!normalized) return null;

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 365) {
    return null;
  }

  return parsed;
};

const inferModeFromText = (value: unknown): ShippingDeadlineDayMode => {
  const normalized = normalizeText(value);
  if (!normalized) return 'UNKNOWN';

  if (BUSINESS_DAY_PATTERNS.some((token) => normalized.includes(token))) {
    return 'BUSINESS';
  }

  if (CALENDAR_DAY_PATTERNS.some((token) => normalized.includes(token))) {
    return 'CALENDAR';
  }

  return 'UNKNOWN';
};

const readPathValue = (payload: any, path: string) => {
  const parts = path.split('.');
  let current = payload;

  for (const part of parts) {
    if (!current || typeof current !== 'object') {
      return null;
    }
    current = current[part];
  }

  return current;
};

const pickFirstPositive = (payload: any, paths: string[]) => {
  for (const path of paths) {
    const value = readPathValue(payload, path);
    const parsed = toPositiveInteger(value);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
};

const inferModeFromPayload = (
  payload: any,
  fallback: ShippingDeadlineDayMode,
): ShippingDeadlineDayMode => {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }

  const businessFlags = [
    payload.businessDays,
    payload.isBusinessDays,
    payload.useBusinessDays,
    payload.workingDays,
  ];
  if (businessFlags.some((flag) => flag === true)) {
    return 'BUSINESS';
  }

  const calendarFlags = [
    payload.calendarDays,
    payload.isCalendarDays,
    payload.useCalendarDays,
  ];
  if (calendarFlags.some((flag) => flag === true)) {
    return 'CALENDAR';
  }

  const modeCandidates = [
    payload.deadlineMode,
    payload.deadlineType,
    payload.availabilityMode,
    payload.shippingMode,
    payload.information,
    payload.description,
    payload.name,
    payload.note,
  ];

  for (const candidate of modeCandidates) {
    const inferred = inferModeFromText(candidate);
    if (inferred !== 'UNKNOWN') {
      return inferred;
    }
  }

  return fallback;
};

const toDateKey = (value: Date) => {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const toMonthDayKey = (value: Date) =>
  `${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;

const easterSunday = (year: number) => {
  // Computus (algoritmo gregoriano)
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=mar, 4=abr
  const day = ((h + l - 7 * m + 114) % 31) + 1;

  return new Date(year, month - 1, day, 12, 0, 0, 0);
};

const shiftDays = (baseDate: Date, days: number) => {
  const next = new Date(baseDate);
  next.setDate(next.getDate() + days);
  return next;
};

const buildHolidaySetForYear = (year: number) => {
  const keys = new Set<string>();

  for (const monthDay of BRAZIL_FIXED_HOLIDAYS) {
    keys.add(`${year}-${monthDay}`);
  }

  const easter = easterSunday(year);
  const movableHolidays = [
    shiftDays(easter, -48), // Carnaval (segunda)
    shiftDays(easter, -47), // Carnaval (terca)
    shiftDays(easter, -2), // Sexta-feira Santa
    shiftDays(easter, 60), // Corpus Christi
  ];

  for (const date of movableHolidays) {
    keys.add(toDateKey(date));
  }

  for (const token of EXTRA_HOLIDAY_TOKENS) {
    const fullDateMatch = token.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (fullDateMatch) {
      if (Number(fullDateMatch[1]) === year) {
        keys.add(token);
      }
      continue;
    }

    const monthDayMatch = token.match(/^(\d{2})-(\d{2})$/);
    if (monthDayMatch) {
      keys.add(`${year}-${token}`);
    }
  }

  return keys;
};

const isHoliday = (value: Date) => {
  const year = value.getFullYear();
  let holidaySet = yearHolidayCache.get(year);
  if (!holidaySet) {
    holidaySet = buildHolidaySetForYear(year);
    yearHolidayCache.set(year, holidaySet);
  }

  const fullDateKey = toDateKey(value);
  if (holidaySet.has(fullDateKey)) {
    return true;
  }

  const monthDayKey = toMonthDayKey(value);
  return BRAZIL_FIXED_HOLIDAYS.has(monthDayKey);
};

const isBusinessDay = (value: Date) => {
  const weekDay = value.getDay();
  if (weekDay === 0 || weekDay === 6) {
    return false;
  }
  return !isHoliday(value);
};

const addBusinessDays = (baseDate: Date, businessDays: number) => {
  const next = new Date(baseDate);
  next.setHours(12, 0, 0, 0);

  let remaining = businessDays;
  while (remaining > 0) {
    next.setDate(next.getDate() + 1);
    if (isBusinessDay(next)) {
      remaining -= 1;
    }
  }

  return next;
};

const addCalendarDays = (baseDate: Date, calendarDays: number) => {
  const next = new Date(baseDate);
  next.setHours(12, 0, 0, 0);
  next.setDate(next.getDate() + calendarDays);
  return next;
};

const buildResolution = (
  items: ProductAvailabilitySnapshot[],
  baseDate: Date,
): ShippingAvailabilityResolution => {
  if (items.length === 0) {
    return {
      maxDays: null,
      mode: 'UNKNOWN',
      sendDate: null,
      items: [],
    };
  }

  const maxDays = Math.max(...items.map((item) => item.days));
  const modePriority: ShippingDeadlineDayMode =
    items.some((item) => item.mode === 'BUSINESS')
      ? 'BUSINESS'
      : items.some((item) => item.mode === 'CALENDAR')
        ? 'CALENDAR'
        : 'UNKNOWN';
  const resolvedMode: ShippingDeadlineDayMode =
    modePriority === 'UNKNOWN' ? 'CALENDAR' : modePriority;

  const sendDate =
    resolvedMode === 'BUSINESS'
      ? addBusinessDays(baseDate, maxDays)
      : addCalendarDays(baseDate, maxDays);

  return {
    maxDays,
    mode: resolvedMode,
    sendDate,
    items,
  };
};

const buildSnapshot = (input: {
  productRef: string;
  days: number | null;
  mode: ShippingDeadlineDayMode;
  source: string;
}) => {
  if (input.days === null) return null;

  return {
    productRef: input.productRef,
    days: input.days,
    mode: input.mode,
    source: input.source,
  } as ProductAvailabilitySnapshot;
};

const resolveAnymarketAdditionalTimeFromProductPayload = (
  payload: any,
  productRef: string,
) => {
  const fromTopLevel = pickFirstPositive(payload, [
    'additionalTime',
    'additional_time',
    'availabilityDays',
    'availability_days',
    'shipping.additionalTime',
    'shipping.additional_time',
    'product.additionalTime',
    'product.additional_time',
    'sku.additionalTime',
    'sku.additional_time',
  ]);
  if (fromTopLevel !== null) {
    return fromTopLevel;
  }

  const skus = Array.isArray(payload?.skus) ? payload.skus : [];
  if (skus.length === 0) {
    return null;
  }

  const normalizedRef = normalizeText(productRef);
  const matchedSku = skus.find((sku: any) => {
    const candidates = [
      sku?.id,
      sku?.partnerId,
      sku?.externalId,
      sku?.idInMarketplace,
    ]
      .map((value) => normalizeText(value))
      .filter(Boolean);
    return candidates.includes(normalizedRef);
  });

  if (matchedSku) {
    return pickFirstPositive(matchedSku, [
      'additionalTime',
      'additional_time',
      'availabilityDays',
      'availability_days',
    ]);
  }

  const skuDays = skus
    .map((sku: any) =>
      pickFirstPositive(sku, [
        'additionalTime',
        'additional_time',
        'availabilityDays',
        'availability_days',
      ]),
    )
    .filter((value): value is number => value !== null);

  if (skuDays.length === 0) {
    return null;
  }

  return Math.max(...skuDays);
};

const resolveAnymarketItems = (orderPayload: any) => {
  const items = Array.isArray(orderPayload?.items) ? orderPayload.items : [];

  return items.map((item: any, index: number) => {
    const skuId = readPathValue(item, 'sku.id');
    const skuPartnerId = readPathValue(item, 'sku.partnerId');
    const productId = readPathValue(item, 'product.id');
    const productRef = String(
      skuId || skuPartnerId || productId || `item_${index + 1}`,
    );

    const days = pickFirstPositive(item, [
      'additionalTime',
      'additional_time',
      'availabilityDays',
      'availability_days',
      'shipping.additionalTime',
      'shipping.additional_time',
      'product.additionalTime',
      'product.additional_time',
      'product.availabilityDays',
      'product.availability_days',
      'sku.additionalTime',
      'sku.additional_time',
      'sku.availabilityDays',
      'sku.availability_days',
    ]);

    const mode = inferModeFromPayload(item, 'CALENDAR');
    return buildSnapshot({
      productRef,
      days,
      mode,
      source: 'anymarket-order-items',
    });
  });
};

const resolveTrayItems = (orderPayload: any) => {
  const productNodes: any[] = [];

  const productsSold = Array.isArray(orderPayload?.ProductsSold)
    ? orderPayload.ProductsSold
    : [];
  for (const entry of productsSold) {
    productNodes.push(entry?.ProductsSold || entry);
  }

  const orderItems = Array.isArray(orderPayload?.OrderItems)
    ? orderPayload.OrderItems
    : [];
  for (const entry of orderItems) {
    productNodes.push(entry?.OrderItem || entry);
  }

  const fallbackItems = Array.isArray(orderPayload?.items) ? orderPayload.items : [];
  for (const entry of fallbackItems) {
    productNodes.push(entry);
  }

  return productNodes.map((item: any, index: number) => {
    const productRef = String(
      item?.product_id || item?.id || item?.code || `item_${index + 1}`,
    );

    const days = pickFirstPositive(item, [
      'availability_days',
      'availabilityDays',
      'release_days',
      'releaseDays',
      'days_to_availability',
      'production_days',
      'dispatch_days',
      'deadline',
      'additional_days',
      'additionalDays',
    ]);

    const mode = inferModeFromPayload(item, 'BUSINESS');

    return buildSnapshot({
      productRef,
      days,
      mode,
      source: 'tray-order-items',
    });
  });
};

export const extractAnymarketProductReferences = (
  orderPayload: any,
): IntegrationProductReference[] => {
  const items = Array.isArray(orderPayload?.items) ? orderPayload.items : [];
  const refs: string[] = [];

  for (const item of items) {
    const candidates = [item?.sku?.id, item?.sku?.partnerId, item?.product?.id, item?.id];
    for (const candidate of candidates) {
      const value = String(candidate || '').trim();
      if (value) {
        refs.push(value);
      }
    }
  }

  return Array.from(new Set(refs)).map((productRef) => ({ productRef }));
};

export const extractTrayProductReferences = (
  orderPayload: any,
): IntegrationProductReference[] => {
  const refs: string[] = [];

  const productsSold = Array.isArray(orderPayload?.ProductsSold)
    ? orderPayload.ProductsSold
    : [];
  for (const entry of productsSold) {
    const node = entry?.ProductsSold || entry;
    const ref = String(node?.product_id || node?.id || '').trim();
    if (ref) refs.push(ref);
  }

  const orderItems = Array.isArray(orderPayload?.OrderItems)
    ? orderPayload.OrderItems
    : [];
  for (const entry of orderItems) {
    const node = entry?.OrderItem || entry;
    const ref = String(node?.product_id || node?.id || '').trim();
    if (ref) refs.push(ref);
  }

  const fallbackItems = Array.isArray(orderPayload?.items) ? orderPayload.items : [];
  for (const entry of fallbackItems) {
    const ref = String(entry?.product_id || entry?.id || '').trim();
    if (ref) refs.push(ref);
  }

  return Array.from(new Set(refs)).map((productRef) => ({ productRef }));
};

export const resolveOrderShippingAvailabilityFromAnymarket = (
  orderPayload: any,
  baseDate: Date,
): ShippingAvailabilityResolution =>
  buildResolution(
    resolveAnymarketItems(orderPayload).filter(Boolean) as ProductAvailabilitySnapshot[],
    baseDate,
  );

export const resolveOrderShippingAvailabilityFromTray = (
  orderPayload: any,
  baseDate: Date,
): ShippingAvailabilityResolution =>
  buildResolution(
    resolveTrayItems(orderPayload).filter(Boolean) as ProductAvailabilitySnapshot[],
    baseDate,
  );

export const resolveOrderShippingAvailabilityFromProductPayloads = (
  inputs: Array<{
    productRef: string;
    payload: any;
    integration: 'ANYMARKET' | 'TRAY';
  }>,
  baseDate: Date,
): ShippingAvailabilityResolution => {
  const snapshots: ProductAvailabilitySnapshot[] = [];

  for (const input of inputs) {
    const payload = input.payload;

    const days =
      input.integration === 'ANYMARKET'
        ? resolveAnymarketAdditionalTimeFromProductPayload(payload, input.productRef)
        : pickFirstPositive(payload, [
            'availability_days',
            'availabilityDays',
            'release_days',
            'releaseDays',
            'days_to_availability',
            'production_days',
            'dispatch_days',
            'deadline',
          ]);

    const mode = inferModeFromPayload(
      payload,
      input.integration === 'TRAY' ? 'BUSINESS' : 'CALENDAR',
    );

    const snapshot = buildSnapshot({
      productRef: input.productRef,
      days,
      mode,
      source: `${input.integration.toLowerCase()}-products-api`,
    });

    if (snapshot) {
      snapshots.push(snapshot);
    }
  }

  return buildResolution(snapshots, baseDate);
};
