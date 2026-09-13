"use strict";

const {
  processShopeePushPayload,
} = require("../services/ShopeePushProcessingService");

module.exports = async function shopeeWebhookPushJob(job) {
  const payload =
    job?.data && typeof job.data === "object" ? job.data.payload || {} : {};
  const category =
    job?.data && typeof job.data === "object"
      ? String(job.data.category || "unknown")
      : "unknown";

  const result = await processShopeePushPayload(payload);

  return {
    ...result,
    category,
  };
};
