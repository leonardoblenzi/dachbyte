const configurations = new Map();

function save(configuration) {
  configurations.set(configuration.companyId, configuration);
  return configuration;
}

function findByCompanyId(companyId) {
  return configurations.get(companyId) || null;
}

function list() {
  return Array.from(configurations.values());
}

function clear() {
  configurations.clear();
}

module.exports = {
  save,
  findByCompanyId,
  list,
  clear,
};
