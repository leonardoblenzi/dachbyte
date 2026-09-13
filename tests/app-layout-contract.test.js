const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const moves = {
  server: "apps/gateway",
  ml: "apps/seller-ml",
  shopee: "apps/seller-shopee",
  MadeiraMadeira: "apps/seller-madeira",
  avantracking: "apps/seller-tracking",
  davanttilog: "apps/seller-log",
  LeaderSku: "apps/seller-leader",
  business: "apps/business",
};

test("DACHBYTE products live under apps with no legacy product directories", () => {
  // Ignored .env and node_modules may remain after git moves. They are local
  // state, not duplicate applications; test the versioned source layout.
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0");
  for (const [legacy, destination] of Object.entries(moves)) {
    assert.equal(fs.existsSync(path.join(root, destination)), true, destination);

    if (legacy !== "server") {
      assert.equal(tracked.some(file => file.startsWith(legacy + "/")), false, legacy);
    }
  }

  for (const product of ["core", "stock", "chat", "price"]) {
    assert.equal(fs.existsSync(path.join(root, "apps/business", product)), true, product);
  }
});
