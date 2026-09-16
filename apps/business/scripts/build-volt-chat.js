"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const frontendDir = path.join(__dirname, "..", "chat", "sordchat-frontend");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npmEnv = {
  ...process.env,
  npm_config_cache: process.env.npm_config_cache || path.join(frontendDir, ".npm-cache"),
};

function run(args, env = process.env) {
  const result = spawnSync(npmCommand, args, {
    cwd: frontendDir,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

if (!fs.existsSync(path.join(frontendDir, "node_modules"))) {
  run(["install", "--package-lock=false", "--no-save", "--include=dev"], npmEnv);
}

run(["run", "build"], {
  ...npmEnv,
  PUBLIC_URL: process.env.VOLT_CHAT_PUBLIC_PATH || "/business/chat",
  REACT_APP_API_URL: process.env.VOLT_CHAT_PUBLIC_API_URL || "/business/chat/api",
  REACT_APP_WS_URL: process.env.VOLT_CHAT_PUBLIC_WS_URL || "",
  REACT_APP_DESKTOP_DOWNLOAD_URL:
    process.env.VOLT_CHAT_DESKTOP_DOWNLOAD_URL ||
    "https://www.voltcorporation.com.br/business/chat/api/downloads/desktop/latest",
  REACT_APP_DESKTOP_PACKAGE_DOWNLOAD_URL:
    process.env.VOLT_CHAT_DESKTOP_PACKAGE_URL ||
    "https://www.voltcorporation.com.br/business/chat/api/downloads/desktop/package",
});
