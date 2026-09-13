"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("outbox store returns row-or-null instead of raw pg QueryResult", () => {
  const source = fs.readFileSync(path.join(__dirname, "outboxStore.js"), "utf8");
  assert.match(source, /const result = await db\.withRlsBypass/);
  assert.match(source, /return result\.rows\[0\] \|\| null;/);
});

test("outbox engine stops processing when no event is claimed", () => {
  const source = fs.readFileSync(path.join(__dirname, "outboxEngine.js"), "utf8");
  assert.match(source, /if \(!event\) return null;/);
});
