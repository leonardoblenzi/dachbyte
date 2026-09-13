"use strict";

const { loadRuntimeCollection } = require("./services/dataQueryService");
const { getReportSummary } = require("./services/reportService");

module.exports = {
  getReportSummary,
  loadRuntimeCollection,
};
