"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("sends a newly linked ML account to its management drawer in Seleção de plataforma", () => {
  const { postOAuthSelectionDestination } = require("../services/postOAuthDestination");

  assert.equal(
    postOAuthSelectionDestination({ moduleSlug: "ml", externalAccountId: "1012445923" }),
    "/selecao-plataforma?resource_key=ml%3A1012445923"
  );
});

test("refuses an invalid marketplace identity when building the post-OAuth destination", () => {
  const { postOAuthSelectionDestination } = require("../services/postOAuthDestination");

  assert.throws(
    () => postOAuthSelectionDestination({ moduleSlug: "ml", externalAccountId: "" }),
    /post_oauth_destination_invalid/
  );
});

test("Seleção de plataforma opens the linked account in the Contas view", () => {
  const portal = fs.readFileSync(path.join(__dirname, "../views/selecao-plataforma.html"), "utf8");

  assert.match(portal, /new URLSearchParams\(location\.search\)\.get\("resource_key"\)/);
  assert.match(portal, /setView\("accounts"\);[\s\S]*?openAccountDrawer\(linkedResourceKey\)/);
});
