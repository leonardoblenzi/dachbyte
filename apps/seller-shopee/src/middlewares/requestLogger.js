const morgan = require("morgan");

function requestLogger() {
  return morgan(":method :url :status :res[content-length] - :response-time ms");
}

module.exports = requestLogger;