# DACHBYTE invite and legal-contract renewal

## Goal

Replace the remaining Davantti invite experience with DACHBYTE and unblock first access when the contract cannot be loaded. The public invitation, password-reset e-mail, contract, acceptance record and post-acceptance UI must present one coherent DACHBYTE experience.

## Contracting party and version

The platform brand is **DACHBYTE**. The supplier/contracting party shown in the legal document will be:

- Razao social: `69.092.307 Leonardo Batista Lenzi`
- CNPJ: `69.092.307/0001-66`
- Correspondence address: Rua Dancarino Perereca, 151, Loteamento Viver Bem Arapongas 2, Arapongas/PR, CEP 86711-478.

The legal contract becomes a new immutable version (`2026-10-06.v1`). Existing acceptance records retain their original rendered HTML and version; they are never rewritten.

The new document preserves the current operational clauses (access scope, individual credentials, external-platform limitations, operations at risk, data handling, audit and billing), but replaces the old party/brand references and identifies the DACHBYTE brand and legal supplier in its opening section. It is a product implementation of the owner's terms and should receive independent legal review before commercial rollout.

## Experience

The invitation uses DACHBYTE's dark, operational visual direction: deep green/teal accents, DACHBYTE wordmark, concise first-access language and no Davantti asset, title, subject or sender fallback.

The contract is fetched on initial page load. While it loads, the acceptance control shows an explicit loading state. If it fails, the main invite view displays an actionable error and retry button; it must not leave a disabled checkbox with no explanation. When it succeeds, the checkbox becomes enabled and the user can continue to password creation. The full-contract dialog remains available as a review action.

## Components

1. `legalContract.ts`: new DACHBYTE contract title, issuer identity, version and wording.
2. `globalInvitePage.ts`: DACHBYTE page metadata/assets/copy, accessible contract loading/error state and non-blocking contract dialog.
3. `brevoInvites.ts`: DACHBYTE invitation and reset subjects, sender fallback and email HTML.
4. Brand assets and relevant runtime defaults: eliminate public Davantti references from the invitation path.
5. Tests: contract rendering/versioning, public contract loading failure and success states, invite email copy, and regression coverage for invite acceptance.

## Non-goals

- Do not mutate historical contract acceptances or already-issued email content.
- Do not change billing rules, entitlement rules, invitation scopes or password security policy.
- Do not send a production test email without explicit approval.

## Acceptance criteria

- A new invitation shows DACHBYTE in browser title, UI, e-mail subject/body and sender fallback.
- The visible contract identifies the legal supplier and CNPJ above and records version `2026-10-06.v1` on acceptance.
- A contract endpoint failure is visible in the primary invite view and can be retried.
- A successful contract response enables the acceptance checkbox and the continue action.
- Existing contracts stay legally auditable under their original version and content.
- Focused tests and the relevant Hub suite pass before deployment.
