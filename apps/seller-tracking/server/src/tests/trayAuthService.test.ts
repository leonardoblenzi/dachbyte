import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTrayRefreshFailure } from '../services/trayAuthService.js';

test('preserves the Tray HTTP response when a refresh token request fails', () => {
  const message = formatTrayRefreshFailure({
    response: {
      status: 400,
      data: {
        message: 'Refresh token invalido ou expirado.',
        code: '1099',
      },
    },
  });

  assert.equal(
    message,
    'Tray recusou a renovacao do token (HTTP 400, codigo 1099): Refresh token invalido ou expirado.',
  );
});
