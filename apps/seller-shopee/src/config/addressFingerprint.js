const crypto = require("crypto");

function norm(v) {
  return String(v || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // remove acentos
    .replace(/[\s\W_]+/g, " ") // pontuação/underscore/espaços -> espaço
    .trim();
}

function buildComparableAddress(addr) {
  // Ignora name/phone no hash (pra não gerar alerta por troca de telefone/nome)
  const parts = [
    norm(addr?.zipcode),
    norm(addr?.state),
    norm(addr?.city),
    norm(addr?.district),
    norm(addr?.town),
    norm(addr?.region),
    norm(addr?.fullAddress),
  ];
  return parts.join("|");
}

function addressHash(addr) {
  const s = buildComparableAddress(addr);
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

module.exports = { addressHash };
