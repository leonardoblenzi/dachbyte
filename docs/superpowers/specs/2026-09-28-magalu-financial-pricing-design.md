# Magalu Financial Pricing Design

## Goal

Add an independent Magalu financial area with SKU costs, margin analysis and a sales-price calculator. It follows the commercial flow of Seller ML without sharing its implementation or claiming unverified Magalu fees as actual values.

## Scope

The Seller Magalu sidebar receives a **Financeiro** group with **Custos por SKU**, **Margem de venda** and **Calculadora**. The same Magalu shell, selected account and theme apply to all three screens.

Costs are stored per Magalu account and SKU. A cost record contains the unit product cost, tax rate and optional packaging, operational and other unit costs. The current mirror price is used whenever it exists.

The calculator accepts a sale price plus explicit Magalu commercial inputs: commission percentage and fixed fee, platform fee percentage and fixed fee, seller freight, shipping share, seller discount/promotion, tax rate, product cost, packaging, operational and other costs. It returns revenue, total cost, contribution profit, margin, ROI, break-even price and target-margin price. It never writes a price remotely.

The margin screen summarizes the stored cost coverage of the synchronized catalog and calculates an estimated unit margin for each priced SKU. It labels its source as **estimated** until a future Financial Analysis integration provides settled transaction values. Missing SKU cost is not treated as zero cost.

## Accuracy and safety

The implementation must not invent a Magalu commission, shipping charge or fiscal tax. Each estimate is labelled according to the manual values used. A user can save explicit account/SKU costs, and all APIs verify the selected account belongs to the Suite identity and passes the Hub READ check.

No token, OAuth secret, financial payload containing PII, or remote write is added. The public Magalu Financial Analysis API can later reconcile settled transaction classes such as SALE, FEES, TAXES, SHIPPING_COST and PROMOTION once its exact scope is confirmed in the client configuration; that deferred API work is outside this first pricing screen.

## Data and API

Migration `011_financial_pricing.sql` creates `magalu.sku_costs` with one current row per account/SKU and indexes for account lookup. The row has `unit_cost`, `tax_rate`, `packaging_cost`, `operational_cost`, `other_cost`, notes and timestamps.

Routes under `/magalu/api/financial` expose cost listing/upsert, margin listing and calculator lookup/calculation. They use repositories/services unique to Seller Magalu.

## Verification

Unit tests cover calculator arithmetic, zero/invalid denominators, target-price math, missing-cost treatment and account-scoped access wiring. UI contract tests assert the new canonical-shell navigation/pages and that the calculator labels estimates rather than official fees.
