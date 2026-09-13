"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

if (process.env.VOLT_CHAT_API_ENABLED === "false" || process.env.VOLT_CHAT_INSTALL === "false") {
  console.log("[volt-corp] Instalacao da API do VoltChat desativada.");
  process.exit(0);
}

const rootDir = path.resolve(__dirname, "..");
const bundledPython = path.join(
  rootDir,
  ".venv-voltchat",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
const candidates = [
  process.env.VOLT_CHAT_PYTHON,
  fs.existsSync(bundledPython) ? bundledPython : null,
  process.platform === "win32" ? "python" : "python3",
  process.platform === "win32" ? "py" : "python",
].filter(Boolean);

const pythonCommand = candidates.find((candidate) => {
  const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
});

if (!pythonCommand) {
  console.error("[volt-corp] Python nao encontrado para instalar a API interna do VoltChat.");
  process.exit(1);
}

const importCheck = spawnSync(
  pythonCommand,
  ["-c", "import fastapi, uvicorn, sqlalchemy, jose, passlib, psycopg, multipart, openpyxl"],
  { stdio: "ignore" },
);

if (importCheck.status === 0) {
  console.log(`[volt-corp] Dependencias da API do VoltChat prontas (${pythonCommand}).`);
  process.exit(0);
}

console.log(`[volt-corp] Instalando dependencias da API do VoltChat com ${pythonCommand}...`);
const requirementsPath = path.join(rootDir, "chat", "backend", "requirements.txt");
const install = spawnSync(
  pythonCommand,
  ["-m", "pip", "install", "--disable-pip-version-check", "-r", requirementsPath],
  { cwd: rootDir, stdio: "inherit" },
);

if (install.error) throw install.error;
if (install.status !== 0) {
  console.error("[volt-corp] Falha ao instalar dependencias da API interna do VoltChat.");
  process.exit(install.status || 1);
}

console.log("[volt-corp] Dependencias da API do VoltChat instaladas.");
