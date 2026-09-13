"use strict";

const path = require("path");
const fs = require("fs");
const { spawn, spawnSync } = require("child_process");
const { createChatApiExitHandler } = require("./chatApiSupervisor");

const businessDir = path.join(__dirname, "..");
const rootDir = path.join(__dirname, "..", "..", "..");

function resolvePythonCommand() {
  const bundledPython = path.join(
    rootDir,
    ".venv-voltchat",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  return process.env.VOLT_CHAT_PYTHON
    || (fs.existsSync(bundledPython)
      ? bundledPython
      : process.platform === "win32" ? "python" : "python3");
}

async function waitForChatApi({ port, getExit }) {
  const timeoutMs = Number(process.env.VOLT_CHAT_STARTUP_TIMEOUT_MS || 90000);
  const deadline = Date.now() + timeoutMs;
  const healthUrl = `http://127.0.0.1:${port}/health`;
  let lastError = null;

  while (Date.now() < deadline) {
    const exit = getExit();
    if (exit) throw new Error(`processo Python encerrou (code=${exit.code}, signal=${exit.signal})`);
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        console.log(`[volt-corp] API interna do VoltChat pronta em ${healthUrl}.`);
        return;
      }
      lastError = new Error(`health check retornou ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`timeout aguardando ${healthUrl}: ${lastError?.message || "sem resposta"}`);
}

/**
 * Starts the private Python API that backs the Volt Chat UI. It is shared by
 * the standalone Business server and the root DACHBYTE gateway so both run
 * the UI and its API as one availability unit.
 */
async function startVoltChatApi({ terminateSuite = () => process.exit(1) } = {}) {
  if (process.env.VOLT_CHAT_API_ENABLED === "false") return { stop: () => {} };

  const dependencyCheck = spawnSync(
    process.execPath,
    [path.join(rootDir, "scripts", "install-volt-chat-api.js")],
    { env: process.env, stdio: "inherit" },
  );
  if (dependencyCheck.error) throw dependencyCheck.error;
  if (dependencyCheck.status !== 0) {
    throw new Error("Dependencias da API do VoltChat indisponiveis.");
  }

  const databaseUrl = process.env.VOLT_CHAT_DATABASE_URL
    || (process.env.NODE_ENV !== "production" ? process.env.DATABASE_URL || "sqlite:///./voltcorp.db" : null);
  const secretKey = process.env.VOLT_CHAT_SECRET_KEY
    || (process.env.NODE_ENV !== "production" ? process.env.SECRET_KEY || "voltchat-local-development-secret" : null);
  if (!databaseUrl) throw new Error("VOLT_CHAT_DATABASE_URL e obrigatoria em producao.");
  if (!secretKey) throw new Error("VOLT_CHAT_SECRET_KEY e obrigatoria em producao.");

  const port = String(process.env.VOLT_CHAT_API_PORT || "8001");
  let shuttingDown = false;
  let exit = null;
  const child = spawn(
    resolvePythonCommand(),
    ["-m", "uvicorn", "sordchat_fixed:app", "--host", "127.0.0.1", "--port", port, "--workers", "1"],
    {
      cwd: path.join(businessDir, "chat", "backend"),
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        SECRET_KEY: secretKey,
        AUTO_MIGRATE_DB: process.env.AUTO_MIGRATE_DB || "true",
        PORT: port,
        PYTHONUNBUFFERED: "1",
      },
      stdio: "inherit",
    },
  );

  child.on("error", (error) => {
    console.error("[volt-corp] Nao foi possivel iniciar a API interna do VoltChat:", error);
  });
  child.on("exit", createChatApiExitHandler({
    isShuttingDown: () => shuttingDown,
    onChatApiExit: (nextExit) => { exit = nextExit; },
    terminateSuite,
  }));

  try {
    await waitForChatApi({ port, getExit: () => exit });
  } catch (error) {
    shuttingDown = true;
    if (!child.killed) child.kill("SIGTERM");
    throw error;
  }

  return {
    stop() {
      shuttingDown = true;
      if (!child.killed) child.kill("SIGTERM");
    },
  };
}

module.exports = { startVoltChatApi };
