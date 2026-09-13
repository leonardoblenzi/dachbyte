"use strict";

// Commercial plans are intentionally non-restrictive until product limits are defined.
// Keeping them in a registry now prevents planKey from becoming scattered business logic later.
const plans = Object.freeze([
  { key: "starter", name: "Starter", disabledModules: [], limits: {} },
  { key: "professional", name: "Professional", disabledModules: [], limits: {} },
  { key: "pro", name: "Pro", disabledModules: [], limits: {} },
  { key: "enterprise", name: "Enterprise", disabledModules: [], limits: {} },
]);

const planByKey = Object.freeze(Object.fromEntries(plans.map((plan) => [plan.key, plan])));

function getPlan(planKey) {
  return planByKey[String(planKey || "starter").trim().toLowerCase()] || planByKey.starter;
}

module.exports = { getPlan, plans };
