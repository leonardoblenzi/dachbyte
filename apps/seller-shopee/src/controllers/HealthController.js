const { query } = require("../config/postgres");

async function health(req, res) {
  let db = "unknown";

  try {
    await query("SELECT 1");
    db = "ok";
  } catch (e) {
    db = "down";
  }

  res.json({
    status: "ok",
    uptimeSec: Math.floor(process.uptime()),
    db
  });
}

module.exports = {
  health
};
