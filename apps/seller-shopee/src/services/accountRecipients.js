"use strict";

const ROLE_PRIORITY = {
  SUPER_ADMIN: 0,
  ADMIN: 1,
  MANAGER: 2,
  VIEWER: 3,
};

function pickActiveRecipients(users = []) {
  const seen = new Set();

  return [...users]
    .filter(
      (user) =>
        String(user?.status || "").toUpperCase() === "ACTIVE" && user?.email,
    )
    .sort((left, right) => {
      const leftRole = ROLE_PRIORITY[String(left?.role || "").toUpperCase()] ?? 99;
      const rightRole =
        ROLE_PRIORITY[String(right?.role || "").toUpperCase()] ?? 99;

      if (leftRole !== rightRole) {
        return leftRole - rightRole;
      }

      return String(left?.email || "").localeCompare(String(right?.email || ""));
    })
    .filter((user) => {
      const emailKey = String(user.email || "").trim().toLowerCase();
      if (!emailKey || seen.has(emailKey)) return false;
      seen.add(emailKey);
      return true;
    })
    .map((user) => ({
      ...user,
      email: String(user.email || "").trim(),
    }));
}

module.exports = {
  pickActiveRecipients,
};
