// src/jobs/adsAttribution.job.js
const AdsAttributionService = require("../services/AdsAttributionService");

module.exports = async () => {
  return AdsAttributionService.run({});
};
