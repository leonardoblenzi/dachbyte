const crypto = require("crypto");
const {
  checkAndCreateAddressAlertSql,
} = require("../repositories/orderAlertsSqlRepository");

function norm(v) {
  return String(v || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s\W_]+/g, " ")
    .trim();
}

// Ignora name/phone no hash pra não alertar por troca de contato
function makeAddressHash(snap) {
  const s = [
    norm(snap.zipcode),
    norm(snap.state),
    norm(snap.city),
    norm(snap.district),
    norm(snap.town),
    norm(snap.region),
    norm(snap.fullAddress),
  ].join("|");
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function isOrderClosed(status) {
  const s = String(status || "").toUpperCase();
  return ["COMPLETED", "CANCELLED", "RETURNED"].includes(s);
}

function shouldTrackAddressAlerts(status) {
  return String(status || "").toUpperCase() === "READY_TO_SHIP";
}

async function checkAndCreateAddressAlert({
  orderId,
  orderStatus,
  snapshotData,
}) {
  const addressHash = makeAddressHash(snapshotData);

  return checkAndCreateAddressAlertSql({
    orderId,
    orderStatus,
    snapshotData: {
      ...snapshotData,
      addressHash,
    },
  });
}

module.exports = { checkAndCreateAddressAlert };
