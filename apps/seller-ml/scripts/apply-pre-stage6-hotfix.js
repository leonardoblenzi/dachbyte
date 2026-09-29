"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..", "..");

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function write(relative, content) {
  fs.writeFileSync(path.join(root, relative), content, "utf8");
}

function replaceExact(source, before, after, label) {
  // As âncoras do pacote são LF; preserve CRLF em checkouts Windows sem
  // enfraquecer a exigência de correspondência exata do trecho.
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const withSourceNewlines = (value) =>
    newline === "\r\n" ? value.replace(/\n/g, "\r\n") : value;
  before = withSourceNewlines(before);
  after = withSourceNewlines(after);

  if (source.includes(after)) return { source, changed: false, already: true };
  if (!source.includes(before)) {
    throw new Error(`Trecho esperado nao encontrado: ${label}`);
  }
  return {
    source: source.replace(before, after),
    changed: true,
    already: false,
  };
}

function applyRankingLock() {
  const file = "apps/seller-ml/routes/mercadolivreRankingRoutes.js";
  let source = read(file);
  let changed = false;

  const importBefore =
    'const { decryptToken } = require("../services/tokenCrypto");\n';
  const importAfter =
    'const { decryptToken } = require("../services/tokenCrypto");\n' +
    'const { withPgAdvisoryLock } = require("../services/pgAdvisoryLock");\n';

  let result = replaceExact(
    source,
    importBefore,
    importAfter,
    `${file}: import withPgAdvisoryLock`,
  );
  source = result.source;
  changed ||= result.changed;

  const fnBefore = `async function withSnapshotAdvisoryLock(fn) {
  const lockKey = "ml_ranking_monthly_snapshots";
  const lockedResult = await db.query(\`select pg_try_advisory_lock(hashtext($1)) as locked\`, [lockKey]);
  if (!lockedResult.rows?.[0]?.locked) {
    return { skipped: true, reason: "lock_not_acquired" };
  }
  try {
    return await fn();
  } finally {
    await db.query(\`select pg_advisory_unlock(hashtext($1))\`, [lockKey]).catch(() => null);
  }
}`;

  const fnAfter = `async function withSnapshotAdvisoryLock(fn) {
  return withPgAdvisoryLock("ml_ranking_monthly_snapshots", fn);
}`;

  result = replaceExact(
    source,
    fnBefore,
    fnAfter,
    `${file}: withSnapshotAdvisoryLock`,
  );
  source = result.source;
  changed ||= result.changed;

  if (changed) write(file, source);
  return { file, changed };
}

function applyStrategicLock() {
  const file = "apps/seller-ml/services/estrategicosService.js";
  let source = read(file);
  let changed = false;

  const importBefore =
    'const { decryptToken } = require("./tokenCrypto");\n';
  const importAfter =
    'const { decryptToken } = require("./tokenCrypto");\n' +
    'const { withPgAdvisoryLock } = require("./pgAdvisoryLock");\n';

  let result = replaceExact(
    source,
    importBefore,
    importAfter,
    `${file}: import withPgAdvisoryLock`,
  );
  source = result.source;
  changed ||= result.changed;

  const fnBefore = `async function reviewDueRounds({ limit = 50 } = {}) {
  const today = currentDateSaoPaulo();
  const lock = await db.query(\`select pg_try_advisory_lock(hashtext($1)) as locked\`, ["ml_strategic_due_reviews"]);
  if (!lock.rows?.[0]?.locked) return { success: true, skipped: true, reason: "lock_not_acquired" };
  try {
    const { rows } = await db.query(\`select id from ml_strategic_rounds where status in ('active','ready') and review_due_date <= $1::date order by review_due_date asc, id asc limit $2\`, [today, Math.max(1, Math.min(200, Number(limit) || 50))]);
    const output = [];
    for (const row of rows) {
      try {
        const result = await reviewRound({ roundId: row.id });
        output.push({ id: String(row.id), ok: true, impact: result.round?.impact || null });
      } catch (error) {
        await db.query(\`update ml_strategic_rounds set status = 'failed', impact = 'failed', confidence = 'low', error = $2, updated_at = now() where id = $1\`, [row.id, error?.message || String(error)]);
        output.push({ id: String(row.id), ok: false, error: error?.message || String(error) });
      }
    }
    return { success: true, checked_date: today, total: rows.length, rows: output };
  } finally {
    await db.query(\`select pg_advisory_unlock(hashtext($1))\`, ["ml_strategic_due_reviews"]).catch(() => null);
  }
}`;

  const fnAfter = `async function reviewDueRounds({ limit = 50 } = {}) {
  const today = currentDateSaoPaulo();
  return withPgAdvisoryLock("ml_strategic_due_reviews", async () => {
    const { rows } = await db.query(\`select id from ml_strategic_rounds where status in ('active','ready') and review_due_date <= $1::date order by review_due_date asc, id asc limit $2\`, [today, Math.max(1, Math.min(200, Number(limit) || 50))]);
    const output = [];
    for (const row of rows) {
      try {
        const result = await reviewRound({ roundId: row.id });
        output.push({ id: String(row.id), ok: true, impact: result.round?.impact || null });
      } catch (error) {
        await db.query(\`update ml_strategic_rounds set status = 'failed', impact = 'failed', confidence = 'low', error = $2, updated_at = now() where id = $1\`, [row.id, error?.message || String(error)]);
        output.push({ id: String(row.id), ok: false, error: error?.message || String(error) });
      }
    }
    return { success: true, checked_date: today, total: rows.length, rows: output };
  });
}`;

  result = replaceExact(
    source,
    fnBefore,
    fnAfter,
    `${file}: reviewDueRounds`,
  );
  source = result.source;
  changed ||= result.changed;

  if (changed) write(file, source);
  return { file, changed };
}

