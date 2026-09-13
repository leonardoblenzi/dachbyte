"use strict";

const platform = require("./services/platformService");
const configuration = require("./services/configurationService");
const access = require("./services/accessService");
const commercial = require("./services/commercialService");

module.exports = {
  ...platform,
  ...commercial,
  checkCapability: configuration.checkCapability,
  checkPermission: access.checkPermission,
  deleteConfigurationItem: configuration.deleteConfigurationItem,
  getCompanyConfiguration: configuration.getCompanyConfiguration,
  getCompanyUserAccess: access.getCompanyUserAccess,
  hasCompanyAccess: access.hasCompanyAccess,
  saveConfigurationItem: configuration.saveConfigurationItem,
  updateCompanyOverrides: configuration.updateCompanyOverrides,
  updateCompanySettings: configuration.updateCompanySettings,
};
