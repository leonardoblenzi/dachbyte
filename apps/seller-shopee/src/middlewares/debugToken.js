function requireDebugToken(req, res, next) {
  const expected = String(process.env.DEBUG_EGRESS_TOKEN || "");
  const token = String(req.headers["x-debug-token"] || "");

  if (!expected) {
    return res.status(500).json({ error: "debug_token_not_configured" });
  }
  if (token !== expected) {
    return res.status(403).json({ error: "invalid_debug_token" });
  }
  return next();
}

module.exports = { requireDebugToken };
