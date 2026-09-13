const crypto = require("crypto");

function hmacSha256Hex(key, payload) {
  return crypto.createHmac("sha256", key).update(payload).digest("hex");
}

module.exports = {
  hmacSha256Hex
};