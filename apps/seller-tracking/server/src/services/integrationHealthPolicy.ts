export type IntegrationHealthIssue = {
  integration: 'TRAY' | 'ANYMARKET' | 'MAGAZORD' | 'JET' | 'INTELIPOST' | 'SSW';
  code:
    | 'TRAY_RECONNECT_REQUIRED'
    | 'ANYMARKET_TOKEN_MISSING'
    | 'MAGAZORD_CREDENTIALS_MISSING'
    | 'JET_API_KEY_MISSING'
    | 'INTELIPOST_CREDENTIALS_MISSING'
    | 'SSW_CNPJ_MISSING';
  title: string;
  message: string;
};

export type IntegrationConfiguration = {
  trayIntegrationEnabled?: boolean | null;
  hasTrayAuth?: boolean;
  anymarketIntegrationEnabled?: boolean | null;
  anymarketToken?: string | null;
  magazordIntegrationEnabled?: boolean | null;
  magazordApiBaseUrl?: string | null;
  magazordApiUser?: string | null;
  magazordApiPassword?: string | null;
  jetIntegrationEnabled?: boolean | null;
  jetIntegrationKey?: string | null;
  intelipostIntegrationEnabled?: boolean | null;
  intelipostClientId?: string | null;
  intelipostApiKey?: string | null;
  sswRequireEnabled?: boolean | null;
  sswRequireCnpjs?: unknown;
  correiosIntegrationEnabled?: boolean | null;
};

const hasText = (value: unknown) => String(value || '').trim().length > 0;

export const shouldPreserveMasterCompanySelection = (
  email: string | null | undefined,
  masterEmail: string | null | undefined,
) =>
  Boolean(
    hasText(email) &&
      hasText(masterEmail) &&
      String(email).trim().toLowerCase() === String(masterEmail).trim().toLowerCase(),
  );

export const evaluateIntegrationConfiguration = (
  configuration: IntegrationConfiguration,
): IntegrationHealthIssue[] => {
  const issues: IntegrationHealthIssue[] = [];

  if (configuration.trayIntegrationEnabled && !configuration.hasTrayAuth) {
    issues.push({
      integration: 'TRAY',
      code: 'TRAY_RECONNECT_REQUIRED',
      title: 'Reconexao da Tray necessaria',
      message:
        'A integracao Tray esta ativa, mas a autenticacao nao esta disponivel. Acesse Integracoes e reconecte a Tray.',
    });
  }

  if (configuration.anymarketIntegrationEnabled && !hasText(configuration.anymarketToken)) {
    issues.push({
      integration: 'ANYMARKET',
      code: 'ANYMARKET_TOKEN_MISSING',
      title: 'Credencial da AnyMarket pendente',
      message:
        'A integracao AnyMarket esta ativa sem token. Informe ou reconecte a credencial em Integracoes.',
    });
  }

  if (
    configuration.magazordIntegrationEnabled &&
    (!hasText(configuration.magazordApiBaseUrl) ||
      !hasText(configuration.magazordApiUser) ||
      !hasText(configuration.magazordApiPassword))
  ) {
    issues.push({
      integration: 'MAGAZORD',
      code: 'MAGAZORD_CREDENTIALS_MISSING',
      title: 'Credenciais da Magazord pendentes',
      message:
        'A integracao Magazord esta ativa, mas faltam credenciais. Revise URL, usuario e senha em Integracoes.',
    });
  }

  if (configuration.jetIntegrationEnabled && !hasText(configuration.jetIntegrationKey)) {
    issues.push({
      integration: 'JET',
      code: 'JET_API_KEY_MISSING',
      title: 'Credencial da JET pendente',
      message:
        'A integracao JET esta ativa sem a credencial de integracao (apiKey). Informe-a em Integracoes.',
    });
  }

  if (
    configuration.intelipostIntegrationEnabled &&
    (!hasText(configuration.intelipostClientId) || !hasText(configuration.intelipostApiKey))
  ) {
    issues.push({
      integration: 'INTELIPOST',
      code: 'INTELIPOST_CREDENTIALS_MISSING',
      title: 'Credenciais da Intelipost pendentes',
      message:
        'A integracao Intelipost esta ativa sem Client ID ou API key. Revise a configuracao de rastreio.',
    });
  }

  const configuredSswCnpjs = Array.isArray(configuration.sswRequireCnpjs)
    ? configuration.sswRequireCnpjs.filter((cnpj) => hasText(cnpj))
    : [];
  if (configuration.sswRequireEnabled && configuredSswCnpjs.length === 0) {
    issues.push({
      integration: 'SSW',
      code: 'SSW_CNPJ_MISSING',
      title: 'CNPJ da SSW pendente',
      message:
        'A integracao SSW esta ativa sem CNPJ configurado. Informe ao menos um CNPJ no rastreio.',
    });
  }

  return issues;
};
