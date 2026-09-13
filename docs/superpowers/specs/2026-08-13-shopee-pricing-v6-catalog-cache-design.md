# Shopee Pricing V6 Catalog Cache Design

## Objective

Make the intelligent pricing screen responsive after its first data preparation. The pricing overview and paginated product table must use a persistent full-catalog preview rather than repeatedly loading and calculating every active product. The table must also compare the live selling price, including an active promotion when present, against the suggested price and show the effective margin of the current price.

## Scope

- Only active Shopee products (`NORMAL`) belong in the catalog cache.
- The first visit prepares a full cache once for the shop and current pricing-settings version.
- A later visit, overview refresh, pagination, filtering, and search reuse that persisted cache.
- `Atualizar dados` explicitly invalidates and rebuilds the full cache from the local product, campaign, cost, and price data already synchronized by the application.
- The V6 settings expose an optional tax rate. It defaults to the shop tax rate, and an empty V6 value means 0% for the V6 engine.
- The same rate affects suggested-price calculation, the free sale-price simulator, the current-price margin, and the detailed breakdown.

## Data Model And Cache Flow

`PricingV6Snapshot` remains the durable cache store. A full-catalog snapshot is identified by a stable request key containing the all-products selection and current filters. Its result stores the normalized product rows, calculated suggestion, current effective price, effective-price breakdown, summary totals, and the settings version.

The service resolves a full cache in this order:

1. Find the newest non-invalidated full-catalog snapshot for the shop and settings version.
2. If found, parse it and serve overview totals or filter/page its stored items in memory.
3. If absent, load active local product rows once, calculate the complete catalog, create the snapshot with no expiration, then serve it.
4. When the user selects `Atualizar dados`, invalidate the matching full-catalog snapshot and rebuild it. No endpoint in this flow calls the Shopee API.

Changing V6 settings increments the settings version. That naturally causes a new cache to be generated for the new configuration, without mutating the prior snapshot.

## Pricing Calculations

Each cached row contains two views:

- **Suggested price:** the existing V6 calculation using the product CMV, fees, promotion/coupon rules, and optional tax rate.
- **Current selling price:** the active promotion price when one exists and is lower than the normal current price; otherwise the normal current price. Its breakdown is calculated with the same fee, campaign, coupon, cost, and tax settings as the suggested price.

The product row returns `currentEffectivePriceCents`, `currentDiscountPercent`, `currentBreakdown`, `currentMarginRate`, and `currentNetPayoutCents`. The existing current normal price remains available for context.

The optional V6 tax rate is a percentage between 0 and 100. It is represented internally as a fractional cost rate and is deducted from revenue after coupon, matching the contribution-margin tax treatment. The detail and simulator explicitly show `Imposto` and include it in total costs, net payout, final contribution, and margin.

## UI

The overview renders only cached summary totals and recent jobs. It has an explicit loading and failure state so a rejected request never leaves the section permanently on `Carregando`.

The product table columns become:

1. Product
2. Current selling price, with a promotion discount line when applicable
3. Current margin
4. Suggested price
5. Suggested margin and health
6. CMV
7. Promotion status
8. Calculation actions

The detailed row presents both current and suggested calculation results. The free sale-price simulator uses the cached product row where available and displays the tax amount alongside the other deductions.

## Error Handling

- Cache parsing errors are treated as an invalid cache: the service rebuilds a fresh full snapshot.
- A first preparation failure returns a clear API error. The UI replaces its loading message with an actionable error message and leaves `Atualizar dados` available.
- A product with zero CMV retains `missing_cost` status. Its current selling price is visible, but no healthy margin is claimed.
- Empty or invalid tax input is rejected on save; an omitted tax rate is valid and stored as no V6 override.

## Tests

- Reuse a full-catalog snapshot for overview and paginated list requests without calling the product repository again.
- Refresh invalidates and rebuilds only after the explicit refresh flag.
- Verify active promotional price is used as the current selling price and current margin source.
- Verify a tax rate changes suggested price and all three calculation views: current, suggested, and free simulator.
- Verify overview and product endpoints surface failures instead of leaving the UI loading indefinitely.
