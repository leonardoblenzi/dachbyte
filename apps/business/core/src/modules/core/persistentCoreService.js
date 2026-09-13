"use strict";

// Backward-compatible facade. Runtime/domain behavior lives in dedicated services.
const platform = require("./runtime/services/platformService");
const configuration = require("./runtime/services/configurationService");
const access = require("./runtime/services/accessService");
const customers = require("./runtime/services/customerService");
const catalog = require("./runtime/services/catalogService");
const finance = require("./runtime/services/financeService");
const inventory = require("./runtime/services/inventoryService");
const cash = require("./runtime/services/cashService");
const sales = require("./runtime/services/salesService");
const users = require("./runtime/services/userService");

module.exports = {
  ...platform,
  ...configuration,
  ...access,
  ...customers,
  ...catalog,
  ...finance,
  ...inventory,
  ...cash,
  ...sales,
  ...users,
  __test: sales.__test,
};
