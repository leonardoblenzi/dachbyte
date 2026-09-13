"use strict";

// Public application boundary for the persisted runtime. Controllers and
// middleware depend only on domain facades; persistentCoreService remains
// a compatibility export and contains no business rules.
module.exports = {
  ...require("./platform"),
  ...require("./data"),
  ...require("./customers"),
  ...require("./catalog"),
  ...require("./operations"),
  ...require("./finance"),
  ...require("./users"),
};
