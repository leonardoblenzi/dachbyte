const {
  listPendingAddressAlertsWithSnapshots,
  resolveAddressAlert,
} = require("../repositories/operationsSqlRepository");

function normalizeStr(v) {
  return String(v || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function normalizeZipcode(v) {
  return String(v || "").replace(/\D+/g, "");
}

function keyFromSnapshot(s) {
  return [
    normalizeZipcode(s?.zipcode),
    normalizeStr(s?.state),
    normalizeStr(s?.city),
    normalizeStr(s?.fullAddress),
  ].join("|");
}

async function main() {
  const alerts = await listPendingAddressAlertsWithSnapshots();

  let checked = 0;
  let resolved = 0;

  for (const a of alerts) {
    checked += 1;

    if (!a.oldSnapshot || !a.newSnapshot) continue;

    const k1 = keyFromSnapshot(a.oldSnapshot);
    const k2 = keyFromSnapshot(a.newSnapshot);

    if (k1 === k2) {
      await resolveAddressAlert(a.id);
      resolved += 1;
    }
  }

  console.log(`Verificados: ${checked}`);
  console.log(`Resolvidos (falsos positivos): ${resolved}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
