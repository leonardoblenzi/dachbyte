"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const publicDirectory = path.join(__dirname, "..", "public");
const html = fs.readFileSync(path.join(publicDirectory, "index.html"), "utf8");
const styles = fs.readFileSync(path.join(publicDirectory, "styles.css"), "utf8");
const responsiveStyles = fs.readFileSync(path.join(publicDirectory, "responsive-shell.css"), "utf8");
const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");

function mediaBlock(source, breakpoint) {
  const marker = `@media(max-width:${breakpoint}px)`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing ${marker}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }
  throw new Error(`unterminated ${marker}`);
}

test("prototype shell exposes the shared light application contract", () => {
  assert.match(styles, /--purple:\s*#6c4cf4/i);
  assert.match(styles, /\.app\{[^}]*grid-template-columns:\s*202px 1fr/i);
  assert.match(styles, /\.topbar\{[^}]*height:\s*54px/i);
  assert.match(styles, /\.sidebar\{[^}]*background:\s*#fff/i);
  assert.match(styles, /\.card\{[^}]*border-radius:\s*14px/i);
  assert.match(styles, /\.chip\.green/);
  assert.match(styles, /@media\(max-width:1200px\)/);
  assert.match(html, /id="nav"/);
  assert.match(html, /id="content"/);
});

test("login and first-access content remains reachable without a false search landmark", () => {
  assert.doesNotMatch(styles, /body\{[^}]*overflow\s*:\s*hidden/i);
  assert.doesNotMatch(html, /class="topbar-search"[^>]*role="search"/i);
});

test("responsive shell keeps the shared breakpoint policy", () => {
  assert.match(responsiveStyles, /@media\(max-width:1200px\)/);
  assert.match(responsiveStyles, /@media\(max-width:650px\)/);
});

test("tablet navigation keeps every destination label visibly identifiable", () => {
  const tabletStyles = `${mediaBlock(styles, 1200)}\n${mediaBlock(responsiveStyles, 1200)}`;
  assert.doesNotMatch(tabletStyles, /nav-btn span[^}]*display\s*:\s*none/i);
  assert.match(tabletStyles, /nav-btn span[^}]*display\s*:\s*inline/i);
});

test("mobile shell keeps the sole logout action visible", () => {
  const mobileStyles = `${mediaBlock(styles, 650)}\n${mediaBlock(responsiveStyles, 650)}`;
  assert.match(html, /id="logoutBtn"/);
  assert.doesNotMatch(mobileStyles, /side-foot[^}]*display\s*:\s*none/i);
  assert.match(mobileStyles, /side-foot[^}]*display\s*:\s*(?:flex|grid|block)/i);
});

test("README records the prototype and real-data invariant", () => {
  assert.match(readme, /voltprice-prototype\.html/i);
  assert.match(readme, /não fabrica dados|nao fabrica dados/i);
});
