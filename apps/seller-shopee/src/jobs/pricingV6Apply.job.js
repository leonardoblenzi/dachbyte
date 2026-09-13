"use strict";

const { runApplyJob, failApplyJob } = require("../services/PricingV6Service");

module.exports = async function pricingV6ApplyProcessor(job) {
  if (job?.name !== "apply" || !job?.data?.jobId) {
    return { ok: true, ignored: true, reason: "unsupported_pricing_job" };
  }
  try {
    return await runApplyJob({
      jobId: String(job.data.jobId),
      progress: (payload) => job.updateProgress(payload),
    });
  } catch (error) {
    await failApplyJob({ jobId: String(job.data.jobId), error });
    throw error;
  }
};