function applyHubGate() {
  const file = "apps/seller-ml/app.js";
  let source = read(file);
  let changed = false;

  const strictBefore = `  function shouldFailClosedHubGate() {
    const raw = String(
      process.env.ML_HUB_GATE_MODE ||
        process.env.HUB_AUTH_MODE ||
        process.env.HUB_ENFORCEMENT ||
        "hybrid",
    )
      .trim()
      .toLowerCase();

    return ["strict", "enforce", "enabled"].includes(raw);
  }`;

  const strictAfter = `  function isProductionRuntime() {
    return String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
  }

  function shouldFailClosedHubGate() {
    const fallback = isProductionRuntime() ? "strict" : "hybrid";
    const raw = String(
      process.env.ML_HUB_GATE_MODE ||
        process.env.HUB_AUTH_MODE ||
        process.env.HUB_ENFORCEMENT ||
        fallback,
    )
      .trim()
      .toLowerCase();

    return ["strict", "enforce", "enabled"].includes(raw);
  }

  function hubRequestTimeoutMs() {
    const configured = Number(
      process.env.ML_HUB_GATE_TIMEOUT_MS ||
        process.env.HUB_REQUEST_TIMEOUT_MS ||
        5000,
    );
    if (!Number.isFinite(configured) || configured < 500) return 5000;
    return Math.min(30000, Math.trunc(configured));
  }

  async function fetchHubWithTimeout(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), hubRequestTimeoutMs());
    timer.unref?.();
    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }`;

  let result = replaceExact(
    source,
    strictBefore,
    strictAfter,
    `${file}: strict production + timeout helpers`,
  );
  source = result.source;
  changed ||= result.changed;

  const fetchBefore =
    '      const response = await fetch(`${hubBaseUrl}/v1/access/check`, {';
  const fetchAfter =
    '      const response = await fetchHubWithTimeout(`${hubBaseUrl}/v1/access/check`, {';

  result = replaceExact(
    source,
    fetchBefore,
    fetchAfter,
    `${file}: hub access timeout`,
  );
  source = result.source;
  changed ||= result.changed;

  if (changed) write(file, source);
  return { file, changed };
}

function applyEnvExample() {
  const file = "infra/env/seller-ml.env.example";
  let source = read(file);
  const marker = "ML_HUB_GATE_MODE=strict\n";
  const addition =
    "ML_HUB_GATE_MODE=strict\n" +
    "# Timeout compartilhado das chamadas sincronas ao Hub. O gate limita internamente a 30s.\n" +
    "HUB_REQUEST_TIMEOUT_MS=5000\n" +
    "ML_HUB_GATE_TIMEOUT_MS=5000\n";

  if (source.includes("ML_HUB_GATE_TIMEOUT_MS=")) {
    return { file, changed: false };
  }
  if (!source.includes(marker)) {
    throw new Error(`Trecho esperado nao encontrado: ${file}: Hub gate env`);
  }
  source = source.replace(marker, addition);
  write(file, source);
  return { file, changed: true };
}

function main() {
  const results = [
    applyRankingLock(),
    applyStrategicLock(),
    applyHubGate(),
    applyEnvExample(),
  ];

  for (const result of results) {
    console.log(
      `${result.changed ? "ALTERADO" : "OK/JA APLICADO"}: ${result.file}`,
    );
  }

  console.log("\nHotfix pre-Etapa 6 aplicado com sucesso.");
}

try {
  main();
} catch (error) {
  console.error("\nHotfix abortado sem continuar:", error?.message || error);
  process.exit(1);
}
