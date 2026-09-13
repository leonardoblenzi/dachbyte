"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { attachJobReview } = require("../services/jobReviewHelper");

test("query action can be labeled as Gerar CSV", () => {
  const job = attachJobReview({ id: "10", completed: true }, {
    basePath: "/jobs",
    hasCsv: true,
    label: "Gerar CSV",
  });

  assert.equal(job.review_action.label, "Gerar CSV");
  assert.equal(job.review_action.url, "/jobs/10/download.csv");
});

test("completed export keeps Baixar CSV label", () => {
  const job = attachJobReview({ id: "11", completed: true }, {
    basePath: "/jobs",
    hasCsv: true,
    label: "Baixar CSV",
  });

  assert.equal(job.review_action.label, "Baixar CSV");
});
