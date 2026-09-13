async function egressIp(req, res, next) {
  try {
    const r = await fetch("https://api.ipify.org?format=json", {
      method: "GET",
    });
    const j = await r.json();
    return res.json({ egress_ip: j.ip, source: "api.ipify.org" });
  } catch (e) {
    return next(e);
  }
}
module.exports = { egressIp };
