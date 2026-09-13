const {
  createOrderAdsAttribution,
  listAdsMetricsForAttributionRange,
  listAllShopsForAdsAttribution,
  listEligibleOrdersForAdsAttribution,
} = require("../repositories/adsSqlRepository");

const DEFAULT_TZ_OFFSET = process.env.SHOPEE_REPORT_TZ_OFFSET || "-03:00";
const DEFAULT_TZ_OFFSET_MINUTES = Number(
  process.env.SHOPEE_REPORT_TZ_OFFSET_MINUTES || -180,
);

function floorToHourWithOffset(date, offsetMinutes) {
  const ms = date.getTime();
  const shifted = ms + offsetMinutes * 60 * 1000;
  const flooredShifted =
    Math.floor(shifted / (60 * 60 * 1000)) * (60 * 60 * 1000);
  return new Date(flooredShifted - offsetMinutes * 60 * 1000);
}

function minutesIntoLocalHour(date, offsetMinutes) {
  const ms = date.getTime();
  const shifted = ms + offsetMinutes * 60 * 1000;
  const minute = Math.floor((shifted / (60 * 1000)) % 60);
  return minute < 0 ? minute + 60 : minute;
}

function metricDateHourToInstant(dateValue, hour, tzOffset = DEFAULT_TZ_OFFSET) {
  if (!(dateValue instanceof Date) || Number.isNaN(dateValue.getTime())) {
    return null;
  }

  const isoDay = dateValue.toISOString().slice(0, 10);
  return new Date(
    `${isoDay}T${String(Number(hour || 0)).padStart(2, "0")}:00:00.000${tzOffset}`,
  );
}

function hourKey(date) {
  return date.toISOString();
}

function metricHasSignal(metric) {
  if (!metric) return false;

  return (
    Number(metric.expense || 0) > 0 ||
    Number(metric.directGmv || 0) > 0 ||
    Number(metric.broadGmv || 0) > 0 ||
    Number(metric.directSold || 0) > 0 ||
    Number(metric.broadSold || 0) > 0
  );
}

function capacityFromMetric(metric) {
  return Math.max(
    0,
    Number(metric?.directSold || 0),
    Number(metric?.broadSold || 0),
  );
}

const AdsAttributionService = {
  async run() {
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const shops = await listAllShopsForAdsAttribution();

    let processedOrders = 0;
    let created = 0;
    let skippedNoCandidates = 0;

    for (const shop of shops) {
      const orders = await listEligibleOrdersForAdsAttribution(shop.id, since, 500);
      if (!orders.length) {
        continue;
      }

      processedOrders += orders.length;

      const offsetMinutes = DEFAULT_TZ_OFFSET_MINUTES;
      const buckets = orders.map((order) =>
        floorToHourWithOffset(new Date(order.shopeeCreateTime), offsetMinutes),
      );
      const minBucket = new Date(
        Math.min(...buckets.map((bucket) => bucket.getTime())) - 60 * 60 * 1000,
      );
      const maxBucket = new Date(
        Math.max(...buckets.map((bucket) => bucket.getTime())) + 60 * 60 * 1000,
      );
      const minDate = new Date(minBucket);
      minDate.setHours(0, 0, 0, 0);
      const maxDate = new Date(maxBucket);
      maxDate.setHours(0, 0, 0, 0);

      const metrics = await listAdsMetricsForAttributionRange(
        shop.id,
        minDate,
        maxDate,
        "CPC",
      );

      const metricByHour = new Map();
      for (const metric of metrics) {
        const instant = metricDateHourToInstant(metric.date, metric.hour);
        if (!instant) {
          continue;
        }
        metricByHour.set(hourKey(instant), metric);
      }

      const usedByHour = new Map();

      for (const order of orders) {
        const createTime = new Date(order.shopeeCreateTime);
        const same = floorToHourWithOffset(createTime, offsetMinutes);
        const prev = new Date(same.getTime() - 60 * 60 * 1000);
        const next = new Date(same.getTime() + 60 * 60 * 1000);
        const candidates = [
          { hour: same, kind: "same" },
          { hour: prev, kind: "prev" },
          { hour: next, kind: "next" },
        ];

        let picked = null;

        for (const candidate of candidates) {
          const key = hourKey(candidate.hour);
          const metric = metricByHour.get(key);
          if (!metricHasSignal(metric)) {
            continue;
          }

          const capacity = capacityFromMetric(metric);
          const used = usedByHour.get(key) || 0;

          if (capacity > 0 && used >= capacity) {
            continue;
          }

          picked = { ...candidate, metric, key };
          break;
        }

        if (!picked) {
          skippedNoCandidates += 1;
          continue;
        }

        const minutes = minutesIntoLocalHour(createTime, offsetMinutes);
        let matchConfidence = "LOW";

        if (picked.kind === "same") {
          matchConfidence = minutes <= 15 ? "HIGH" : "MEDIUM";
        }

        const inserted = await createOrderAdsAttribution({
          shopId: shop.id,
          orderId: order.id,
          orderSn: order.orderSn,
          adsType: "CPC",
          channelId: null,
          matchConfidence,
        });

        if (inserted) {
          usedByHour.set(picked.key, (usedByHour.get(picked.key) || 0) + 1);
          created += 1;
        }
      }
    }

    return {
      ok: true,
      processedOrders,
      created,
      skippedNoCandidates,
    };
  },
};

module.exports = AdsAttributionService;
