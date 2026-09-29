"use strict";

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const mlRoot = path.resolve(__dirname, "..");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function versionFromLock(lock) {
  return lock?.packages?.["node_modules/multer"]?.version || null;
}

function main() {
  const mlPackage = readJson(path.join(mlRoot, "package.json"));
  if (mlPackage?.dependencies?.multer !== "2.4.0") {
    throw new Error("seller-ml/package.json deve fixar multer em 2.4.0.");
  }

  const rootLockPath = path.join(repoRoot, "package-lock.json");
  if (!fs.existsSync(rootLockPath)) {
    throw new Error("package-lock.json raiz nao encontrado. Rode npm install na raiz do repositorio.");
  }
  const rootLock = readJson(rootLockPath);
  const rootVersion = versionFromLock(rootLock);
  if (rootVersion !== "2.4.0") {
    throw new Error(
      `Lockfile raiz ainda resolve multer=${rootVersion || "desconhecido"}. Rode npm install na raiz do repositorio.`,
    );
  }

  const nestedLockPath = path.join(mlRoot, "package-lock.json");
  if (fs.existsSync(nestedLockPath)) {
    const nestedLock = readJson(nestedLockPath);
    const nestedVersion = versionFromLock(nestedLock);
    if (nestedVersion && nestedVersion !== "2.4.0") {
      throw new Error(
        `apps/seller-ml/package-lock.json ainda resolve multer=${nestedVersion}. Rode npm --prefix apps/seller-ml install --package-lock-only --ignore-scripts --workspaces=false.`,
      );
    }
  }

  console.log("[Etapa 5] dependencia Multer 2.4.0 confirmada nos lockfiles.");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error?.message || error);
    process.exit(1);
  }
}

module.exports = { main, versionFromLock };
