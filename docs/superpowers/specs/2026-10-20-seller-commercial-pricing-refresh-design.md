# Seller commercial pricing refresh — design

Date: 2026-10-20
Status: approved design; implementation not started

## Objective and scope

Make the Hub's published commercial matrix authoritative for fixed ML and Shopee subscriptions, ML prepaid top-ups, Seller contracting flows, and public Seller pricing. Keep the current fixed prices through 1,500 monthly sales, remove the extra charge per 500 sales for ML and Shopee, and introduce one fixed tier through 3,000 sales. Accounts above 3,000 sales must contact sales rather than obtain an automatic checkout.

This change does not reprice ML operations, implement Shopee prepaid-operation billing, alter Tracking, change existing wallet balances, or activate a new credit tariff. The discussed `promotions.apply` price of 1 c per 100 successful applications remains a separate, unapproved change.

## Approved commercial terms

| Monthly sales per linked account | ML fixed price | Shopee fixed price |
| --- | ---: | ---: |
| 0–30 | R$ 17,90 | R$ 17,90 |
| 31–200 | R$ 32,90 | R$ 32,90 |
| 201–700 | R$ 44,90 | R$ 44,90 |
| 701–1,500 | R$ 74,90 | R$ 74,90 |
| 1,501–3,000 | R$ 109,90 | R$ 109,90 |
| Above 3,000 | Contact sales; no automatic checkout | Contact sales; no automatic checkout |

No ML or Shopee range charges an additional block price. The ML prepaid top-ups offered for new purchases are 1,000 c for R$ 29, 4,000 c for R$ 99, and 9,000 c for R$ 199. Purchased and granted balances retain their visible amount and non-expiring behavior. Shopee's existing consumption model is unchanged.

## Architecture and boundaries

### Hub commercial catalog

Create a new, versioned published Sellers matrix. Do not edit historical published matrices or old migration files. The new matrix contains ML and Shopee ranges with finite `max_units` of 3,000 and zero/null overage fields. Tracking is copied unchanged so combined-module quotes remain valid. Publish ML top-ups with new package codes for the 4,000 c and 9,000 c offers; do not repurpose the old 5,000 c and 15,000 c codes. Retain the 1,000 c package code because its terms are unchanged. Prior matrices and top-up definitions remain available for audit and previously created orders.

The Hub catalog and checkout server enforce quantity/range consistency. A client-supplied range code cannot price 3,001 sales as a smaller tier. For ML and Shopee, volumes above 3,000 produce an explicit contact-sales response, never a fallback to the 1,501–3,000 price. Negotiated conditions remain a separate administrative path, not a public checkout option.

### Checkout and payment lifecycle

At creation, a subscription checkout snapshots matrix/version, selected range, price, and declared sales. A top-up order snapshots package code, visible credits, and amount before creating its Asaas charge. A later matrix publication must not change the amount charged or credits granted for a pending checkout already created. Webhook and refund handling use the order snapshot and existing idempotency rules. No paying subscriber is currently known, but pre-publication checks still inspect pending checkouts and manual/test conditions.

### Dach Seller and public presentation

The Seller contracting flow, account-renewal flow, and public landing derive prices and ranges from the published Hub catalog. The Seller must not calculate an independent price for submission to checkout. If the catalog is unavailable, contracting must not present an apparently valid stale price; show a temporary unavailable state. After selection, the checkout confirmation shows the same price, scope, and terms that the Hub will charge.

The existing `apps/seller-ml/views/landing.html` contains hard-coded prices, `+ R$ 11` copy, and a promise of monthly ML credits. Remove those stale claims. Show the finite 1,501–3,000 tier and a contact-sales action for larger accounts. Review other public landings, plan builders, account-management screens, and Hub public checkout/catalog pages for repeated pricing and top-up copy. Tracking text and pricing remain unchanged.

## User flows

1. A prospect selects ML, Shopee, or both and declares monthly sales per account. Hub resolves each product's tier and returns the authoritative quote. The UI displays fixed monthly amounts and any separate ML prepaid-credit explanation.
2. At 1,501–3,000 sales the prospect sees R$ 109,90 for that account and may proceed to checkout.
3. Above 3,000 sales the prospect sees “Entre em contato” and cannot create a public paid checkout for that account. The contact action does not invent a quote or silently cap sales at 3,000.
4. An ML account selecting a top-up sees 1,000/4,000/9,000 c. The created order fixes the credits and amount; Asaas payment confirmation grants the fixed quantity at the wallet's internal unit scale.
5. A previously created checkout or top-up order remains payable under its recorded terms. The new catalog applies only to orders created after publication.

## Failure and edge behavior

- Reject out-of-range quantities and forged range codes at the Hub boundary, not only in the browser.
- Do not allow stale Seller or landing pricing to create a mismatched checkout.
- Preserve a pending old-package top-up's recorded credits even after its package is no longer offered.
- Keep ML/Shopee subscription pricing independent per linked account; do not collapse several marketplace accounts into one tier.
- Leave Tracking block pricing intact in standalone and combined-module quotes.
- Fail visibly if the Hub catalog cannot be loaded; no silent fallback to outdated hard-coded prices.

## Verification and release gates

Test boundaries at 30/31, 200/201, 700/701, 1,500/1,501, and 3,000/3,001 for both ML and Shopee, including forged client inputs. Test combined ML + Shopee + Tracking quotes, initial checkout, renewal, and account plan presentation. Test all three new ML top-up packages, a pending old-package order, webhook idempotency, and refund correspondence. Compare landing, Seller selection, Hub quote, checkout session, Asaas amount, and final provisioned terms for identical inputs.

Release in dependency order: Hub schema/matrix and server validation; Hub public catalog and checkout; Dach contracting/account views; public landing content. Use test accounts and non-settling checkout simulations first, then a controlled real payment if approved. Confirm `/healthz`, published matrix identity, boundary behavior, and displayed prices after deploy. Do not deploy pricing copy ahead of the Hub catalog it describes.
