const DEFAULT_TZ = process.env.SHOPEE_REPORT_TZ_OFFSET || "-03:00";

function tzOffsetToMinutes(tzOffset) {
  const s = String(tzOffset || DEFAULT_TZ).trim();
  const m = s.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!m) return -180;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

function hourIndexInOffset(dateUtc, tzOffset = DEFAULT_TZ) {
  const offsetMin = tzOffsetToMinutes(tzOffset);
  const d = dateUtc instanceof Date ? dateUtc : new Date(dateUtc);
  const shiftedMs = d.getTime() + offsetMin * 60 * 1000;
  return new Date(shiftedMs).getUTCHours();
}

module.exports = { DEFAULT_TZ, tzOffsetToMinutes, hourIndexInOffset };
