"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function run(args, options = {}) {
  const result = spawnSync(npmCommand, args, {
    cwd: options.cwd || rootDir,
    env: options.env || process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`${npmCommand} ${args.join(" ")} falhou com status ${result.status}`);
    error.status = result.status;
    throw error;
  }
}

function runNode(script, options = {}) {
  const result = spawnSync(process.execPath, [script], {
    cwd: options.cwd || rootDir,
    env: options.env || process.env,
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`node ${script} falhou com status ${result.status}`);
    error.status = result.status;
    throw error;
  }
}

function buildRequiredProduct(name, dir, installArgs, buildArgs) {
  console.log(`[volt-corp] Build obrigatorio: ${name}`);
  run(installArgs, { cwd: dir });
  run(buildArgs, { cwd: dir });
}

function buildOptionalProduct(name, dir, installArgs, buildArgs, requiredEnv, buildEnv) {
  if (process.env[buildEnv] === "false") {
    console.warn(`[volt-corp] Build de ${name} desativado por ${buildEnv}=false.`);
    return;
  }

  if (!fs.existsSync(dir)) {
    console.warn(`[volt-corp] ${name} nao encontrado; seguindo sem este produto.`);
    return;
  }

  try {
    console.log(`[volt-corp] Build opcional: ${name}`);
    run(installArgs, { cwd: dir });
    run(buildArgs, { cwd: dir });
  } catch (error) {
    if (process.env[requiredEnv] === "true") throw error;
    console.warn(`[volt-corp] Build de ${name} ignorado neste ambiente: ${error.message}`);
  }
}

buildRequiredProduct(
  "Volt Core",
  path.join(rootDir, "core"),
  ["install", "--workspaces=false", "--package-lock=false", "--no-save"],
  ["run", "build"],
);

buildOptionalProduct(
  "Volt Stock",
  path.join(rootDir, "stock"),
  ["install", "--include=dev", "--package-lock=false", "--no-save"],
  ["run", "build"],
  "VOLT_STOCK_REQUIRED",
  "VOLT_STOCK_BUILD",
);

try {
  if (process.env.VOLT_CHAT_BUILD === "false") {
    console.warn("[volt-corp] Build de Volt Chat desativado por VOLT_CHAT_BUILD=false.");
  } else {
    console.log("[volt-corp] Build opcional: Volt Chat");
    runNode(path.join(__dirname, "build-volt-chat.js"));
  }
} catch (error) {
  if (process.env.VOLT_CHAT_REQUIRED === "true") throw error;
  console.warn(`[volt-corp] Build de Volt Chat ignorado neste ambiente: ${error.message}`);
}
