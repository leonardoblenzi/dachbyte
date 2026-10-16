# Core Transaction Integrity Design

## Goal

Prevent duplicate financial effects, preserve a traceable cash-session ledger, and keep sale, receivable, stock, and cancellation state transitions consistent.

## Decisions

1. A `pending_delivery` sale is an order, not a financial sale. Its update path may change only order metadata; it must not create payments, receivables, cash movements, or a receipt. Financial completion remains exclusive to delivery completion.
2. Every automatic or manual cash movement is bound to an open cash session when the company requires an open cash session. The same locked session is used for validation and insertion, removing time-based inference for new records.
3. The database enforces one open cash session per company with a partial unique index. The service translates a unique-conflict into the existing business conflict response.
4. A shared operational-timestamp resolver accepts a valid past or present instant and rejects future or invalid values. It receives the company timezone for UI defaults and date-boundary calculations; instant validation is performed server-side.
5. Receivable settlement accepts an idempotency key. Repeating the same key returns the original settlement result and never creates another cash movement.
6. Cancelled sales remain audit records. Deletion is replaced by archival visibility only after cancellation; operational movements and receipts remain linked.
7. Product row locks are acquired in deterministic product-id order. A product with active reservations cannot turn off stock tracking.
8. Permissions distinguish normal sale creation/editing from cancellation and archival.

## Error Handling

- Future or invalid operational timestamps return HTTP 400 with stable error codes.
- A pending-delivery order submitted to the financial sale-edit path returns HTTP 409.
- Cash-session absence/closure returns HTTP 409 before a movement is written.
- Duplicate idempotency keys return the original response; conflicting reuse returns HTTP 409.
- A duplicate open-session insert returns the normal `CASH_SESSION_ALREADY_OPEN` conflict.

## Tests

Regression coverage will prove that a pending delivery cannot create financial records through update, duplicate receivable settlement is harmless, future timestamps fail in all operational endpoints, session linkage is explicit, multiple concurrent cash opens are rejected by schema/service behavior, archive preserves ledger rows, and reservation rules protect stock tracking.
