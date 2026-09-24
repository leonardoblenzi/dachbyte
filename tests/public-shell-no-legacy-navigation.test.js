"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.join(__dirname, "..");
const read = (...segments) => fs.readFileSync(path.join(root, ...segments), "utf8");

const publicShellPages = [
  ["apps", "gateway", "views", "seller", "landing-general.html"],
  ["apps", "gateway", "views", "seller", "landing-mercado-livre.html"],
  ["apps", "gateway", "views", "seller", "landing-shopee.html"],
  ["apps", "gateway", "views", "seller", "landing-tracking.html"],
  ["apps", "gateway", "views", "seller", "landing-magalu.html"],
  ["apps", "gateway", "views", "seller", "legal-magalu-terms.html"],
  ["apps", "gateway", "views", "seller", "legal-magalu-privacy.html"],
  ["apps", "business", "public", "landing.html"],
  ["apps", "business", "core", "public", "landing.html"],
  ["apps", "business", "stock", "apps", "web", "public", "landing.html"],
];

test("public Seller and Business landings start with the global shell without legacy navigation", () => {
  for (const page of publicShellPages) {
    const html = read(...page);
    assert.match(html, /<body>\s*<div data-dx-shell=/, page.join("/"));
    assert.doesNotMatch(html, /seller-nav|class="navbar"/, page.join("/"));
  }

  const core = read("apps", "business", "core", "public", "landing.html");
  assert.doesNotMatch(core, /<header>/, "Core must not render a competing local header");
});

test("Chat keeps product actions without rendering a second landing navigation", () => {
  const chat = read("apps", "business", "chat", "sordchat-frontend", "src", "pages", "Landing.js");

  assert.match(chat, /data-dx-shell="business"/);
  assert.match(chat, /DESKTOP_DOWNLOAD_URL/);
  assert.doesNotMatch(chat, /lp-nav-wrap|lp-nav-links/);
});

test("the global shell owns the Magalu entry and never hides an older header", () => {
  const shell = read("public", "brand", "dachbyte", "landing-experience.js");
  const css = read("public", "brand", "dachbyte", "landing-experience.css");

  assert.match(shell, /label: 'Magalu', href: '\/seller\/magalu', login: '\/go\/magalu'/);
  assert.doesNotMatch(shell, /hideLegacyNavigation|dx-legacy-nav/);
  assert.doesNotMatch(css, /dx-legacy-nav|seller-nav__inner|seller-nav__links/);
});

test("the global shell mounts only its header while the document is still parsing", () => {
  const shell = read("public", "brand", "dachbyte", "landing-experience.js");
  const deferredHeaderOnly = shell.indexOf("if (document.readyState === 'loading') return () => nav.remove();");
  const contact = shell.indexOf("const contact = document.createElement");

  assert.ok(deferredHeaderOnly >= 0, "the shell must defer page content during parsing");
  assert.ok(deferredHeaderOnly < contact, "contact and footer must wait for the parsed main element");
});
