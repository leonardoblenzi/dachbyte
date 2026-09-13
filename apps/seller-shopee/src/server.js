const createApp = require("./app");
const env = require("./config/env");
const { initWorkers, closeWorkers } = require("./config/queue");
const { startHubUsageReporter } = require("./services/hubUsageReporter");
const {
  startReportRetentionCleanup,
} = require("./services/AdminAccountPerformanceReportService");

const app = createApp();

const publicRoutes = require("./routes/public.routes");
app.use(publicRoutes);

let server;
let stopReportRetentionCleanup = null;

async function shutdown(signal) {
  console.log(`[server] shutting down after ${signal}`);

  if (stopReportRetentionCleanup) {
    stopReportRetentionCleanup();
    stopReportRetentionCleanup = null;
  }

  await closeWorkers().catch((error) => {
    console.error("[server] failed to close workers", error);
  });

  if (!server) {
    process.exit(0);
    return;
  }

  server.close((error) => {
    if (error) {
      console.error("[server] failed to close http server", error);
      process.exit(1);
      return;
    }

    process.exit(0);
  });
}

async function boot() {
  try {
    const queueStatus = await initWorkers();
    console.log("[server] queue workers ready", queueStatus);
  } catch (error) {
    console.error("[server] queue workers failed to initialize", error);
  }

  startHubUsageReporter();
  stopReportRetentionCleanup = startReportRetentionCleanup();

  server = app.listen(env.PORT, () => {
    console.log(`[server] listening on port ${env.PORT}`);
  });
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

boot().catch((error) => {
  console.error("[server] fatal startup error", error);
  process.exit(1);
});
