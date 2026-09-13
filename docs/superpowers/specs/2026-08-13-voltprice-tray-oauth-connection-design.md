# VoltPrice Tray OAuth Connection Design

**Status:** Approved direction; implementation begins only after review of this specification.

## Objective

Complete the production experience for connecting each VoltPrice company to Tray through OAuth. The tenant user supplies only the store URL and authorizes access at Tray. Consumer credentials remain server-side Render environment variables; access and refresh tokens are encrypted at rest, never shown in the browser, and refreshed automatically.

## Configuration boundary

The app credentials are global deployment secrets, configured in Render and never collected or returned by the VoltPrice UI or API:

```dotenv
VOLT_PRICE_TRAY_CONSUMER_KEY=
VOLT_PRICE_TRAY_CONSUMER_SECRET=
VOLT_PRICE_PUBLIC_BASE_URL=https://volt-staging.onrender.com
VOLT_PRICE_TRAY_ALLOWED_HOSTS=.commercesuite.com.br
```

`VOLT_PRICE_PUBLIC_BASE_URL` determines the callback origin. The configured Tray app must register this exact callback:

```text
https://<public-host>/volt-price/api/integrations/tray/callback
```

The store URL entered by a user must be HTTPS and match `VOLT_PRICE_TRAY_ALLOWED_HOSTS`; arbitrary hosts, local addresses and private networks remain rejected. `consumer_key`, `consumer_secret`, access tokens, refresh tokens and callback codes never appear in rendered HTML, client JavaScript state, telemetry, audit metadata, URL query text beyond the provider callback, or responses returned to the UI. The opaque OAuth state is the sole protocol exception: it travels only inside the generated Tray authorization/callback URL, is short lived and single use, and is never rendered, logged or included in connection-list responses.

## User experience

The existing **Integrações** page remains the sole connection surface and follows the approved VoltPrice prototype system: page header, compact white cards, status chips, dense metadata and explicit empty/error states.

The Tray card has three states:

| State | Visible content and actions |
| --- | --- |
| Not connected | Store URL field, explanatory text and **Autorizar na Tray**. The UI explains that it redirects to Tray and that credentials are managed by the platform. |
| Authorization in progress | Button is disabled while the authorization URL is requested; navigation immediately uses the returned URL. The app does not open an uncontrolled popup. |
| Connected / attention | Store name, connection health, token expiry and last successful renewal. **Renovar agora** is available to authorized users; **Desconectar** asks for confirmation. Errors are safe user-facing summaries only. |

After a successful callback, Tray redirects to `/volt-price/app/integrations?connected=tray`. The renderer consumes that one-time indication to show a generic success toast/banner, then removes the query parameter from browser history and reloads connection state. Callback failures render a generic safe error response; tokens or provider payloads are never surfaced.

## OAuth and token lifecycle

1. A user with `integrations.manage` enters a store URL and selects **Autorizar na Tray**.
2. `POST /volt-price/api/integrations/tray/connect`, protected by authentication, password-change completion and CSRF, validates the store URL and creates a single-use, expiring tenant-scoped OAuth state.
3. The server stores the opaque state in an HttpOnly, secure-in-production, same-site callback-scoped cookie and returns the Tray authorization URL.
4. The browser navigates to that URL. Tray returns the code and API host to the callback.
5. The callback consumes state exactly once, validates the returned Tray API host, exchanges code using Render-held Consumer Key/Secret, and upserts the tenant’s encrypted access/refresh token connection in one tenant transaction.
6. It records a password/token-free `integration.connect` audit event, clears the OAuth cookie and redirects to the integration page.
7. Every Tray call checks expiration with a five-minute safety margin. If expiry is near, it locks the connection, refreshes it, persists the replacement tokens encrypted and continues. A provider 401 triggers one refresh-and-retry only.
8. Manual renewal calls the same locked refresh implementation. Disconnect clears encrypted tokens and records an audit event.

The current connector and routes already implement the security-critical portions above. This phase makes their runtime contract explicit, adds any missing status/readiness behavior needed for the UI, and closes UX/error/reporting gaps without redesigning provider protocol behavior.

## API contracts

Existing contracts remain canonical:

```text
GET  /volt-price/api/integrations/
POST /volt-price/api/integrations/tray/connect   { storeHost }
GET  /volt-price/api/integrations/tray/callback
POST /volt-price/api/integrations/tray/refresh  { connectionId? }
POST /volt-price/api/integrations/tray/disconnect
```

The listing endpoint returns only connection-safe metadata already used by the interface, such as channel, display name, status, expiry timestamps, last renewal timestamp and a redacted error summary. It must not return any secret material. If UI readiness needs to communicate missing Render credentials, it uses the existing `POST /tray/connect` 503 error path rather than an endpoint that exposes secret/configuration values.

## Error handling

- Missing deployment credentials: the connect action receives a clear, non-secret `503` message saying Tray is not configured by the platform.
- Invalid/non-allowed store URL: the request is rejected before OAuth state creation with an actionable host/HTTPS message.
- Expired, invalid or replayed state: callback rejects it and does not write a connection.
- Missing code/API host or unsafe callback API host: callback rejects it, logs no sensitive payload and does not write a connection.
- Exchange/refresh failure: current encrypted connection remains unchanged unless a successful upsert occurs; safe error state is recorded/displayed and retry can be manual or next use according to existing retry logic.
- No permission or pending first-password change: the server denies the action; buttons may be absent in the UI but server authorization remains authoritative.

## Scope limits

- no Consumer Key/Secret input in the browser or tenant database;
- no manual access/refresh token entry;
- no new provider, migration, frontend framework or Tray order-import redesign;
- no automatic order sync schedule; order sync remains an explicit action;
- no callback payload or token display, export or support logging;
- preserve the prototype-led visual system delivered in the UX/UI refactor.

## Verification

Tests cover authorization URL construction/host validation, OAuth state consumption, callback persistence without secret output, refresh lock/retry and safe UI contracts. Browser QA uses a non-production Tray test store and verifies connect redirect, consent return, success banner, refresh, disconnect and a failed authorization at desktop/tablet/mobile widths. Render deployment QA verifies that only environment variables contain app credentials.
