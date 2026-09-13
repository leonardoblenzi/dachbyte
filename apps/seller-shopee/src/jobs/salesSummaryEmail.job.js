"use strict";

const { sendPendingSalesSummaryEmails } = require("../services/salesSummaryReportService");

module.exports = async function salesSummaryEmailProcessor(job) {
  return sendPendingSalesSummaryEmails({
    reportType: job?.data?.reportType,
  });
};
