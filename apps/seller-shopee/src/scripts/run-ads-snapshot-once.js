const AdsHourlySnapshotService = require("../services/AdsHourlySnapshotService");
const {
  countAdsHourlyMetrics,
  findLatestAdsHourlyMetric,
} = require("../repositories/operationsSqlRepository");

async function main() {
  const out = await AdsHourlySnapshotService.run({});
  console.log("snapshot out:", out);

  const count = await countAdsHourlyMetrics();
  console.log("AdsHourlyMetric.count =", count);

  const last = await findLatestAdsHourlyMetric();
  console.log("last:", last);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
