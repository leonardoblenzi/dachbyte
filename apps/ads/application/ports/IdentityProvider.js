"use strict";

/**
 * Port used by the Ads application to resolve the shared DACH identity.
 *
 * Implementations return one of:
 * - { status: "authenticated", identity: { tenantId, userId, email?, name? } }
 * - { status: "anonymous" }
 * - { status: "forbidden", reason, accessStatus? }
 * - { status: "unavailable", reason }
 *
 * Production uses the shared DACH suite session only to identify the user and
 * always revalidates `dach_ads` against the external Hub. The Ads domain never
 * receives Hub credentials or owns passwords/subscriptions.
 */
module.exports = {};
