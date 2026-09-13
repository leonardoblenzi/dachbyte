module.exports = function requireAdmin(req, res, next) {
  const role = String(req?.user?.role || req?.session?.user?.role || "");
  if (role === "ADMIN" || role === "SUPER_ADMIN") return next();
  return res.status(403).json({ error: "forbidden" });
};
