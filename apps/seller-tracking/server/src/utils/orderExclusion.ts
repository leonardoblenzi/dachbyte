const normalizeFreightText = (freightType: string | null | undefined) =>
  String(freightType || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();

const DEFAULT_IMPORT_EXCEPTION_ALIASES = [
  'retirada normal na agencia',
  'retirada na agencia',
];

export const normalizeCarrierExceptionList = (value: unknown) => {
  if (!Array.isArray(value)) return [];

  return Array.from(
    new Set(
      value
        .map((item) => normalizeFreightText(String(item || '')))
        .filter(Boolean),
    ),
  );
};

export const shouldApplyChannelLogisticsRules = (
  companyName: string | null | undefined,
) => false;

export const normalizeExcludedPlatformFreight = (
  freightType: string | null | undefined,
  companyName?: string | null,
) => null;

export const shouldSkipPlatformOrderImport = ({
  freightType,
  carrierExceptions,
}: {
  freightType: string | null | undefined;
  carrierExceptions?: string[] | null | undefined;
}) => {
  const normalized = normalizeFreightText(freightType);
  if (!normalized) return false;

  const normalizedExceptions = new Set([
    ...DEFAULT_IMPORT_EXCEPTION_ALIASES,
    ...normalizeCarrierExceptionList(carrierExceptions),
  ]);

  return normalizedExceptions.has(normalized);
};

export const isExcludedPlatformFreight = (
  freightType: string | null | undefined,
  companyName?: string | null,
) => false;

export const isStoredChannelManagedFreight = (
  freightType: string | null | undefined,
  companyName?: string | null,
) => false;
