// src/jobs/adsHourlySnapshot.job.js
const AdsHourlySnapshotService = require("../services/AdsHourlySnapshotService");
const { queues } = require("../config/queue");

module.exports = async () => {
  const summary = await AdsHourlySnapshotService.run({});

  await queues.adsAttributionQueue.add(
    "run",
    {},
    {
      jobId: `adsAttribution:afterSnapshot:${Date.now()}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: 50,
    },
  );

  return summary;
};
