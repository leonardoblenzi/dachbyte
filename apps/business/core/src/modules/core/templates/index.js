const general = require("./general");
const optical = require("./optical");

const templates = {
  [general.segmentKey]: general,
  [optical.segmentKey]: optical,
};

function getTemplateBySegment(segmentKey) {
  return templates[segmentKey] || null;
}

module.exports = {
  getTemplateBySegment,
  templates,
};
