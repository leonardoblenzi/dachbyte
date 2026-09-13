"use strict";

require("../config/env");

const { sendPendingSalesSummaryEmails } = require("../services/salesSummaryReportService");

async function main() {
  const args = process.argv.slice(2);
  const skipSyncBeforeSend = args.includes("--skip-sync");
  const positionalArgs = args.filter((arg) => arg !== "--skip-sync");
  const reportType = String(positionalArgs[0] || "").trim() || undefined;
  const accountName = String(positionalArgs[1] || "").trim() || undefined;
  const result = await sendPendingSalesSummaryEmails({
    force: true,
    reportType,
    accountName,
    skipSyncBeforeSend,
  });
  console.log("[sales-summary-once] result", result);
}

main().catch((error) => {
  console.error("[sales-summary-once] failed", error);
  process.exit(1);
});
