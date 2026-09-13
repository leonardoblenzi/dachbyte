"use strict";
module.exports = {
  ...require("./services/inventoryService"),
  ...require("./services/salesService"),
  ...require("./services/saleHistoryService"),
  ...require("./services/serviceOrderService"),
};
