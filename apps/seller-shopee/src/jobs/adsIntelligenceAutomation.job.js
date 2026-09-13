"use strict";

const AdsIntelligenceAutomationService = require("../services/AdsIntelligenceAutomationService");

module.exports = async () => {
  return AdsIntelligenceAutomationService.runScheduledAutomation();
};

