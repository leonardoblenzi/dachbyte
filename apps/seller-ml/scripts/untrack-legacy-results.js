"use strict";

const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..", "..", "..");
const target = "apps/seller-ml/results";

function run(args, options = {}) {
  return spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
}

const listed = run(["ls-files", target]);
if (listed.error) {
  console.error("Nao foi possivel executar git:", listed.error.message);
  process.exit(1);
}
if (listed.status !== 0) {
  process.stderr.write(listed.stderr || "");
  process.exit(listed.status || 1);
}

const tracked = String(listed.stdout || "")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

if (!tracked.length) {
  console.log("Nenhum arquivo de results/ permanece rastreado pelo Git.");
  process.exit(0);
}

console.log(`Removendo ${tracked.length} arquivo(s) de results/ apenas do indice Git...`);
const removed = run(
  ["rm", "-r", "--cached", "--ignore-unmatch", target],
  { stdio: "inherit", encoding: undefined },
);

if (removed.error) {
  console.error("Falha ao executar git rm --cached:", removed.error.message);
  process.exit(1);
}
if (removed.status !== 0) process.exit(removed.status || 1);

console.log("\nConcluido.");
console.log("Os arquivos fisicos continuam no disco; apenas deixaram de ser rastreados.");
console.log("Confira `git status` antes do commit.");
