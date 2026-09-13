"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function read(relative) {
  return fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
}

const appSource = read("public/app.js");
const adsSource = read("public/ads-financial.js");
const cashSource = read("public/cash-financial.js");

function moduleBlock(key, nextKey) {
  const start = appSource.indexOf(`if(key==="${key}")`);
  const end = nextKey ? appSource.indexOf(`if(key==="${nextKey}")`, start + 1) : appSource.indexOf("root.innerHTML='<div class=\"empty\">", start + 1);
  assert.ok(start >= 0 && end > start, `missing module block: ${key}`);
  return appSource.slice(start, end);
}

const adsBlock = moduleBlock("ads", "cash");
const cashBlock = moduleBlock("cash", "audit");
const auditBlock = moduleBlock("audit", "actions");
const actionsBlock = moduleBlock("actions", "reports");
const reportsBlock = moduleBlock("reports");

test("financial pages use the shared prototype presentation contracts", () => {
  assert.match(adsBlock, /class="pagehead"/);
  assert.match(cashBlock, /class="toolbar"/);
  assert.match(auditBlock, /class="chip/);
  assert.match(actionsBlock, /class="timeline"/);
  assert.match(reportsBlock, /class="scenario/);
  assert.match(adsSource, /class="pagehead"/);
  assert.match(adsSource, /class="platform"/);
  assert.match(cashSource, /class="pagehead"/);
  assert.match(cashSource, /class="scenario/);
});

test("financial workspaces retain their real routes", () => {
  assert.match(appSource, /async function modulePage[\s\S]*api\(`\/\$\{key\}`\)/);
  assert.match(cashSource, /\/cash/);
  assert.match(adsSource, /\/ads\/sources/);
});

test("legacy Cash create action retains its request body", () => {
  assert.ok(appSource.includes('id="cashNew"'));
  assert.ok(appSource.includes('id="cashSave"'));
  assert.ok(appSource.includes('body:JSON.stringify({entryType:$("#cashType").value,amount:$("#cashAmount").value,dueDate:$("#cashDue").value||null,description:$("#cashDesc").value})'));
});

test("Ads source actions retain their request bodies", () => {
  for (const contract of [
    'save("/ads/sources",{channel:document.querySelector("#mkChannel").value,displayName:document.querySelector("#mkName").value,externalAccountId:document.querySelector("#mkAccount").value,authMode:document.querySelector("#mkMode").value})',
    'save("/ads/metrics/import",{sourceId:document.querySelector("#miSource").value||null,channel:document.querySelector("#miChannel").value,metricDate:document.querySelector("#miDate").value,sourceRef:document.querySelector("#miRef").value,externalCampaignId:document.querySelector("#miCampaign").value||null,campaignName:document.querySelector("#miCampaignName").value,spend:document.querySelector("#miSpend").value,attributedRevenue:document.querySelector("#miRevenue").value,attributedOrders:document.querySelector("#miOrders").value,conversions:document.querySelector("#miOrders").value,impressions:document.querySelector("#miImpressions").value,clicks:document.querySelector("#miClicks").value,sourceType:"IMPORT"})',
    'save("/ads/order-costs",{orderId:document.querySelector("#mcOrder").value,costType:document.querySelector("#mcType").value,amount:document.querySelector("#mcAmount").value,fundedBy:document.querySelector("#mcFunded").value,sourceRef:document.querySelector("#mcRef").value||null})',
    'save("/ads/promotions",{channel:document.querySelector("#mpChannel").value,promotionType:document.querySelector("#mpType").value,code:document.querySelector("#mpCode").value,orderId:document.querySelector("#mpOrder").value||null,sellerFundedAmount:document.querySelector("#mpSeller").value,marketplaceFundedAmount:document.querySelector("#mpMarketplace").value,coinsAmount:document.querySelector("#mpCoins").value,sourceRef:document.querySelector("#mpRef").value||null})',
    'save("/ads/affiliates",{channel:document.querySelector("#maChannel").value,affiliateName:document.querySelector("#maName").value,orderId:document.querySelector("#maOrder").value||null,attributionDate:document.querySelector("#maDate").value,commissionAmount:document.querySelector("#maCommission").value,attributedRevenue:document.querySelector("#maRevenue").value,sourceRef:document.querySelector("#maRef").value||null})',
  ]) {
    assert.ok(adsSource.includes(contract), `changed Ads request contract: ${contract.slice(0, 48)}`);
  }
});

test("Reports selects its two comparison periods from the Orders and Profit union", () => {
  const unionIndex = reportsBlock.indexOf("reportMonths=[...new Set");
  const currentPeriodIndex = reportsBlock.indexOf("currentMonth=reportMonths[0]");
  const lookupIndex = reportsBlock.indexOf("currentOrders=monthlyOrders.find");
  assert.ok(unionIndex >= 0 && unionIndex < currentPeriodIndex && currentPeriodIndex < lookupIndex);
  assert.match(reportsBlock, /currentOrders=monthlyOrders\.find\(x=>String\(x\.month\)===currentMonth\)/);
  assert.match(reportsBlock, /previousOrders=monthlyOrders\.find\(x=>String\(x\.month\)===previousMonth\)/);
  assert.match(reportsBlock, /currentProfit=monthlyProfit\.find\(x=>String\(x\.month\)===currentMonth\)/);
  assert.match(reportsBlock, /previousProfit=monthlyProfit\.find\(x=>String\(x\.month\)===previousMonth\)/);

  const ordersThroughJuly = [{ month: "2026-07-01" }];
  const profitThroughAugust = [{ month: "2026-08-01" }, { month: "2026-07-01" }];
  const periods = [...new Set([...ordersThroughJuly.map((row) => row.month), ...profitThroughAugust.map((row) => row.month)])].sort().reverse();
  assert.deepEqual(periods.slice(0, 2), ["2026-08-01", "2026-07-01"]);
});

test("Cash does not present receivables as an operand of free cash", () => {
  assert.doesNotMatch(cashSource, /\(\+\) A receber/);
  const freeCashIndex = cashSource.indexOf("Caixa livre</span>");
  const projectionIndex = cashSource.indexOf("Recebíveis para projeção");
  const receivableIndex = cashSource.indexOf("A receber pendente");
  assert.ok(freeCashIndex >= 0 && freeCashIndex < projectionIndex && projectionIndex < receivableIndex);
});
