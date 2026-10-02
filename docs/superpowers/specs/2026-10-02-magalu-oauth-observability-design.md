# Magalu OAuth: observability and reconnection coverage

## Objective

Make the Magalu OAuth lifecycle diagnosable without storing or exposing credentials, and prevent regressions when a revoked Magalu organization is authorized again.

## Scope

The Seller Magalu backend will append sanitized audit events for three lifecycle points:

- `oauth_started` after a valid authorization state is created;
- `oauth_connected` after the authorization code is exchanged and the account/tokens transaction succeeds;
- `oauth_failed` when callback completion fails after a valid state is consumed.

Each event may include the DACH tenant/user, local account id when known, Magalu tenant id when known, flow mode, requested or granted scope count, safe error code and HTTP status. It must never contain an authorization code, state value/hash, cookie, access token, refresh token, client secret, authorization header, or raw provider response.

The existing audit sanitizer remains the final boundary before persistence.

## Reconnection behavior

Normal reconnection continues to use `/magalu/auth/start`. If the user authorizes an organization that is already present under the same DACH tenant but currently `revoked` or `error`, the existing record is reactivated and receives the newly authorized scopes and tokens. It must retain the same local account id and not create a duplicate account.

## Error behavior

The callback will retain its current safe browser redirect. Audit information is for authorized operational diagnosis; the browser still receives only the existing allowlisted reason code.

## Tests

- A controller test verifies the three audit lifecycle points are emitted with safe metadata.
- A repository test verifies reconnecting a revoked organization updates the existing row, returns it as active, and preserves its id.
- The existing OAuth, Hub-resource and entry-gate suites remain required regression coverage.

## Non-goals

- No change to the Magalu consent URL, requested scopes, callback URI, token exchange contract, Hub authorization policy, migrations, or UI.
- No persistence or logging of OAuth secrets.
