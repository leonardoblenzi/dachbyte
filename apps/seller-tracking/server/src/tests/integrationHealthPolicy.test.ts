import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateIntegrationConfiguration,
  shouldPreserveMasterCompanySelection,
} from '../services/integrationHealthPolicy.js';

test('preserves the selected company only for the configured master administrator', () => {
  assert.equal(
    shouldPreserveMasterCompanySelection(
      ' CADASTRO6@DROSSIINTERIORES.COM.BR ',
      'cadastro6@drossiinteriores.com.br',
    ),
    true,
  );
  assert.equal(
    shouldPreserveMasterCompanySelection(
      'user@drossiinteriores.com.br',
      'cadastro6@drossiinteriores.com.br',
    ),
    false,
  );
});

test('reports only enabled integrations that are missing their required settings', () => {
  const issues = evaluateIntegrationConfiguration({
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

  assert.deepEqual(
    issues.map((issue) => issue.code),
    [
      'TRAY_RECONNECT_REQUIRED',
      'ANYMARKET_TOKEN_MISSING',
      'MAGAZORD_CREDENTIALS_MISSING',
      'JET_API_KEY_MISSING',
      'INTELIPOST_CREDENTIALS_MISSING',
      'SSW_CNPJ_MISSING',
    ],
  );
});

test('does not report disabled integrations or configured integrations', () => {
  const issues = evaluateIntegrationConfiguration({
    trayIntegrationEnabled: false,
    hasTrayAuth: false,
    anymarketIntegrationEnabled: false,
    anymarketToken: '',
    magazordIntegrationEnabled: false,
    jetIntegrationEnabled: false,
    intelipostIntegrationEnabled: false,
    sswRequireEnabled: false,
  });

  assert.deepEqual(issues, []);
});
