// services/promoJobsService.js
/**
 * PromoJobsService
 * - Fila Bull baseada em Redis para aplicar promoções em MASSA
 * - Varrimento com filtros (status / % máx / MLB)
 * - Chama a API oficial do ML
 *
 * Requer: REDIS_URL ou REDIS_HOST/REDIS_PORT
 */

const Queue = require('bull');
const crypto = require('crypto');
const os = require('os');
const fetch = require('node-fetch');
const ExcelJS = require('exceljs');
const TokenService = require('./tokenService');
const { makeBullClient, getSharedRedis } = require('../lib/redisClient');
const { buildCsv, attachJobReview } = require('./jobReviewHelper');
const { recordAuthEvent, listAuthEvents } = require('./authAuditService');
const PromoSelectionStore = require('./promoSelectionStore');
const { reserveCredits, settleCredits } = require('./hubCreditsService');

// Concurrency do worker (ajustável por env)
const CONCURRENCY = Number(process.env.PROMO_JOBS_CONCURRENCY || 4);
const LIST_VALIDATION_MAX_ACTIVE_PER_ACCOUNT = Math.max(
  1,
  Number(process.env.PROMO_LIST_VALIDATION_MAX_ACTIVE_PER_ACCOUNT || 2),
);
const MANUAL_PROMO_MAX_PERCENT = 60;
const MANUAL_PROMO_PERCENT_TOLERANCE = Math.max(
  0,
  Number(process.env.PROMO_MANUAL_PERCENT_TOLERANCE || 1),
);
const MANUAL_PROMO_PERCENT_LOWER_ROUNDING_TOLERANCE = Math.max(
  0,
  Number(process.env.PROMO_MANUAL_PERCENT_LOWER_ROUNDING_TOLERANCE || 1),
);
const POST_APPLY_VERIFY_ATTEMPTS = Math.max(
  1,
  Number(process.env.PROMO_POST_APPLY_VERIFY_ATTEMPTS || 4),
);
const POST_APPLY_VERIFY_DELAY_MS = Math.max(
  100,
  Number(process.env.PROMO_POST_APPLY_VERIFY_DELAY_MS || 500),
);
const SMART_POST_APPLY_VERIFY_ATTEMPTS = Math.max(
  POST_APPLY_VERIFY_ATTEMPTS,
  Number(process.env.PROMO_SMART_POST_APPLY_VERIFY_ATTEMPTS || 8),
);
const SMART_POST_APPLY_VERIFY_DELAY_MS = Math.max(
  POST_APPLY_VERIFY_DELAY_MS,
  Number(process.env.PROMO_SMART_POST_APPLY_VERIFY_DELAY_MS || 1000),
);
const PROMO_CRITICAL_DIVERGENCE_THRESHOLD = Math.max(
  2,
  Number(process.env.PROMO_CRITICAL_DIVERGENCE_THRESHOLD || 2),
);
const PROMO_REMEDIATION_ATTEMPTS = Math.max(
  2,
  Number(process.env.PROMO_REMEDIATION_ATTEMPTS || 4),
);
const PROMO_TRANSIENT_RETRY_ATTEMPTS = Math.max(
  1,
  Number(process.env.PROMO_TRANSIENT_RETRY_ATTEMPTS || 4),
);
const PROMO_TRANSIENT_RETRY_BASE_MS = Math.max(
  500,
  Number(process.env.PROMO_TRANSIENT_RETRY_BASE_MS || 2000),
);
const PROMO_TRANSIENT_RETRY_MAX_MS = Math.max(
  PROMO_TRANSIENT_RETRY_BASE_MS,
  Number(process.env.PROMO_TRANSIENT_RETRY_MAX_MS || 30000),
);
async function readBullJobProgress(job, fallback = 0) {
  try {
    const value = typeof job?.progress === 'function' ? job.progress() : fallback;
    const resolved = await Promise.resolve(value);
    const parsed = Number(resolved);
    return Number.isFinite(parsed) ? parsed : Number(fallback || 0);
  } catch {
    return Number(fallback || 0);
  }
}

const PROMO_TRACE_MAX_ENTRIES = Math.max(
  1000,
  Number(process.env.PROMO_TRACE_MAX_ENTRIES || 20000),
);

const PROMO_ITEM_MAX_CONCURRENCY = Math.max(
  1,
  Math.min(5, Number(process.env.PROMO_ITEM_MAX_CONCURRENCY || 2)),
);
const PROMO_ITEM_SENTINEL_COUNT = Math.max(
  1,
  Number(process.env.PROMO_ITEM_SENTINEL_COUNT || 10),
);
const PROMO_ITEM_HEALTHY_STREAK_TO_SCALE = Math.max(
  2,
  Number(process.env.PROMO_ITEM_HEALTHY_STREAK_TO_SCALE || 10),
);
const PROMO_ACCOUNT_ITEM_CONCURRENCY = Math.max(
  1,
  Math.min(10, Number(process.env.PROMO_ACCOUNT_ITEM_CONCURRENCY || 2)),
);
const PROMO_ACCOUNT_LEASE_MS = Math.max(
  60000,
  Number(process.env.PROMO_ACCOUNT_LEASE_MS || 10 * 60 * 1000),
);
const PROMO_THROUGHPUT_WINDOW = Math.max(
  10,
  Math.min(500, Number(process.env.PROMO_THROUGHPUT_WINDOW || 100)),
);

// Orquestracao global: evita que um unico usuario/campanha monopolize a fila.
const PROMO_MAX_ACTIVE_JOBS_PER_ACCOUNT = Math.max(
  1,
  Math.min(10, Number(process.env.PROMO_MAX_ACTIVE_JOBS_PER_ACCOUNT || 2)),
);
const PROMO_RUNTIME_LEASE_MS = Math.max(
  30000,
  Number(process.env.PROMO_RUNTIME_LEASE_MS || 2 * 60 * 1000),
);
const PROMO_OPEN_GUARD_MS = Math.max(
  5 * 60 * 1000,
  Number(process.env.PROMO_OPEN_GUARD_MS || 7 * 24 * 60 * 60 * 1000),
);
const PROMO_GUARD_RESERVATION_MS = Math.max(
  5000,
  Number(process.env.PROMO_GUARD_RESERVATION_MS || 30000),
);
const PROMO_JOB_CHUNK_SIZE = Math.max(
  10,
  Math.min(500, Number(process.env.PROMO_JOB_CHUNK_SIZE || 50)),
);
const PROMO_JOB_MAX_YIELD_ATTEMPTS = Math.max(
  100,
  Number(process.env.PROMO_JOB_MAX_YIELD_ATTEMPTS || 10000),
);
const PROMO_JOB_YIELD_DELAY_MS = Math.max(
  250,
  Number(process.env.PROMO_JOB_YIELD_DELAY_MS || 1500),
);
const PROMO_PROGRESS_FLUSH_EVERY = Math.max(
  1,
  Number(process.env.PROMO_PROGRESS_FLUSH_EVERY || 5),
);
const PROMO_PROGRESS_FLUSH_MS = Math.max(
  500,
  Number(process.env.PROMO_PROGRESS_FLUSH_MS || 2500),
);
const PROMO_WORKER_HEARTBEAT_MS = Math.max(
  2000,
  Number(process.env.PROMO_WORKER_HEARTBEAT_MS || 5000),
);
const PROMO_WORKER_STALE_MS = Math.max(
  PROMO_WORKER_HEARTBEAT_MS * 3,
  Number(process.env.PROMO_WORKER_STALE_MS || 30000),
);
const PROMO_ACTIVE_STALE_MS = Math.max(
  60 * 1000,
  Number(process.env.PROMO_ACTIVE_STALE_MS || 5 * 60 * 1000),
);
const PROMO_CANCEL_TOMBSTONE_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.PROMO_CANCEL_TOMBSTONE_MS || 7 * 24 * 60 * 60 * 1000),
);

// === Adapter opcional para remoção em massa (reutiliza seu service atual)
let RemovalAdapter = null;
try {
  // Troque o caminho dentro do adapter NOVO (promoBulkRemoveAdapter.js) para apontar ao seu service
  RemovalAdapter = require('./promoBulkRemoveAdapter');
} catch {
  RemovalAdapter = null; // se não existir, o job de remoção avisará "não configurado"
}

let queue;
let workerStarted = false;
let workerHeartbeatTimer = null;
let workerWatchdogTimer = null;
const localActivePromoJobs = new Set();
const WORKER_INSTANCE_ID =
  process.env.RENDER_INSTANCE_ID ||
  process.env.HOSTNAME ||
  `${os.hostname()}:${process.pid}`;

class JobCancelledError extends Error {
  constructor(message = "Job cancelado pelo usuario.") {
    super(message);
    this.name = "JobCancelledError";
  }
}

class PromoFairnessYieldError extends Error {
  constructor(message = "PROMO_YIELD: aguardando disponibilidade da conta.") {
    super(message);
    this.name = "PromoFairnessYieldError";
    this.code = "PROMO_FAIRNESS_YIELD";
  }
}

class PromoCooperativeYieldError extends Error {
  constructor(message = "PROMO_YIELD: lote cooperativo devolveu o slot para a fila.") {
    super(message);
    this.name = "PromoCooperativeYieldError";
    this.code = "PROMO_COOPERATIVE_YIELD";
  }
}

function isInternalYieldError(error) {
  const code = String(error?.code || "");
  const name = String(error?.name || "");
  const message = String(error?.message || "");
  return (
    code === "PROMO_FAIRNESS_YIELD" ||
    code === "PROMO_COOPERATIVE_YIELD" ||
    name === "PromoFairnessYieldError" ||
    name === "PromoCooperativeYieldError" ||
    message.startsWith("PROMO_YIELD:")
  );
}

class PromotionSafetyCircuitBreakerError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = "PromotionSafetyCircuitBreakerError";
    this.details = details;
  }
}

function ensureQueue() {
  if (queue) return queue;

  queue = new Queue('promo-jobs', {
    createClient: (type) => makeBullClient(type, 'promo-jobs')
  });
  queue.on('error', (e) => console.error('PromoJobsService Queue error:', e.message));
  queue.on('active', (job) => {
    if (job?.id != null) localActivePromoJobs.add(String(job.id));
  });
  queue.on('stalled', (job) => {
    console.error(`[PromoJobsService] Job stalled detectado: ${job?.id || '?'}`);
  });
  queue.on('failed', async (job, err) => {
    if (job?.id != null) localActivePromoJobs.delete(String(job.id));
    if (isInternalYieldError(err)) {
      console.log(`[PromoJobsService] Job ${job?.id} cedeu o worker: ${err?.message || err}`);
      return;
    }
    const data = job?.data || {};
    if (isPromotionChunkData(data)) {
      // O chunk e infraestrutura interna. O estado terminal pertence a operacao pai.
      console.error('PromoJobsService Chunk failed:', job?.id, err?.message);
      return;
    }
    console.error('PromoJobsService Job failed:', job?.id, err?.message);
    if (isLogicalPromotionOperationData(data)) {
      // O job Bull pai termina rapidamente apos agendar o primeiro chunk. Recursos
      // sao liquidados somente quando a operacao logica ficar terminal.
      return;
    }
    if (data?.safetyPaused !== true && data?.resumable !== true) {
      await settleCredits(data?.creditReservation, { release: true });
      await releaseCampaignGuard(data, String(job?.id || ''));
    }
  });
  queue.on('completed', async (job, result) => {
    if (job?.id != null) localActivePromoJobs.delete(String(job.id));
    const data = job?.data || {};
    if (isPromotionChunkData(data)) {
      return;
    }
    console.log(`PromoJobsService Job completed: ${job?.id}`, result);
    if (isLogicalPromotionOperationData(data)) {
      // Bull completed != operacao concluida. O pai permanece como registro
      // logico e recebe progresso dos chunks internos.
      if (data?.operationTerminal === true) {
        await settleLogicalOperationResources(job, { releaseCredits: false });
      }
      return;
    }
    await settleCredits(data?.creditReservation, { release: false });
    if (!jobHasPendingRemediation(data)) {
      await releaseCampaignGuard(data, String(job?.id || ''));
    }
  });

  return queue;
}

async function checkCancelled(job) {
  const latest = await job.queue.getJob(job.id).catch(() => null);
  const data = latest?.data || job.data || {};
  if (data?.cancelRequested === true) {
    throw new JobCancelledError();
  }
}

async function latestJobData(job) {
  const latest = await job.queue.getJob(job.id).catch(() => null);
  return latest?.data || job.data || {};
}

function isTransientMlFailure(result = {}) {
  const status = Number(result?.status);
  const errorText = safeText(
    result?.error || result?.message || result?.body?.message || '',
  );
  if (status === 429) return true;
  if (Number.isFinite(status) && status >= 500) return true;
  if (
    !Number.isFinite(status) &&
    /fetch|network|socket|econn|etimedout|timeout|dns|enotfound|eai_again/i.test(errorText)
  ) {
    return true;
  }
  return false;
}

function transientRetryReason(result = {}) {
  const status = Number(result?.status);
  if (status === 429) return 'O Mercado Livre limitou temporariamente as requisicoes.';
  if (Number.isFinite(status) && status >= 500) {
    return `O Mercado Livre respondeu com erro temporario HTTP ${status}.`;
  }
  return 'A comunicacao com o Mercado Livre falhou temporariamente.';
}

function parseRetryAfterMs(response) {
  const raw = response?.headers?.get?.('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const when = Date.parse(raw);
  if (!Number.isFinite(when)) return null;
  return Math.max(0, when - Date.now());
}

function transientRetryDelayMs(attempt, retryAfterMs = null) {
  if (Number.isFinite(Number(retryAfterMs)) && Number(retryAfterMs) >= 0) {
    return Math.min(PROMO_TRANSIENT_RETRY_MAX_MS, Math.max(500, Number(retryAfterMs)));
  }
  const exponent = Math.max(0, Number(attempt || 1) - 1);
  const base = Math.min(
    PROMO_TRANSIENT_RETRY_MAX_MS,
    PROMO_TRANSIENT_RETRY_BASE_MS * (2 ** exponent),
  );
  const jitter = Math.floor(Math.random() * Math.min(1000, Math.max(250, base * 0.2)));
  return Math.min(PROMO_TRANSIENT_RETRY_MAX_MS, base + jitter);
}

async function waitForRetry(job, delayMs) {
  const end = Date.now() + Math.max(0, Number(delayMs || 0));
  while (Date.now() < end) {
    await checkCancelled(job);
    const remaining = end - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(1, remaining))));
  }
  await checkCancelled(job);
}

function promoAccountSemaphoreKey(accountKey, mlCreds = {}) {
  const raw = String(
    accountKey || mlCreds?.meli_conta_id || mlCreds?.user_id || mlCreds?.seller_id || 'default',
  );
  const digest = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 20);
  return `promo:item-slots:${digest}`;
}

async function acquirePromoAccountSlot(job, { accountKey, mlCreds, itemId } = {}) {
  if (PROMO_ACCOUNT_ITEM_CONCURRENCY <= 0) return async () => {};
  const redis = getSharedRedis('promo:item-semaphore');
  const key = promoAccountSemaphoreKey(accountKey, mlCreds);
  const token = `${process.pid}:${job?.id || 'job'}:${itemId || 'item'}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const script = `
    redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
    local count = redis.call('ZCARD', KEYS[1])
    if count < tonumber(ARGV[3]) then
      redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
      redis.call('PEXPIRE', KEYS[1], ARGV[5])
      return 1
    end
    return 0
  `;
  let acquired = false;
  try {
    while (!acquired) {
      await checkCancelled(job);
      const now = Date.now();
      const expiresAt = now + PROMO_ACCOUNT_LEASE_MS;
      acquired = Number(
        await redis.eval(
          script,
          1,
          key,
          now,
          expiresAt,
          PROMO_ACCOUNT_ITEM_CONCURRENCY,
          token,
          PROMO_ACCOUNT_LEASE_MS * 2,
        ),
      ) === 1;
      if (!acquired) {
        await new Promise((resolve) => setTimeout(resolve, 120 + Math.floor(Math.random() * 180)));
      }
    }
  } catch (error) {
    console.warn('[PromoJobsService] semaphore Redis indisponivel; usando limite local:', error?.message || error);
    return async () => {};
  }
  return async () => {
    try {
      await redis.zrem(key, token);
    } catch {}
  };
}

function createAdaptiveItemController({ total = 0, maxLimit: requestedMaxLimit = PROMO_ITEM_MAX_CONCURRENCY } = {}) {
  let currentLimit = 1;
  let healthyStreak = 0;
  let completed = 0;
  let safetyStop = false;
  const completionTimes = [];
  const maxLimit = Math.max(1, Math.min(PROMO_ITEM_MAX_CONCURRENCY, Number(requestedMaxLimit || 1)));
  const sentinelTarget = Math.min(Math.max(1, PROMO_ITEM_SENTINEL_COUNT), Math.max(1, Number(total || PROMO_ITEM_SENTINEL_COUNT)));

  function metrics() {
    let itemsPerMinute = null;
    if (completionTimes.length >= 2) {
      const elapsed = completionTimes[completionTimes.length - 1] - completionTimes[0];
      if (elapsed > 0) {
        itemsPerMinute = ((completionTimes.length - 1) * 60000) / elapsed;
      }
    }
    const remaining = Math.max(0, Number(total || 0) - completed);
    const etaSeconds = itemsPerMinute && itemsPerMinute > 0
      ? Math.round((remaining / itemsPerMinute) * 60)
      : null;
    return {
      currentConcurrency: currentLimit,
      maxConcurrency: maxLimit,
      sentinelTarget,
      healthyStreak,
      itemsPerMinute: itemsPerMinute == null ? null : Number(itemsPerMinute.toFixed(2)),
      etaSeconds,
    };
  }

  return {
    get limit() { return currentLimit; },
    get stopped() { return safetyStop; },
    stop() { safetyStop = true; },
    onTransient() {
      healthyStreak = 0;
      currentLimit = 1;
    },
    onCompleted({ healthy = true, transientRetries = 0 } = {}) {
      completed += 1;
      const now = Date.now();
      completionTimes.push(now);
      if (completionTimes.length > PROMO_THROUGHPUT_WINDOW) completionTimes.shift();
      if (!healthy || Number(transientRetries || 0) > 0) {
        healthyStreak = 0;
        currentLimit = 1;
        return metrics();
      }
      healthyStreak += 1;
      if (
        maxLimit > currentLimit &&
        completed >= sentinelTarget &&
        healthyStreak >= PROMO_ITEM_HEALTHY_STREAK_TO_SCALE
      ) {
        currentLimit = Math.min(maxLimit, currentLimit + 1);
        healthyStreak = 0;
      }
      return metrics();
    },
    metrics,
  };
}

async function runAdaptiveItems(job, items, processFn, controller) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return;
  let index = 0;
  const active = new Set();
  let fatalError = null;

  const launch = (item) => {
    const task = (async () => {
      try {
        return await processFn(item);
      } catch (error) {
        if (error instanceof PromotionSafetyCircuitBreakerError || error instanceof JobCancelledError) {
          fatalError = fatalError || error;
          controller.stop();
        } else {
          fatalError = fatalError || error;
          controller.stop();
        }
        throw error;
      }
    })();
    active.add(task);
    task.finally(() => active.delete(task)).catch(() => {});
  };

  while ((index < list.length || active.size > 0) && !fatalError) {
    await checkCancelled(job);
    while (
      index < list.length &&
      !controller.stopped &&
      !fatalError &&
      active.size < controller.limit
    ) {
      launch(list[index++]);
    }
    if (!active.size) break;
    await Promise.race([...active].map((p) => p.catch(() => null)));
  }

  if (active.size) {
    await Promise.allSettled([...active]);
  }
  if (fatalError) throw fatalError;
}

async function runApplyWithTransientRetry(
  job,
  applyFn,
  { itemId = null, verifyAfterTransient = null, onTransient = null } = {},
) {
  const attempts = [];
  for (let attempt = 1; attempt <= PROMO_TRANSIENT_RETRY_ATTEMPTS; attempt++) {
    await checkCancelled(job);
    let result;
    try {
      result = await applyFn();
    } catch (error) {
      result = {
        ok: false,
        status: null,
        error: error?.message || String(error),
        body: null,
      };
    }

    const transient = isTransientMlFailure(result);
    if (transient && typeof onTransient === 'function') {
      try { onTransient(result, { attempt }); } catch {}
    }

    // Timeout/socket e alguns 5xx sao ambiguos: o ML pode ter aplicado a oferta e
    // apenas perdido a resposta. Antes de reenviar (especialmente LIGHTNING, que
    // nao pode ser editada depois de iniciada), consulte o estado real no ML.
    if (
      transient &&
      Number(result?.status) !== 429 &&
      typeof verifyAfterTransient === "function"
    ) {
      try {
        const verification = await verifyAfterTransient(result, { attempt });
        if (verification?.ok === true) {
          const current = await latestJobData(job);
          const otherRetry =
            current?.transientRetry?.active === true &&
            String(current?.transientRetry?.itemId || '') !== String(itemId || '')
              ? current.transientRetry
              : null;
          await job.update({
            ...current,
            transientRetry: otherRetry,
            stateLabel: otherRetry
              ? current?.stateLabel || "aguardando retomada automatica"
              : "processando apos confirmacao de resposta ambigua",
            lastUpdate: Date.now(),
          }).catch(() => {});
          await auditPromoJobEvent(
            job,
            "promotion_transient_apply_confirmed_without_retry",
            "warn",
            {
              mlb_id: itemId || null,
              original_status: result?.status ?? null,
              attempt,
              actual_percent: verification?.actual_percent ?? null,
              reason: verification?.reason || "estado confirmado no ML antes do retry",
            },
          );
          return {
            result: {
              ...result,
              ok: true,
              status: result?.status || 202,
              body: {
                ...(result?.body && typeof result.body === "object" ? result.body : {}),
                recovered_by_post_apply_confirmation: true,
              },
              recovered_by_post_apply_confirmation: true,
              transient_confirmation: verification,
            },
            retries: attempts.length,
            retry_attempts: attempts,
            recovered_by_confirmation: true,
          };
        }
      } catch (verificationError) {
        await auditPromoJobEvent(
          job,
          "promotion_transient_apply_confirmation_failed",
          "warn",
          {
            mlb_id: itemId || null,
            original_status: result?.status ?? null,
            attempt,
            reason: safeText(
              verificationError?.message || String(verificationError),
            ),
          },
        );
      }
    }

    if (result?.ok || !transient || attempt >= PROMO_TRANSIENT_RETRY_ATTEMPTS) {
      if (attempts.length > 0) {
        const current = await latestJobData(job);
        const otherRetry =
          current?.transientRetry?.active === true &&
          String(current?.transientRetry?.itemId || '') !== String(itemId || '')
            ? current.transientRetry
            : null;
        await job.update({
          ...current,
          transientRetry: otherRetry,
          stateLabel: otherRetry
            ? current?.stateLabel || "aguardando retomada automatica"
            : result?.ok
              ? "processando apos retomada automatica"
              : current?.stateLabel || "processando",
          lastUpdate: Date.now(),
        }).catch(() => {});
      }
      return {
        result,
        retries: attempts.length,
        retry_attempts: attempts,
      };
    }

    const delayMs = transientRetryDelayMs(attempt, result?.retry_after_ms);
    const retryAt = Date.now() + delayMs;
    const reason = transientRetryReason(result);
    attempts.push({
      attempt,
      status: result?.status ?? null,
      delay_ms: delayMs,
      scheduled_at: new Date().toISOString(),
      retry_at: new Date(retryAt).toISOString(),
      reason,
    });

    const current = await latestJobData(job);
    await job.update({
      ...current,
      stateLabel: `aguardando retomada automatica: tentativa ${attempt + 1}/${PROMO_TRANSIENT_RETRY_ATTEMPTS}`,
      transientRetry: {
        active: true,
        itemId: itemId || null,
        attempt: attempt + 1,
        maxAttempts: PROMO_TRANSIENT_RETRY_ATTEMPTS,
        delayMs,
        retryAt,
        reason,
        lastStatus: result?.status ?? null,
      },
      lastUpdate: Date.now(),
    }).catch(() => {});

    await auditPromoJobEvent(job, 'promotion_transient_retry_scheduled', 'warn', {
      mlb_id: itemId || null,
      retry_attempt: attempt + 1,
      retry_max_attempts: PROMO_TRANSIENT_RETRY_ATTEMPTS,
      retry_delay_ms: delayMs,
      retry_at: new Date(retryAt).toISOString(),
      ml_status: result?.status ?? null,
      reason,
    });
    await waitForRetry(job, delayMs);
  }

  return {
    result: { ok: false, status: 503, error: 'Falha temporaria sem resultado final.' },
    retries: attempts.length,
    retry_attempts: attempts,
  };
}

/* ------------------------- Helpers genéricos ------------------------- */

const extractAccessToken = (ret) =>
  (typeof ret === 'string' ? ret : ret?.access_token || null);

function updateMlCredsFromToken(mlCreds = {}, tokenData = {}) {
  const token = extractAccessToken(tokenData);
  if (token) mlCreds.access_token = token;
  if (tokenData?.refresh_token) mlCreds.refresh_token = tokenData.refresh_token;
  if (tokenData?.expires_in) {
    mlCreds.access_expires_at = new Date(
      Date.now() + Number(tokenData.expires_in) * 1000
    ).toISOString();
  }
  return token;
}

async function authFetch(url, init = {}, mlCreds = {}) {
  const call = async (tkn) => {
    const headers = {
      ...(init.headers || {}),
      Authorization: `Bearer ${tkn}`,
      Accept: 'application/json'
    };
    return fetch(url, { ...init, headers });
  };

  let token = mlCreds?.access_token || null;
  if (!token) {
    const t = await TokenService.renovarTokenSeNecessario(mlCreds);
    token = typeof t === 'string' ? t : updateMlCredsFromToken(mlCreds, t);
    if (token) mlCreds.access_token = token;
  }

  let resp = await call(token);
  if (resp.status !== 401) return resp;

  const renewed = await TokenService.renovarToken(mlCreds);
  const newToken = updateMlCredsFromToken(mlCreds, renewed);
  return call(newToken);
}

async function fetchCurrentListingPrice(mlCreds = {}, itemId) {
  const id = String(itemId || '').trim();
  if (!id) return null;
  // /items.price e o preco regular atual do anuncio; nao usar sale_price como base
  // para evitar desconto em cascata quando ja existe promocao ativa.
  const url = `https://api.mercadolibre.com/items/${encodeURIComponent(
    id
  )}?attributes=price`;
  const response = await authFetch(url, {}, mlCreds).catch(() => null);
  if (!response?.ok) return null;
  const body = await response.json().catch(() => null);
  return toNum(body?.price);
}

function resolveManualPercentBasePrice(item = {}, currentListingPrice = null) {
  const candidates = [
    item?.original_price,
    item?.item_original_price,
    item?.regular_amount,
    item?.base_price,
    currentListingPrice,
    item?.price,
  ]
    .map(toNum)
    .filter((value) => value != null && value > 0);

  if (!candidates.length) return null;
  return Math.max(...candidates);
}

function mergeFreshPromotionItem(base = {}, fresh = null) {
  if (!fresh || typeof fresh !== 'object') return base || {};
  const merged = { ...(base || {}), ...fresh };
  merged.id = base?.id || base?.item_id || fresh?.id || fresh?.item_id || null;
  merged.item_id = base?.item_id || base?.id || fresh?.item_id || fresh?.id || null;
  merged.original_price =
    fresh.original_price ?? base?.original_price ?? base?.item_original_price ?? null;
  merged.item_original_price =
    fresh.item_original_price ?? base?.item_original_price ?? fresh.original_price ?? base?.original_price ?? null;
  merged.regular_amount = fresh.regular_amount ?? base?.regular_amount ?? null;
  merged.base_price = fresh.base_price ?? base?.base_price ?? null;
  merged.price = fresh.price ?? base?.price ?? null;
  merged.min_discounted_price =
    fresh.min_discounted_price ?? base?.min_discounted_price ?? null;
  merged.max_discounted_price =
    fresh.max_discounted_price ?? base?.max_discounted_price ?? null;
  merged.discount_percentage =
    fresh.discount_percentage ?? base?.discount_percentage ?? null;
  merged.deal_price = fresh.deal_price ?? fresh.new_price ?? base?.deal_price ?? base?.new_price ?? null;
  merged.new_price = fresh.new_price ?? base?.new_price ?? fresh.deal_price ?? base?.deal_price ?? null;
  merged.status = fresh.status ?? base?.status ?? null;
  merged.type = fresh.type ?? base?.type ?? null;
  return merged;
}

const toNum = (v) =>
  v === null || v === undefined || v === '' || Number.isNaN(Number(v))
    ? null
    : Number(v);

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function normalizePositiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function resolveLightningStock(item, preferredStock = null) {
  const preferred = normalizePositiveInt(preferredStock);
  if (preferred != null) return preferred >= 5 ? preferred : null;
  const rawStock = item?.stock;
  let resolved;
  if (rawStock && typeof rawStock === 'object' && !Array.isArray(rawStock)) {
    resolved = normalizePositiveInt(
      rawStock.selected ??
        rawStock.value ??
        rawStock.quantity ??
        rawStock.min ??
        rawStock.max
    );
  } else {
    resolved = normalizePositiveInt(
      item?.promotion_stock ??
        item?.selected_stock ??
        item?.quantity ??
        item?.stock_quantity ??
        item?.stock_min ??
        item?.min_stock ??
        null
    );
  }
  return resolved != null && resolved >= 5 ? resolved : null;
}

function computeDealPriceFromPercent(originalPrice, percent) {
  const orig = toNum(originalPrice);
  const pct = toNum(percent);
  if (orig == null || orig <= 0) return null;
  if (pct == null || pct <= 0 || pct > MANUAL_PROMO_MAX_PERCENT) return null;
  return round2(orig * (1 - pct / 100));
}

function isValidManualPromoPercent(value) {
  const pct = Number(value);
  return Number.isFinite(pct) && pct > 0 && pct <= MANUAL_PROMO_MAX_PERCENT;
}

function computePercentFromDealPrice(originalPrice, dealPrice) {
  const original = toNum(originalPrice);
  const deal = toNum(dealPrice);
  if (original == null || original <= 0 || deal == null || deal <= 0) return null;
  return round2(100 * (1 - deal / original));
}

function validateManualDealPricePercent({
  item,
  promotionType,
  requestedPercent,
  dealPrice,
}) {
  const t = String(promotionType || "").toUpperCase();
  const requested = toNum(requestedPercent);
  if (!isValidManualPromoPercent(requested)) {
    return {
      ok: false,
      error: `Percentual manual invalido para ${t}.`,
      notes: "percentual manual ausente ou acima do limite permitido",
      requested_percent: requested,
      calculated_percent: null,
    };
  }

  const original = toNum(item?.original_price ?? item?.regular_amount ?? item?.base_price ?? item?.price);
  const calculated = computePercentFromDealPrice(original, dealPrice);
  if (calculated == null) {
    return {
      ok: false,
      error: `Nao foi possivel confirmar a % efetiva de ${t} antes de aplicar.`,
      notes: "preco original ou deal_price indisponivel para validar divergencia",
      requested_percent: requested,
      calculated_percent: null,
    };
  }

  const minAllowed = round2(requested - MANUAL_PROMO_PERCENT_LOWER_ROUNDING_TOLERANCE);
  const maxAllowed = round2(
    Math.min(MANUAL_PROMO_MAX_PERCENT, requested + MANUAL_PROMO_PERCENT_TOLERANCE)
  );
  if (calculated < minAllowed || calculated > maxAllowed) {
    return {
      ok: false,
      error: `Aplicacao bloqueada: percentual calculado ${calculated}% fora do limite permitido para ${requested}% (maximo ${maxAllowed}%).`,
      notes: "percentual efetivo do deal_price diverge do percentual solicitado",
      requested_percent: round2(requested),
      calculated_percent: round2(calculated),
      min_allowed_percent: minAllowed,
      max_allowed_percent: maxAllowed,
    };
  }

  return {
    ok: true,
    requested_percent: round2(requested),
    calculated_percent: round2(calculated),
  };
}

function normalizePricePolicy(policy) {
  return String(policy || '').toLowerCase() === 'max' ? 'max' : 'min';
}

function computeDealDiscountRange(item) {
  const original = toNum(item?.original_price ?? item?.price ?? null);
  const minPrice = toNum(item?.min_discounted_price);
  let maxPrice = toNum(item?.max_discounted_price);
  const typeUp = String(item?.promotion_type ?? item?.type ?? '').toUpperCase();
  const lightningPrice = toNum(item?.price);

  if (
    typeUp === 'LIGHTNING' &&
    maxPrice == null &&
    lightningPrice != null &&
    lightningPrice > 0 &&
    lightningPrice < original &&
    (minPrice == null || lightningPrice >= minPrice)
  ) {
    maxPrice = lightningPrice;
  }
  const toPct = (price) =>
    original != null && original > 0 && price != null
      ? round2(((original - price) / original) * 100)
      : null;

  return {
    minPrice,
    maxPrice,
    minPct: toPct(maxPrice),
    maxPct: toPct(minPrice),
  };
}

function isDealPercentWithinRange(item, percent, tolerance = 0.01) {
  const pct = toNum(percent);
  if (pct == null) return false;
  const range = computeDealDiscountRange(item);
  const lo = range.minPct;
  const hi = range.maxPct;
  if (lo == null || hi == null) return false;
  return pct + tolerance >= lo && pct - tolerance <= hi;
}

function computeCurrentDealPercent(item) {
  const original = toNum(item?.original_price);
  if (original == null || original <= 0) return null;
  const finalPrice = toNum(
    item?.deal_price ?? item?.new_price ?? item?._resolved_final_price,
  );
  if (finalPrice != null && finalPrice > 0 && finalPrice < original) {
    return round2(((original - finalPrice) / original) * 100);
  }
  const explicit = toNum(item?.discount_percentage ?? item?.discountPercent);
  return explicit != null && explicit > 0 ? round2(explicit) : null;
}

function isManualPercentApplicable(item, percent, tolerance = 0.01) {
  const target = toNum(percent);
  if (target == null) return false;
  const status = normalizeStatusForML(item?.status);
  const range = computeDealDiscountRange(item);
  const existing = ['started', 'pending', 'scheduled'].includes(status);

  if (existing) {
    const current = computeCurrentDealPercent(item);
    if (current == null || target <= current + tolerance) return false;
  }
  if (range.minPct != null && range.maxPct != null) {
    return isDealPercentWithinRange(item, target, tolerance);
  }
  return existing;
}

function mergeManualPromotionRows(rows, promotionType) {
  const list = (Array.isArray(rows) ? rows : []).filter(
    (row) => row && typeof row === 'object',
  );
  if (!list.length) return null;

  const existing =
    list.find((row) => normalizeStatusForML(row?.status) === 'started') ||
    list.find((row) => normalizeStatusForML(row?.status) === 'scheduled') ||
    null;
  const candidate =
    list.find((row) => normalizeStatusForML(row?.status) === 'candidate') || null;
  const rangeRow =
    list.find((row) => {
      const range = computeDealDiscountRange({
        ...row,
        promotion_type: promotionType,
      });
      return range.minPct != null && range.maxPct != null;
    }) || null;
  const base = existing || candidate || list[0];
  const merged = {
    ...(candidate || {}),
    ...(rangeRow || {}),
    ...base,
    promotion_type: String(promotionType || '').toUpperCase(),
  };

  if (rangeRow) {
    merged.min_discounted_price = rangeRow.min_discounted_price ?? null;
    merged.max_discounted_price = rangeRow.max_discounted_price ?? null;
  }
  if (existing) {
    merged.status = existing.status;
    merged.original_price =
      existing.original_price ?? rangeRow?.original_price ?? candidate?.original_price ?? null;
    merged.price = existing.price ?? null;
    merged.deal_price = existing.deal_price ?? existing.new_price ?? null;
    merged.new_price = existing.new_price ?? null;
    merged.discount_percentage = existing.discount_percentage ?? null;
  }

  return merged;
}

function clampPct(n){
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function positiveNumber(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function pickArray(...values) {
  return values.find((value) => Array.isArray(value)) || [];
}

function countPromoResultRows(rows, wanted) {
  if (!Array.isArray(rows)) return 0;
  return rows.reduce((count, row) => {
    const status = String(row?.status || '').toLowerCase();
    if (status === 'info') return count;

    if (wanted === 'success') {
      if (row?.success === true || status === 'success' || status === 'applied') {
        return count + 1;
      }
      return count;
    }

    if (row?.success === false || ['error', 'failed', 'failure'].includes(status)) {
      return count + 1;
    }
    return count;
  }, 0);
}

function safeText(value, max = 500) {
  const text = value == null ? "" : String(value);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function buildAuditBase(job) {
  const context = job?.data?.auditContext || {};
  const promotion = job?.data?.promotion || {};
  return {
    userId: Number(context.userId) || null,
    email: context.email || null,
    ip: context.ip || null,
    userAgent: context.userAgent || null,
    accountKey: context.accountKey || job?.data?.accountKey || null,
    accountLabel: context.accountLabel || job?.data?.accountLabel || null,
    meli_conta_id: context.meli_conta_id || job?.data?.mlCreds?.meli_conta_id || null,
    route: context.route || null,
    method: context.method || null,
    action: job?.data?.action || null,
    promotion_id: promotion.id || null,
    promotion_type: promotion.type || null,
    promotion_name: promotion.name || promotion.title || null,
    job_id: job?.id ? String(job.id) : null,
    operation_id: job?.data?.operationId || job?.data?.options?.operation_id || null,
  };
}

async function auditPromoJobEvent(job, evento, status, metadata = {}) {
  const base = buildAuditBase(job);
  return recordAuthEvent({
    userId: base.userId,
    email: base.email,
    evento,
    status,
    ip: base.ip,
    userAgent: base.userAgent,
    metadata: {
      accountKey: base.accountKey,
      accountLabel: base.accountLabel,
      meli_conta_id: base.meli_conta_id,
      route: base.route,
      method: base.method,
      action: base.action,
      promotion_id: base.promotion_id,
      promotion_type: base.promotion_type,
      promotion_name: base.promotion_name,
      job_id: base.job_id,
      operation_id: base.operation_id,
      ...metadata,
    },
  }).catch((err) => {
    console.error("[PromoJobsService] audit erro:", err?.message || err);
  });
}

function resolvePromoJobMetrics(job, state) {
  const d = job?.data || {};
  const counters = d.counters || {};
  const result = state === 'completed' ? (job?.returnvalue || null) : null;
  const results = pickArray(d.results, result?.results);
  const failedItems = pickArray(d.failedItems, result?.failed_items);
  const rowSuccess = countPromoResultRows(results, 'success');
  const rowFailed = Math.max(
    countPromoResultRows(results, 'failed'),
    failedItems.length
  );
  const derivedProcessed = rowSuccess + rowFailed;

  const success = Math.max(
    positiveNumber(counters.success),
    positiveNumber(result?.success),
    rowSuccess
  );
  const failed = Math.max(
    positiveNumber(counters.failed),
    positiveNumber(result?.failed),
    rowFailed
  );
  const processed = Math.max(
    positiveNumber(counters.processed),
    positiveNumber(result?.processed),
    derivedProcessed
  );
  const total = Math.max(
    positiveNumber(d.operationTotal),
    positiveNumber(counters.total),
    positiveNumber(result?.total),
    processed
  );

  return { processed, total, success, failed, result, results, failedItems };
}

function normalizeAccountKey(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  if (v.toLowerCase() === 'default') return null;
  return v;
}

function canAccessJobData(data = {}, accountKey = null) {
  const wanted = normalizeAccountKey(accountKey);
  const current = normalizeAccountKey(data?.accountKey);
  if (!wanted) return false;
  if (!current) return false;
  return current === wanted;
}

function promoOrchestrationRedis() {
  return getSharedRedis('promo:orchestration');
}

function stablePromoValue(value) {
  if (Array.isArray(value)) return value.map(stablePromoValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((acc, key) => {
      const next = stablePromoValue(value[key]);
      if (next !== undefined) acc[key] = next;
      return acc;
    }, {});
}

function buildPromoRequestFingerprint(input = {}) {
  const filters = input?.filters || {};
  const options = input?.options || {};
  const selection = Array.isArray(input?.selectionItems)
    ? input.selectionItems
        .map((item) => ({
          id: String(item?.id || item?.item_id || item || '').trim().toUpperCase(),
          offer_id: item && typeof item === 'object'
            ? String(item?.offer_id || item?.candidate_id || item?.ref_id || '').trim()
            : '',
        }))
        .filter((row) => row.id)
        .sort((a, b) => `${a.id}|${a.offer_id}`.localeCompare(`${b.id}|${b.offer_id}`))
    : [];
  const mlbs = normalizeMlbFilterList(filters?.mlbs || (filters?.mlb ? [filters.mlb] : []))
    .slice()
    .sort();

  const payload = stablePromoValue({
    accountKey: normalizeAccountKey(input?.accountKey),
    action: input?.action === 'remove' ? 'remove' : 'apply',
    promotion: {
      id: String(input?.promotion?.id || ''),
      type: String(input?.promotion?.type || '').toUpperCase(),
    },
    price_policy: normalizePricePolicy(input?.price_policy),
    filters: {
      status: normalizeStatusForML(filters?.status) || null,
      maxDesc: toNum(filters?.maxDesc ?? filters?.percent_max),
      mlbs,
    },
    options: {
      dryRun: options?.dryRun === true,
      deal_manual_percent: toNum(options?.deal_manual_percent),
      seller_manual_percent: toNum(options?.seller_manual_percent),
      lightning_stock: toNum(options?.lightning_stock),
      max_discount_percent: toNum(options?.max_discount_percent),
      prevalidated_selection: options?.prevalidated_selection === true,
      selection_count: toNum(options?.selection_count),
    },
    selection,
  });
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function campaignGuardIdentity(data = {}) {
  const accountKey = normalizeAccountKey(data?.accountKey) || 'unknown';
  const promotionId = String(data?.promotion?.id || '').trim();
  const promotionType = String(data?.promotion?.type || '').trim().toUpperCase();
  return `${accountKey}|${promotionType}|${promotionId}`;
}

function campaignGuardKey(data = {}) {
  const hash = crypto.createHash('sha1').update(campaignGuardIdentity(data)).digest('hex');
  return `promo:campaign-open:${hash}`;
}

function accountRuntimeKey(accountKey) {
  const safe = crypto.createHash('sha1').update(String(normalizeAccountKey(accountKey) || 'unknown')).digest('hex');
  return `promo:runtime-account:${safe}`;
}

function campaignRuntimeKey(data = {}) {
  const hash = crypto.createHash('sha1').update(campaignGuardIdentity(data)).digest('hex');
  return `promo:runtime-campaign:${hash}`;
}

function canceledTombstoneHashKey(accountKey) {
  const safe = crypto.createHash('sha1').update(String(normalizeAccountKey(accountKey) || 'unknown')).digest('hex');
  return `promo:canceled-jobs:${safe}`;
}

function jobHasPendingRemediation(data = {}) {
  return Number(data?.quarantineCounters?.pending || 0) > 0;
}

async function getOpenPromotionJobs(q, { accountKey = null, limit = 500 } = {}) {
  const wanted = normalizeAccountKey(accountKey);
  const buckets = await Promise.all(
    ['active', 'waiting', 'delayed', 'failed', 'completed'].map(async (state) => {
      const jobs = await q.getJobs([state], 0, Math.max(0, limit - 1), false).catch(() => []);
      return jobs.map((job) => ({ job, state }));
    }),
  );
  const tracked = await getTrackedLogicalOperations(q, { accountKey, limit });
  const byId = new Map();
  for (const entry of [...buckets.flat(), ...tracked]) {
    const id = String(entry?.job?.id ?? '');
    if (!id) continue;
    const current = byId.get(id);
    if (!current || isLogicalPromotionOperationOpen(entry?.job?.data || {})) {
      byId.set(id, entry);
    }
  }
  return [...byId.values()].filter(({ job, state }) => {
    const data = job?.data || {};
    if (data?.kind === 'list-validation' || data?.kind === 'promotion-remediation' || data?.internalJob === true) {
      return false;
    }
    if (wanted && normalizeAccountKey(data?.accountKey) !== wanted) return false;
    if (data?.stateLabel === 'cancelado') return false;
    if (isLogicalPromotionOperationOpen(data)) return true;
    if (state === 'active' || state === 'waiting' || state === 'delayed') return true;
    if (state === 'failed' && (data?.safetyPaused === true || data?.resumable === true)) return true;
    if (state === 'completed' && jobHasPendingRemediation(data)) return true;
    return false;
  });
}
async function findOpenCampaignJob(q, data = {}) {
  const wantedIdentity = campaignGuardIdentity(data);
  const fingerprint = data?.requestFingerprint || buildPromoRequestFingerprint(data);
  const open = await getOpenPromotionJobs(q, { accountKey: data?.accountKey });
  const matches = open
    .filter(({ job }) => campaignGuardIdentity(job?.data || {}) === wantedIdentity)
    .sort((a, b) => Number(a?.job?.timestamp || 0) - Number(b?.job?.timestamp || 0));
  if (!matches.length) return null;
  const exact = matches.find(({ job }) => {
    const current = job?.data || {};
    const currentFingerprint =
      current?.requestFingerprint || buildPromoRequestFingerprint(current);
    return currentFingerprint === fingerprint;
  });
  const selected = exact || matches[0];
  return {
    job: selected.job,
    state: selected.state,
    exact: !!exact,
    reason: exact ? 'duplicate' : 'campaign_busy',
  };
}

async function releaseCampaignGuard(data = {}, expectedJobId = null) {
  const redis = promoOrchestrationRedis();
  const key = data?.campaignGuardKey || campaignGuardKey(data);
  if (!key) return;
  try {
    if (!expectedJobId) {
      await redis.del(key);
      return;
    }
    const script = `
      local current = redis.call('GET', KEYS[1])
      if current == ARGV[1] then
        return redis.call('DEL', KEYS[1])
      end
      return 0
    `;
    await redis.eval(script, 1, key, String(expectedJobId));
  } catch (error) {
    console.warn('[PromoJobsService] falha ao liberar lock de campanha:', error?.message || error);
  }
}

async function claimCampaignGuard(data = {}, jobId) {
  if (!jobId) return;
  try {
    await promoOrchestrationRedis().set(
      data?.campaignGuardKey || campaignGuardKey(data),
      String(jobId),
      'PX',
      PROMO_OPEN_GUARD_MS,
    );
  } catch {}
}

async function refreshCampaignGuard(job) {
  return refreshCampaignGuardForOwner(job?.data || {}, operationOwnerJobId(job));
}

async function acquireCampaignCreationReservation(data = {}) {
  const redis = promoOrchestrationRedis();
  const key = campaignGuardKey(data);
  const token = `pending:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const result = await redis
    .set(key, token, 'PX', PROMO_GUARD_RESERVATION_MS, 'NX')
    .catch(() => null);
  return result === 'OK'
    ? {
        key,
        token,
        async finalize(jobId) {
          const script = `
            local current = redis.call('GET', KEYS[1])
            if current == ARGV[1] then
              redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
              return 1
            end
            return 0
          `;
          return redis.eval(script, 1, key, token, String(jobId), PROMO_OPEN_GUARD_MS).catch(() => 0);
        },
        async release() {
          const script = `
            local current = redis.call('GET', KEYS[1])
            if current == ARGV[1] then return redis.call('DEL', KEYS[1]) end
            return 0
          `;
          return redis.eval(script, 1, key, token).catch(() => 0);
        },
      }
    : null;
}

async function waitForCampaignReservationOwner(q, data = {}, attempts = 8) {
  const redis = promoOrchestrationRedis();
  const key = campaignGuardKey(data);
  for (let i = 0; i < attempts; i += 1) {
    const open = await findOpenCampaignJob(q, data);
    if (open) return open;
    const owner = await redis.get(key).catch(() => null);
    if (owner && !String(owner).startsWith('pending:')) {
      const job = await q.getJob(owner).catch(() => null);
      if (job) {
        const state = await job.getState().catch(() => 'unknown');
        const jobData = job.data || {};
        const stillOpen =
          isLogicalPromotionOperationOpen(jobData) ||
          ['active', 'waiting', 'delayed'].includes(state) ||
          (state === 'failed' && (jobData?.safetyPaused === true || jobData?.resumable === true)) ||
          (state === 'completed' && jobHasPendingRemediation(jobData));
        if (stillOpen) {
          const currentFingerprint =
            jobData?.requestFingerprint || buildPromoRequestFingerprint(jobData);
          return {
            job,
            state,
            exact: currentFingerprint === data?.requestFingerprint,
            reason:
              currentFingerprint === data?.requestFingerprint
                ? 'duplicate'
                : 'campaign_busy',
          };
        }
        await releaseCampaignGuard(data, String(owner));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 120 + i * 60));
  }
  return findOpenCampaignJob(q, data);
}

async function acquireRuntimeFairness(job) {
  const data = job?.data || {};
  const accountKey = normalizeAccountKey(data?.accountKey);
  if (!accountKey) return { acquired: true, release: async () => {}, refresh: async () => {} };
  const redis = promoOrchestrationRedis();
  const accountKeyRedis = accountRuntimeKey(accountKey);
  const campaignKeyRedis = campaignRuntimeKey(data);
  const openGuardKey = data?.campaignGuardKey || campaignGuardKey(data);
  const ownerJobId = operationOwnerJobId(job);
  const token = `${WORKER_INSTANCE_ID}:${job.id}`;
  const now = Date.now();
  const expiresAt = now + PROMO_RUNTIME_LEASE_MS;
  const accountScript = `
    redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
    local existing = redis.call('ZSCORE', KEYS[1], ARGV[4])
    if existing then
      redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
      redis.call('PEXPIRE', KEYS[1], ARGV[5])
      return 1
    end
    local count = redis.call('ZCARD', KEYS[1])
    if count < tonumber(ARGV[3]) then
      redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
      redis.call('PEXPIRE', KEYS[1], ARGV[5])
      return 1
    end
    return 0
  `;
  try {
    const openOwner = await redis.get(openGuardKey).catch(() => null);
    if (openOwner && !String(openOwner).startsWith('pending:') && String(openOwner) !== ownerJobId) {
      return {
        acquired: false,
        reason: 'campaign_busy',
        ownerJobId: String(openOwner),
        release: async () => {},
        refresh: async () => {},
      };
    }
    if (!openOwner) {
      await redis.set(openGuardKey, ownerJobId, 'PX', PROMO_OPEN_GUARD_MS, 'NX').catch(() => null);
      const claimedOwner = await redis.get(openGuardKey).catch(() => null);
      if (claimedOwner && String(claimedOwner) !== ownerJobId) {
        return {
          acquired: false,
          reason: 'campaign_busy',
          ownerJobId: String(claimedOwner),
          release: async () => {},
          refresh: async () => {},
        };
      }
    }

    const accountAcquired = Number(
      await redis.eval(
        accountScript,
        1,
        accountKeyRedis,
        now,
        expiresAt,
        PROMO_MAX_ACTIVE_JOBS_PER_ACCOUNT,
        token,
        PROMO_RUNTIME_LEASE_MS * 2,
      ),
    ) === 1;
    if (!accountAcquired) {
      return { acquired: false, reason: 'account_limit', release: async () => {}, refresh: async () => {} };
    }
    const campaignAcquired = await redis
      .set(campaignKeyRedis, token, 'PX', PROMO_RUNTIME_LEASE_MS, 'NX')
      .catch(() => null);
    if (campaignAcquired !== 'OK') {
      const current = await redis.get(campaignKeyRedis).catch(() => null);
      if (current !== token) {
        await redis.zrem(accountKeyRedis, token).catch(() => {});
        return { acquired: false, reason: 'campaign_busy', release: async () => {}, refresh: async () => {} };
      }
    }
    return {
      acquired: true,
      async refresh() {
        const ts = Date.now() + PROMO_RUNTIME_LEASE_MS;
        await redis.zadd(accountKeyRedis, ts, token).catch(() => {});
        await redis.pexpire(accountKeyRedis, PROMO_RUNTIME_LEASE_MS * 2).catch(() => {});
        const script = `
          if redis.call('GET', KEYS[1]) == ARGV[1] then
            return redis.call('PEXPIRE', KEYS[1], ARGV[2])
          end
          return 0
        `;
        await redis.eval(script, 1, campaignKeyRedis, token, PROMO_RUNTIME_LEASE_MS).catch(() => {});
        await refreshCampaignGuardForOwner(data, ownerJobId);
      },
      async release() {
        await redis.zrem(accountKeyRedis, token).catch(() => {});
        const script = `
          if redis.call('GET', KEYS[1]) == ARGV[1] then
            return redis.call('DEL', KEYS[1])
          end
          return 0
        `;
        await redis.eval(script, 1, campaignKeyRedis, token).catch(() => {});
      },
    };
  } catch (error) {
    console.warn('[PromoJobsService] fairness Redis indisponivel; seguindo sem bloqueio global:', error?.message || error);
    return { acquired: true, release: async () => {}, refresh: async () => {} };
  }
}

async function storeCanceledTombstone(job, data = null) {
  const source = data || job?.data || {};
  const accountKey = normalizeAccountKey(source?.accountKey);
  if (!accountKey) return;
  const counters = source?.counters || {};
  const tombstone = {
    id: String(job?.id || source?.id || ''),
    source: 'promo',
    state: 'cancelado',
    lifecycle_status: 'canceled',
    processed: Number(counters.processed || 0),
    total: Number(source?.operationTotal || counters.total || source?.options?.expected_total || 0),
    success: Number(counters.success || 0),
    failed: Number(counters.failed || 0),
    progress: Number(counters.total || 0) > 0
      ? clampPct((Number(counters.processed || 0) / Number(counters.total || 1)) * 100)
      : 0,
    label: source?.promotion?.id
      ? `${source?.action === 'remove' ? 'Removendo' : 'Aplicando'} ${source?.promotion?.type || ''} ${source?.promotion?.id}`
      : 'Job de promocao cancelado',
    account: { key: accountKey, label: source?.accountLabel || accountKey },
    accountKey,
    accountLabel: source?.accountLabel || accountKey,
    operation_id: source?.operationId || source?.options?.operation_id || null,
    canceled_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    terminal: true,
    completed: true,
    can_cancel: false,
    job_contract_version: 1,
  };
  try {
    const redis = promoOrchestrationRedis();
    const key = canceledTombstoneHashKey(accountKey);
    await redis.hset(key, String(tombstone.id), JSON.stringify(tombstone));
    await redis.pexpire(key, PROMO_CANCEL_TOMBSTONE_MS);
  } catch {}
}

async function listCanceledTombstones(accountKey, limit = 25) {
  const wanted = normalizeAccountKey(accountKey);
  if (!wanted) return [];
  try {
    const redis = promoOrchestrationRedis();
    const raw = await redis.hvals(canceledTombstoneHashKey(wanted));
    return raw
      .map((value) => {
        try { return JSON.parse(value); } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0))
      .slice(0, limit);
  } catch {
    return [];
  }
}

async function getWorkerHealth() {
  try {
    const redis = promoOrchestrationRedis();
    const raw = await redis.get('promo:worker:heartbeat');
    if (!raw) return { online: false, last_seen: null, instance: null };
    const heartbeat = JSON.parse(raw);
    const ts = Number(heartbeat?.ts || 0);
    return {
      ...heartbeat,
      online: ts > 0 && Date.now() - ts <= PROMO_WORKER_STALE_MS,
      last_seen: ts ? new Date(ts).toISOString() : null,
    };
  } catch {
    return { online: null, last_seen: null, instance: null };
  }
}

async function writeWorkerHeartbeat(q) {
  try {
    const counts = await q.getJobCounts().catch(() => ({}));
    const payload = {
      ts: Date.now(),
      instance: WORKER_INSTANCE_ID,
      pid: process.pid,
      concurrency: CONCURRENCY,
      local_active: localActivePromoJobs.size,
      waiting: Number(counts?.waiting || 0),
      active: Number(counts?.active || 0),
      delayed: Number(counts?.delayed || 0),
    };
    await promoOrchestrationRedis().set(
      'promo:worker:heartbeat',
      JSON.stringify(payload),
      'PX',
      PROMO_WORKER_STALE_MS * 2,
    );
    return payload;
  } catch {
    return null;
  }
}

function canCooperativelyYield(job) {
  const max = Number(job?.opts?.attempts || 1);
  const used = Number(job?.attemptsMade || 0);
  return max > used + 1;
}

const PROMO_ORCHESTRATION_VERSION = 2;
const PROMO_LOGICAL_OPEN_JOBS_KEY = 'promo:logical-open-jobs';

async function trackLogicalOperation(jobOrId, { open = true } = {}) {
  const id = String(jobOrId?.id ?? jobOrId ?? '').trim();
  if (!id) return;
  try {
    const redis = promoOrchestrationRedis();
    if (open) {
      await redis.zadd(PROMO_LOGICAL_OPEN_JOBS_KEY, Date.now(), id);
      await redis.pexpire(PROMO_LOGICAL_OPEN_JOBS_KEY, PROMO_OPEN_GUARD_MS);
    } else {
      await redis.zrem(PROMO_LOGICAL_OPEN_JOBS_KEY, id);
    }
  } catch {}
}

async function getTrackedLogicalOperations(q, { accountKey = null, limit = 500 } = {}) {
  const wanted = normalizeAccountKey(accountKey);
  try {
    const redis = promoOrchestrationRedis();
    const ids = await redis.zrevrange(
      PROMO_LOGICAL_OPEN_JOBS_KEY,
      0,
      Math.max(0, Number(limit || 500) - 1),
    );
    if (!Array.isArray(ids) || !ids.length) return [];
    const jobs = await Promise.all(
      ids.map((id) => q.getJob(id).catch(() => null)),
    );
    const valid = [];
    const staleIds = [];
    for (let i = 0; i < ids.length; i += 1) {
      const job = jobs[i];
      const data = job?.data || {};
      if (!job || !isLogicalPromotionOperationOpen(data)) {
        staleIds.push(ids[i]);
        continue;
      }
      if (wanted && normalizeAccountKey(data?.accountKey) !== wanted) continue;
      valid.push({ job, state: 'completed' });
    }
    if (staleIds.length) await redis.zrem(PROMO_LOGICAL_OPEN_JOBS_KEY, ...staleIds).catch(() => {});
    return valid;
  } catch {
    return [];
  }
}


function isLogicalPromotionOperationData(data = {}) {
  return (
    Number(data?.orchestrationVersion || 0) >= PROMO_ORCHESTRATION_VERSION &&
    String(data?.kind || '').toLowerCase() === 'promotion-operation'
  );
}

function isPromotionChunkData(data = {}) {
  return (
    Number(data?.orchestrationVersion || 0) >= PROMO_ORCHESTRATION_VERSION &&
    String(data?.kind || '').toLowerCase() === 'promotion-chunk'
  );
}

function isLogicalPromotionOperationOpen(data = {}) {
  return isLogicalPromotionOperationData(data) && data?.operationTerminal !== true;
}

function logicalPromotionLifecycle(data = {}, bullState = 'unknown') {
  if (!isLogicalPromotionOperationData(data)) return null;
  if (data?.stateLabel === 'cancelado' || data?.operationLifecycle === 'canceled') return 'canceled';
  if (data?.safetyPaused === true || data?.operationLifecycle === 'paused_safety') return 'paused_safety';
  if (data?.transientRetry?.active === true || data?.operationLifecycle === 'retry_wait') return 'retry_wait';
  if (data?.operationLifecycle === 'review_pending' || jobHasPendingRemediation(data)) return 'review_pending';
  if (data?.operationTerminal === true) {
    if (data?.operationLifecycle === 'failed') return 'failed';
    if (data?.operationLifecycle === 'partial') return 'partial';
    return 'completed';
  }
  if (data?.operationLifecycle === 'processing') return 'processing';
  if (data?.operationLifecycle === 'queued' || data?.operationLifecycle === 'yielded') return 'queued';
  return bullState === 'active' ? 'processing' : 'queued';
}

function operationOwnerJobId(job) {
  const data = job?.data || {};
  return String(data?.parentJobId || job?.id || '');
}

async function refreshCampaignGuardForOwner(data = {}, ownerJobId = null) {
  const owner = String(ownerJobId || '').trim();
  if (!owner) return;
  const redis = promoOrchestrationRedis();
  const key = data?.campaignGuardKey || campaignGuardKey(data);
  try {
    const script = `
      local current = redis.call('GET', KEYS[1])
      if current == ARGV[1] then
        redis.call('PEXPIRE', KEYS[1], ARGV[2])
        return 1
      end
      return 0
    `;
    await redis.eval(script, 1, key, owner, PROMO_OPEN_GUARD_MS);
  } catch {}
}

function inferOperationTotal(data = {}) {
  const explicit = Number(data?.operationTotal || 0);
  if (explicit > 0) return explicit;
  const countersTotal = Number(data?.counters?.total || 0);
  if (countersTotal > 0) return countersTotal;
  const expected = Number(data?.options?.expected_total || 0);
  if (expected > 0) return expected;
  if (Array.isArray(data?.selectionItems) && data.selectionItems.length > 0) {
    return data.selectionItems.length;
  }
  if (Array.isArray(data?.filters?.mlbs) && data.filters.mlbs.length > 0) {
    return data.filters.mlbs.length;
  }
  return data?.filters?.mlb ? 1 : 0;
}

function shouldUseLogicalChunks(job, sourceCount = 0) {
  return (
    isLogicalPromotionOperationData(job?.data || {}) &&
    Number(sourceCount || 0) > PROMO_JOB_CHUNK_SIZE
  );
}

async function enqueuePromotionChunk(parentJob, {
  offset = 0,
  sequence = 1,
  reason = 'worker_queue',
} = {}) {
  if (!parentJob) throw new Error('Operacao pai ausente para criar chunk promocional.');
  const q = parentJob.queue || ensureQueue();
  const parentData = parentJob.data || {};
  const parentJobId = String(parentJob.id);
  const chunkJobId = `promo-chunk:${parentJobId}:${Number(sequence || 1)}`;
  const chunkData = {
    kind: 'promotion-chunk',
    internalJob: true,
    orchestrationVersion: PROMO_ORCHESTRATION_VERSION,
    parentJobId,
    operationId: parentData.operationId || parentData.options?.operation_id || null,
    accountKey: parentData.accountKey || null,
    accountLabel: parentData.accountLabel || parentData.accountKey || null,
    promotion: parentData.promotion || null,
    action: parentData.action || 'apply',
    requestFingerprint: parentData.requestFingerprint || null,
    campaignGuardKey: parentData.campaignGuardKey || campaignGuardKey(parentData),
    chunkOffset: Math.max(0, Number(offset || 0)),
    chunkSequence: Math.max(1, Number(sequence || 1)),
    createdAt: Date.now(),
  };

  let child = await q.getJob(chunkJobId).catch(() => null);
  if (!child) {
    child = await q.add(chunkData, {
      jobId: chunkJobId,
      removeOnComplete: true,
      removeOnFail: 100,
      attempts: PROMO_JOB_MAX_YIELD_ATTEMPTS,
      backoff: { type: 'fixed', delay: PROMO_JOB_YIELD_DELAY_MS },
    });
  }

  const latest = (await q.getJob(parentJobId).catch(() => null)) || parentJob;
  const latestData = latest?.data || parentData;
  const opTotal = inferOperationTotal(latestData);
  const counters = latestData?.counters || {};
  await latest.update({
    ...latestData,
    operationTotal: opTotal,
    operationTerminal: false,
    operationLifecycle: reason === 'cooperative_chunk' ? 'yielded' : 'queued',
    activeChunkJobId: String(child.id),
    chunkCheckpoint: {
      ...(latestData?.chunkCheckpoint || {}),
      offset: Math.max(0, Number(offset || 0)),
      sourceCount: Number(latestData?.chunkCheckpoint?.sourceCount || opTotal || 0),
      size: PROMO_JOB_CHUNK_SIZE,
      sequence: Math.max(1, Number(sequence || 1)),
      updatedAt: Date.now(),
    },
    stateLabel:
      reason === 'cooperative_chunk'
        ? `na fila: ${Number(counters.processed || 0)}/${opTotal || '?'} processados, cedendo turno`
        : 'na fila: aguardando worker',
    queueReason: reason,
    lastUpdate: Date.now(),
  }).catch(() => {});

  return child;
}

async function settleLogicalOperationResources(job, { releaseCredits = false } = {}) {
  const data = job?.data || {};
  if (!isLogicalPromotionOperationData(data)) return;
  if (data?.operationTerminal === true) {
    await trackLogicalOperation(job, { open: false });
  } else {
    await trackLogicalOperation(job, { open: true });
  }
  await settleCredits(data?.creditReservation, { release: releaseCredits }).catch(() => {});
  if (!jobHasPendingRemediation(data) && data?.operationTerminal === true) {
    await releaseCampaignGuard(data, String(job.id)).catch(() => {});
  }
}

async function supersedeDuplicateBeforeMutation(job, ownerJobId = null) {
  const data = job?.data || {};
  const counters = data?.counters || {};
  const originalReservation = data?.creditReservation || null;
  const updated = {
    ...data,
    creditReservation: null,
    stateLabel: ownerJobId
      ? `cancelado: campanha ja protegida pelo job ${ownerJobId}`
      : 'cancelado: operacao duplicada da mesma campanha',
    duplicateOfJobId: ownerJobId ? String(ownerJobId) : null,
    supersededDuplicate: true,
    cancelRequested: false,
    safetyPaused: false,
    resumable: false,
    transientRetry: null,
    lastUpdate: Date.now(),
  };
  await job.update(updated).catch(() => {});
  await settleCredits(originalReservation, { release: true }).catch(() => {});
  await auditPromoJobEvent(job, 'promotion_duplicate_job_superseded', 'warn', {
    duplicate_of_job_id: ownerJobId ? String(ownerJobId) : null,
    processed: Number(counters.processed || 0),
    total: Number(counters.total || data?.options?.expected_total || 0),
  });
  await releaseCampaignGuard(data, String(job.id));
  return {
    id: job.id,
    status: 'cancelado',
    duplicate: true,
    duplicate_of_job_id: ownerJobId ? String(ownerJobId) : null,
    total: Number(counters.total || data?.options?.expected_total || 0),
    processed: Number(counters.processed || 0),
    success: Number(counters.success || 0),
    failed: Number(counters.failed || 0),
  };
}

async function immediateQueuedCancel(job, { reason = 'cancelado antes de iniciar', cancelAuditContext = null } = {}) {
  if (!job) return null;
  const state = await job.getState().catch(() => 'unknown');
  if (!['waiting', 'delayed'].includes(state)) return null;
  const data = {
    ...(job.data || {}),
    stateLabel: 'cancelado',
    cancelRequested: false,
    cancelRequestedAt: job?.data?.cancelRequestedAt || Date.now(),
    cancelRequestedBy: cancelAuditContext || job?.data?.cancelRequestedBy || null,
    cancelCompletedAt: Date.now(),
    safetyPaused: false,
    resumable: false,
    transientRetry: null,
    lastUpdate: Date.now(),
  };
  await auditPromoJobEvent(job, 'promotion_job_canceled', 'warn', {
    current_state: state,
    processed: Number(data?.counters?.processed || 0),
    total: Number(data?.counters?.total || data?.options?.expected_total || 0),
    pending: Math.max(
      0,
      Number(data?.counters?.total || data?.options?.expected_total || 0) -
        Number(data?.counters?.processed || 0),
    ),
    canceled_before_start: true,
    reason,
  });
  await storeCanceledTombstone(job, data);
  await settleCredits(data?.creditReservation, { release: true }).catch(() => {});
  await releaseCampaignGuard(data, String(job.id));
  await job.remove();
  return {
    ok: true,
    status: 'cancelado',
    processed: Number(data?.counters?.processed || 0),
    total: Number(data?.counters?.total || data?.options?.expected_total || 0),
    removed_from_queue: true,
  };
}

async function reconcileQueuedDuplicateCampaignJobs(q) {
  const open = await getOpenPromotionJobs(q, { limit: 1000 });
  const byCampaign = new Map();
  for (const entry of open) {
    const key = campaignGuardIdentity(entry.job?.data || {});
    if (!byCampaign.has(key)) byCampaign.set(key, []);
    byCampaign.get(key).push(entry);
  }
  let canceled = 0;
  for (const entries of byCampaign.values()) {
    entries.sort((a, b) => {
      const aActive = a.state === 'active' ? 0 : 1;
      const bActive = b.state === 'active' ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return Number(a.job?.timestamp || 0) - Number(b.job?.timestamp || 0);
    });
    const keeper = entries[0];
    await claimCampaignGuard(keeper.job?.data || {}, String(keeper.job.id));
    for (const duplicate of entries.slice(1)) {
      if (!['waiting', 'delayed'].includes(duplicate.state)) continue;
      const result = await immediateQueuedCancel(duplicate.job, {
        reason: `duplicado da mesma campanha; job mantido #${keeper.job.id}`,
      }).catch(() => null);
      if (result?.ok) canceled += 1;
    }
  }
  if (canceled > 0) {
    console.warn(`[PromoJobsService] ${canceled} job(s) duplicado(s) em espera foram cancelados na inicializacao.`);
  }
  return canceled;
}

async function countOpenListValidationJobsForAccount(q, accountKey) {
  const wanted = normalizeAccountKey(accountKey);
  if (!wanted) return 0;
  const jobs = await q
    .getJobs(['active', 'waiting', 'delayed'], 0, 500, false)
    .catch(() => []);
  return jobs.reduce((count, job) => {
    const data = job?.data || {};
    if (String(data?.kind || '').toLowerCase() !== 'list-validation') return count;
    if (data?.cancelRequested === true) return count;
    return canAccessJobData(data, wanted) ? count + 1 : count;
  }, 0);
}

function publicPromoJobData(data = {}, counters = {}) {
  const {
    mlCreds,
    auditContext,
    selectionItems,
    ...safeData
  } = data || {};
  return {
    ...safeData,
    counters,
  };
}

function trimTraceBody(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    return value.length > 1200 ? value.slice(0, 1200) : value;
  }
  try {
    const json = JSON.stringify(value);
    if (json.length <= 1200) return value;
    return { raw_preview: json.slice(0, 1200) };
  } catch {
    return { raw_preview: String(value).slice(0, 1200) };
  }
}

function buildTraceEntry({
  action,
  promotion_id,
  promotion_type,
  item_id,
  payload,
  method = null,
  snapshot = null,
  result = null,
  notes = null
}) {
  return {
    ts: new Date().toISOString(),
    action: String(action || ''),
    promotion_id: promotion_id || null,
    promotion_type: promotion_type || null,
    item_id: item_id || null,
    inspection_endpoint:
      promotion_id && promotion_type && item_id
        ? `GET /seller-promotions/promotions/${promotion_id}/items?promotion_type=${promotion_type}&item_id=${item_id}&app_version=v2`
        : null,
    apply_endpoint:
      item_id
        ? `POST|PUT /seller-promotions/items/${item_id}?app_version=v2`
        : null,
    method: method || null,
    campaign_item_status: snapshot?.status || null,
    campaign_item_type: snapshot?.type || null,
    original_price:
      toNum(snapshot?.original_price ?? result?.original_price ?? null),
    campaign_price:
      toNum(snapshot?.price ?? snapshot?.deal_price ?? snapshot?.new_price ?? null),
    requested_deal_price:
      toNum(payload?.deal_price ?? null),
    requested_top_deal_price:
      toNum(payload?.top_deal_price ?? null),
    payload: payload || null,
    ok: result?.ok === true,
    http_status: result?.status ?? null,
    error: friendlyPromotionErrorMessage(result, null),
    ml_body: trimTraceBody(result?.body ?? null),
    notes: notes || null
  };
}

function friendlyPromotionErrorMessage(result, fallback = 'apply_failed') {
  const body = result?.body && typeof result.body === 'object' ? result.body : null;
  const causes = Array.isArray(body?.cause) ? body.cause : [];
  const firstCause = causes.find((cause) => cause && typeof cause === 'object') || null;
  const code = String(firstCause?.error_code || body?.error_code || '').trim();
  const causeMessage = String(firstCause?.error_message || '').trim();
  const mlMessage = String(body?.message || '').trim();
  const resultError = String(result?.error || '').trim();
  const bodyError = String(body?.error || '').trim();

  if (code === 'ERROR_CREDIBILITY_DISCOUNTED_PRICE') {
    return 'O Mercado Livre recusou o preço com desconto porque ele não passou na validação de credibilidade do anúncio.';
  }
  if (code === 'ERROR_PRICE_NOT_IN_RANGE' || code === 'ERROR_DISCOUNT_NOT_IN_RANGE') {
    return causeMessage || mlMessage || 'O preço/desconto informado está fora da faixa permitida pelo Mercado Livre para este anúncio.';
  }
  if (/credibility/i.test(`${code} ${causeMessage} ${mlMessage}`)) {
    return 'O Mercado Livre recusou o preço com desconto porque ele não passou na validação de credibilidade do anúncio.';
  }
  if (causeMessage) return causeMessage;
  if (mlMessage && !/^errors?:?\s*bad_request$/i.test(mlMessage)) return mlMessage;
  if (resultError && resultError !== 'bad_request') return resultError;
  if (bodyError && bodyError !== 'bad_request') return bodyError;
  if (bodyError === 'bad_request' || resultError === 'bad_request') {
    return 'O Mercado Livre recusou a aplicação da promoção para este anúncio. Consulte os detalhes técnicos do erro no painel.';
  }
  return fallback;
}

function promotionCsvErrorExplanation(row) {
  const status = String(row?.status || (row?.success ? 'success' : 'error')).toLowerCase();
  if (status === 'success' || row?.success === true) return '';
  const message = String(row?.message || row?.error || '').toLowerCase();

  if (/credibilidade|credibility|not credible|pre[cç]o com desconto/i.test(message)) {
    return 'O item passou na pré-validação, mas o Mercado Livre recusou a aplicação no momento final porque o preço com desconto não passou nas regras internas de credibilidade/preço histórico.';
  }
  if (/fora da faixa|range|faixa permitida/i.test(message)) {
    return 'O item passou na consulta inicial, mas na revalidação final o Mercado Livre informou uma faixa mínima maior para este anúncio.';
  }
  if (/não aparece|nao aparece|não retornou|nao retornou|não encontrou|nao encontrou|campaign selecionada|campanha selecionada/i.test(message)) {
    return 'O item estava na seleção inicial, mas no momento da aplicação o Mercado Livre não retornou mais este anúncio dentro da campanha selecionada.';
  }
  return '';
}

function promoResultErrorMessage(row) {
  const status = String(row?.status || (row?.success ? 'success' : 'error')).toLowerCase();
  if (status === 'success' || row?.success === true) return '';
  return (
    row?.error_message ??
    row?.error ??
    row?.message ??
    ''
  );
}

function promoResultRequestedPercent(row) {
  return (
    row?.requested_percent ??
    row?.defined_percent ??
    ''
  );
}

function promoResultEstimatedPercent(row) {
  return (
    row?.estimated_percent ??
    row?.applied_percent ??
    ''
  );
}

function promoResultRealAppliedPercent(row) {
  if (row?.success === false || String(row?.status || '').toLowerCase() === 'error') {
    return row?.real_applied_percent ?? '';
  }
  return row?.real_applied_percent ?? row?.applied_percent ?? '';
}

function pushTrace(list, entry, maxEntries = PROMO_TRACE_MAX_ENTRIES) {
  if (!Array.isArray(list) || !entry) return;
  list.push(entry);
  if (list.length > maxEntries) {
    list.splice(0, list.length - maxEntries);
  }
}

/* -------------------- Normalização de status p/ ML ------------------- */

function normalizeStatusForML(s) {
  if (!s) return '';
  const v = String(s).toLowerCase().trim();
  if (v === 'pending') return 'scheduled';
  if (v === 'prog' || v === 'programados' || v === 'programado') return 'scheduled';
  if (v === 'yes' || v === 'participantes') return 'started';
  if (v === 'non' || v === 'nao' || v === 'não') return 'candidate';
  return v; // 'candidate' | 'started' | 'scheduled' | 'all'
}
function statusQueryOrNull(s) {
  const v = normalizeStatusForML(s);
  return (!v || v === 'all') ? null : v;
}

/* ----------------------------- Busca paginada ----------------------------- */

async function fetchPromotionItemsPaged({
  mlCreds,
  promotion_id,
  promotion_type,
  status,           // 'started' | 'candidate' | 'scheduled' | null
  limit = 50,
  search_after = null
}) {
  const qs = new URLSearchParams();
  qs.set('promotion_type', String(promotion_type).toUpperCase());
  const s = statusQueryOrNull(status);
  if (s) qs.set('status', String(s));
  qs.set('limit', String(limit));
  if (search_after) qs.set('search_after', String(search_after));
  qs.set('app_version', 'v2');

  const url = `https://api.mercadolibre.com/seller-promotions/promotions/${encodeURIComponent(
    promotion_id
  )}/items?${qs.toString()}`;

  const r = await authFetch(url, {}, mlCreds);
  const txt = await r.text();
  let json;
  try {
    json = JSON.parse(txt);
  } catch {
    json = {};
  }
  const results = Array.isArray(json.results) ? json.results : [];
  const p = json?.paging || {};
  const next = p.searchAfter ?? p.next_token ?? p.search_after ?? null;
  const total = p.total ?? null;
  const benefits = json?.promotion_benefits || null;

  return { results, next, total, benefits, status: r.status };
}

function pickPromotionItemByStatus(results, preferredStatus = null) {
  const list = Array.isArray(results) ? results : [];
  const preferred = normalizeStatusForML(preferredStatus);
  if (!preferred) return list[0] || null;
  return (
    list.find((entry) => normalizeStatusForML(entry?.status) === preferred) ||
    null
  );
}

async function fetchPromotionItemById({
  mlCreds,
  promotion_id,
  promotion_type,
  item_id,
  preferred_status = null,
}) {
  const { results } = await fetchPromotionItemsBundleById({
    mlCreds,
    promotion_id,
    promotion_type,
    item_id,
    status: preferred_status,
  });
  return pickPromotionItemByStatus(results, preferred_status);
}

async function fetchPromotionItemsById({
  mlCreds,
  promotion_id,
  promotion_type,
  item_id
}) {
  const { results } = await fetchPromotionItemsBundleById({
    mlCreds,
    promotion_id,
    promotion_type,
    item_id,
  });
  return results;
}

async function fetchPromotionItemsBundleById({
  mlCreds,
  promotion_id,
  promotion_type,
  item_id,
  status = null,
}) {
  if (!promotion_id || !promotion_type || !item_id) {
    return { results: [], benefits: null };
  }

  const qs = new URLSearchParams();
  qs.set('promotion_type', String(promotion_type).toUpperCase());
  qs.set('item_id', String(item_id));
  const normalizedStatus = statusQueryOrNull(status);
  if (normalizedStatus) qs.set('status', normalizedStatus);
  qs.set('app_version', 'v2');

  const url = `https://api.mercadolibre.com/seller-promotions/promotions/${encodeURIComponent(
    promotion_id
  )}/items?${qs.toString()}`;

  const r = await authFetch(url, {}, mlCreds);
  if (!r.ok) return { results: [], benefits: null };

  const payload = await r.json().catch(() => ({}));
  const list = Array.isArray(payload?.results) ? payload.results : [];
  const target = String(item_id).trim().toUpperCase();
  return {
    results: list.filter((entry) =>
      String(entry?.id || entry?.item_id || "").trim().toUpperCase() === target
    ),
    benefits: payload?.promotion_benefits || null,
  };
}

/** Para SMART/PRICE_MATCHING: achar o offer_id candidate do item naquela campanha */
async function getOfferIdForItem({ mlCreds, item_id, promotion_id }) {
  const url = `https://api.mercadolibre.com/seller-promotions/items/${encodeURIComponent(
    item_id
  )}?app_version=v2`;
  const r = await authFetch(url, {}, mlCreds);
  if (!r.ok) return null;
  let arr;
  try {
    arr = await r.json();
  } catch {
    arr = [];
  }
  const list = Array.isArray(arr) ? arr : Array.isArray(arr.results) ? arr.results : [];
  const hit = list.find((p) => String(p.id || p.promotion_id) === String(promotion_id));
  const offer = hit?.offers?.[0] || null;
  return (
    offer?.offer_id ||
    offer?.id ||
    hit?.offer_id ||
    (/^OFFER-/i.test(String(hit?.ref_id || '')) ? String(hit.ref_id) : null) ||
    null
  );
}

function isStrictOfferPromotionType(promotion_type) {
  const typeUp = String(promotion_type || '').toUpperCase();
  return typeUp === 'PRE_NEGOTIATED' || typeUp === 'UNHEALTHY_STOCK';
}

function isCandidateNotFoundMlError(body) {
  const message = String(body?.message || body?.error || '').toUpperCase();
  if (message.includes('CANDIDATE_NOT_FOUND')) return true;
  const causes = Array.isArray(body?.cause) ? body.cause : [];
  return causes.some((cause) =>
    String(cause?.error_code || cause?.code || '').toUpperCase() === 'CANDIDATE_NOT_FOUND'
  );
}

function collectApplyOfferRefsFromItem(item, promotion_type) {
  const refs = [];
  const add = (value) => {
    const text = String(value || '').trim();
    if (!text || refs.includes(text)) return;
    refs.push(text);
  };

  const strictType = isStrictOfferPromotionType(promotion_type);

  add(item?._variant_offer_id);
  add(item?.offer_id);
  if (strictType) add(item?.ref_id);
  if (Array.isArray(item?.offers)) {
    for (const offer of item.offers) add(offer?.offer_id);
    for (const offer of item.offers) add(offer?.id);
    for (const offer of item.offers) add(offer?.candidate_id);
  }
  if (!strictType) add(item?.ref_id);
  add(item?.candidate_id);
  add(item?.offer_candidate_id);
  add(item?.candidate?.id);

  if (!refs.length && !isStrictOfferPromotionType(promotion_type)) {
    add(item?.offer_id);
  }

  return refs;
}

function requiresConfirmedOfferIdentity(promotion_type) {
  const typeUp = String(promotion_type || '').toUpperCase();
  return typeUp === 'SMART' || isStrictOfferPromotionType(typeUp);
}

function resolveSmartContribution(item, preferredOfferId = null) {
  const source = item && typeof item === 'object' ? item : {};
  const expected = String(preferredOfferId || '').trim();
  const offers = Array.isArray(source.offers) ? source.offers : [];
  let selected = null;
  if (expected) {
    selected = offers.find((offer) =>
      collectApplyOfferRefsFromItem(offer, 'SMART').includes(expected),
    ) || null;
  }
  const resolved = selected || source;
  const meli = toNum(
    resolved?.meli_percentage ??
      resolved?.rebate_meli_percent ??
      source?.meli_percentage ??
      source?.rebate_meli_percent,
  );
  const seller = toNum(
    resolved?.seller_percentage ?? source?.seller_percentage,
  );
  return {
    meli_percentage: meli == null ? null : round2(meli),
    seller_percentage: seller == null ? null : round2(seller),
  };
}

function smartContributionMatches(expected = {}, confirmed = {}, tolerance = 0.02) {
  const expectedMeli = toNum(expected?.meli_percentage);
  const expectedSeller = toNum(expected?.seller_percentage);
  if (expectedMeli == null && expectedSeller == null) return null;

  const confirmedMeli = toNum(confirmed?.meli_percentage);
  const confirmedSeller = toNum(confirmed?.seller_percentage);

  // SMART propaga a composicao de rebate de forma assincrona. Ausencia temporaria
  // de meli_percentage/seller_percentage significa "ainda nao confirmado", e nao
  // divergencia. So retornamos false quando os dois lados existem e diferem.
  if (expectedMeli != null && confirmedMeli == null) return null;
  if (expectedSeller != null && confirmedSeller == null) return null;

  const meliOk =
    expectedMeli == null || Math.abs(expectedMeli - confirmedMeli) <= tolerance;
  const sellerOk =
    expectedSeller == null || Math.abs(expectedSeller - confirmedSeller) <= tolerance;
  return meliOk && sellerOk;
}

function pickSmartPostApplyRow(rows, { expectedOfferId = null, preflightSnapshot = null } = {}) {
  const activeRows = (Array.isArray(rows) ? rows : []).filter((entry) =>
    ["started", "pending", "scheduled"].includes(
      normalizeStatusForML(entry?.status),
    ),
  );
  if (!activeRows.length) return null;

  const expected = String(expectedOfferId || "").trim();
  if (/^OFFER-/i.test(expected)) {
    const exact = activeRows.find((entry) =>
      collectApplyOfferRefsFromItem(entry, "SMART").includes(expected),
    );
    if (exact) return exact;
  }

  const expectedContribution = resolveSmartContribution(
    preflightSnapshot || {},
    null,
  );
  const contributionMatch = activeRows.find((entry) =>
    smartContributionMatches(
      expectedContribution,
      resolveSmartContribution(entry, null),
    ) === true,
  );
  return contributionMatch || activeRows[0] || null;
}

function smartConfirmationAuditFields(confirmation, promotion_type) {
  const typeUp = String(promotion_type || '').toUpperCase();
  if (typeUp === 'SMART') {
    return {
      smart_requested_offer_id: confirmation?.requested_offer_id ?? null,
      smart_expected_offer_id: confirmation?.expected_offer_id ?? null,
      smart_accepted_offer_id: confirmation?.accepted_offer_id ?? null,
      smart_accepted_price: confirmation?.accepted_price ?? null,
      smart_confirmed_offer_id: confirmation?.confirmed_offer_id ?? null,
      smart_confirmation_state:
        confirmation?.confirmation_state ??
        (confirmation?.confirmation_deferred === true ? 'pending' : confirmation?.ok === true ? 'confirmed' : 'failed'),
      smart_offer_resource_confirmed: confirmation?.offer_resource_confirmed === true,
      smart_offer_match_confirmed: confirmation?.offer_match_confirmed === true,
      smart_expected_meli_percentage:
        confirmation?.expected_meli_percentage ?? null,
      smart_confirmed_meli_percentage:
        confirmation?.confirmed_meli_percentage ?? null,
      smart_expected_seller_percentage:
        confirmation?.expected_seller_percentage ?? null,
      smart_confirmed_seller_percentage:
        confirmation?.confirmed_seller_percentage ?? null,
      smart_contribution_match:
        confirmation?.contribution_match == null
          ? null
          : confirmation.contribution_match === true,
      smart_contribution_state:
        confirmation?.contribution_match === true
          ? 'confirmed'
          : confirmation?.contribution_match === false
            ? 'different'
            : 'pending',
    };
  }

  if (typeUp === 'PRE_NEGOTIATED') {
    const snapshot = confirmation?.snapshot || {};
    const preflight = confirmation?.preflight_snapshot || confirmation?.preflightSnapshot || {};
    const originalPrice = toNum(
      snapshot?.original_price ??
      snapshot?.item_original_price ??
      preflight?.original_price ??
      preflight?.item_original_price,
    );
    const agreedPrice = toNum(
      confirmation?.accepted_price ??
      snapshot?.price ??
      snapshot?.deal_price ??
      preflight?.price ??
      preflight?.deal_price,
    );
    const baseDiscount =
      toNum(confirmation?.actual_percent) ??
      (originalPrice != null && originalPrice > 0 && agreedPrice != null && agreedPrice > 0
        ? computePercentFromDealPrice(originalPrice, agreedPrice)
        : null);
    return {
      pre_requested_offer_id: confirmation?.requested_offer_id ?? null,
      pre_accepted_offer_id: confirmation?.accepted_offer_id ?? null,
      pre_confirmed_offer_id: confirmation?.confirmed_offer_id ?? null,
      pre_confirmation_state:
        confirmation?.confirmation_state ??
        (confirmation?.confirmation_deferred === true ? 'pending' : confirmation?.ok === true ? 'confirmed' : 'failed'),
      pre_original_price: originalPrice,
      pre_agreed_price: agreedPrice,
      pre_base_discount_percent: baseDiscount == null ? null : round2(baseDiscount),
      pre_expected_meli_percentage: confirmation?.expected_meli_percentage ?? null,
      pre_confirmed_meli_percentage: confirmation?.confirmed_meli_percentage ?? null,
      pre_expected_seller_percentage: confirmation?.expected_seller_percentage ?? null,
      pre_confirmed_seller_percentage: confirmation?.confirmed_seller_percentage ?? null,
      pre_contribution_match:
        confirmation?.contribution_match == null ? null : confirmation.contribution_match === true,
      pre_boosted_offer: snapshot?.boosted_offer === true,
      pre_meli_boost_percent: toNum(
        snapshot?.discount_meli_boosted_percentage ??
        confirmation?.ml_response_body?.discount_meli_boosted_percentage,
      ),
      pre_meli_boost_amount: toNum(
        snapshot?.discount_meli_boost_amount ??
        confirmation?.ml_response_body?.discount_meli_boost_amount,
      ),
      pre_boosted_buyer_price: toNum(
        snapshot?.total_price_for_boosted_offer ??
        confirmation?.ml_response_body?.total_price_for_boosted_offer,
      ),
    };
  }

  return {};
}

function isPostApplyFullyConfirmed(confirmation) {
  return (
    confirmation?.ok === true &&
    confirmation?.confirmation_deferred !== true &&
    confirmation?.confirmation_state !== 'pending'
  );
}

function directOfferRefForPercentVariant(item, promotion_type) {
  const strictType = isStrictOfferPromotionType(promotion_type);
  const refs = collectApplyOfferRefsFromItem(item, promotion_type);
  return strictType
    ? refs.find((value) => !/^CANDIDATE-/i.test(String(value || ''))) || null
    : refs[0] || null;
}

function selectOfferWithinPercentCap(item, promotion_type, benefitsGlobal, percentCap) {
  const base = item && typeof item === 'object' ? item : {};
  const itemId = String(base.id || base.item_id || '').trim().toUpperCase();
  const cap = toNum(percentCap);
  if (!itemId || cap == null) return null;

  const variants = [{ ...base }];
  if (Array.isArray(base.offers)) {
    for (const offer of base.offers) {
      if (!offer || typeof offer !== 'object') continue;
      const hasOfferPercentHints =
        toNum(offer.discount_percentage) != null ||
        toNum(offer.meli_percentage) != null ||
        toNum(offer.seller_percentage) != null ||
        toNum(offer.rebate_meli_percent) != null ||
        toNum(offer?.benefits?.meli_percent) != null ||
        toNum(offer?.benefits?.seller_percent) != null;
      variants.push({
        ...base,
        ...offer,
        id: itemId,
        item_id: itemId,
        _variant_offer_id: offer.offer_id ?? offer.id ?? offer.candidate_id ?? null,
        original_price: offer.original_price ?? base.original_price ?? null,
        discount_percentage: hasOfferPercentHints
          ? offer.discount_percentage ?? null
          : base.discount_percentage ?? null,
        meli_percentage: offer.meli_percentage ?? base.meli_percentage ?? null,
        seller_percentage: offer.seller_percentage ?? base.seller_percentage ?? null,
        rebate_meli_percent:
          offer.rebate_meli_percent ?? base.rebate_meli_percent ?? null,
        benefits: offer.benefits ?? base.benefits ?? null,
      });
    }
  }

  const eligible = variants
    .map((variant) => {
      const offerId = directOfferRefForPercentVariant(variant, promotion_type);
      const percent = toNum(
        computeDiscountPct(variant, promotion_type, benefitsGlobal, 'min')
      );
      return { variant, offerId, percent };
    })
    .filter(
      (entry) =>
        entry.offerId &&
        entry.percent != null &&
        entry.percent <= cap + 0.0001
    )
    .sort((a, b) => b.percent - a.percent);

  const selected = eligible[0];
  if (!selected) return null;
  return {
    ...selected.variant,
    id: itemId,
    item_id: itemId,
    offer_id: selected.offerId,
    discount_percentage: round2(selected.percent),
    _selected_offer_id: selected.offerId,
    _selected_discount_percentage: round2(selected.percent),
    _offer_locked: true,
  };
}

async function fetchItemPromotionSnapshot({ mlCreds, item_id, promotion_id }) {
  return fetchPromotionItemById({
    mlCreds,
    promotion_id,
    promotion_type: 'SELLER_CAMPAIGN',
    item_id
  });
}


async function fetchPromotionSnapshotFromItem({ mlCreds, item_id, promotion_id }) {
  const id = String(item_id || "").trim();
  if (!id || !promotion_id) return null;

  const url =
    `https://api.mercadolibre.com/seller-promotions/items/${encodeURIComponent(id)}?app_version=v2`;
  const response = await authFetch(url, {}, mlCreds).catch(() => null);
  if (!response?.ok) return null;

  const payload = await response.json().catch(() => []);
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.results)
      ? payload.results
      : [];
  return (
    list.find(
      (entry) =>
        String(entry?.id || entry?.promotion_id || "") === String(promotion_id),
    ) || null
  );
}

async function fetchPromotionOfferResource({ mlCreds, offer_id }) {
  const offerId = String(offer_id || '').trim();
  if (!/^OFFER-/i.test(offerId)) return null;
  const url = `https://api.mercadolibre.com/seller-promotions/offers/${encodeURIComponent(offerId)}?app_version=v2`;
  const response = await authFetch(url, {}, mlCreds).catch(() => null);
  if (!response) return null;
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

function confirmSmartOfferResourceIdentity(resource, { offerId, itemId, promotionId } = {}) {
  if (!resource?.ok || !resource?.body) return false;
  const body = resource.body;
  const returnedId = String(body?.id || body?.offer_id || '').trim();
  const returnedItem = String(body?.item_id || body?.item?.id || '').trim().toUpperCase();
  const returnedPromotion = String(body?.promotion_id || body?.promotion?.id || '').trim();
  const returnedType = String(body?.type || body?.promotion_type || '').trim().toUpperCase();
  const returnedStatus = String(
    body?.status?.id ?? body?.status?.status ?? body?.status ?? '',
  ).trim().toLowerCase();
  return (
    returnedId === String(offerId || '').trim() &&
    returnedItem === String(itemId || '').trim().toUpperCase() &&
    returnedPromotion === String(promotionId || '').trim() &&
    (!returnedType || returnedType === 'SMART') &&
    (!returnedStatus || ['active', 'programmed', 'pending', 'started'].includes(returnedStatus))
  );
}

function isManualPercentPromotionType(type) {
  return ["DEAL", "SELLER_CAMPAIGN", "PRICE_DISCOUNT", "DOD", "LIGHTNING"].includes(
    String(type || "").toUpperCase(),
  );
}

function evaluatePostApplySnapshot({
  snapshot,
  item,
  preflightSnapshot,
  promotion_type,
  requested_percent,
  max_discount_percent,
  expected_offer_id,
  requested_offer_id = null,
}) {
  const t = String(promotion_type || "").toUpperCase();
  const status = normalizeStatusForML(snapshot?.status);
  if (!["started", "pending", "scheduled"].includes(status)) {
    return {
      ok: false,
      reason: `status pos-aplicacao nao confirmado: ${status || "ausente"}`,
      status,
      actual_percent: null,
    };
  }

  if (isManualPercentPromotionType(t)) {
    const requested = toNum(requested_percent);
    const originals = [
      snapshot?.original_price,
      snapshot?.item_original_price,
      snapshot?.regular_amount,
      snapshot?.base_price,
      preflightSnapshot?.original_price,
      preflightSnapshot?.item_original_price,
      preflightSnapshot?.regular_amount,
      preflightSnapshot?.base_price,
      item?.original_price,
      item?.item_original_price,
      item?.regular_amount,
      item?.base_price,
      item?.price,
    ]
      .map(toNum)
      .filter((value) => value != null && value > 0);
    const original = originals.length ? Math.max(...originals) : null;
    const appliedPrice =
      [
        snapshot?.deal_price,
        snapshot?.new_price,
        snapshot?._resolved_final_price,
        snapshot?.price,
      ]
        .map(toNum)
        .find(
          (value) =>
            value != null && value > 0 && (original == null || value < original),
        ) ?? null;
    const calculated =
      original != null && appliedPrice != null
        ? computePercentFromDealPrice(original, appliedPrice)
        : toNum(snapshot?.discount_percentage ?? snapshot?.discountPercent);
    // A boosted offer can lower the buyer-facing price beyond the base offer.
    const buyerPrice = toNum(snapshot?.total_price_for_boosted_offer) ?? appliedPrice;
    const buyerCalculated =
      original != null && buyerPrice != null
        ? computePercentFromDealPrice(original, buyerPrice)
        : calculated;

    if (!isValidManualPromoPercent(requested) || calculated == null) {
      return {
        ok: false,
        reason: "nao foi possivel confirmar o percentual real salvo no ML",
        status,
        actual_percent: calculated == null ? null : round2(calculated),
        original_price: original,
        applied_price: appliedPrice,
      };
    }

    const minAllowed = round2(
      requested - MANUAL_PROMO_PERCENT_LOWER_ROUNDING_TOLERANCE,
    );
    const maxAllowed = round2(
      Math.min(
        MANUAL_PROMO_MAX_PERCENT,
        requested + MANUAL_PROMO_PERCENT_TOLERANCE,
      ),
    );
    const ok = buyerCalculated >= minAllowed && buyerCalculated <= maxAllowed;
    return {
      ok,
      reason: ok
        ? null
        : `percentual final ao comprador ${round2(buyerCalculated)}% fora do permitido para ${round2(requested)}%`,
      status,
      requested_percent: round2(requested),
      actual_percent: round2(buyerCalculated),
      base_offer_percent: calculated == null ? null : round2(calculated),
      buyer_price: buyerPrice,
      boosted_offer: snapshot?.boosted_offer === true,
      min_allowed_percent: minAllowed,
      max_allowed_percent: maxAllowed,
      original_price: original,
      applied_price: appliedPrice,
    };
  }

  if (
    t === "SMART" ||
    t === "PRE_NEGOTIATED" ||
    t === "UNHEALTHY_STOCK" ||
    t.startsWith("PRICE_MATCHING")
  ) {
    const cap = toNum(max_discount_percent);
    const original = toNum(
      snapshot?.original_price ??
        snapshot?.item_original_price ??
        snapshot?.regular_amount ??
        snapshot?.base_price,
    );
    const appliedPrice = toNum(
      snapshot?.deal_price ??
        snapshot?.new_price ??
        snapshot?._resolved_final_price ??
        snapshot?.price,
    );
    const derivedFromPrice =
      original != null &&
      original > 0 &&
      appliedPrice != null &&
      appliedPrice > 0 &&
      appliedPrice < original
        ? computePercentFromDealPrice(original, appliedPrice)
        : null;
    const explicit = toNum(
      snapshot?.discount_percentage ?? snapshot?.discountPercent,
    );
    const computed = toNum(
      computeDiscountPct(snapshot || {}, t, null, "min"),
    );
    const actual =
      explicit ??
      derivedFromPrice ??
      (computed != null && computed > 0 ? computed : null);
    const refs = collectApplyOfferRefsFromItem(snapshot, t);
    const confirmedOfferRefs = refs.filter((value) =>
      /^OFFER-/i.test(String(value || "")),
    );
    const expected = String(expected_offer_id || "").trim();
    const requested = String(requested_offer_id || expected_offer_id || "").trim();
    const expectedIsConcreteOffer = /^OFFER-/i.test(expected);
    // PRE_NEGOTIATED usa um offer_id de candidatura que pode virar um OFFER-*
    // diferente quando a oferta fica ativa. A identidade estrita e validada no
    // POST; no pos-apply confirmamos campanha/item/status/preco, sem exigir que
    // o identificador ativo seja textual e identico ao candidato.
    const requiresOfferMatch =
      t === 'PRE_NEGOTIATED' ? false : requiresConfirmedOfferIdentity(t);
    const confirmedOfferId = expectedIsConcreteOffer && refs.includes(expected)
      ? expected
      : confirmedOfferRefs[0] || null;
    const offerMatches =
      t === 'PRE_NEGOTIATED'
        ? refs.length > 0
        : t === "SMART"
          ? expectedIsConcreteOffer
            ? refs.includes(expected)
            : confirmedOfferRefs.length === 1
          : !!expected && refs.includes(expected);

    const rebateAuditedType = t === 'SMART' || t === 'PRE_NEGOTIATED';
    const expectedContribution =
      rebateAuditedType
        ? resolveSmartContribution(preflightSnapshot || item || {}, requested || expected)
        : { meli_percentage: null, seller_percentage: null };
    const confirmedContribution =
      rebateAuditedType
        ? resolveSmartContribution(snapshot || {}, confirmedOfferId || expected)
        : { meli_percentage: null, seller_percentage: null };
    const contributionMatch =
      rebateAuditedType
        ? smartContributionMatches(expectedContribution, confirmedContribution)
        : null;
    const withinCap = cap != null && actual != null && actual <= cap + 0.0001;
    // A composicao meli/seller e informacao de auditoria/rebate. Ela pode propagar
    // depois do OFFER e, por si so, nao autoriza rollback. A trava comercial da
    // SMART continua sendo a identidade da oferta + desconto base dentro do teto.
    const ok =
      withinCap &&
      (!requiresOfferMatch || offerMatches);

    let reason = null;
    let warning = null;
    if (!ok) {
      if (requiresOfferMatch && !offerMatches) {
        reason = t === "SMART"
          ? expectedIsConcreteOffer
            ? "offer_id Smart confirmado no ML difere da oferta criada"
            : "nao foi possivel confirmar um OFFER-* efetivamente aplicado para a Smart"
          : "offer_id confirmado no ML difere da oferta selecionada";
      } else if (actual == null) {
        reason =
          t === 'PRE_NEGOTIATED'
            ? "nao foi possivel confirmar o desconto base do pre-acordo"
            : "nao foi possivel confirmar o desconto real da oferta Smart";
      } else {
        reason =
          t === 'PRE_NEGOTIATED'
            ? `desconto base PRE_NEGOTIATED confirmado ${round2(actual)}% acima do teto de ${round2(cap)}%`
            : `desconto Smart confirmado ${round2(actual)}% acima do teto de ${round2(cap)}%`;
      }
    } else if ((t === "SMART" || t === 'PRE_NEGOTIATED') && contributionMatch === false) {
      warning =
        t === 'PRE_NEGOTIATED'
          ? "participacao ML/vendedor do pre-acordo difere do candidato; mantida para auditoria"
          : "participacao ML/vendedor confirmada na Smart difere da oferta selecionada; mantida para auditoria";
    }

    return {
      ok,
      reason,
      warning,
      status,
      actual_percent: actual == null ? null : round2(actual),
      max_discount_percent: cap,
      requested_offer_id: requested || null,
      expected_offer_id: expected || null,
      confirmed_offer_id: confirmedOfferId,
      confirmed_offer_refs: refs,
      offer_match_required: requiresOfferMatch,
      offer_match_confirmed: offerMatches,
      expected_meli_percentage: expectedContribution.meli_percentage,
      confirmed_meli_percentage: confirmedContribution.meli_percentage,
      expected_seller_percentage: expectedContribution.seller_percentage,
      confirmed_seller_percentage: confirmedContribution.seller_percentage,
      contribution_match: contributionMatch,
    };
  }

  return { ok: true, reason: null, status, actual_percent: null };
}

function evaluateAcceptedApplyResponse({
  applyResult,
  item,
  preflightSnapshot,
  promotion_type,
  requested_percent,
  max_discount_percent,
  expected_offer_id,
}) {
  if (!applyResult?.ok) return null;

  const t = String(promotion_type || "").toUpperCase();
  const body = applyResult?.body || applyResult?.trace?.ml_body || {};
  const requestPayload = applyResult?.trace?.payload || {};
  const status = Number(applyResult?.status ?? applyResult?.trace?.http_status);
  if (!Number.isFinite(status) || status < 200 || status >= 300) return null;
  if (!body || typeof body !== "object") return null;

  const responseSnapshot = {
    ...body,
    status: body.status || "pending",
    ref_id:
      body.ref_id ??
      (/^CANDIDATE-/i.test(String(expected_offer_id || ""))
        ? expected_offer_id
        : null),
    candidate_id:
      body.candidate_id ??
      (/^CANDIDATE-/i.test(String(expected_offer_id || ""))
        ? expected_offer_id
        : null),
    original_price:
      body.original_price ??
      body.item_original_price ??
      preflightSnapshot?.original_price ??
      preflightSnapshot?.item_original_price ??
      item?.original_price ??
      item?.item_original_price ??
      item?.regular_amount ??
      item?.base_price,
    price:
      body.price ??
      body.deal_price ??
      body.new_price ??
      body._resolved_final_price ??
      requestPayload.deal_price ??
      preflightSnapshot?.price ??
      preflightSnapshot?.deal_price,
    deal_price:
      body.deal_price ??
      body.price ??
      body.new_price ??
      body._resolved_final_price ??
      requestPayload.deal_price ??
      preflightSnapshot?.deal_price ??
      preflightSnapshot?.price,
  };

  const evaluated = evaluatePostApplySnapshot({
    snapshot: responseSnapshot,
    item,
    preflightSnapshot,
    promotion_type: t,
    requested_percent,
    max_discount_percent,
    expected_offer_id,
  });

  const responseOfferRefs = collectApplyOfferRefsFromItem(body, t);
  const acceptedOfferId =
    t === 'PRE_NEGOTIATED'
      ? responseOfferRefs[0] || String(body?.offer_id || body?.id || '').trim() || null
      : responseOfferRefs.find((ref) => /^OFFER-/i.test(String(ref || ""))) ||
        (/^OFFER-/i.test(String(body?.id || "")) ? String(body.id) : null);
  const acceptedPrice = toNum(body?.price ?? body?.deal_price ?? body?.new_price);

  // Para SMART, o fallback assincrono so e considerado evidencia suficiente
  // quando o POST devolve um OFFER-* concreto e o preco efetivamente aceito.
  // Sem um desses dados, aguardamos os GETs de confirmacao e nao inferimos o
  // estado final apenas a partir do preflight.
  if (
    (t === "SMART" || t === 'PRE_NEGOTIATED') &&
    (!acceptedOfferId || acceptedPrice == null)
  ) return null;

  const requestedOfferId = String(
    requestPayload?.offer_id || expected_offer_id || '',
  ).trim();
  if (
    t === 'PRE_NEGOTIATED' &&
    requestedOfferId &&
    acceptedOfferId &&
    String(acceptedOfferId) !== requestedOfferId
  ) {
    return {
      ...evaluated,
      ok: false,
      reason: 'offer_id aceito pelo ML difere do pre-acordo enviado no POST',
      concrete_divergence: true,
      requested_offer_id: requestedOfferId,
      accepted_offer_id: acceptedOfferId,
      accepted_price: acceptedPrice,
      confirmation_state: 'divergent',
      ml_response_status: status,
      ml_response_body: body,
    };
  }

  // Se a propria resposta 2xx do ML trouxer um desconto acima do teto, isso e
  // uma divergencia concreta e deve permanecer bloqueante. Nos demais casos,
  // a resposta aceita e uma evidencia segura para aguardar propagacao.
  if (!evaluated.ok) {
    const cap = toNum(max_discount_percent);
    const actual = toNum(evaluated?.actual_percent);
    if (
      (t === "SMART" || t === 'PRE_NEGOTIATED') &&
      acceptedOfferId &&
      acceptedPrice != null &&
      cap != null &&
      actual != null &&
      actual > cap + 0.0001
    ) {
      return {
        ...evaluated,
        status: "accepted_by_ml",
        concrete_divergence: true,
        accepted_offer_id: acceptedOfferId,
        accepted_price: acceptedPrice,
        confirmation_state: "divergent",
        ml_response_status: status,
        ml_response_body: body,
      };
    }
    return null;
  }

  return {
    ...evaluated,
    status: "accepted_by_ml",
    reason: "aplicacao aceita pelo ML; confirmacao assincrona ainda pendente",
    confirmation_deferred: true,
    confirmation_state: "pending",
    accepted_offer_id: acceptedOfferId,
    accepted_price: acceptedPrice,
    ml_response_status: status,
    ml_response_body: body,
  };
}

async function confirmAppliedPromotionState({
  mlCreds,
  promotion_id,
  promotion_type,
  item,
  applyResult,
  requested_percent,
  max_discount_percent,
}) {
  const itemId = item?.id || item?.item_id;
  const typeUp = String(promotion_type || "").toUpperCase();
  let last = null;
  const requestedOfferId = applyResult?.trace?.payload?.offer_id || null;
  const responseOfferRefs = collectApplyOfferRefsFromItem(
    applyResult?.body || {},
    typeUp,
  );
  const acceptedOfferId =
    typeUp === 'PRE_NEGOTIATED'
      ? responseOfferRefs[0] ||
        String(applyResult?.body?.offer_id || applyResult?.body?.id || '').trim() ||
        null
      : responseOfferRefs.find((ref) => /^OFFER-/i.test(String(ref || ""))) ||
        (/^OFFER-/i.test(String(applyResult?.body?.id || ""))
          ? String(applyResult.body.id)
          : null) ||
        (/^OFFER-/i.test(String(applyResult?.body?.offer_id || ""))
          ? String(applyResult.body.offer_id)
          : null) ||
        null;
  const acceptedPrice = toNum(
    applyResult?.body?.price ??
      applyResult?.body?.deal_price ??
      applyResult?.body?.new_price,
  );
  const acceptedResponse = evaluateAcceptedApplyResponse({
    applyResult,
    item,
    preflightSnapshot: applyResult?.trace?.snapshot || null,
    promotion_type,
    requested_percent,
    max_discount_percent,
    expected_offer_id: requestedOfferId,
  });

  if (acceptedResponse?.concrete_divergence === true) {
    return {
      ...acceptedResponse,
      requested_offer_id: requestedOfferId,
      accepted_offer_id: acceptedOfferId || acceptedResponse.accepted_offer_id || null,
      accepted_price: acceptedPrice ?? acceptedResponse.accepted_price ?? null,
      confirmation_state: "divergent",
      attempt: 0,
    };
  }

  let offerResourceConfirmed = false;
  let offerResource = null;
  const asyncOfferType = typeUp === "SMART" || typeUp === 'PRE_NEGOTIATED';
  const verifyAttempts =
    asyncOfferType ? SMART_POST_APPLY_VERIFY_ATTEMPTS : POST_APPLY_VERIFY_ATTEMPTS;
  const verifyDelayMs =
    asyncOfferType ? SMART_POST_APPLY_VERIFY_DELAY_MS : POST_APPLY_VERIFY_DELAY_MS;

  for (let attempt = 1; attempt <= verifyAttempts; attempt += 1) {
    if (attempt > 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, verifyDelayMs * Math.min(attempt - 1, 4)),
      );
    }

    if (typeUp === "SMART" && acceptedOfferId && !offerResourceConfirmed) {
      offerResource = await fetchPromotionOfferResource({
        mlCreds,
        offer_id: acceptedOfferId,
      }).catch(() => null);
      offerResourceConfirmed = confirmSmartOfferResourceIdentity(offerResource, {
        offerId: acceptedOfferId,
        itemId,
        promotionId: promotion_id,
      });
    }

    let snapshot = await fetchPromotionSnapshotFromItem({
      mlCreds,
      item_id: itemId,
      promotion_id,
    }).catch(() => null);

    const preflightSnapshot = applyResult?.trace?.snapshot || null;
    const snapshotStatusOk =
      !!snapshot &&
      ["started", "pending", "scheduled"].includes(
        normalizeStatusForML(snapshot?.status),
      );
    const smartRefs =
      typeUp === "SMART" ? collectApplyOfferRefsFromItem(snapshot, typeUp) : [];
    const smartContribution =
      typeUp === "SMART"
        ? resolveSmartContribution(snapshot || {}, acceptedOfferId)
        : null;
    const smartNeedsDetailedSnapshot =
      typeUp === "SMART" &&
      (
        !smartRefs.some((ref) => /^OFFER-/i.test(String(ref || ""))) ||
        smartContribution?.meli_percentage == null ||
        smartContribution?.seller_percentage == null
      );

    if (!snapshotStatusOk || smartNeedsDetailedSnapshot) {
      const bundle = await fetchPromotionItemsBundleById({
        mlCreds,
        promotion_id,
        promotion_type,
        item_id: itemId,
      }).catch(() => ({ results: [] }));
      const rows = Array.isArray(bundle?.results) ? bundle.results : [];
      if (typeUp === "SMART") {
        snapshot =
          pickSmartPostApplyRow(rows, {
            expectedOfferId: acceptedOfferId,
            preflightSnapshot,
          }) || snapshot;
      } else {
        snapshot =
          rows.find((entry) =>
            ["started", "pending", "scheduled"].includes(
              normalizeStatusForML(entry?.status),
            ),
          ) || snapshot;
      }
    }

    last = {
      ...evaluatePostApplySnapshot({
        snapshot,
        item,
        preflightSnapshot,
        promotion_type,
        requested_percent,
        max_discount_percent,
        expected_offer_id: acceptedOfferId || requestedOfferId,
        requested_offer_id: requestedOfferId,
      }),
      snapshot,
      attempt,
      accepted_offer_id: acceptedOfferId,
      accepted_price: acceptedPrice,
      offer_resource_confirmed: offerResourceConfirmed,
      offer_resource_status: offerResource?.status ?? null,
    };

    // Desconto acima do teto e uma divergencia concreta: nao aguardamos mais
    // propagacao para iniciar a protecao/rollback.
    if (
      (typeUp === "SMART" || typeUp === 'PRE_NEGOTIATED') &&
      toNum(last.actual_percent) != null &&
      toNum(max_discount_percent) != null &&
      toNum(last.actual_percent) > toNum(max_discount_percent) + 0.0001
    ) {
      return {
        ...last,
        confirmation_state: "divergent",
      };
    }

    if (last.ok) {
      const rebatePending =
        (typeUp === "SMART" || typeUp === 'PRE_NEGOTIATED') &&
        last.contribution_match == null;
      return {
        ...last,
        confirmation_deferred: rebatePending,
        confirmation_state: rebatePending
          ? "confirmed_offer_rebate_pending"
          : last.contribution_match === false
            ? "confirmed_with_rebate_warning"
            : "confirmed",
      };
    }
  }

  // SMART e PRE_NEGOTIATED podem propagar o estado ativo de forma assincrona.
  // Se o POST 2xx trouxe a oferta aceita e o preco ficou dentro do teto, seguimos
  // como confirmacao pendente. Isso evita rollback/remediacao apenas por atraso
  // de propagacao, sem relaxar a trava de desconto acima do teto.
  if ((typeUp === "SMART" || typeUp === "PRE_NEGOTIATED") && acceptedResponse) {
    const isPreNegotiated = typeUp === "PRE_NEGOTIATED";
    return {
      ...acceptedResponse,
      requested_offer_id: requestedOfferId,
      expected_offer_id: isPreNegotiated
        ? requestedOfferId
        : acceptedOfferId || acceptedResponse.expected_offer_id || requestedOfferId,
      accepted_offer_id: acceptedOfferId || acceptedResponse.accepted_offer_id || null,
      accepted_price: acceptedPrice ?? acceptedResponse.accepted_price ?? null,
      confirmed_offer_id: last?.confirmed_offer_id || (offerResourceConfirmed ? acceptedOfferId : null),
      offer_match_confirmed: isPreNegotiated
        ? last?.offer_match_confirmed === true
        : offerResourceConfirmed,
      offer_resource_confirmed: isPreNegotiated ? false : offerResourceConfirmed,
      offer_resource_status: isPreNegotiated ? null : offerResource?.status ?? null,
      confirmation_deferred: true,
      confirmation_state: isPreNegotiated
        ? "pre_agreement_accepted_activation_pending"
        : offerResourceConfirmed
          ? "offer_confirmed_details_pending"
          : "pending",
      fallback_reason:
        last?.reason ||
        (isPreNegotiated
          ? "pre-acordo aceito pelo ML; ativacao ainda em propagacao"
          : "propagacao Smart ainda pendente"),
      snapshot: acceptedResponse.ml_response_body,
      attempt: verifyAttempts,
    };
  }

  if (
    typeUp !== "SMART" &&
    typeUp !== "PRE_NEGOTIATED" &&
    acceptedResponse &&
    last &&
    String(last.reason || "").includes("status pos-aplicacao nao confirmado")
  ) {
    return {
      ...acceptedResponse,
      fallback_reason: last.reason,
      snapshot: acceptedResponse.ml_response_body,
      attempt: verifyAttempts,
    };
  }

  return (
    last || {
      ok: false,
      reason: "nao foi possivel consultar o estado pos-aplicacao no ML",
      actual_percent: null,
      snapshot: null,
      accepted_offer_id: acceptedOfferId,
      accepted_price: acceptedPrice,
      confirmation_state: "pending",
      attempt: verifyAttempts,
    }
  );
}

function isPromotionReviewRow(row) {
  return row?.success !== true || String(row?.status || '').toLowerCase() === 'review';
}

function classifyPostApplyReview(confirmation = {}) {
  if (confirmation?.ok === true) {
    if (confirmation?.contribution_match === false) {
      return { code: 'SMART_REBATE_DIVERGENTE', severity: 'warning', critical: false };
    }
    return { code: null, severity: null, critical: false };
  }
  const actual = toNum(confirmation?.actual_percent);
  const minAllowed = toNum(confirmation?.min_allowed_percent);
  const maxAllowed = toNum(
    confirmation?.max_allowed_percent ?? confirmation?.max_discount_percent,
  );
  if (actual != null && maxAllowed != null && actual > maxAllowed + 0.0001) {
    return { code: 'PERCENTUAL_ACIMA', severity: 'critical', critical: true };
  }
  if (actual != null && minAllowed != null && actual < minAllowed) {
    return { code: 'PERCENTUAL_ABAIXO', severity: 'warning', critical: false };
  }
  if (confirmation?.contribution_match === false) {
    return { code: 'SMART_REBATE_DIVERGENTE', severity: 'warning', critical: false };
  }
  return { code: 'CONFIRMACAO_PENDENTE', severity: 'warning', critical: false };
}

const PROMOTION_REPORT_COLUMNS = [
  { header: 'MLB', key: 'mlb_id', width: 20 },
  { header: 'Status', key: 'status', width: 18 },
  { header: 'Status da revisao', key: 'review_status', width: 28 },
  { header: 'Gravidade', key: 'review_severity', width: 14 },
  { header: '% solicitada', key: 'requested_percent', width: 16 },
  { header: '% estimada', key: 'estimated_percent', width: 16 },
  { header: '% aplicada real', key: 'real_applied_percent', width: 18 },
  { header: 'Confirmado no ML', key: 'post_apply_confirmed', width: 18 },
  { header: 'Smart candidato enviado', key: 'smart_requested_offer_id', width: 28 },
  { header: 'Smart OFFER aceito no POST', key: 'smart_accepted_offer_id', width: 30 },
  { header: 'Smart preco aceito no POST', key: 'smart_accepted_price', width: 24 },
  { header: 'Smart OFFER confirmado', key: 'smart_confirmed_offer_id', width: 28 },
  { header: 'Smart estado confirmacao', key: 'smart_confirmation_state', width: 26 },
  { header: 'Smart recurso OFFER confirmado', key: 'smart_offer_resource_confirmed', width: 28 },
  { header: 'Smart % ML esperada', key: 'smart_expected_meli_percentage', width: 20 },
  { header: 'Smart % ML confirmada', key: 'smart_confirmed_meli_percentage', width: 22 },
  { header: 'Smart % vendedor esperada', key: 'smart_expected_seller_percentage', width: 24 },
  { header: 'Smart % vendedor confirmada', key: 'smart_confirmed_seller_percentage', width: 26 },
  { header: 'Smart rebate confirmado', key: 'smart_contribution_match', width: 22 },
  { header: 'PRE oferta candidata enviada', key: 'pre_requested_offer_id', width: 34 },
  { header: 'PRE oferta aceita no POST', key: 'pre_accepted_offer_id', width: 34 },
  { header: 'PRE oferta ativa confirmada', key: 'pre_confirmed_offer_id', width: 34 },
  { header: 'PRE estado confirmacao', key: 'pre_confirmation_state', width: 26 },
  { header: 'PRE preco original', key: 'pre_original_price', width: 20 },
  { header: 'PRE preco acordado', key: 'pre_agreed_price', width: 20 },
  { header: 'PRE desconto base %', key: 'pre_base_discount_percent', width: 20 },
  { header: 'PRE % ML esperada', key: 'pre_expected_meli_percentage', width: 20 },
  { header: 'PRE % ML confirmada', key: 'pre_confirmed_meli_percentage', width: 22 },
  { header: 'PRE % vendedor esperada', key: 'pre_expected_seller_percentage', width: 24 },
  { header: 'PRE % vendedor confirmada', key: 'pre_confirmed_seller_percentage', width: 26 },
  { header: 'PRE rebate confirmado', key: 'pre_contribution_match', width: 22 },
  { header: 'PRE boost ML', key: 'pre_boosted_offer', width: 16 },
  { header: 'PRE boost ML %', key: 'pre_meli_boost_percent', width: 18 },
  { header: 'PRE boost ML valor', key: 'pre_meli_boost_amount', width: 20 },
  { header: 'PRE preco comprador c/ boost', key: 'pre_boosted_buyer_price', width: 26 },
  { header: 'Retries transitorios', key: 'transient_retries', width: 20 },
  { header: 'Disjuntor de seguranca', key: 'safety_circuit_breaker', width: 22 },
  { header: 'Decisao do lote', key: 'batch_decision', width: 18 },
  { header: 'Codigo da decisao', key: 'batch_decision_code', width: 32 },
  { header: 'Motivo da decisao', key: 'batch_decision_reason', width: 55 },
  { header: 'Status da quarentena', key: 'quarantine_status', width: 24 },
  { header: 'Job de remediacao', key: 'remediation_job_id', width: 38 },
  { header: 'Tentativas de remediacao', key: 'remediation_attempts', width: 24 },
  { header: 'Ultimo erro da remediacao', key: 'remediation_last_error', width: 50 },
  { header: 'Rollback tentado', key: 'rollback_attempted', width: 18 },
  { header: 'Rollback confirmado', key: 'rollback_confirmed', width: 20 },
  { header: 'HTTP rollback', key: 'rollback_status', width: 15 },
  { header: 'Erro do rollback', key: 'rollback_error', width: 40 },
  { header: 'Mensagem', key: 'message', width: 55 },
  { header: 'Motivo do erro', key: 'error_reason', width: 55 },
  { header: 'Explicacao', key: 'explanation', width: 65 },
];

function promotionReportRecord(row = {}) {
  const requestedPercent = toNum(promoResultRequestedPercent(row));
  const estimatedPercent = toNum(promoResultEstimatedPercent(row));
  const realAppliedPercent = toNum(promoResultRealAppliedPercent(row));
  return {
    mlb_id: String(row?.mlb_id || ''),
    status: row?.status || (row?.success ? 'success' : 'error'),
    review_status: row?.review_status || '',
    review_severity: row?.review_severity || '',
    requested_percent: requestedPercent ?? '',
    estimated_percent: estimatedPercent ?? '',
    real_applied_percent: realAppliedPercent ?? '',
    post_apply_confirmed:
      row?.post_apply_confirmed == null
        ? ''
        : row.post_apply_confirmed
          ? 'sim'
          : 'nao',
    smart_requested_offer_id: row?.smart_requested_offer_id || null,
    smart_accepted_offer_id: row?.smart_accepted_offer_id || null,
    smart_accepted_price: toNum(row?.smart_accepted_price),
    smart_confirmed_offer_id: row?.smart_confirmed_offer_id || null,
    smart_confirmation_state: row?.smart_confirmation_state || null,
    smart_offer_resource_confirmed:
      row?.smart_offer_resource_confirmed == null
        ? null
        : row.smart_offer_resource_confirmed
          ? 'sim'
          : 'nao',
    smart_expected_meli_percentage: toNum(row?.smart_expected_meli_percentage),
    smart_confirmed_meli_percentage: toNum(row?.smart_confirmed_meli_percentage),
    smart_expected_seller_percentage: toNum(row?.smart_expected_seller_percentage),
    smart_confirmed_seller_percentage: toNum(row?.smart_confirmed_seller_percentage),
    smart_contribution_match:
      row?.smart_contribution_match == null
        ? ''
        : row.smart_contribution_match
          ? 'sim'
          : 'nao',
    pre_requested_offer_id: row?.pre_requested_offer_id || null,
    pre_accepted_offer_id: row?.pre_accepted_offer_id || null,
    pre_confirmed_offer_id: row?.pre_confirmed_offer_id || null,
    pre_confirmation_state: row?.pre_confirmation_state || null,
    pre_original_price: toNum(row?.pre_original_price),
    pre_agreed_price: toNum(row?.pre_agreed_price),
    pre_base_discount_percent: toNum(row?.pre_base_discount_percent),
    pre_expected_meli_percentage: toNum(row?.pre_expected_meli_percentage),
    pre_confirmed_meli_percentage: toNum(row?.pre_confirmed_meli_percentage),
    pre_expected_seller_percentage: toNum(row?.pre_expected_seller_percentage),
    pre_confirmed_seller_percentage: toNum(row?.pre_confirmed_seller_percentage),
    pre_contribution_match:
      row?.pre_contribution_match == null
        ? ''
        : row.pre_contribution_match
          ? 'sim'
          : 'nao',
    pre_boosted_offer:
      row?.pre_boosted_offer == null ? '' : row.pre_boosted_offer ? 'sim' : 'nao',
    pre_meli_boost_percent: toNum(row?.pre_meli_boost_percent),
    pre_meli_boost_amount: toNum(row?.pre_meli_boost_amount),
    pre_boosted_buyer_price: toNum(row?.pre_boosted_buyer_price),
    transient_retries: toNum(row?.transient_retries) ?? 0,
    safety_circuit_breaker: row?.safety_circuit_breaker ? 'sim' : 'nao',
    batch_decision: row?.batch_decision || '',
    batch_decision_code: row?.batch_decision_code || '',
    batch_decision_reason: row?.batch_decision_reason || '',
    quarantine_status: row?.quarantine_status || '',
    remediation_job_id: row?.remediation_job_id || '',
    remediation_attempts: toNum(row?.remediation_attempts) ?? '',
    remediation_last_error: row?.remediation_last_error || '',
    rollback_attempted: row?.rollback_attempted ? 'sim' : 'nao',
    rollback_confirmed: row?.rollback_confirmed ? 'sim' : 'nao',
    rollback_status: row?.rollback_status ?? '',
    rollback_error: row?.rollback_error || '',
    message: row?.message || '',
    error_reason: promoResultErrorMessage(row),
    explanation: promotionCsvErrorExplanation(row),
  };
}

function stylePromotionReportSheet(sheet) {
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: PROMOTION_REPORT_COLUMNS.length },
  };
  sheet.getRow(1).height = 24;
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF183153' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  for (const key of [
    'requested_percent',
    'estimated_percent',
    'real_applied_percent',
    'smart_expected_meli_percentage',
    'smart_confirmed_meli_percentage',
    'smart_expected_seller_percentage',
    'smart_confirmed_seller_percentage',
  ]) {
    sheet.getColumn(key).numFmt = '0.00"%"';
  }
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.alignment = { vertical: 'top', wrapText: true };
    const status = String(row.getCell('status').value || '').toLowerCase();
    const rollbackConfirmed = String(row.getCell('rollback_confirmed').value || '').toLowerCase() === 'sim';
    const color = rollbackConfirmed
      ? 'FFFFF3CD'
      : status === 'success'
        ? 'FFE7F6EC'
        : 'FFFDE8E8';
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
      cell.alignment = { vertical: 'top', wrapText: true };
    });
  });
}

async function buildPromotionResultsWorkbook(rows = [], context = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'DACHBYTE Seller';
  workbook.created = new Date();

  const jobData = context?.jobData || {};
  const counters = context?.counters || jobData?.counters || {};
  const promotion = jobData?.promotion || {};
  const auditContext = jobData?.auditContext || {};
  const requestedPercent =
    toNum(jobData?.options?.deal_manual_percent) ??
    toNum(jobData?.options?.seller_manual_percent) ??
    toNum(jobData?.filters?.maxDesc) ??
    null;

  const summary = workbook.addWorksheet('Resumo do job');
  summary.columns = [
    { header: 'Campo', key: 'field', width: 30 },
    { header: 'Valor', key: 'value', width: 70 },
  ];
  const summaryRows = [
    ['Job', context?.jobId != null ? String(context.jobId) : ''],
    ['Operacao', jobData?.operationId || jobData?.options?.operation_id || ''],
    [
      'Retomado do job',
      jobData?.resumedFromJobId || jobData?.options?.resumed_from_job_id || '',
    ],
    ['Retomado pelo job', jobData?.resumedByJobId || ''],
    ['Status', context?.stateLabel || jobData?.stateLabel || ''],
    ['Conta', jobData?.accountLabel || jobData?.accountKey || ''],
    ['Usuario', auditContext?.email || auditContext?.userId || ''],
    ['Tipo', promotion?.type || ''],
    ['Campanha', promotion?.name || promotion?.title || promotion?.id || ''],
    ['Promotion ID', promotion?.id || ''],
    ['Percentual solicitado', requestedPercent != null ? `${round2(requestedPercent)}%` : ''],
    ['Total', Number(counters?.total || 0)],
    ['Processados', Number(counters?.processed || 0)],
    ['Sucessos', Number(counters?.success || 0)],
    ['Erros/revisoes', Number(counters?.failed || 0)],
    ['Pendentes', Math.max(0, Number(counters?.total || 0) - Number(counters?.processed || 0))],
    ['Velocidade (itens/min)', toNum(jobData?.performance?.itemsPerMinute) ?? ''],
    ['ETA restante (segundos)', toNum(jobData?.performance?.etaSeconds) ?? ''],
    ['Concorrencia atual', toNum(jobData?.performance?.currentConcurrency) ?? ''],
    ['Concorrencia maxima', toNum(jobData?.performance?.maxConcurrency) ?? PROMO_ITEM_MAX_CONCURRENCY],
    ['Duracao ultimo item (ms)', toNum(jobData?.performance?.lastItemDurationMs) ?? ''],
    ['Criado em', context?.createdAt || ''],
    ['Atualizado em', context?.updatedAt || ''],
    ['Pausado por seguranca', jobData?.safetyPaused === true ? 'sim' : 'nao'],
    ['Cancelado', jobData?.stateLabel === 'cancelado' ? 'sim' : 'nao'],
    [
      'Cancelamento solicitado por',
      jobData?.cancelRequestedBy?.email ||
        jobData?.cancelRequestedBy?.userId ||
        '',
    ],
    [
      'Cancelamento solicitado em',
      jobData?.cancelRequestedAt
        ? new Date(jobData.cancelRequestedAt).toISOString()
        : '',
    ],
    [
      'Cancelamento concluido em',
      jobData?.cancelCompletedAt
        ? new Date(jobData.cancelCompletedAt).toISOString()
        : '',
    ],
  ];
  summaryRows.forEach(([field, value]) => summary.addRow({ field, value }));
  summary.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF183153' } };
  });
  summary.views = [{ state: 'frozen', ySplit: 1 }];

  const addSheet = (name, sourceRows) => {
    const sheet = workbook.addWorksheet(name, {
      properties: { defaultRowHeight: 18 },
    });
    sheet.columns = PROMOTION_REPORT_COLUMNS;
    sourceRows.map(promotionReportRecord).forEach((record) => sheet.addRow(record));
    stylePromotionReportSheet(sheet);
    return sheet;
  };

  addSheet('Resultado completo', safeRows);
  addSheet('Erros e revisoes', safeRows.filter(isPromotionReviewRow));
  addSheet(
    'Quarentena',
    safeRows.filter((row) => String(row?.quarantine_status || '').trim()),
  );

  const traces = Array.isArray(context?.itemTraces)
    ? context.itemTraces
    : Array.isArray(jobData?.itemTraces)
      ? jobData.itemTraces
      : [];
  const auditSheet = workbook.addWorksheet('Auditoria tecnica', {
    properties: { defaultRowHeight: 18 },
  });
  auditSheet.columns = [
    { header: 'Horario', key: 'ts', width: 24 },
    { header: 'MLB', key: 'item_id', width: 20 },
    { header: 'Acao', key: 'action', width: 14 },
    { header: 'Tipo', key: 'promotion_type', width: 22 },
    { header: 'Promotion ID', key: 'promotion_id', width: 28 },
    { header: 'Metodo', key: 'method', width: 12 },
    { header: 'Status antes', key: 'campaign_item_status', width: 18 },
    { header: 'Preco original', key: 'original_price', width: 18 },
    { header: 'Preco campanha antes', key: 'campaign_price', width: 22 },
    { header: 'Preco enviado', key: 'requested_deal_price', width: 18 },
    { header: 'HTTP', key: 'http_status', width: 10 },
    { header: 'OK', key: 'ok', width: 10 },
    { header: 'Erro', key: 'error', width: 45 },
    { header: 'Observacao', key: 'notes', width: 55 },
    { header: 'Resposta ML (resumo)', key: 'ml_body', width: 70 },
  ];
  traces.forEach((trace) => {
    let mlBody = '';
    try {
      mlBody = trace?.ml_body == null ? '' : JSON.stringify(trace.ml_body);
    } catch {
      mlBody = safeText(trace?.ml_body || '', 2000);
    }
    auditSheet.addRow({
      ts: trace?.ts || '',
      item_id: trace?.item_id || '',
      action: trace?.action || '',
      promotion_type: trace?.promotion_type || '',
      promotion_id: trace?.promotion_id || '',
      method: trace?.method || '',
      campaign_item_status: trace?.campaign_item_status || '',
      original_price: trace?.original_price ?? '',
      campaign_price: trace?.campaign_price ?? '',
      requested_deal_price: trace?.requested_deal_price ?? '',
      http_status: trace?.http_status ?? '',
      ok: trace?.ok ? 'sim' : 'nao',
      error: trace?.error || '',
      notes: trace?.notes || '',
      ml_body: safeText(mlBody, 4000),
    });
  });
  auditSheet.views = [{ state: 'frozen', ySplit: 1 }];
  auditSheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: auditSheet.columns.length },
  };
  auditSheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF183153' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  auditSheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.alignment = { vertical: 'top', wrapText: true };
  });

  const operationAuditEvents = Array.isArray(context?.operationAuditEvents)
    ? context.operationAuditEvents
    : [];
  if (operationAuditEvents.length) {
    const operationSheet = workbook.addWorksheet('Auditoria da operacao', {
      properties: { defaultRowHeight: 18 },
    });
    operationSheet.columns = [
      { header: 'Horario', key: 'created_at', width: 24 },
      { header: 'Evento', key: 'evento', width: 38 },
      { header: 'Status', key: 'status', width: 14 },
      { header: 'Usuario', key: 'email', width: 30 },
      { header: 'Job', key: 'job_id', width: 18 },
      { header: 'Operacao', key: 'operation_id', width: 24 },
      { header: 'MLB', key: 'mlb_id', width: 20 },
      { header: '% solicitado', key: 'requested_percent', width: 16 },
      { header: '% aplicado real', key: 'real_applied_percent', width: 18 },
      { header: 'Smart candidato', key: 'smart_requested_offer_id', width: 28 },
      { header: 'Smart OFFER aceito', key: 'smart_accepted_offer_id', width: 28 },
      { header: 'Smart OFFER confirmado', key: 'smart_confirmed_offer_id', width: 28 },
      { header: 'Smart confirmacao', key: 'smart_confirmation_state', width: 24 },
      { header: 'Smart % ML', key: 'smart_confirmed_meli_percentage', width: 18 },
      { header: 'Smart % vendedor', key: 'smart_confirmed_seller_percentage', width: 22 },
      { header: 'PRE oferta candidata', key: 'pre_requested_offer_id', width: 34 },
      { header: 'PRE oferta aceita', key: 'pre_accepted_offer_id', width: 34 },
      { header: 'PRE oferta ativa', key: 'pre_confirmed_offer_id', width: 34 },
      { header: 'PRE confirmacao', key: 'pre_confirmation_state', width: 24 },
      { header: 'PRE preco acordado', key: 'pre_agreed_price', width: 20 },
      { header: 'PRE desconto base %', key: 'pre_base_discount_percent', width: 20 },
      { header: 'PRE % ML', key: 'pre_confirmed_meli_percentage', width: 18 },
      { header: 'PRE % vendedor', key: 'pre_confirmed_seller_percentage', width: 22 },
      { header: 'PRE boost ML %', key: 'pre_meli_boost_percent', width: 18 },
      { header: 'HTTP', key: 'ml_status', width: 10 },
      { header: 'Mensagem', key: 'message', width: 55 },
      { header: 'Metadata JSON', key: 'metadata_json', width: 80 },
    ];
    operationAuditEvents
      .slice()
      .reverse()
      .forEach((event) => {
        const metadata = event?.metadata && typeof event.metadata === 'object' ? event.metadata : {};
        let metadataJson = '';
        try { metadataJson = JSON.stringify(metadata); } catch { metadataJson = ''; }
        operationSheet.addRow({
          created_at: event?.created_at ? new Date(event.created_at).toISOString() : '',
          evento: event?.evento || '',
          status: event?.status || '',
          email: event?.email || event?.user_nome || '',
          job_id: metadata?.job_id || '',
          operation_id: metadata?.operation_id || '',
          mlb_id: metadata?.mlb_id || metadata?.item_id || '',
          requested_percent: toNum(metadata?.requested_percent ?? metadata?.defined_percent) ?? '',
          real_applied_percent: toNum(metadata?.real_applied_percent ?? metadata?.applied_percent) ?? '',
          smart_requested_offer_id: metadata?.smart_requested_offer_id || null,
          smart_accepted_offer_id: metadata?.smart_accepted_offer_id || null,
          smart_confirmed_offer_id: metadata?.smart_confirmed_offer_id || null,
          smart_confirmation_state: metadata?.smart_confirmation_state || null,
          smart_confirmed_meli_percentage: toNum(metadata?.smart_confirmed_meli_percentage),
          smart_confirmed_seller_percentage: toNum(metadata?.smart_confirmed_seller_percentage) ?? '',
          pre_requested_offer_id: metadata?.pre_requested_offer_id || null,
          pre_accepted_offer_id: metadata?.pre_accepted_offer_id || null,
          pre_confirmed_offer_id: metadata?.pre_confirmed_offer_id || null,
          pre_confirmation_state: metadata?.pre_confirmation_state || null,
          pre_agreed_price: toNum(metadata?.pre_agreed_price),
          pre_base_discount_percent: toNum(metadata?.pre_base_discount_percent),
          pre_confirmed_meli_percentage: toNum(metadata?.pre_confirmed_meli_percentage),
          pre_confirmed_seller_percentage: toNum(metadata?.pre_confirmed_seller_percentage),
          pre_meli_boost_percent: toNum(metadata?.pre_meli_boost_percent),
          ml_status: metadata?.ml_status ?? '',
          message: safeText(metadata?.message || metadata?.error || '', 2000),
          metadata_json: safeText(metadataJson, 12000),
        });
      });
    operationSheet.views = [{ state: 'frozen', ySplit: 1 }];
    operationSheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: operationSheet.columns.length },
    };
    operationSheet.getRow(1).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF183153' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function decidePostApplyContinuation(
  review = {},
  rollback = null,
  { criticalOccurrence = 1, remediationQueued = false } = {},
) {
  if (!review?.critical) {
    return {
      action: 'continue',
      code: 'ITEM_REVIEW_CONTINUED',
      reason: 'A divergencia deste item nao representa risco de desconto acima do solicitado.',
    };
  }
  if (rollback?.ok === true) {
    return {
      action: 'continue',
      code: 'ROLLBACK_CONFIRMED_CONTINUED',
      reason: 'A divergencia foi revertida e confirmada; os demais itens podem continuar.',
    };
  }
  if (
    remediationQueued &&
    Number(criticalOccurrence || 0) < PROMO_CRITICAL_DIVERGENCE_THRESHOLD
  ) {
    return {
      action: 'continue',
      code: 'QUARANTINED_FOR_REMEDIATION',
      reason: 'O item foi isolado para remediacao automatica; o lote principal continuara.',
    };
  }
  return {
    action: 'pause',
    code: remediationQueued
      ? 'REPEATED_CRITICAL_DIVERGENCE'
      : 'UNSAFE_STATE_REMAINS_ACTIVE',
    reason: remediationQueued
      ? 'Uma segunda divergencia critica indica risco sistemico no lote.'
      : 'Ha uma aplicacao potencialmente incorreta sem rollback confirmado nem remediacao enfileirada.',
  };
}

function evaluatePromotionBatchFailure(result = {}, previous = {}) {
  const status = Number(result?.status);
  const errorText = safeText(
    result?.error || result?.message || result?.body?.message || '',
  );
  let signature = null;
  let immediate = false;
  let reason = null;

  if (status === 401 || status === 403) {
    signature = `AUTH_${status}`;
    immediate = true;
    reason = 'A autenticacao ou permissao da conta no Mercado Livre falhou.';
  } else if (status === 429) {
    signature = 'ML_RATE_LIMIT';
    reason = 'O Mercado Livre limitou temporariamente as requisicoes do lote.';
  } else if (Number.isFinite(status) && status >= 500) {
    signature = 'ML_SERVER_ERROR';
    reason = 'O Mercado Livre apresentou falhas consecutivas de servidor.';
  } else if (
    !Number.isFinite(status) &&
    /fetch|network|socket|econn|etimedout|timeout|dns|enotfound/i.test(errorText)
  ) {
    signature = 'ML_NETWORK_ERROR';
    reason = 'A comunicacao com o Mercado Livre falhou repetidamente.';
  }

  if (!signature) {
    return {
      action: 'continue',
      systemic: false,
      signature: null,
      consecutive: 0,
      reason: 'Falha isolada do anuncio; o restante do lote pode continuar.',
    };
  }

  const consecutive = previous?.signature === signature
    ? Number(previous?.consecutive || 0) + 1
    : 1;
  // Falhas transitorias (429/5xx/rede) sao tratadas com retry/backoff no mesmo job.
  // Somente falhas persistentes de autenticacao/permissao pausam o lote.
  const mustPause = immediate;
  return {
    action: mustPause ? 'pause' : 'continue',
    systemic: true,
    signature,
    consecutive,
    reason: mustPause
      ? reason
      : `${reason} O item ja passou pelas tentativas automaticas; o lote continuara sem exigir acao manual.`,
  };
}

async function rollbackAppliedPromotion({
  mlCreds,
  promotion_id,
  promotion_type,
  item_id,
  offer_id = null,
}) {
  const type = String(promotion_type || '').toUpperCase();
  if (!['DEAL', 'SELLER_CAMPAIGN', 'SMART', 'LIGHTNING', 'PRE_NEGOTIATED'].includes(type)) {
    return {
      ok: false,
      supported: false,
      status: 409,
      error: `Rollback automatico nao suportado para ${type || 'UNKNOWN'}.`,
    };
  }
  if (type === 'SMART' && !/^OFFER-/i.test(String(offer_id || ''))) {
    return {
      ok: false,
      supported: false,
      status: 409,
      error: 'Rollback Smart exige o offer_id confirmado pelo Mercado Livre.',
    };
  }
  if (type === 'PRE_NEGOTIATED' && !String(offer_id || '').trim()) {
    return {
      ok: false,
      supported: false,
      status: 409,
      error: 'Rollback PRE_NEGOTIATED exige o offer_id original do pre-acordo.',
    };
  }

  const url = buildPromotionRollbackUrl({
    promotion_id,
    promotion_type: type,
    item_id,
    offer_id,
  });
  const response = await authFetch(url, { method: 'DELETE' }, mlCreds).catch(() => null);
  if (!response) {
    return { ok: false, supported: true, status: 503, error: 'Falha de rede ao reverter promocao.' };
  }
  const parsed = await parseJsonResponseSafe(response);
  if (!response.ok) {
    return {
      ok: false,
      supported: true,
      status: response.status,
      error: parsed?.json?.message || parsed?.json?.error || 'ML rejeitou o rollback.',
      body: parsed?.json || null,
    };
  }

  for (let attempt = 1; attempt <= POST_APPLY_VERIFY_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      await new Promise((resolve) => setTimeout(resolve, POST_APPLY_VERIFY_DELAY_MS * attempt));
    }
    const snapshot = await fetchPromotionSnapshotFromItem({
      mlCreds,
      item_id,
      promotion_id,
    }).catch(() => null);
    const status = normalizeStatusForML(snapshot?.status);
    if (!snapshot || !['started', 'pending', 'scheduled'].includes(status)) {
      return { ok: true, supported: true, status: response.status, attempt };
    }
  }

  return {
    ok: false,
    supported: true,
    status: 409,
    error: 'Rollback aceito, mas a promocao continuou ativa no ML.',
  };
}

function buildPromotionRollbackUrl({
  promotion_id,
  promotion_type,
  item_id,
  offer_id = null,
}) {
  const params = new URLSearchParams({
    promotion_type: String(promotion_type || '').toUpperCase(),
    promotion_id: String(promotion_id || ''),
    app_version: 'v2',
  });
  if (offer_id) params.set('offer_id', String(offer_id));
  return `https://api.mercadolibre.com/seller-promotions/items/${encodeURIComponent(
    item_id,
  )}?${params.toString()}`;
}

async function updateSourceJobRemediationStatus({
  sourceJobId,
  itemId,
  patch = {},
}) {
  const sourceJob = await ensureQueue().getJob(sourceJobId).catch(() => null);
  if (!sourceJob) return null;
  const data = sourceJob.data || {};
  const normalizedItemId = String(itemId || '').toUpperCase();
  const results = Array.isArray(data.results)
    ? data.results.map((row) =>
        String(row?.mlb_id || '').toUpperCase() === normalizedItemId
          ? { ...row, ...patch }
          : row,
      )
    : [];
  const quarantineCounters = results.reduce(
    (acc, row) => {
      const status = String(row?.quarantine_status || '').toLowerCase();
      if (!status) return acc;
      acc.total += 1;
      if (status === 'resolved' || status === 'superseded') acc.resolved += 1;
      else if (status === 'critical_failed') acc.critical += 1;
      else acc.pending += 1;
      return acc;
    },
    { total: 0, pending: 0, resolved: 0, critical: 0 },
  );
  const remediationCompleted = quarantineCounters.pending <= 0;
  const sourceCounters = data?.counters || {};
  const updatedSourceData = {
    ...data,
    results,
    quarantineCounters,
    operationLifecycle:
      isLogicalPromotionOperationData(data) && remediationCompleted
        ? Number(sourceCounters.failed || 0) > 0
          ? 'partial'
          : 'completed'
        : isLogicalPromotionOperationData(data)
          ? 'review_pending'
          : data?.operationLifecycle,
    operationTerminal:
      isLogicalPromotionOperationData(data)
        ? remediationCompleted
        : data?.operationTerminal,
    stateLabel:
      isLogicalPromotionOperationData(data) && remediationCompleted
        ? `concluído: ${Number(sourceCounters.success || 0)} ok, ${Number(sourceCounters.failed || 0)} erros`
        : data?.stateLabel,
    lastUpdate: Date.now(),
  };
  await sourceJob.update(updatedSourceData);
  if (remediationCompleted) {
    const sourceState = await sourceJob.getState().catch(() => 'unknown');
    if (
      isLogicalPromotionOperationData(updatedSourceData) ||
      sourceState === 'completed' ||
      (sourceState === 'failed' && data?.resumable !== true)
    ) {
      if (isLogicalPromotionOperationData(updatedSourceData)) {
        await settleCredits(updatedSourceData?.creditReservation, { release: false }).catch(() => {});
        await trackLogicalOperation(sourceJob, { open: false }).catch(() => {});
      }
      await releaseCampaignGuard(updatedSourceData, String(sourceJob.id));
    }
  } else {
    await claimCampaignGuard(updatedSourceData, String(sourceJob.id));
  }
  return sourceJob;
}

async function enqueuePromotionRemediation({
  sourceJob,
  itemId,
  promotionId,
  promotionType,
  offerId = null,
  requestedPercent = null,
  actualPercent = null,
  rollback = null,
}) {
  const q = ensureQueue();
  const sourceData = sourceJob?.data || {};
  const safeSourceId = String(sourceJob?.id || '').replace(/[^a-zA-Z0-9_-]/g, '-');
  const safeItemId = String(itemId || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '-');
  const queueJobId = `promo-remediation-${safeSourceId}-${safeItemId}`;
  const existing = await q.getJob(queueJobId).catch(() => null);
  if (existing) return existing.id;

  const remediationJob = await q.add(
    {
      kind: 'promotion-remediation',
      action: 'rollback-remediation',
      internalJob: true,
      sourceJobId: String(sourceJob.id),
      parentJobId: String(sourceJob.id),
      operationId: sourceData.operationId || sourceData.options?.operation_id || null,
      remediationPolicyVersion: 2,
      remediationTrigger: 'confirmed_discount_above_cap',
      mlCreds: sourceData.mlCreds,
      accountKey: sourceData.accountKey,
      accountLabel: sourceData.accountLabel,
      promotion: {
        id: String(promotionId || ''),
        type: String(promotionType || '').toUpperCase(),
      },
      itemId: String(itemId || '').toUpperCase(),
      offerId: offerId || null,
      requestedPercent: toNum(requestedPercent),
      actualPercent: toNum(actualPercent),
      initialRollback: rollback || null,
      auditContext: sourceData.auditContext || null,
      counters: { processed: 0, total: 1, success: 0, failed: 0 },
      stateLabel: 'quarentena aguardando remediacao',
      createdAt: Date.now(),
    },
    {
      jobId: queueJobId,
      removeOnComplete: 50,
      removeOnFail: false,
      attempts: PROMO_REMEDIATION_ATTEMPTS,
      delay: 2000,
      backoff: { type: 'exponential', delay: 10000 },
    },
  );
  return remediationJob.id;
}

async function runPromotionRemediationJob(job, done) {
  const data = job.data || {};
  const itemId = String(data.itemId || '').toUpperCase();
  const attempt = Number(job.attemptsMade || 0) + 1;
  const maxAttempts = Number(job.opts?.attempts || PROMO_REMEDIATION_ATTEMPTS);
  const baseResult = {
    mlb_id: itemId,
    status: 'review',
    success: false,
    review_severity: 'critical',
    requested_percent: data.requestedPercent ?? null,
    real_applied_percent: data.actualPercent ?? null,
    quarantine_status: 'remediating',
    remediation_job_id: String(job.id),
    remediation_attempts: attempt,
    rollback_attempted: true,
  };

  // Jobs SMART de remediacao criados antes da politica v2 podem ter surgido de
  // uma confirmacao apenas inconclusiva (ex.: #2412/#2415). Nao executamos um
  // DELETE legado depois do deploy: encerramos o filho sem alterar a oferta.
  if (
    String(data?.promotion?.type || '').toUpperCase() === 'SMART' &&
    Number(data?.remediationPolicyVersion || 0) < 2
  ) {
    const result = {
      ...baseResult,
      success: true,
      review_severity: 'warning',
      review_status: 'REMEDIACAO_LEGADA_CANCELADA',
      quarantine_status: 'superseded',
      rollback_attempted: false,
      rollback_confirmed: false,
      remediation_last_error: '',
      message:
        'Remediacao SMART criada pela politica antiga foi encerrada sem remover a oferta. Nova verificacao deve ocorrer em um novo job.',
      error_message: '',
    };
    const sourceJob = await updateSourceJobRemediationStatus({
      sourceJobId: data.sourceJobId,
      itemId,
      patch: result,
    });
    if (sourceJob) {
      await auditPromoJobEvent(sourceJob, 'promotion_legacy_smart_remediation_superseded', 'warn', {
        remediation_job_id: String(job.id),
        mlb_id: itemId,
        remediation_policy_version: Number(data?.remediationPolicyVersion || 0),
      });
    }
    await job.update({
      ...data,
      counters: { processed: 1, total: 1, success: 1, failed: 0 },
      stateLabel: 'remediacao Smart legada encerrada',
      results: [result],
      lastUpdate: Date.now(),
    });
    await job.progress(100);
    done(null, {
      id: job.id,
      kind: 'promotion-remediation',
      status: 'superseded',
      total: 1,
      processed: 1,
      success: 1,
      failed: 0,
      skipped: 1,
      results: [result],
    });
    return;
  }

  try {
    await job.update({
      ...data,
      counters: { processed: 0, total: 1, success: 0, failed: 0 },
      stateLabel: `remediando ${itemId}: tentativa ${attempt}/${maxAttempts}`,
      results: [baseResult],
      lastUpdate: Date.now(),
    });
    await job.progress(25);
    await auditPromoJobEvent(job, 'promotion_remediation_attempted', 'warn', {
      source_job_id: data.sourceJobId,
      mlb_id: itemId,
      attempt,
      max_attempts: maxAttempts,
      requested_percent: data.requestedPercent ?? null,
      real_applied_percent: data.actualPercent ?? null,
    });

    const rollback = await rollbackAppliedPromotion({
      mlCreds: data.mlCreds,
      promotion_id: data.promotion?.id,
      promotion_type: data.promotion?.type,
      item_id: itemId,
      offer_id: data.offerId || null,
    });
    if (!rollback?.ok) {
      const finalAttempt = attempt >= maxAttempts;
      const quarantineStatus = finalAttempt ? 'critical_failed' : 'retry_scheduled';
      const error = rollback?.error || 'Rollback de remediacao nao confirmado.';
      const result = {
        ...baseResult,
        review_status: finalAttempt
          ? 'REMEDIACAO_FALHOU'
          : 'REMEDIACAO_AGUARDANDO_NOVA_TENTATIVA',
        quarantine_status: quarantineStatus,
        remediation_last_error: error,
        rollback_confirmed: false,
        rollback_status: rollback?.status ?? null,
        rollback_error: error,
        message: error,
        error_message: error,
      };
      const sourceJob = await updateSourceJobRemediationStatus({
        sourceJobId: data.sourceJobId,
        itemId,
        patch: result,
      });
      if (sourceJob) {
        await auditPromoJobEvent(
          sourceJob,
          finalAttempt
            ? 'promotion_quarantine_remediation_failed'
            : 'promotion_quarantine_remediation_retry_scheduled',
          finalAttempt ? 'error' : 'warn',
          {
            remediation_job_id: String(job.id),
            mlb_id: itemId,
            attempt,
            max_attempts: maxAttempts,
            error,
          },
        );
      }
      await job.update({
        ...job.data,
        counters: finalAttempt
          ? { processed: 1, total: 1, success: 0, failed: 1 }
          : { processed: 0, total: 1, success: 0, failed: 0 },
        stateLabel: finalAttempt
          ? 'remediacao critica falhou'
          : `aguardando nova tentativa ${Math.min(attempt + 1, maxAttempts)}/${maxAttempts}`,
        remediationAttempt: attempt,
        remediationMaxAttempts: maxAttempts,
        results: [result],
        lastUpdate: Date.now(),
      });
      await job.progress(finalAttempt ? 100 : Math.max(10, Math.min(90, Math.round((attempt / maxAttempts) * 80))));
      done(new Error(error));
      return;
    }

    const result = {
      ...baseResult,
      review_status: 'REVERTIDO_POR_REMEDIACAO',
      quarantine_status: 'resolved',
      rollback_confirmed: true,
      rollback_status: rollback.status ?? null,
      rollback_error: '',
      batch_decision: 'continue',
      batch_decision_code: 'QUARANTINE_REMEDIATION_CONFIRMED',
      batch_decision_reason: 'Rollback confirmado pelo job automatico de remediacao.',
      message: 'Promocao divergente revertida e confirmada automaticamente.',
      error_message: '',
    };
    const sourceJob = await updateSourceJobRemediationStatus({
      sourceJobId: data.sourceJobId,
      itemId,
      patch: result,
    });
    if (sourceJob) {
      await auditPromoJobEvent(sourceJob, 'promotion_quarantine_remediation_completed', 'success', {
        remediation_job_id: String(job.id),
        mlb_id: itemId,
        attempt,
        requested_percent: data.requestedPercent ?? null,
        real_applied_percent: data.actualPercent ?? null,
      });
    }
    await job.update({
      ...job.data,
      counters: { processed: 1, total: 1, success: 1, failed: 0 },
      stateLabel: 'remediacao concluida',
      results: [result],
      lastUpdate: Date.now(),
    });
    await job.progress(100);
    done(null, {
      id: job.id,
      kind: 'promotion-remediation',
      status: 'completed',
      total: 1,
      processed: 1,
      success: 1,
      failed: 0,
      results: [result],
    });
  } catch (error) {
    done(error);
  }
}

function resolveApplyMethodForItem(promotion_type, snapshot) {
  const typeUp = String(promotion_type || '').toUpperCase();
  const status = normalizeStatusForML(snapshot?.status);

  if (typeUp === 'SELLER_CAMPAIGN' || typeUp === 'DEAL') {
    if (status === 'started' || status === 'pending' || status === 'scheduled') {
      return 'PUT';
    }
  }

  return 'POST';
}

function isSellerCampaignNoCandidatesError(body) {
  return String(body?.message || '').toLowerCase().includes('no candidates found');
}

async function parseJsonResponseSafe(response) {
  const txt = await response.text().catch(() => '');
  try {
    return { txt, json: txt ? JSON.parse(txt) : {} };
  } catch {
    return { txt, json: { raw: txt } };
  }
}

async function mapWithConcurrency(list, concurrency, worker) {
  const items = Array.isArray(list) ? list : [];
  const limit = Math.max(1, Number(concurrency) || 1);
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const currentIndex = index++;
      await worker(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(runners);
}

function needsDealFallbackDetail(item, promotion_type) {
  const typeUp = String(item?.type || promotion_type || '').toUpperCase();
  if (typeUp !== 'DEAL') return false;
  const st = normalizeStatusForML(item?.status);
  const hasRange =
    toNum(item?.min_discounted_price) != null ||
    toNum(item?.max_discounted_price) != null;
  return ['candidate', 'pending', 'scheduled'].includes(st) && !hasRange;
}

async function enrichDealItemIfNeeded({ mlCreds, promotion_id, promotion_type, item }) {
  if (!needsDealFallbackDetail(item, promotion_type)) return item;
  const item_id = item?.id || item?.item_id;
  if (!item_id) return item;
  const snapshot = await fetchPromotionItemById({
    mlCreds,
    promotion_id,
    promotion_type,
    item_id
  });
  if (!snapshot) return item;
  return {
    ...snapshot,
    ...item,
    original_price: item.original_price ?? snapshot.original_price ?? null,
    deal_price: item.deal_price ?? snapshot.deal_price ?? snapshot.new_price ?? null,
    min_discounted_price: item.min_discounted_price ?? snapshot.min_discounted_price ?? null,
    max_discounted_price: item.max_discounted_price ?? snapshot.max_discounted_price ?? null,
    discount_percentage: item.discount_percentage ?? snapshot.discount_percentage ?? null,
    price: item.price ?? snapshot.price ?? null,
  };
}

/* --------------- Calcula novo preço para DEAL/SELLER_CAMPAIGN ------------- */
function resolveDealPriceForDealItem(item, policy = 'min') {
  // Campos que o ML devolve para DEAL:
  // original_price, min_discounted_price, max_discounted_price, price (quando started)
  const original = toNum(item.original_price ?? item.price ?? null);
  const normalizedPolicy = policy === 'max' ? 'max' : 'min';
  const fallbackPrice = toNum(item.price ?? null);
  const usableFallbackPrice =
    fallbackPrice != null &&
    fallbackPrice > 0 &&
    original != null &&
    fallbackPrice < original
      ? fallbackPrice
      : null;

  let candidate;
  if (normalizedPolicy === 'max') {
    candidate =
      toNum(item.max_discounted_price) ??
      toNum(item.min_discounted_price) ??
      usableFallbackPrice;
  } else {
    // default: mínimo permitido
    candidate =
      toNum(item.min_discounted_price) ??
      toNum(item.max_discounted_price) ??
      usableFallbackPrice;
  }

  if (candidate == null || original == null) return { newPrice: null, discountPct: null };

  const pct = 100 * (1 - candidate / original);
  return { newPrice: round2(candidate), discountPct: pct };
}

/* ----------------- Cálculo de % de desconto e filtros ----------------- */

function computeDiscountPct(it, promotion_type, benefitsGlobal, price_policy) {
  const t = String(promotion_type).toUpperCase();
  const n = (v) => (v==null || Number.isNaN(Number(v)) ? null : Number(v));

  // já veio pronto?
  let pct = n(
    it._selected_discount_percentage ??
    it.selected_discount_percentage ??
    it.discount_percentage
  );
  if (pct != null) return pct;

  if (t === 'DEAL' || t === 'SELLER_CAMPAIGN' || t === 'PRICE_DISCOUNT' || t === 'DOD' || t === 'LIGHTNING') {
    const orig = n(it.original_price ?? it.price);
    let deal  = n(it.deal_price ?? it.new_price ?? it._resolved_final_price);
    if (deal == null) {
      const r = resolveDealPriceForDealItem(it, price_policy);
      if (r.newPrice != null) {
        it.deal_price = r.newPrice; // cache para não recalcular depois
        deal = r.newPrice;
      }
    }
    if (orig != null && deal != null && orig > 0) return 100 * (1 - deal / orig);
    return null;
  }

  if (t === 'PRE_NEGOTIATED') {
    const orig = n(
      it.original_price ?? it.item_original_price ?? it.regular_amount ?? it.base_price,
    );
    const agreed = n(
      it.deal_price ?? it.new_price ?? it._resolved_final_price ?? it.price,
    );
    if (
      orig != null &&
      orig > 0 &&
      agreed != null &&
      agreed > 0 &&
      agreed <= orig
    ) {
      return 100 * (1 - agreed / orig);
    }
    return n(it.discount_percentage);
  }

  if (t === 'SMART' || t.startsWith('PRICE_MATCHING')) {
    const meli   = n(it.meli_percentage ?? it.rebate_meli_percent ?? benefitsGlobal?.meli_percent);
    const seller = n(it.seller_percentage ?? benefitsGlobal?.seller_percent);
    const tot = n((meli || 0) + (seller || 0));
    return tot;
  }

  const orig = n(it.original_price ?? it.price);
  const deal = n(it.deal_price ?? it.new_price ?? it._resolved_final_price);
  if (orig != null && deal != null && orig > 0) return 100 * (1 - deal / orig);

  return n(it.discount_percentage);
}

function resolveAppliedPercentForCsv({
  item,
  promotion_type,
  benefitsGlobal,
  price_policy,
  options = {}
}) {
  const t = String(promotion_type || "").toUpperCase();
  const manual =
    t === "SELLER_CAMPAIGN"
      ? toNum(options.seller_manual_percent)
      : t === "DEAL" || t === "PRICE_DISCOUNT" || t === "DOD" || t === "LIGHTNING"
        ? toNum(options.deal_manual_percent)
        : null;

  if (manual != null) return round2(manual);

  const computed = computeDiscountPct(item || {}, t, benefitsGlobal, price_policy);
  return computed == null ? null : round2(computed);
}

function resolveDefinedPercentForAudit({ promotion_type, filters = {}, options = {} }) {
  const t = String(promotion_type || "").toUpperCase();
  const manual =
    t === "SELLER_CAMPAIGN"
      ? toNum(options.seller_manual_percent)
      : t === "DEAL" || t === "PRICE_DISCOUNT" || t === "DOD" || t === "LIGHTNING"
        ? toNum(options.deal_manual_percent)
        : null;
  const cap = toNum(filters.maxDesc ?? filters.percent_max ?? filters.discount_max);
  const value = manual != null ? manual : cap;
  return value == null ? null : round2(value);
}

function pickAppliedPriceFromResult(result, originalPrice = null) {
  const body = result?.body || {};
  const payload = result?.trace?.payload || null;
  const original = toNum(originalPrice);
  const values = [
    body.deal_price,
    body.final_price,
    body.discounted_price,
    body?.item?.deal_price,
    body?.item?.final_price,
    body?.item?.discounted_price,
    payload?.deal_price,
    body.price,
    body?.item?.price,
  ];
  for (const value of values) {
    const price = toNum(value);
    if (price == null || price <= 0) continue;
    if (original != null && original > 0 && price >= original) continue;
    return price;
  }
  return null;
}

function resolveRealAppliedPercentForAudit({
  item,
  promotion_type,
  benefitsGlobal,
  price_policy,
  result,
  fallbackPercent,
}) {
  const t = String(promotion_type || "").toUpperCase();
  const bodyPct =
    toNum(result?.body?.discount_percentage) ??
    toNum(result?.body?.discount_percent) ??
    null;
  if (bodyPct != null) return round2(bodyPct);

  if (t === "DEAL" || t === "SELLER_CAMPAIGN" || t === "PRICE_DISCOUNT" || t === "DOD" || t === "LIGHTNING") {
    const snapshot = result?.trace?.snapshot || null;
    const originalCandidates = [
      snapshot?.original_price,
      snapshot?.item_original_price,
      snapshot?.regular_amount,
      snapshot?.base_price,
      item?.original_price,
      item?.item_original_price,
      item?.regular_amount,
      item?.base_price,
      item?.price,
    ]
      .map(toNum)
      .filter((value) => value != null && value > 0);
    const original = originalCandidates.length ? Math.max(...originalCandidates) : null;
    const appliedPrice = pickAppliedPriceFromResult(result, original);
    if (original != null && original > 0 && appliedPrice != null) {
      return round2(100 * (1 - appliedPrice / original));
    }
  }

  const computed = computeDiscountPct(item || {}, t, benefitsGlobal, price_policy);
  if (computed != null) return round2(computed);
  return fallbackPercent == null ? null : round2(fallbackPercent);
}

function normalizeMlbFilterList(values) {
  const source = Array.isArray(values)
    ? values
    : String(values || "")
        .split(/[\s,;|]+/)
        .filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const value of source) {
    let id = String(value || "").trim().toUpperCase();
    if (/^\d+$/.test(id)) id = `MLB${id}`;
    const match = id.match(/MLB\s*-?\s*(\d+)/i);
    if (match) id = `MLB${match[1]}`;
    if (!/^MLB\d+$/i.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function resolvePendingResumeIds(sourceIds, results) {
  const normalizedSource = normalizeMlbFilterList(sourceIds);
  const processedIds = new Set(
    (Array.isArray(results) ? results : [])
      .map((row) => String(row?.mlb_id || row?.id || '').trim().toUpperCase())
      .filter((id) => /^MLB\d+$/.test(id)),
  );
  return normalizedSource.filter((id) => !processedIds.has(id));
}

function parseMlbListEntries(values) {
  const source = Array.isArray(values)
    ? values
    : String(values || "")
        .split(/[\s,;|]+/)
        .filter(Boolean);
  const seen = new Set();
  return source
    .map((value, index) => {
      const token = String(value || "").trim();
      if (!token) return null;
      let mlb = token.toUpperCase();
      if (/^\d+$/.test(mlb)) mlb = `MLB${mlb}`;
      const match = mlb.match(/MLB\s*-?\s*(\d+)/i);
      if (match) mlb = `MLB${match[1]}`;
      if (!/^MLB\d+$/i.test(mlb)) mlb = "";
      const duplicate = !!mlb && seen.has(mlb);
      if (mlb && !duplicate) seen.add(mlb);
      return { index: index + 1, token, mlb, duplicate };
    })
    .filter(Boolean);
}

function buildListValidationDiagnostics({
  entries,
  eligibleIds,
  promotion,
  status,
  percent,
}) {
  const eligibleSet = new Set(
    (Array.isArray(eligibleIds) ? eligibleIds : [])
      .map((id) => String(id || "").trim().toUpperCase())
      .filter(Boolean),
  );
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    const base = {
      ordem: entry.index,
      entrada: entry.token,
      mlb: entry.mlb || "",
      campanha_id: promotion?.id || "",
      campanha_nome: promotion?.name || "",
      campanha_tipo: promotion?.type || "",
      filtro_status: status || "",
      percentual: percent != null ? round2(percent) : "",
      resultado: "",
      motivo: "",
      aplicavel: "nao",
      mlb_id: entry.mlb || "",
      status: "error",
      success: false,
      applied_percent: percent != null ? round2(percent) : "",
      message: "",
    };
    if (!entry.mlb) {
      return {
        ...base,
        resultado: "invalido",
        motivo: "Entrada nao foi reconhecida como MLB valido.",
        message: "Entrada nao foi reconhecida como MLB valido.",
      };
    }
    if (entry.duplicate) {
      return {
        ...base,
        resultado: "duplicado",
        motivo: "MLB repetido na lista. A validacao considera apenas a primeira ocorrencia.",
        message: "MLB repetido na lista. A validacao considera apenas a primeira ocorrencia.",
      };
    }
    if (eligibleSet.has(entry.mlb)) {
      return {
        ...base,
        resultado: "elegivel",
        motivo: "Anuncio retornado como elegivel para esta campanha e filtro.",
        aplicavel: "sim",
        status: "success",
        success: true,
        message: "Anuncio retornado como elegivel para esta campanha e filtro.",
      };
    }
    return {
      ...base,
      resultado: "nao_elegivel",
      motivo: "O Mercado Livre nao retornou este anuncio para a campanha e filtro selecionados; isso nao confirma ausencia de outras promocoes no anuncio.",
      message: "O Mercado Livre nao retornou este anuncio para a campanha e filtro selecionados; isso nao confirma ausencia de outras promocoes no anuncio.",
    };
  });
}

function buildListValidationCsv(rows) {
  return buildCsv(
    (Array.isArray(rows) ? rows : []).map((row) => [
      row?.ordem ?? "",
      row?.entrada ?? "",
      row?.mlb ?? "",
      row?.campanha_id ?? "",
      row?.campanha_nome ?? "",
      row?.campanha_tipo ?? "",
      row?.filtro_status ?? "",
      row?.percentual ?? "",
      row?.resultado ?? "",
      row?.aplicavel ?? "",
      row?.motivo ?? "",
    ]),
    [
      "ordem",
      "entrada",
      "mlb",
      "campanha_id",
      "campanha_nome",
      "campanha_tipo",
      "filtro_status",
      "percentual",
      "resultado",
      "aplicavel",
      "motivo",
    ],
  );
}

function isEligible(it, { mlb, mlbs, maxDesc }, promotion_type, benefitsGlobal, price_policy) {
  const itemId = String(it.id || it.item_id || "").toUpperCase();
  const typeUp = String(promotion_type || '').toUpperCase();
  if (mlb && String(it.id || it.item_id).toUpperCase() !== String(mlb).toUpperCase()) return false;
  if (Array.isArray(mlbs) && mlbs.length && !mlbs.includes(itemId)) return false;
  // "Todos" pode exibir participantes, mas uma aplicacao Smart so envia candidatos.
  if (
    ['SMART', 'LIGHTNING', 'PRE_NEGOTIATED'].includes(typeUp) &&
    normalizeStatusForML(it?.status) !== 'candidate'
  ) return false;
  if (maxDesc != null) {
    if (['DEAL', 'SELLER_CAMPAIGN', 'DOD', 'LIGHTNING'].includes(typeUp)) {
      if (!isDealPercentWithinRange({ ...it, promotion_type }, Number(maxDesc))) return false;
    } else {
      const pct = computeDiscountPct(it, promotion_type, benefitsGlobal, price_policy);
      if (pct == null || pct > Number(maxDesc)) return false;
    }
  }
  return true;
}

/* -------------------------- Pré-contagem (estável) -------------------------- */

async function precountEligible({ mlCreds, promotion_id, promotion_type, status, filters, price_policy }) {
  let token = null;
  let total = 0;
  let benefitsGlobal = null;

  while (true) {
    const page = await fetchPromotionItemsPaged({
      mlCreds, promotion_id, promotion_type, status, limit: 50, search_after: token
    });

    if (!benefitsGlobal && page.benefits) benefitsGlobal = page.benefits;

    const items = page.results || [];
    const normalizedFilters = {
      ...(filters || {}),
      mlbs: normalizeMlbFilterList(filters?.mlbs),
    };
    for (const it of items) {
      const itemId = String(it?.id || it?.item_id || "").toUpperCase();
      if (normalizedFilters.mlb && itemId !== String(normalizedFilters.mlb).toUpperCase()) continue;
      if (normalizedFilters.mlbs?.length && !normalizedFilters.mlbs.includes(itemId)) continue;
      const candidate =
        filters?.maxDesc != null
          ? await enrichDealItemIfNeeded({
              mlCreds,
              promotion_id,
              promotion_type,
              item: it
            }).catch(() => it)
          : it;
      if (isEligible(candidate, normalizedFilters, promotion_type, benefitsGlobal, price_policy)) total++;
    }

    if (!page.next || items.length === 0) break;
    token = page.next;
  }

  return { total, benefitsGlobal };
}
/* ----------------------------- Aplicar o item ----------------------------- */

async function applyItem({
  mlCreds,
  promotion_id,
  promotion_type,
  item,
  policy = 'min',
  dryRun = false,
  seller_manual_percent = null,
  deal_manual_percent = null,
  lightning_stock = null,
  max_discount_percent = null
}) {
  const t = String(promotion_type || '').toUpperCase();
  if (t === 'PRICE_MATCHING_MELI_ALL') {
    return { ok: false, status: 501, error: 'PRICE_MATCHING_MELI_ALL é 100% ML (aplicação manual indisponível)' };
  }

  const item_id = item.id || item.item_id;
  let snapshot = null;
  const trace = {
    action: 'apply',
    promotion_id,
    promotion_type: t,
    item_id,
    payload: null,
    method: null,
    snapshot: null,
    notes: null
  };

  const payload = { promotion_id, promotion_type: t };
  let lockedOfferRef = null;
  if (
    t === 'SMART' ||
    t === 'PRE_NEGOTIATED' ||
    t === 'UNHEALTHY_STOCK' ||
    t.startsWith('PRICE_MATCHING')
  ) {
    const cap = toNum(max_discount_percent);
    if (cap == null) {
      return {
        ok: false,
        status: 400,
        error:
          t === 'PRE_NEGOTIATED'
            ? 'Teto de desconto obrigatorio para aceitar ofertas PRE_NEGOTIATED.'
            : 'Teto de desconto obrigatório para aplicar ofertas Smart.',
        trace: buildTraceEntry({
          ...trace,
          payload,
          notes:
            t === 'PRE_NEGOTIATED'
              ? 'max_discount_percent ausente; pre-acordo bloqueado'
              : 'max_discount_percent ausente; aplicacao Smart bloqueada'
        })
      };
    }

    const freshBundle = await fetchPromotionItemsBundleById({
      mlCreds,
      promotion_id,
      promotion_type: t,
      item_id,
    }).catch(() => ({ results: [], benefits: null }));
    const freshRows = Array.isArray(freshBundle?.results) ? freshBundle.results : [];
    const selectedFreshOffers = freshRows
      .filter((row) =>
        !['SMART', 'LIGHTNING', 'PRE_NEGOTIATED'].includes(t) ||
        normalizeStatusForML(row?.status) === 'candidate'
      )
      .map((row) => selectOfferWithinPercentCap(row, t, freshBundle?.benefits, cap))
      .filter(Boolean)
      .sort((a, b) => {
        const ap = toNum(a?._selected_discount_percentage ?? a?.discount_percentage) ?? -1;
        const bp = toNum(b?._selected_discount_percentage ?? b?.discount_percentage) ?? -1;
        return bp - ap;
      });
    let selectedFreshOffer = selectedFreshOffers[0] || null;
    if (t === 'PRE_NEGOTIATED') {
      const requestedPreOfferRefs = collectApplyOfferRefsFromItem(item, t);
      if (requestedPreOfferRefs.length) {
        selectedFreshOffer =
          selectedFreshOffers.find((candidate) =>
            requestedPreOfferRefs.includes(
              String(candidate?._selected_offer_id || candidate?.offer_id || '').trim(),
            ),
          ) || null;
      }
    }
    const selectedPercent = computeDiscountPct(
      selectedFreshOffer || {},
      t,
      freshBundle?.benefits,
      policy
    );
    if (!selectedFreshOffer || selectedPercent == null || selectedPercent > cap + 0.0001) {
      return {
        ok: false,
        status: 412,
        error:
          selectedPercent == null
            ? `Não foi possível confirmar o desconto da oferta antes da aplicação (teto: ${cap}%).`
            : `Oferta bloqueada: desconto de ${round2(selectedPercent)}% acima do teto de ${cap}%.`,
        trace: buildTraceEntry({
          ...trace,
          payload,
          snapshot: freshRows[0] || null,
          notes: 'oferta recusada pela revalidacao fresca do teto de desconto'
        })
      };
    }
    snapshot = selectedFreshOffer;

    const strictOfferType = isStrictOfferPromotionType(t);
    const lockedOfferId = String(
      selectedFreshOffer?._selected_offer_id || selectedFreshOffer?.offer_id || ''
    ).trim() || null;
    lockedOfferRef = lockedOfferId;
    const itemOfferRefs = lockedOfferId
      ? [lockedOfferId]
      : collectApplyOfferRefsFromItem(item, t);
    let campaignRow = null;
    if (!lockedOfferId && (strictOfferType || !itemOfferRefs.length)) {
      campaignRow = await fetchPromotionItemById({
        mlCreds,
        promotion_id,
        promotion_type: t,
        item_id
      }).catch(() => null);
    }

    const offerRefs = lockedOfferId
      ? [lockedOfferId]
      : [
          ...new Set([
            ...collectApplyOfferRefsFromItem(campaignRow, t),
            ...itemOfferRefs,
            await getOfferIdForItem({ mlCreds, item_id, promotion_id })
          ].filter(Boolean))
        ];

    if (!offerRefs.length) {
      return {
        ok: false,
        status: 400,
        error: 'offer_id não encontrado',
        trace: buildTraceEntry({
          ...trace,
          payload,
          notes: 'offer_id ausente para promocao que depende de offer_id'
        })
      };
    }
    payload.offer_id = offerRefs[0];
  } else if (t === 'SELLER_CAMPAIGN') {
    if (
      !isValidManualPromoPercent(seller_manual_percent)
    ) {
      return {
        ok: false,
        status: 400,
        error: `seller_manual_percent é obrigatório e deve estar entre 0,01 e ${MANUAL_PROMO_MAX_PERCENT}%`,
        trace: buildTraceEntry({
          ...trace,
          payload,
          notes: 'seller_manual_percent ausente; aplicacao bloqueada para evitar fallback de preco minimo'
        })
      };
    }
    const [freshPromotionItem, currentListingPrice] = await Promise.all([
      fetchPromotionItemById({
        mlCreds,
        promotion_id,
        promotion_type: t,
        item_id,
        preferred_status: item?.status,
      }).catch(() => null),
      fetchCurrentListingPrice(mlCreds, item_id).catch(() => null),
    ]);
    if (!freshPromotionItem) {
      return {
        ok: false,
        status: 409,
        error: 'Não foi possível revalidar o item dentro da seller campaign antes da aplicação.',
        trace: buildTraceEntry({
          ...trace,
          payload,
          notes: 'revalidacao fresca da promocao ausente; aplicacao manual bloqueada'
        })
      };
    }
    const effectiveItem = mergeFreshPromotionItem(item, freshPromotionItem);
    if (freshPromotionItem) snapshot = freshPromotionItem;
    const manualBasePrice = resolveManualPercentBasePrice(effectiveItem, currentListingPrice);
    const manualGuardItem = {
      ...effectiveItem,
      original_price: manualBasePrice,
      price: manualBasePrice,
      current_listing_price: currentListingPrice,
    };
    const manualPrice = computeDealPriceFromPercent(
      manualBasePrice,
      seller_manual_percent
    );
    const sellerRange = computeDealDiscountRange({ ...effectiveItem, promotion_type: t });
    const hasSellerRange =
      sellerRange.minPct != null && sellerRange.maxPct != null;
    if (
      seller_manual_percent != null &&
      hasSellerRange &&
      !isManualPercentApplicable({ ...effectiveItem, promotion_type: t }, seller_manual_percent)
    ) {
      return {
        ok: false,
        status: 400,
        error: `A % informada para a seller está fora da faixa permitida (${sellerRange.minPct ?? '—'}% a ${sellerRange.maxPct ?? '—'}%).`,
        trace: buildTraceEntry({
          ...trace,
          payload,
          notes: 'seller_manual_percent fora da faixa permitida para o item'
        })
      };
    }
    const dealAlready = toNum(effectiveItem.deal_price);
    const { newPrice } =
      manualPrice != null
        ? { newPrice: manualPrice }
        : dealAlready != null
          ? { newPrice: dealAlready }
          : resolveDealPriceForDealItem(effectiveItem, policy);

    if (newPrice == null) {
      return {
        ok: false,
        status: 400,
        error: 'Não foi possível calcular deal_price',
        trace: buildTraceEntry({
          ...trace,
          payload,
          notes: 'falha ao calcular deal_price para seller campaign'
        })
      };
    }
    payload.deal_price = newPrice;
    const percentGuard = validateManualDealPricePercent({
      item: manualGuardItem,
      promotionType: t,
      requestedPercent: seller_manual_percent,
      dealPrice: payload.deal_price,
    });
    if (!percentGuard.ok) {
      return {
        ok: false,
        status: 412,
        error: percentGuard.error,
        body: {
          error: "manual_percent_divergence",
          message: percentGuard.error,
          requested_percent: percentGuard.requested_percent,
          calculated_percent: percentGuard.calculated_percent,
          min_allowed_percent: percentGuard.min_allowed_percent,
          max_allowed_percent: percentGuard.max_allowed_percent,
          tolerance: MANUAL_PROMO_PERCENT_TOLERANCE,
        },
        trace: buildTraceEntry({
          ...trace,
          payload,
          notes: percentGuard.notes,
          result: {
            ok: false,
            status: 412,
            body: {
              error: "manual_percent_divergence",
              requested_percent: percentGuard.requested_percent,
              calculated_percent: percentGuard.calculated_percent,
              min_allowed_percent: percentGuard.min_allowed_percent,
              max_allowed_percent: percentGuard.max_allowed_percent,
              tolerance: MANUAL_PROMO_PERCENT_TOLERANCE,
            },
          },
        }),
      };
    }
  } else if (t === 'DEAL' || t === 'PRICE_DISCOUNT' || t === 'DOD' || t === 'LIGHTNING') {
    if (
      !isValidManualPromoPercent(deal_manual_percent)
    ) {
      return {
        ok: false,
        status: 400,
        error: `deal_manual_percent é obrigatório e deve estar entre 0,01 e ${MANUAL_PROMO_MAX_PERCENT}%`,
        trace: buildTraceEntry({
          ...trace,
          payload,
          notes: 'deal_manual_percent ausente; aplicacao bloqueada para evitar fallback de preco minimo'
        })
      };
    }
    const [freshPromotionItem, currentListingPrice] = await Promise.all([
      fetchPromotionItemById({
        mlCreds,
        promotion_id,
        promotion_type: t,
        item_id,
        preferred_status: item?.status,
      }).catch(() => null),
      fetchCurrentListingPrice(mlCreds, item_id).catch(() => null),
    ]);
    if (!freshPromotionItem) {
      return {
        ok: false,
        status: 409,
        error: 'Não foi possível revalidar o item dentro da campanha antes da aplicação.',
        trace: buildTraceEntry({
          ...trace,
          payload,
          notes: 'revalidacao fresca da promocao ausente; aplicacao manual bloqueada'
        })
      };
    }
    if (
      t === 'LIGHTNING' &&
      normalizeStatusForML(freshPromotionItem?.status) !== 'candidate'
    ) {
      return {
        ok: false,
        status: 409,
        error: 'A oferta relampago ja participa ou esta programada e nao pode ser editada diretamente.',
        trace: buildTraceEntry({
          ...trace,
          payload,
          snapshot: freshPromotionItem,
          notes: 'Lightning nao candidata bloqueada; o ML exige excluir e reaplicar'
        })
      };
    }
    const effectiveItem = mergeFreshPromotionItem(item, freshPromotionItem);
    if (freshPromotionItem) snapshot = freshPromotionItem;
    const manualBasePrice = resolveManualPercentBasePrice(effectiveItem, currentListingPrice);
    const manualGuardItem = {
      ...effectiveItem,
      original_price: manualBasePrice,
      price: manualBasePrice,
      current_listing_price: currentListingPrice,
    };
    const manualPrice = computeDealPriceFromPercent(
      manualBasePrice,
      deal_manual_percent
    );
    if (
      deal_manual_percent != null &&
      !isManualPercentApplicable({ ...effectiveItem, promotion_type: t }, deal_manual_percent)
    ) {
      const range = computeDealDiscountRange({ ...effectiveItem, promotion_type: t });
      return {
        ok: false,
        status: 400,
        error: `A % informada para a deal está fora da faixa permitida (${range.minPct ?? '—'}% a ${range.maxPct ?? '—'}%).`,
        trace: buildTraceEntry({
          ...trace,
          payload,
          notes: 'deal_manual_percent fora da faixa permitida para o item'
        })
      };
    }

    // usa preço calculado (guardamos no item se já existir)
    const dealAlready = toNum(effectiveItem.deal_price);
    const { newPrice } =
      manualPrice != null
        ? { newPrice: manualPrice }
        : dealAlready != null
          ? { newPrice: dealAlready }
          : resolveDealPriceForDealItem(effectiveItem, policy);

    if (newPrice == null) {
      return {
        ok: false,
        status: 400,
        error: 'Não foi possível calcular deal_price',
        trace: buildTraceEntry({
          ...trace,
          payload,
          notes: 'falha ao calcular deal_price'
        })
      };
    }
    payload.deal_price = newPrice;
    const percentGuard = validateManualDealPricePercent({
      item: manualGuardItem,
      promotionType: t,
      requestedPercent: deal_manual_percent,
      dealPrice: payload.deal_price,
    });
    if (!percentGuard.ok) {
      return {
        ok: false,
        status: 412,
        error: percentGuard.error,
        body: {
          error: "manual_percent_divergence",
          message: percentGuard.error,
          requested_percent: percentGuard.requested_percent,
          calculated_percent: percentGuard.calculated_percent,
          min_allowed_percent: percentGuard.min_allowed_percent,
          max_allowed_percent: percentGuard.max_allowed_percent,
          tolerance: MANUAL_PROMO_PERCENT_TOLERANCE,
        },
        trace: buildTraceEntry({
          ...trace,
          payload,
          notes: percentGuard.notes,
          result: {
            ok: false,
            status: 412,
            body: {
              error: "manual_percent_divergence",
              requested_percent: percentGuard.requested_percent,
              calculated_percent: percentGuard.calculated_percent,
              min_allowed_percent: percentGuard.min_allowed_percent,
              max_allowed_percent: percentGuard.max_allowed_percent,
              tolerance: MANUAL_PROMO_PERCENT_TOLERANCE,
            },
          },
        }),
      };
    }
    if (t === 'LIGHTNING') {
      const stock = resolveLightningStock(effectiveItem, lightning_stock);
      if (stock == null) {
        return {
          ok: false,
          status: 400,
          error: 'Não foi possível definir stock para oferta relâmpago',
          trace: buildTraceEntry({
            ...trace,
            payload,
            notes: 'stock ausente para LIGHTNING'
          })
        };
      }
      payload.stock = stock;
    }
  } else if (t === 'MARKETPLACE_CAMPAIGN') {
    // nada extra
  }

  if (dryRun) {
    // Simula sucesso sem bater no ML
    return {
      ok: true,
      status: 200,
      body: { dryRun: true, method: resolveApplyMethodForItem(t, snapshot), payload },
      trace: buildTraceEntry({
        ...trace,
        payload,
        method: resolveApplyMethodForItem(t, snapshot),
        snapshot,
        result: { ok: true, status: 200, body: { dryRun: true } },
        notes: 'simulacao local sem chamada ao ML'
      })
    };
  }

  if (t === 'SELLER_CAMPAIGN') {
    snapshot = snapshot || await fetchItemPromotionSnapshot({ mlCreds, item_id, promotion_id }).catch(() => null);
    const snapshotStatus = normalizeStatusForML(snapshot?.status);
    trace.snapshot = snapshot;
    if (!snapshot) {
      return {
        ok: false,
        status: 409,
        error: 'O item não aparece na seller campaign selecionada no ML',
        trace: buildTraceEntry({
          ...trace,
          payload,
          snapshot,
          notes: 'item nao encontrado no endpoint segmentado da promocao'
        })
      };
    }
    if (!['candidate', 'pending', 'scheduled', 'started'].includes(snapshotStatus)) {
      return {
        ok: false,
        status: 409,
        error: `Item com status "${snapshotStatus || 'unknown'}" não pode ser aplicado agora`,
        trace: buildTraceEntry({
          ...trace,
          payload,
          snapshot,
          notes: 'status fora dos estados aplicaveis'
        })
      };
    }
  }

  const method = resolveApplyMethodForItem(t, snapshot);
  const fallbackMethod =
    t === 'SELLER_CAMPAIGN' && method === 'POST' ? 'PUT' : null;
  let usedMethod = method;
  trace.method = method;
  trace.payload = payload;
  const strictOfferRefs = isStrictOfferPromotionType(t)
    ? [
        ...new Set(
          [
            ...collectApplyOfferRefsFromItem(snapshot, t),
            ...collectApplyOfferRefsFromItem(item, t),
            payload.offer_id,
          ].filter(Boolean)
        ),
      ]
    : [];

  const url = `https://api.mercadolibre.com/seller-promotions/items/${encodeURIComponent(
    item_id
  )}?app_version=v2`;
  let r = await authFetch(
    url,
    { method: usedMethod, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
    mlCreds
  );

  let { json } = await parseJsonResponseSafe(r);

  if (
    fallbackMethod &&
    !r.ok &&
    isSellerCampaignNoCandidatesError(json)
  ) {
    usedMethod = fallbackMethod;
    r = await authFetch(
      url,
      { method: usedMethod, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
      mlCreds
    );
    ({ json } = await parseJsonResponseSafe(r));
  }
  if (
    !lockedOfferRef &&
    !r.ok &&
    isStrictOfferPromotionType(t) &&
    isCandidateNotFoundMlError(json)
  ) {
    for (const ref of strictOfferRefs) {
      if (!ref || ref === payload.offer_id) continue;
      const retryPayload = { ...payload, offer_id: ref };
      r = await authFetch(
        url,
        { method: usedMethod, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(retryPayload) },
        mlCreds
      );
      ({ json } = await parseJsonResponseSafe(r));
      if (r.ok || !isCandidateNotFoundMlError(json)) {
        trace.payload = retryPayload;
        break;
      }
    }
  }
  if (
    !r.ok &&
    t === 'SELLER_CAMPAIGN' &&
    isSellerCampaignNoCandidatesError(json)
  ) {
    return {
      ok: false,
      status: 409,
      body: {
        message: 'O Mercado Livre não encontrou o item como candidato aplicável nessa seller campaign',
        apply_method: usedMethod,
        attempted_methods: usedMethod === method ? [method] : [method, usedMethod],
        campaign_item_status: normalizeStatusForML(snapshot?.status) || null,
        requested_deal_price: payload.deal_price != null ? Number(payload.deal_price) : null,
        ml_body: json
      },
      trace: buildTraceEntry({
        ...trace,
        snapshot,
        result: {
          ok: false,
          status: 409,
          body: {
            message: 'O Mercado Livre não encontrou o item como candidato aplicável nessa seller campaign',
            apply_method: usedMethod,
            attempted_methods: usedMethod === method ? [method] : [method, usedMethod],
            campaign_item_status: normalizeStatusForML(snapshot?.status) || null,
            requested_deal_price: payload.deal_price != null ? Number(payload.deal_price) : null,
            ml_body: json
          }
        },
        notes: 'ml respondeu no candidates found'
      })
    };
  }
  return {
    ok: r.ok,
    status: r.status,
    body: json,
    retry_after_ms: parseRetryAfterMs(r),
    trace: buildTraceEntry({
      ...trace,
      snapshot,
      result: { ok: r.ok, status: r.status, body: json },
      notes: r.ok ? 'aplicacao aceita pelo ML' : 'aplicacao rejeitada pelo ML'
    })
  };
}

// Remove 1 item usando o adapter (que chama seu service)
async function removeItem({ mlCreds, promotion_id, promotion_type, item }) {
  if (!RemovalAdapter || typeof RemovalAdapter.removeOne !== 'function') {
    return { ok: false, status: 501, error: 'Bulk removal adapter não configurado' };
  }
  const item_id = item.id || item.item_id;
  try {
    const r = await RemovalAdapter.removeOne({ mlCreds, promotion_id, promotion_type, item_id });
    // Normalize resultado
    return {
      ok: !!r?.ok,
      status: r?.status ?? (r?.ok ? 200 : 400),
      body: r?.body ?? r ?? null
    };
  } catch (e) {
    return { ok: false, status: 500, error: e.message || String(e) };
  }
}

/* -------------------------- Execução do job (worker) ---------------------- */

async function runListValidationJob(job, done) {
  const data = job.data || {};
  const {
    mlCreds,
    accountKey,
    accountLabel,
    promotion: { id: promotion_id, type: promotion_type_raw, name: promotion_name } = {
      id: null,
      type: null,
      name: null,
    },
    filters = {},
    options = {},
  } = data;

  const promotion_type = String(promotion_type_raw || "").toUpperCase();
  const status = statusQueryOrNull(filters.status);
  const percent = toNum(filters.percent_max ?? filters.maxDesc);
  const entries = parseMlbListEntries(data.raw_list || filters.mlbs || []);
  const wantedIds = normalizeMlbFilterList(entries.map((entry) => entry.mlb || entry.token));
  const wantedSet = new Set(wantedIds);
  const foundRowsById = new Map();
  const eligibleItems = [];
  const eligibleIds = [];
  const seenEligible = new Set();
  let processedPages = 0;
  let total = entries.length;

  const updateJob = async (patch = {}) => {
    const counters = patch.counters || {
      processed: entries.length,
      total,
      success: eligibleIds.length,
      failed: Math.max(0, entries.length - eligibleIds.length),
    };
    await job
      .update({
        ...job.data,
        ...patch,
        counters,
        lastUpdate: Date.now(),
      })
      .catch(() => {});
  };

  try {
    await job.progress(0);
    await updateJob({
      stateLabel: `validando 0/${total || wantedIds.length}`,
      counters: { processed: 0, total, success: 0, failed: 0 },
    });

    await auditPromoJobEvent(job, "promotion_list_validation_started", "success", {
      total_items: wantedIds.length,
      raw_entries: entries.length,
      percent,
      status,
      application_source: "list_validation",
      selection_count: wantedIds.length,
    });

    if (!promotion_id || !promotion_type) {
      throw new Error("promotion_id e promotion_type sao obrigatorios.");
    }
    if (!wantedIds.length) {
      throw new Error("Informe ao menos 1 MLB valido para validar a lista.");
    }
    if (!isValidManualPromoPercent(percent)) {
      throw new Error(`Informe um percentual valido entre 0,01 e ${MANUAL_PROMO_MAX_PERCENT}%.`);
    }

    let token = null;
    let benefitsGlobal = null;
    const manualListLookup = ["SELLER_CAMPAIGN", "DEAL", "DOD", "LIGHTNING"].includes(
      promotion_type,
    );

    if (manualListLookup) {
      let checked = 0;
      const directConcurrency = Number(process.env.ML_PROMO_LIST_LOOKUP_CONCURRENCY || 6);
      await mapWithConcurrency(wantedIds, directConcurrency, async (id) => {
        await checkCancelled(job);
        let rows = await fetchPromotionItemsById({
          mlCreds,
          promotion_id,
          promotion_type,
          item_id: id,
        }).catch(() => []);
        rows = (Array.isArray(rows) ? rows : [])
          .filter((item) => {
            const itemId = String(item?.id || item?.item_id || "").trim().toUpperCase();
            if (itemId !== id) return false;
            if (status && normalizeStatusForML(item?.status) !== status) return false;
            return true;
          })
          .map((item) => ({
            ...item,
            id,
            item_id: id,
            promotion_id,
            promotion_type,
          }));

        if (rows.length) {
          foundRowsById.set(id, rows);
        }

        checked += 1;
        if (checked === wantedIds.length || checked % 10 === 0) {
          const pct = wantedIds.length
            ? clampPct(Math.min(90, (checked / wantedIds.length) * 90))
            : 90;
          await job.progress(pct).catch(() => {});
          await updateJob({
            stateLabel: `validando lista (${checked}/${wantedIds.length})`,
            counters: { processed: checked, total, success: 0, failed: 0 },
          });
        }
      });
    } else {
      while (true) {
        await checkCancelled(job);
        processedPages += 1;
        if (processedPages > 1000) break;

        const page = await fetchPromotionItemsPaged({
          mlCreds,
          promotion_id,
          promotion_type,
          status,
          limit: 50,
          search_after: token,
        });
        if (page.status >= 400) {
          throw new Error(`Falha ao consultar itens da campanha no ML (${page.status}).`);
        }
        if (!benefitsGlobal && page.benefits) benefitsGlobal = page.benefits;
        const items = Array.isArray(page.results) ? page.results : [];
        if (!items.length && !page.next) break;

        for (let item of items) {
          const id = String(item?.id || item?.item_id || "").trim().toUpperCase();
          if (!id || !wantedSet.has(id)) continue;
          if (status && normalizeStatusForML(item?.status) !== status) continue;

          const rows = foundRowsById.get(id) || [];
          rows.push(item);
          foundRowsById.set(id, rows);
        }

        const foundCount = foundRowsById.size;
        const pct = wantedIds.length
          ? clampPct(Math.min(90, (foundCount / wantedIds.length) * 90))
          : 90;
        await job.progress(pct).catch(() => {});
        await updateJob({
          stateLabel: `validando lista (${foundCount}/${wantedIds.length})`,
          counters: { processed: foundCount, total, success: 0, failed: 0 },
        });

        if (!page.next) break;
        token = page.next;
      }
    }

    for (const id of wantedIds) {
      await checkCancelled(job);
      const rows = foundRowsById.get(id) || [];
      const candidate =
        promotion_type === "LIGHTNING"
          ? rows.find(
              (row) => normalizeStatusForML(row?.status) === "candidate",
            ) || null
          : ["SELLER_CAMPAIGN", "DEAL", "DOD"].includes(promotion_type)
          ? mergeManualPromotionRows(rows, promotion_type)
          : rows[0] || null;
      if (!candidate) continue;

      const applicable =
        ["SELLER_CAMPAIGN", "DEAL", "DOD", "LIGHTNING"].includes(promotion_type)
          ? isManualPercentApplicable({ ...candidate, promotion_type }, percent)
          : isEligible(
              candidate,
              { mlb: null, mlbs: null, maxDesc: percent },
              promotion_type,
              benefitsGlobal,
              "min",
            );
      if (!applicable || seenEligible.has(id)) continue;

      seenEligible.add(id);
      eligibleIds.push(id);
      eligibleItems.push({
        ...candidate,
        id,
        item_id: id,
        promotion_id,
        promotion_type,
      });
    }

    const diagnostics = buildListValidationDiagnostics({
      entries,
      eligibleIds,
      promotion: {
        id: promotion_id,
        type: promotion_type,
        name: promotion_name || promotion_id,
      },
      status,
      percent,
    });
    const notEligible = diagnostics.filter((row) => row.success !== true).length;
    const selection = await PromoSelectionStore.saveSelection({
      accountKey,
      promotionId: promotion_id,
      promotionType: promotion_type,
      filters: {
        status: status || null,
        mlbs: eligibleIds,
        percent_max: percent,
      },
      items: eligibleItems.length === eligibleIds.length ? eligibleItems : eligibleIds,
      meta: {
        application_source: "list_validation",
        selection_count: eligibleIds.length,
        original_list_count: wantedIds.length,
      },
    });
    const selectionToken = selection?.token || null;

    const summary = {
      id: job.id,
      kind: "promotion-list-validation",
      title: `Validar lista ${promotion_type} ${promotion_name || promotion_id}`,
      status: "completed",
      total,
      processed: total,
      success: eligibleIds.length,
      failed: 0,
      eligible: eligibleIds.length,
      not_eligible: notEligible,
      ids: eligibleIds,
      selection_token: selectionToken,
      diagnostics,
      results: diagnostics,
      account:
        accountKey || accountLabel
          ? { key: accountKey || null, label: accountLabel || accountKey || null }
          : null,
      finished_at: new Date().toISOString(),
    };

    await updateJob({
      counters: {
        processed: total,
        total,
        success: eligibleIds.length,
        failed: 0,
      },
      notEligible,
      not_eligible: notEligible,
      results: diagnostics,
      listDiagnostics: diagnostics,
      selectionToken,
      selectionIds: eligibleIds,
      stateLabel: `concluido: ${eligibleIds.length} elegiveis, ${notEligible} fora`,
    });
    await job.progress(100).catch(() => {});
    await auditPromoJobEvent(job, "promotion_list_validation_completed", "success", {
      total_items: total,
      eligible_items: eligibleIds.length,
      not_eligible_items: notEligible,
      failed_items: 0,
      application_source: "list_validation",
      selection_count: wantedIds.length,
    });
    done(null, summary);
  } catch (error) {
    if (error instanceof JobCancelledError) {
      const diagnostics = buildListValidationDiagnostics({
        entries,
        eligibleIds,
        promotion: { id: promotion_id, type: promotion_type, name: promotion_name || promotion_id },
        status,
        percent,
      });
      const cancelProcessed = Math.min(
        Number(total || 0),
        Array.isArray(entries) ? entries.length : 0,
      );
      const cancelCoverage =
        total > 0 ? clampPct((cancelProcessed / total) * 100) : 0;
      await updateJob({
        counters: {
          processed: cancelProcessed,
          total,
          success: eligibleIds.length,
          failed: 0,
        },
        results: diagnostics,
        listDiagnostics: diagnostics,
        stateLabel: "cancelado",
        cancelRequested: false,
        cancelCompletedAt: Date.now(),
        resumable: false,
      });
      await job.progress(cancelCoverage).catch(() => {});
      done(null, {
        id: job.id,
        kind: "promotion-list-validation",
        status: "cancelado",
        total,
        processed: cancelProcessed,
        success: eligibleIds.length,
        failed: 0,
        results: diagnostics,
        diagnostics,
      });
      return;
    }
    await auditPromoJobEvent(job, "promotion_list_validation_failed", "error", {
      error: safeText(error?.message || String(error)),
      total_items: total,
      application_source: "list_validation",
      selection_count: wantedIds.length,
    });
    done(error);
  }
}

async function scheduleLogicalPromotionOperation(job, done) {
  const latest = (await job.queue.getJob(job.id).catch(() => null)) || job;
  const data = latest?.data || job.data || {};
  if (!isLogicalPromotionOperationData(data)) {
    done(new Error('Operacao logica promocional invalida.'));
    return;
  }

  if (data?.operationTerminal === true) {
    done(null, {
      id: job.id,
      kind: 'promotion-operation',
      status: data.operationLifecycle || 'completed',
      terminal: true,
    });
    return;
  }

  if (data?.cancelRequested === true || data?.stateLabel === 'cancelado') {
    const operationTotal = inferOperationTotal(data);
    const counters = data?.counters || {};
    const canceledData = {
      ...data,
      operationTotal,
      operationLifecycle: 'canceled',
      operationTerminal: true,
      activeChunkJobId: null,
      stateLabel: 'cancelado',
      queueReason: null,
      cancelRequested: false,
      cancelCompletedAt: Date.now(),
      lastUpdate: Date.now(),
    };
    await latest.update(canceledData).catch(() => {});
    await storeCanceledTombstone(latest, canceledData).catch(() => {});
    await settleCredits(canceledData?.creditReservation, { release: true }).catch(() => {});
    await releaseCampaignGuard(canceledData, String(latest.id)).catch(() => {});
    done(null, {
      id: latest.id,
      kind: 'promotion-operation',
      status: 'cancelado',
      total: operationTotal,
      processed: Number(counters.processed || 0),
      success: Number(counters.success || 0),
      failed: Number(counters.failed || 0),
    });
    return;
  }

  const checkpoint = data?.chunkCheckpoint || {};
  const offset = Math.max(0, Number(checkpoint?.offset || 0));
  const sequence = Math.max(1, Number(checkpoint?.sequence || 1));
  const child = await enqueuePromotionChunk(latest, {
    offset,
    sequence,
    reason: offset > 0 ? 'cooperative_chunk' : 'worker_queue',
  });

  done(null, {
    id: latest.id,
    kind: 'promotion-operation',
    status: 'scheduled',
    terminal: false,
    chunk_job_id: String(child.id),
  });
}

async function runPromotionChunkJob(chunkJob, done) {
  const chunkData = chunkJob?.data || {};
  const parentJobId = String(chunkData?.parentJobId || '').trim();
  if (!parentJobId) {
    done(new Error('Chunk promocional sem parentJobId.'));
    return;
  }

  const parentJob = await chunkJob.queue.getJob(parentJobId).catch(() => null);
  if (!parentJob) {
    done(null, {
      id: chunkJob.id,
      kind: 'promotion-chunk',
      status: 'orphaned',
      parent_job_id: parentJobId,
    });
    return;
  }

  let parentData = parentJob.data || {};
  if (parentData?.operationTerminal === true) {
    done(null, {
      id: chunkJob.id,
      kind: 'promotion-chunk',
      status: 'parent_terminal',
      parent_job_id: parentJobId,
    });
    return;
  }

  const offset = Math.max(0, Number(chunkData?.chunkOffset || parentData?.chunkCheckpoint?.offset || 0));
  const sequence = Math.max(1, Number(chunkData?.chunkSequence || parentData?.chunkCheckpoint?.sequence || 1));
  const operationTotal = inferOperationTotal(parentData);
  await parentJob.update({
    ...parentData,
    operationTotal,
    operationLifecycle: 'processing',
    operationTerminal: false,
    activeChunkJobId: String(chunkJob.id),
    chunkCheckpoint: {
      ...(parentData?.chunkCheckpoint || {}),
      offset,
      sequence,
      size: PROMO_JOB_CHUNK_SIZE,
      updatedAt: Date.now(),
    },
    queueReason: null,
    stateLabel: operationTotal > 0
      ? `active ${Number(parentData?.counters?.processed || 0)}/${operationTotal}`
      : 'active 0/?',
    lastUpdate: Date.now(),
  }).catch(() => {});
  parentData = parentJob.data || parentData;

  let lease = null;
  while (!lease?.acquired) {
    const freshParent = await chunkJob.queue.getJob(parentJobId).catch(() => null);
    const freshData = freshParent?.data || {};
    if (!freshParent || freshData?.operationTerminal === true) {
      done(null, {
        id: chunkJob.id,
        kind: 'promotion-chunk',
        status: 'parent_terminal',
        parent_job_id: parentJobId,
      });
      return;
    }
    if (freshData?.cancelRequested === true || freshData?.stateLabel === 'cancelado') {
      await parentJob.update({
        ...freshData,
        operationLifecycle: 'canceled',
        operationTerminal: true,
        activeChunkJobId: null,
        stateLabel: 'cancelado',
        queueReason: null,
        cancelRequested: false,
        cancelCompletedAt: Date.now(),
        lastUpdate: Date.now(),
      }).catch(() => {});
      await storeCanceledTombstone(parentJob, parentJob.data || freshData).catch(() => {});
      await settleCredits(freshData?.creditReservation, { release: true }).catch(() => {});
      await releaseCampaignGuard(freshData, parentJobId).catch(() => {});
      done(null, {
        id: chunkJob.id,
        kind: 'promotion-chunk',
        status: 'cancelado',
        parent_job_id: parentJobId,
      });
      return;
    }

    lease = await acquireRuntimeFairness(chunkJob);
    if (lease?.acquired) break;

    const reason =
      lease?.reason === 'campaign_busy'
        ? 'na fila: outra operacao da mesma campanha esta em andamento'
        : `na fila: limite de ${PROMO_MAX_ACTIVE_JOBS_PER_ACCOUNT} jobs ativos da conta`;
    await parentJob.update({
      ...(freshParent?.data || freshData),
      operationLifecycle: 'queued',
      operationTerminal: false,
      stateLabel: reason,
      queueReason: lease?.reason || 'fairness',
      activeChunkJobId: String(chunkJob.id),
      lastUpdate: Date.now(),
    }).catch(() => {});

    // Um chunk e interno e pode usar retry do Bull sem contaminar o lifecycle
    // do job principal exibido ao usuario.
    if (canCooperativelyYield(chunkJob)) {
      done(new PromoFairnessYieldError(`PROMO_YIELD: ${reason}`));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  const refreshTimer = setInterval(() => {
    lease?.refresh?.().catch(() => {});
  }, Math.max(5000, Math.floor(PROMO_RUNTIME_LEASE_MS / 3)));
  refreshTimer.unref?.();

  const finish = async (error, result) => {
    clearInterval(refreshTimer);
    await lease?.release?.().catch(() => {});

    if (error && !isInternalYieldError(error)) {
      const latestParent = await chunkJob.queue.getJob(parentJobId).catch(() => null);
      const latestData = latestParent?.data || parentJob.data || {};
      if (latestParent && latestData?.safetyPaused !== true && latestData?.operationTerminal !== true) {
        const failedData = {
          ...latestData,
          operationLifecycle: 'failed',
          operationTerminal: true,
          activeChunkJobId: null,
          stateLabel: latestData?.stateLabel || 'falhou',
          queueReason: null,
          failedReason: error?.message || String(error),
          lastUpdate: Date.now(),
        };
        await latestParent.update(failedData).catch(() => {});
        await settleCredits(failedData?.creditReservation, { release: true }).catch(() => {});
        await releaseCampaignGuard(failedData, parentJobId).catch(() => {});
      }
    }

    done(error, {
      ...(result || {}),
      chunk_job_id: String(chunkJob.id),
      parent_job_id: parentJobId,
    });
  };

  try {
    return runBulkJob(parentJob, finish);
  } catch (error) {
    return finish(error);
  }
}

async function runPromoJob(job, done) {
  const kind = String(job?.data?.kind || "").toLowerCase();
  if (kind === "list-validation") {
    return runListValidationJob(job, done);
  }
  if (kind === "promotion-remediation") {
    return runPromotionRemediationJob(job, done);
  }
  if (kind === 'promotion-operation' && isLogicalPromotionOperationData(job?.data || {})) {
    return scheduleLogicalPromotionOperation(job, done);
  }
  if (kind === 'promotion-chunk' && isPromotionChunkData(job?.data || {})) {
    return runPromotionChunkJob(job, done);
  }

  // Compatibilidade para jobs criados antes da orquestracao v2.
  let lease = null;
  while (!lease?.acquired) {
    try {
      await checkCancelled(job);
    } catch (error) {
      if (error instanceof JobCancelledError) {
        done(null, {
          id: job.id,
          status: 'cancelado',
          total: Number(job?.data?.counters?.total || 0),
          processed: Number(job?.data?.counters?.processed || 0),
          success: Number(job?.data?.counters?.success || 0),
          failed: Number(job?.data?.counters?.failed || 0),
        });
        return;
      }
      done(error);
      return;
    }
    lease = await acquireRuntimeFairness(job);
    if (lease?.acquired) break;

    const latest = await latestJobData(job);
    const reason =
      lease?.reason === 'campaign_busy'
        ? 'na fila: outra operacao da mesma campanha esta em andamento'
        : `na fila: limite de ${PROMO_MAX_ACTIVE_JOBS_PER_ACCOUNT} jobs ativos da conta`;
    await job.update({
      ...latest,
      stateLabel: reason,
      queueReason: lease?.reason || 'fairness',
      lastUpdate: Date.now(),
    }).catch(() => {});
    await job.progress(
      Number(latest?.counters?.total || 0) > 0
        ? clampPct(
            (Number(latest?.counters?.processed || 0) /
              Number(latest?.counters?.total || 1)) *
              100,
          )
        : 0,
    ).catch(() => {});

    if (lease?.reason === 'campaign_busy') {
      const summary = await supersedeDuplicateBeforeMutation(
        job,
        lease?.ownerJobId || null,
      );
      done(null, summary);
      return;
    }

    if (canCooperativelyYield(job)) {
      done(new PromoFairnessYieldError(`PROMO_YIELD: ${reason}`));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  const refreshTimer = setInterval(() => {
    lease?.refresh?.().catch(() => {});
  }, Math.max(5000, Math.floor(PROMO_RUNTIME_LEASE_MS / 3)));
  refreshTimer.unref?.();

  const finish = async (error, result) => {
    clearInterval(refreshTimer);
    await lease?.release?.().catch(() => {});
    if (error && !isInternalYieldError(error)) {
      try { job.discard(); } catch {}
    }
    done(error, result);
  };

  try {
    return runBulkJob(job, finish);
  } catch (error) {
    return finish(error);
  }
}

async function runBulkJob(job, done) {
  const data = job.data || {};
  const {
    mlCreds,
    accountKey,
    accountLabel,
    action,
    promotion: { id: promotion_id, type: promotion_type_raw } = { id: null, type: null },
    selectionItems = null,
    filters = {},
    price_policy = 'min',
    options = {}
  } = data;

  const promotion_type = String(promotion_type_raw || '').toUpperCase();
  const normalizedPricePolicy = normalizePricePolicy(price_policy);
  const normalizedFilters = {
    ...(filters || {}),
    mlbs: normalizeMlbFilterList(filters?.mlbs),
  };
  const selectedMlbIds = new Set(normalizedFilters.mlbs || []);
  const prevalidatedSelection =
    options?.prevalidated_selection === true && selectedMlbIds.size > 0;
  const applicationSource =
    options?.application_source ||
    (prevalidatedSelection ? "prevalidated_selection" : "campaign_scan");
  const selectionCount =
    Number(options?.selection_count) ||
    (prevalidatedSelection ? selectedMlbIds.size : null);
  const processedPrevalidatedIds = new Set();
  const processedCandidateIds = new Set();
  const groupPrevalidatedManualRows =
    prevalidatedSelection &&
    ['SELLER_CAMPAIGN', 'DEAL', 'DOD', 'LIGHTNING'].includes(promotion_type);
  const prevalidatedRowsById = new Map();
  
  const checkpoint = data?.chunkCheckpoint || {};
  const chunkOffset = Math.max(0, Number(checkpoint?.offset || 0));
  const persistedCounters = data?.counters || {};
  const logicalOperation = isLogicalPromotionOperationData(data);
  let operationTotal = inferOperationTotal(data);

  // Em retomadas cooperativas preservamos o progresso real da operacao pai.
  await job.progress(
    Number(persistedCounters.total || 0) > 0
      ? clampPct(
          (Number(persistedCounters.processed || 0) /
            Number(persistedCounters.total || 1)) *
            100,
        )
      : 0,
  );

  const wantStatus = statusQueryOrNull(normalizedFilters.status) || undefined;

  // Counters/checkpoint persistem entre fatias do mesmo job.
  let total = Number(operationTotal || persistedCounters.total || 0);
  let processed = Number(persistedCounters.processed || 0);
  let success = Number(persistedCounters.success || 0);
  let failed = Number(persistedCounters.failed || 0);
  let failedItems = Array.isArray(data?.failedItems) ? data.failedItems.slice() : [];
  let itemTraces = Array.isArray(data?.itemTraces) ? data.itemTraces.slice() : [];
  let results = Array.isArray(data?.results) ? data.results.slice() : [];
  const strictOfferType =
    promotion_type === 'PRE_NEGOTIATED' || promotion_type === 'UNHEALTHY_STOCK';
  const preparedItems = Array.isArray(selectionItems)
    ? selectionItems
        .map((item) =>
          item && typeof item === 'object'
            ? item
            : { id: String(item || '').trim().toUpperCase() }
        )
        .filter((item) => String(item?.id || item?.item_id || '').trim())
    : null;

  async function finishCancelled() {
    const latest = await job.queue.getJob(job.id).catch(() => null);
    const latestData = latest?.data || job.data || {};
    const latestCounters = latestData.counters || {};
    const finalProcessed = Number(latestCounters.processed ?? processed ?? 0);
    const inferredCancelTotal =
      (Array.isArray(preparedItems) && preparedItems.length > 0
        ? preparedItems.length
        : Number(options?.expected_total || 0) > 0
          ? Number(options.expected_total)
          : Array.isArray(normalizedFilters?.mlbs) && normalizedFilters.mlbs.length > 0
            ? normalizedFilters.mlbs.length
            : normalizedFilters?.mlb
              ? 1
              : 0);
    const finalTotal = Number(
      Number(latestCounters.total || 0) > 0
        ? latestCounters.total
        : Number(total || 0) > 0
          ? total
          : inferredCancelTotal,
    );
    const finalSuccess = Number(latestCounters.success ?? success ?? 0);
    const finalFailed = Number(latestCounters.failed ?? failed ?? 0);
    const finalFailedItems = Array.isArray(latestData.failedItems)
      ? latestData.failedItems
      : failedItems;
    const finalItemTraces = Array.isArray(latestData.itemTraces)
      ? latestData.itemTraces
      : itemTraces;
    const finalResults = Array.isArray(latestData.results)
      ? latestData.results
      : results;

    const cancelledData = {
      ...latestData,
      counters: {
        processed: finalProcessed,
        total: finalTotal,
        success: finalSuccess,
        failed: finalFailed,
      },
      failedItems: finalFailedItems,
      itemTraces: finalItemTraces,
      results: finalResults,
      stateLabel: "cancelado",
      operationLifecycle: logicalOperation ? 'canceled' : latestData?.operationLifecycle,
      operationTerminal: logicalOperation ? true : latestData?.operationTerminal,
      activeChunkJobId: logicalOperation ? null : latestData?.activeChunkJobId,
      queueReason: null,
      cancelRequested: false,
      cancelCompletedAt: Date.now(),
      safetyPaused: false,
      resumable: false,
      transientRetry: null,
      lastUpdate: Date.now(),
    };

    await job.update(cancelledData).catch(() => {});
    const cancellationCoverage =
      finalTotal > 0 ? clampPct((finalProcessed / finalTotal) * 100) : 0;
    await job.progress(cancellationCoverage).catch(() => {});
    if (logicalOperation) {
      await storeCanceledTombstone(job, cancelledData).catch(() => {});
      await settleCredits(cancelledData?.creditReservation, { release: true }).catch(() => {});
      await releaseCampaignGuard(cancelledData, String(job.id)).catch(() => {});
    }

    const summary = {
      id: job.id,
      title: `${action === 'remove' ? 'Remover' : 'Aplicar'} ${promotion_type} ${promotion_id}`,
      status: 'cancelado',
      total: finalTotal,
      processed: finalProcessed,
      success: finalSuccess,
      failed: finalFailed,
      failed_items: finalFailedItems,
      item_traces: finalItemTraces,
      results: finalResults,
      account:
        accountKey || accountLabel
          ? { key: accountKey || null, label: accountLabel || accountKey || null }
          : null,
      finished_at: new Date().toISOString()
    };

    await auditPromoJobEvent(job, "promotion_job_canceled", "warn", {
      total_items: finalTotal,
      processed: finalProcessed,
      success: finalSuccess,
      failed: finalFailed,
    });

    return summary;
  }

  // 🔧 CORREÇÃO 2: Definir total ANTES e atualizar job imediatamente
  let benefitsGlobal = null;
  try {
    console.log(`[PromoJobsService] Job ${job.id} - Calculando total...`);
    await checkCancelled(job);
    
    if (operationTotal > 0) {
      total = operationTotal;
      console.log(`[PromoJobsService] Job ${job.id} - Total imutavel da operacao: ${total}`);
    } else if (Array.isArray(preparedItems) && preparedItems.length > 0) {
      total = Number(preparedItems.length);
      operationTotal = total;
      console.log(`[PromoJobsService] Job ${job.id} - Total vindo da seleção preparada: ${total}`);
    } else if (typeof options.expected_total === 'number' && options.expected_total > 0) {
      total = Number(options.expected_total);
      operationTotal = total;
      console.log(`[PromoJobsService] Job ${job.id} - Total esperado: ${total}`);
    } else {
      const pre = await precountEligible({
        mlCreds,
        promotion_id,
        promotion_type,
        status: wantStatus,
        filters: normalizedFilters,
        price_policy: normalizedPricePolicy
      });
      total = Number(pre.total || 0);
      operationTotal = total;
      benefitsGlobal = pre.benefitsGlobal || null;
      console.log(`[PromoJobsService] Job ${job.id} - Total calculado: ${total}`);
    }
  } catch (e) {
    if (e instanceof JobCancelledError) {
      const cancelledSummary = await finishCancelled();
      done(null, cancelledSummary);
      return;
    }
    console.error(`[PromoJobsService] Job ${job.id} - Erro ao calcular total:`, e.message);
    total = 0;
  }

  // 🔧 CORREÇÃO 3: Atualizar job data com total definido IMEDIATAMENTE
  const initialData = {
    ...job.data,
    counters: { processed, total, success, failed },
    operationTotal: total,
    operationLifecycle: logicalOperation ? 'processing' : job.data?.operationLifecycle,
    operationTerminal: logicalOperation ? false : job.data?.operationTerminal,
    failedItems,
    itemTraces,
    results,
    stateLabel:
      chunkOffset > 0
        ? `retomando ${processed}/${total || '?'}`
        : total > 0
          ? `iniciando ${processed}/${total}`
          : `iniciando ${processed}/?`,
    queueReason: null,
    lastUpdate: Date.now()
  };

  try {
    await job.update(initialData);
    console.log(`[PromoJobsService] Job ${job.id} - Dados iniciais atualizados`);
  } catch (e) {
    console.error(`[PromoJobsService] Job ${job.id} - Erro ao atualizar dados iniciais:`, e.message);
  }

  let token = null;

  // 🔧 CORREÇÃO 4: Melhorar logging e controle de progresso
  console.log(`[PromoJobsService] Job ${job.id} - Iniciando processamento...`);
  const adaptivePromotionTypes = new Set(['DEAL', 'SELLER_CAMPAIGN', 'LIGHTNING']);
  const itemConcurrencyMax =
    action === 'apply' && adaptivePromotionTypes.has(promotion_type)
      ? PROMO_ITEM_MAX_CONCURRENCY
      : 1;
  const adaptiveController = createAdaptiveItemController({
    total,
    maxLimit: itemConcurrencyMax,
  });

  await auditPromoJobEvent(job, "promotion_job_processing_started", "success", {
    total_items: total,
    filters: normalizedFilters,
    price_policy: normalizedPricePolicy,
    dry_run: !!options.dryRun,
    application_source: applicationSource,
    selection_count: selectionCount,
    prevalidated_selection: prevalidatedSelection,
    item_concurrency_initial: 1,
    item_concurrency_max: itemConcurrencyMax,
    account_item_concurrency_max: PROMO_ACCOUNT_ITEM_CONCURRENCY,
    sentinel_items: Math.min(PROMO_ITEM_SENTINEL_COUNT, Math.max(total, 1)),
    sample_ids: Array.isArray(preparedItems)
      ? preparedItems
          .slice(0, 20)
          .map((item) => String(item?.id || item?.item_id || "").toUpperCase())
          .filter(Boolean)
      : normalizedFilters.mlbs?.slice(0, 20) || (normalizedFilters.mlb ? [normalizedFilters.mlb] : []),
  });

  async function cooperativelyYieldAfterChunk(nextOffset, sourceCount) {
    if (nextOffset >= sourceCount || sourceCount <= PROMO_JOB_CHUNK_SIZE) {
      return false;
    }

    const latest = await latestJobData(job);
    const pct = total > 0 ? clampPct((processed / total) * 100) : 0;

    if (logicalOperation) {
      const nextSequence = Math.max(
        2,
        Number(latest?.chunkCheckpoint?.sequence || checkpoint?.sequence || 1) + 1,
      );
      await job.update({
        ...latest,
        counters: { processed, total, success, failed },
        operationTotal: total,
        operationLifecycle: 'yielded',
        operationTerminal: false,
        activeChunkJobId: null,
        failedItems,
        itemTraces,
        results,
        chunkCheckpoint: {
          offset: nextOffset,
          sourceCount,
          size: PROMO_JOB_CHUNK_SIZE,
          sequence: nextSequence,
          yields: Number(latest?.chunkCheckpoint?.yields || checkpoint?.yields || 0) + 1,
          updatedAt: Date.now(),
        },
        stateLabel: `na fila: ${processed}/${total || sourceCount} processados, cedendo turno`,
        queueReason: 'cooperative_chunk',
        safetyPaused: false,
        transientRetry: null,
        lastUpdate: Date.now(),
      }).catch(() => {});
      await job.progress(pct).catch(() => {});
      const nextChunk = await enqueuePromotionChunk(job, {
        offset: nextOffset,
        sequence: nextSequence,
        reason: 'cooperative_chunk',
      });
      await auditPromoJobEvent(job, 'promotion_job_chunk_yielded', 'success', {
        processed,
        total,
        next_offset: nextOffset,
        source_count: sourceCount,
        chunk_size: PROMO_JOB_CHUNK_SIZE,
        next_chunk_job_id: String(nextChunk.id),
      });
      done(null, {
        id: job.id,
        kind: 'promotion-operation',
        status: 'chunk_completed',
        terminal: false,
        total,
        processed,
        success,
        failed,
        next_chunk_job_id: String(nextChunk.id),
      });
      return true;
    }

    // Compatibilidade para jobs legados: ainda usa o retry do mesmo Bull job.
    if (!canCooperativelyYield(job)) return false;
    await job.update({
      ...latest,
      counters: { processed, total, success, failed },
      failedItems,
      itemTraces,
      results,
      chunkCheckpoint: {
        offset: nextOffset,
        sourceCount,
        size: PROMO_JOB_CHUNK_SIZE,
        yields: Number(checkpoint?.yields || 0) + 1,
        updatedAt: Date.now(),
      },
      stateLabel: `na fila: lote ${processed}/${total || sourceCount} concluido, cedendo turno`,
      queueReason: 'cooperative_chunk',
      safetyPaused: false,
      transientRetry: null,
      lastUpdate: Date.now(),
    }).catch(() => {});
    await job.progress(pct).catch(() => {});
    await auditPromoJobEvent(job, 'promotion_job_chunk_yielded', 'success', {
      processed,
      total,
      next_offset: nextOffset,
      source_count: sourceCount,
      chunk_size: PROMO_JOB_CHUNK_SIZE,
    });
    done(
      new PromoCooperativeYieldError(
        `PROMO_YIELD: fatia ${processed}/${total || sourceCount} concluida`,
      ),
    );
    return true;
  }

  // varrer todas as páginas aplicando filtros
  try {
    let batchFailureState = { signature: null, consecutive: 0 };
    let criticalDivergenceCount = 0;
    const processCandidateItem = async (it) => {
      const id = (it.id || it.item_id || '').toUpperCase();
      const definedPercent = resolveDefinedPercentForAudit({
        promotion_type,
        filters: normalizedFilters,
        options,
      });
      const estimatedAppliedPercent =
        action === 'apply'
          ? resolveAppliedPercentForCsv({
              item: it,
              promotion_type,
              benefitsGlobal,
              price_policy: normalizedPricePolicy,
              options,
            })
          : null;
      let realAppliedPercent = null;
      let postApplyConfirmation = null;
      let circuitBreakerError = null;
      let remediationJobId = null;
      let quarantineStatus = null;
      let transientRetries = 0;
      let transientRetryAttempts = [];
      let batchDecision = {
        action: 'continue',
        code: 'ITEM_PROCESSED',
        reason: null,
      };

      await checkCancelled(job);
      const itemStartedAt = Date.now();
      const releaseAccountSlot = await acquirePromoAccountSlot(job, {
        accountKey,
        mlCreds,
        itemId: id,
      });
      try {
      let itemAudit = null;
      try {
        if (action === 'apply') {
          const applyAttempt = await runApplyWithTransientRetry(
            job,
            () => applyItem({
              mlCreds,
              promotion_id,
              promotion_type,
              item: it,
              policy: normalizedPricePolicy,
              dryRun: !!options.dryRun,
              seller_manual_percent: options.seller_manual_percent ?? null,
              deal_manual_percent: options.deal_manual_percent ?? null,
              lightning_stock: options.lightning_stock ?? null,
              max_discount_percent: normalizedFilters.maxDesc ?? null
            }),
            {
              itemId: id,
              onTransient: () => adaptiveController.onTransient(),
              verifyAfterTransient: options.dryRun
                ? null
                : (failedApplyResult) =>
                    confirmAppliedPromotionState({
                      mlCreds,
                      promotion_id,
                      promotion_type,
                      item: it,
                      applyResult: failedApplyResult,
                      requested_percent: definedPercent,
                      max_discount_percent: normalizedFilters.maxDesc ?? null,
                    }),
            },
          );
          const res = applyAttempt.result;
          transientRetries = Number(applyAttempt.retries || 0);
          transientRetryAttempts = Array.isArray(applyAttempt.retry_attempts)
            ? applyAttempt.retry_attempts
            : [];
          processed++;
          if (res.trace) pushTrace(itemTraces, res.trace);

          if (res.ok && !options.dryRun) {
            try {
              postApplyConfirmation =
                res?.recovered_by_post_apply_confirmation === true &&
                res?.transient_confirmation?.ok === true
                  ? res.transient_confirmation
                  : await confirmAppliedPromotionState({
                      mlCreds,
                      promotion_id,
                      promotion_type,
                      item: it,
                      applyResult: res,
                      requested_percent: definedPercent,
                      max_discount_percent: normalizedFilters.maxDesc ?? null,
                    });
            } catch (confirmationError) {
              postApplyConfirmation = {
                ok: false,
                reason:
                  "erro inesperado ao confirmar a aplicacao no ML: " +
                  safeText(confirmationError?.message || String(confirmationError)),
                actual_percent: null,
                snapshot: null,
                attempt: 0,
              };
            }
            realAppliedPercent = postApplyConfirmation.actual_percent ?? null;
          } else if (res.ok) {
            realAppliedPercent = resolveRealAppliedPercentForAudit({
              item: it,
              promotion_type,
              benefitsGlobal,
              price_policy: normalizedPricePolicy,
              result: res,
              fallbackPercent: estimatedAppliedPercent,
            });
          }

          if (res.ok && postApplyConfirmation && !postApplyConfirmation.ok) {
            batchFailureState = { signature: null, consecutive: 0 };
            failed++;
            const review = classifyPostApplyReview(postApplyConfirmation);
            let rollback = null;
            const confirmedOfferId =
              postApplyConfirmation?.confirmed_offer_id ||
              postApplyConfirmation?.accepted_offer_id ||
              postApplyConfirmation?.snapshot?.offer_id ||
              postApplyConfirmation?.snapshot?.ref_id ||
              null;
            // PRE_NEGOTIATED deve ser removida usando o offer_id original do
            // pre-acordo (o mesmo enviado no POST). Depois de ativa, a consulta
            // da campanha pode exibir um OFFER-* diferente.
            const rollbackOfferId =
              promotion_type === 'PRE_NEGOTIATED'
                ? postApplyConfirmation?.requested_offer_id ||
                  res?.trace?.payload?.offer_id ||
                  confirmedOfferId
                : confirmedOfferId;
            if (review.critical) {
              rollback = await rollbackAppliedPromotion({
                mlCreds,
                promotion_id,
                promotion_type,
                item_id: id,
                offer_id: rollbackOfferId,
              });
            }
            const rollbackConfirmed = rollback?.ok === true;
            let criticalOccurrenceForItem = null;
            if (review.critical && !rollbackConfirmed) {
              criticalDivergenceCount += 1;
              criticalOccurrenceForItem = criticalDivergenceCount;
              remediationJobId = await enqueuePromotionRemediation({
                sourceJob: job,
                itemId: id,
                promotionId: promotion_id,
                promotionType: promotion_type,
                offerId: rollbackOfferId,
                requestedPercent: definedPercent,
                actualPercent: realAppliedPercent,
                rollback,
              }).catch((error) => {
                console.error(
                  `[PromoJobsService] Job ${job.id} - Falha ao enfileirar remediacao de ${id}:`,
                  error?.message || error,
                );
                return null;
              });
              quarantineStatus = remediationJobId ? 'queued' : null;
            }
            batchDecision = decidePostApplyContinuation(review, rollback, {
              criticalOccurrence: criticalOccurrenceForItem ?? criticalDivergenceCount,
              remediationQueued: !!remediationJobId,
            });
            const mustPause = batchDecision.action === 'pause';
            const reviewStatus = rollbackConfirmed
              ? 'REVERTIDO_POR_SEGURANCA'
              : remediationJobId
                ? mustPause
                  ? 'QUARENTENA_COM_RISCO_SISTEMICO'
                  : 'QUARENTENA_EM_REMEDIACAO'
              : review.code;
            const safetyMessage = rollbackConfirmed
              ? `Aplicacao divergente revertida com sucesso: ${postApplyConfirmation.reason}. O lote continuara.`
              : remediationJobId && !mustPause
                ? `Item isolado em quarentena para remediacao automatica: ${postApplyConfirmation.reason}. O lote continuara.`
              : mustPause
                ? `Aplicacao interrompida por seguranca: ${postApplyConfirmation.reason}. Foi detectado risco sistemico ou a remediacao nao pode ser enfileirada.`
                : `Item enviado para revisao: ${postApplyConfirmation.reason}. O lote continuara.`;
            itemAudit = {
              status: mustPause ? "error" : "warn",
              message: safetyMessage,
              ml_status: 412,
              ml_body: { post_apply_confirmation: postApplyConfirmation, rollback },
            };
            results.push({
              mlb_id: id,
              status: "review",
              success: false,
              review_status: reviewStatus,
              review_severity: mustPause ? 'critical' : review.severity,
              defined_percent: definedPercent,
              requested_percent: definedPercent,
              estimated_percent: estimatedAppliedPercent,
              applied_percent: realAppliedPercent,
              real_applied_percent: realAppliedPercent,
              post_apply_confirmed: false,
              confirmation_attempts: postApplyConfirmation.attempt,
              ...smartConfirmationAuditFields(postApplyConfirmation, promotion_type),
              transient_retries: transientRetries,
              transient_retry_attempts: transientRetryAttempts,
              safety_circuit_breaker: mustPause,
              batch_decision: batchDecision.action,
              batch_decision_code: batchDecision.code,
              batch_decision_reason: batchDecision.reason,
              quarantine_status: quarantineStatus || '',
              remediation_job_id: remediationJobId ? String(remediationJobId) : '',
              remediation_attempts: 0,
              remediation_last_error: rollback?.error || '',
              rollback_attempted: !!rollback,
              rollback_confirmed: rollbackConfirmed,
              rollback_status: rollback?.status ?? null,
              rollback_error: rollback?.error || null,
              message: safetyMessage,
              error_message: safetyMessage,
            });
            failedItems.push({
              id,
              status: 412,
              error: reviewStatus,
              body: { confirmation: postApplyConfirmation, rollback },
            });
            if (remediationJobId) {
              await auditPromoJobEvent(job, 'promotion_item_quarantined', 'warn', {
                mlb_id: id,
                remediation_job_id: String(remediationJobId),
                critical_occurrence: criticalOccurrenceForItem ?? criticalDivergenceCount,
                requested_percent: definedPercent,
                real_applied_percent: realAppliedPercent,
                rollback_error: rollback?.error || null,
                batch_will_continue: !mustPause,
              });
            }
            if (mustPause) {
              circuitBreakerError = new PromotionSafetyCircuitBreakerError(
                safetyMessage,
                {
                  item_id: id,
                  confirmation: postApplyConfirmation,
                  rollback,
                  remediation_job_id: remediationJobId,
                  critical_occurrence: criticalOccurrenceForItem ?? criticalDivergenceCount,
                  resume_allowed: false,
                },
              );
            }
          } else if (res.ok) {
            batchFailureState = { signature: null, consecutive: 0 };
            // O limiar critico passa a representar divergencias consecutivas/relacionadas,
            // e nao duas ocorrencias isoladas em um job de milhares de itens.
            criticalDivergenceCount = 0;
            success++;
            const appliedSuccessMessage = options.dryRun
              ? "Simulacao validada com sucesso"
              : postApplyConfirmation?.warning
                ? `Aplicado no Mercado Livre; ${postApplyConfirmation.warning}`
                : postApplyConfirmation?.confirmation_deferred
                  ? "Aplicacao aceita pelo ML; confirmacao assincrona pendente"
                  : "Aplicado e confirmado no Mercado Livre";
            itemAudit = {
              status: "success",
              message: appliedSuccessMessage,
              ml_status: res.status ?? 200,
            };
            results.push({
              mlb_id: id,
              status: "success",
              success: true,
              defined_percent: definedPercent,
              requested_percent: definedPercent,
              estimated_percent: estimatedAppliedPercent,
              applied_percent: realAppliedPercent,
              real_applied_percent: realAppliedPercent,
              post_apply_confirmed: isPostApplyFullyConfirmed(postApplyConfirmation),
              post_apply_confirmation_deferred:
                postApplyConfirmation?.confirmation_deferred === true,
              confirmation_attempts: postApplyConfirmation?.attempt ?? null,
              ...smartConfirmationAuditFields(postApplyConfirmation, promotion_type),
              transient_retries: transientRetries,
              transient_retry_attempts: transientRetryAttempts,
              safety_circuit_breaker: false,
              batch_decision: 'continue',
              batch_decision_code: postApplyConfirmation?.confirmation_deferred
                ? 'ITEM_ACCEPTED_CONFIRMATION_PENDING'
                : postApplyConfirmation?.warning
                  ? 'ITEM_CONFIRMED_WITH_WARNING'
                  : 'ITEM_CONFIRMED',
              batch_decision_reason: postApplyConfirmation?.confirmation_deferred
                ? 'Item aceito pelo ML; detalhes continuam em propagacao assincrona.'
                : postApplyConfirmation?.warning
                  ? 'Item confirmado; divergencia de rebate registrada apenas para auditoria.'
                  : 'Item aceito; o lote continua automaticamente.',
              message: appliedSuccessMessage,
              error_message: "",
            });
          } else {
            failed++;
            const friendlyError = friendlyPromotionErrorMessage(res, 'apply_failed');
            const failureDecision = evaluatePromotionBatchFailure(
              { ...res, error: friendlyError },
              batchFailureState,
            );
            batchFailureState = failureDecision.systemic
              ? {
                  signature: failureDecision.signature,
                  consecutive: failureDecision.consecutive,
                }
              : { signature: null, consecutive: 0 };
            batchDecision = {
              action: failureDecision.action,
              code: failureDecision.signature || 'ITEM_FAILURE_CONTINUED',
              reason: failureDecision.reason,
            };
            itemAudit = {
              status: failureDecision.action === 'pause' ? "error" : "warn",
              message: friendlyError,
              ml_status: res.status ?? 400,
              ml_body: res.body ?? null,
            };
            results.push({
              mlb_id: id,
              status: 'error',
              success: false,
              defined_percent: definedPercent,
              requested_percent: definedPercent,
              estimated_percent: estimatedAppliedPercent,
              applied_percent: estimatedAppliedPercent,
              real_applied_percent: realAppliedPercent,
              transient_retries: transientRetries,
              transient_retry_attempts: transientRetryAttempts,
              batch_decision: batchDecision.action,
              batch_decision_code: batchDecision.code,
              batch_decision_reason: batchDecision.reason,
              message: friendlyError,
              error_message: friendlyError,
            });
            failedItems.push({
              id,
              status: res.status ?? 400,
              error: friendlyError,
              body: res.body ?? null
            });
            if (failureDecision.action === 'pause') {
              circuitBreakerError = new PromotionSafetyCircuitBreakerError(
                `${failureDecision.reason} O lote foi pausado para evitar repetir a falha nos demais anuncios.`,
                {
                  item_id: id,
                  failure_signature: failureDecision.signature,
                  consecutive_failures: failureDecision.consecutive,
                  ml_status: res.status ?? null,
                },
              );
            }
          }
        } else if (action === 'remove') {
          const res = await removeItem({
            mlCreds,
            promotion_id,
            promotion_type,
            item: it
          });
          processed++;
          pushTrace(
            itemTraces,
            buildTraceEntry({
              action: 'remove',
              promotion_id,
              promotion_type,
              item_id: id,
              result: res
            })
          );
          if (res.ok) {
            success++;
            itemAudit = {
              status: "success",
              message: "Removido com sucesso",
              ml_status: res.status ?? 200,
            };
            results.push({
              mlb_id: id,
              status: 'success',
              success: true,
              defined_percent: definedPercent,
              requested_percent: definedPercent,
              estimated_percent: null,
              applied_percent: null,
              real_applied_percent: null,
              message: 'Removido com sucesso',
              error_message: '',
            });
          } else {
            failed++;
            const friendlyError = friendlyPromotionErrorMessage(res, 'remove_failed');
            itemAudit = {
              status: "warn",
              message: friendlyError,
              ml_status: res.status ?? 400,
              ml_body: res.body ?? null,
            };
            results.push({
              mlb_id: id,
              status: 'error',
              success: false,
              defined_percent: definedPercent,
              requested_percent: definedPercent,
              estimated_percent: null,
              applied_percent: null,
              real_applied_percent: null,
              message: friendlyError,
              error_message: friendlyError,
            });
            failedItems.push({
              id,
              status: res.status ?? 400,
              error: friendlyError,
              body: res.body ?? null
            });
          }
        } else {
          processed++;
          failed++;
          itemAudit = {
            status: "error",
            message: "invalid_action",
            ml_status: 400,
          };
          results.push({
            mlb_id: id,
            status: 'error',
            success: false,
            defined_percent: definedPercent,
            requested_percent: definedPercent,
            estimated_percent: null,
            applied_percent: null,
            real_applied_percent: null,
            message: 'invalid_action',
            error_message: 'invalid_action',
          });
          failedItems.push({
            id,
            status: 400,
            error: 'invalid_action',
            body: null
          });
        }
      } catch (e) {
        if (e instanceof JobCancelledError || e instanceof PromotionSafetyCircuitBreakerError) {
          throw e;
        }
        console.error(`[PromoJobsService] Job ${job.id} - Erro ao processar item ${id}:`, e.message);
        processed++;
        failed++;
        const failureDecision = evaluatePromotionBatchFailure(
          { error: e?.message || String(e) },
          batchFailureState,
        );
        batchFailureState = failureDecision.systemic
          ? {
              signature: failureDecision.signature,
              consecutive: failureDecision.consecutive,
            }
          : { signature: null, consecutive: 0 };
        batchDecision = {
          action: failureDecision.action,
          code: failureDecision.signature || 'ITEM_EXCEPTION_CONTINUED',
          reason: failureDecision.reason,
        };
        itemAudit = {
          status: "error",
          message: e.message || String(e),
          ml_status: 500,
        };
          results.push({
            mlb_id: id,
            status: 'error',
            success: false,
            defined_percent: definedPercent,
            requested_percent: definedPercent,
            estimated_percent: estimatedAppliedPercent,
            applied_percent: estimatedAppliedPercent,
            real_applied_percent: null,
            batch_decision: batchDecision.action,
            batch_decision_code: batchDecision.code,
            batch_decision_reason: batchDecision.reason,
            message: e.message || String(e),
            error_message: e.message || String(e),
          });
        pushTrace(
          itemTraces,
          buildTraceEntry({
            action,
            promotion_id,
            promotion_type,
            item_id: id,
            result: { ok: false, status: 500, error: e.message || String(e), body: null },
            notes: 'excecao local durante o processamento do item'
          })
        );
        failedItems.push({
          id,
          status: 500,
          error: e.message || String(e),
          body: null
        });
        if (failureDecision.action === 'pause') {
          circuitBreakerError = new PromotionSafetyCircuitBreakerError(
            `${failureDecision.reason} O lote foi pausado para evitar repetir a falha nos demais anuncios.`,
            {
              item_id: id,
              failure_signature: failureDecision.signature,
              consecutive_failures: failureDecision.consecutive,
              error: e?.message || String(e),
            },
          );
        }
      }

      const performance = adaptiveController.onCompleted({
        healthy: itemAudit?.status === "success" && !circuitBreakerError,
        transientRetries,
      });
      const itemDurationMs = Math.max(0, Date.now() - itemStartedAt);

      await auditPromoJobEvent(job, "promotion_item_processed", itemAudit?.status || "info", {
        mlb_id: id,
        item_index: processed,
        total_items: total,
        application_source: applicationSource,
        selection_count: selectionCount,
        prevalidated_selection: prevalidatedSelection,
        success: itemAudit?.status === "success",
        ml_status: itemAudit?.ml_status ?? null,
        defined_percent: definedPercent,
        requested_percent: definedPercent,
        estimated_applied_percent: estimatedAppliedPercent,
        applied_percent: realAppliedPercent,
        real_applied_percent: realAppliedPercent,
        percent_source:
          postApplyConfirmation?.ok && realAppliedPercent != null
            ? "post_apply_ml_snapshot"
            : options.dryRun && realAppliedPercent != null
              ? "dry_run_estimate"
              : estimatedAppliedPercent != null
                ? "estimated_pre_validation_not_applied"
                : null,
        post_apply_confirmed: isPostApplyFullyConfirmed(postApplyConfirmation),
        confirmation_attempts: postApplyConfirmation?.attempt ?? null,
        confirmation_status: postApplyConfirmation?.status ?? null,
        ...smartConfirmationAuditFields(postApplyConfirmation, promotion_type),
        transient_retries:
          typeof transientRetries === "number" ? transientRetries : 0,
        transient_retry_attempts:
          Array.isArray(transientRetryAttempts) ? transientRetryAttempts : [],
        safety_circuit_breaker: !!circuitBreakerError,
        batch_decision: batchDecision.action,
        batch_decision_code: batchDecision.code,
        batch_decision_reason: batchDecision.reason,
        quarantine_status: quarantineStatus,
        remediation_job_id: remediationJobId ? String(remediationJobId) : null,
        item_duration_ms: itemDurationMs,
        item_concurrency: performance.currentConcurrency,
        items_per_minute: performance.itemsPerMinute,
        eta_seconds: performance.etaSeconds,
        message: safeText(itemAudit?.message || ""),
        ml_body: itemAudit?.ml_body || null,
      });

      const denom = (total && total > 0) ? total : Math.max(processed, 1);
      const pct = clampPct((processed / denom) * 100);
      await job.progress(pct);

      const freshJobData = await latestJobData(job);
      const cancelWasRequested = freshJobData?.cancelRequested === true;
      const updateData = {
        ...freshJobData,
        counters: { processed, total, success, failed },
        failedItems,
        itemTraces,
        results,
        stateLabel: cancelWasRequested
          ? `cancelando: ${processed}/${total || '?'}`
          : circuitBreakerError
            ? `pausado por seguranca: ${processed}/${total || '?'}`
            : freshJobData?.transientRetry?.active === true &&
                String(freshJobData?.transientRetry?.itemId || '') !== String(id || '')
              ? freshJobData.stateLabel || 'aguardando retomada automatica'
              : total > 0
                ? `active ${processed}/${total}`
                : `active ${processed}/?`,
        pauseReason: circuitBreakerError?.message || null,
        safetyPaused: !!circuitBreakerError,
        resumable:
          !!circuitBreakerError &&
          circuitBreakerError?.details?.resume_allowed !== false &&
          processed < total,
        transientRetry:
          freshJobData?.transientRetry?.active === true &&
          String(freshJobData?.transientRetry?.itemId || '') !== String(id || '')
            ? freshJobData.transientRetry
            : null,
        performance: {
          ...(freshJobData?.performance || {}),
          ...performance,
          lastItemDurationMs: itemDurationMs,
          updatedAt: Date.now(),
        },
        lastUpdate: Date.now(),
        cancelRequested: cancelWasRequested,
      };

      try {
        await job.update(updateData);
        if (processed % 10 === 0) {
          console.log(`[PromoJobsService] Job ${job.id} - Progresso: ${processed}/${total} (${pct}%)`);
        }
      } catch (e) {
        console.error(`[PromoJobsService] Job ${job.id} - Erro ao atualizar progresso:`, e.message);
      }
      if (circuitBreakerError) throw circuitBreakerError;
      return {
        healthy: itemAudit?.status === "success",
        transientRetries,
        itemDurationMs,
      };
      } finally {
        await releaseAccountSlot().catch(() => {});
      }
    };

    if (Array.isArray(preparedItems) && preparedItems.length > 0) {
      const chunkEnd = Math.min(preparedItems.length, chunkOffset + PROMO_JOB_CHUNK_SIZE);
      const chunkItems =
        preparedItems.length > PROMO_JOB_CHUNK_SIZE &&
        (logicalOperation || canCooperativelyYield(job))
          ? preparedItems.slice(chunkOffset, chunkEnd)
          : preparedItems.slice(chunkOffset);
      console.log(
        `[PromoJobsService] Job ${job.id} - Seleção preparada: fatia ${chunkOffset}-${chunkOffset + chunkItems.length}/${preparedItems.length}; concorrencia adaptativa ate ${itemConcurrencyMax}`,
      );
      await runAdaptiveItems(job, chunkItems, processCandidateItem, adaptiveController);
      if (
        await cooperativelyYieldAfterChunk(
          chunkOffset + chunkItems.length,
          preparedItems.length,
        )
      ) {
        return;
      }
    } else if (groupPrevalidatedManualRows) {
      console.log(`[PromoJobsService] Job ${job.id} - Usando busca direta por MLB em seleção pré-validada (${normalizedFilters.mlbs.length} item(ns))`);
      const processPrevalidatedId = async (rawId) => {
        const id = String(rawId || '').trim().toUpperCase();
        await checkCancelled(job);
        const rows = await fetchPromotionItemsById({
          mlCreds,
          promotion_id,
          promotion_type,
          item_id: id,
        }).catch(() => []);
        const filteredRows = (Array.isArray(rows) ? rows : []).filter((row) => {
          const itemId = String(row?.id || row?.item_id || "").trim().toUpperCase();
          if (itemId !== id) return false;
          if (wantStatus && normalizeStatusForML(row?.status) !== wantStatus) return false;
          return true;
        });
        const item = mergeManualPromotionRows(filteredRows, promotion_type);
        if (processedPrevalidatedIds.has(id)) return { healthy: true, transientRetries: 0 };
        if (!item) {
          processedPrevalidatedIds.add(id);
          processed++;
          failed++;
          results.push({
            mlb_id: id,
            status: 'error',
            success: false,
            defined_percent: resolveDefinedPercentForAudit({
              promotion_type,
              filters: normalizedFilters,
              options,
            }),
            requested_percent: resolveDefinedPercentForAudit({
              promotion_type,
              filters: normalizedFilters,
              options,
            }),
            estimated_percent: null,
            applied_percent: null,
            real_applied_percent: null,
            message: 'Item pré-validado não foi localizado na campanha no momento da aplicação.',
            error_message: 'Item pré-validado não foi localizado na campanha no momento da aplicação.',
          });
          failedItems.push({
            id,
            status: 404,
            error: 'prevalidated_item_not_found',
            body: null,
          });
          const performance = adaptiveController.onCompleted({ healthy: false, transientRetries: 0 });
          const pct = clampPct((processed / Math.max(total || processed, 1)) * 100);
          await job.progress(pct).catch(() => {});
          const latestMissingData = await latestJobData(job);
          const cancelMissingRequested = latestMissingData?.cancelRequested === true;
          await job.update({
            ...latestMissingData,
            counters: { processed, total, success, failed },
            failedItems,
            itemTraces,
            results,
            stateLabel: cancelMissingRequested
              ? `cancelando: ${processed}/${total || '?'}`
              : total > 0
                ? `active ${processed}/${total}`
                : `active ${processed}/?`,
            transientRetry: null,
            performance: {
              ...(latestMissingData?.performance || {}),
              ...performance,
              updatedAt: Date.now(),
            },
            lastUpdate: Date.now(),
            cancelRequested: cancelMissingRequested,
          }).catch(() => {});
          return { healthy: false, transientRetries: 0 };
        }
        processedPrevalidatedIds.add(id);
        return processCandidateItem({
          ...item,
          id,
          item_id: id,
          promotion_id,
          promotion_type,
        });
      };
      const sourceIds = normalizedFilters.mlbs || [];
      const chunkEnd = Math.min(sourceIds.length, chunkOffset + PROMO_JOB_CHUNK_SIZE);
      const chunkIds =
        sourceIds.length > PROMO_JOB_CHUNK_SIZE &&
        (logicalOperation || canCooperativelyYield(job))
          ? sourceIds.slice(chunkOffset, chunkEnd)
          : sourceIds.slice(chunkOffset);
      await runAdaptiveItems(
        job,
        chunkIds,
        processPrevalidatedId,
        adaptiveController,
      );
      if (
        await cooperativelyYieldAfterChunk(
          chunkOffset + chunkIds.length,
          sourceIds.length,
        )
      ) {
        return;
      }
    } else {
      while (true) {
        await checkCancelled(job);
        const page = await fetchPromotionItemsPaged({
          mlCreds,
          promotion_id,
          promotion_type,
          status: wantStatus,
          limit: 50,
          search_after: token
        });

        if (!benefitsGlobal && page.benefits) benefitsGlobal = page.benefits;

        const items = page.results || [];
        if (!items.length && !page.next) break;

        const pageCandidates = [];
        for (const it of items) {
          await checkCancelled(job);
          const id = (it.id || it.item_id || '').toUpperCase();
          if (normalizedFilters.mlb && id !== String(normalizedFilters.mlb).toUpperCase()) continue;
          if (selectedMlbIds.size && !selectedMlbIds.has(id)) continue;
          if (wantStatus && normalizeStatusForML(it?.status) !== wantStatus) continue;

          if (groupPrevalidatedManualRows) {
            const rows = prevalidatedRowsById.get(id) || [];
            rows.push(it);
            prevalidatedRowsById.set(id, rows);
            continue;
          }

          if (prevalidatedSelection) {
            if (processedPrevalidatedIds.has(id)) continue;
            processedPrevalidatedIds.add(id);
          } else {
            if (processedCandidateIds.has(id)) continue;
            if (!isEligible(
              it,
              { mlb: null, mlbs: null, maxDesc: normalizedFilters.maxDesc },
              promotion_type,
              benefitsGlobal,
              normalizedPricePolicy,
            )) continue;
            processedCandidateIds.add(id);
          }
          pageCandidates.push(it);
        }
        await runAdaptiveItems(job, pageCandidates, processCandidateItem, adaptiveController);

        if (!page.next) break;
        token = page.next;
      }

      if (groupPrevalidatedManualRows) {
        for (const id of normalizedFilters.mlbs) {
          await checkCancelled(job);
          const item = mergeManualPromotionRows(
            prevalidatedRowsById.get(id),
            promotion_type,
          );
          if (!item || processedPrevalidatedIds.has(id)) continue;
          processedPrevalidatedIds.add(id);
          await processCandidateItem(item);
        }
      }
    }
  } catch (e) {
    if (e instanceof JobCancelledError) {
      const cancelledSummary = await finishCancelled();
      done(null, cancelledSummary);
      return;
    }
    if (e instanceof PromotionSafetyCircuitBreakerError) {
      const current = job.data || {};
      await job.update({
        ...current,
        counters: { processed, total, success, failed },
        failedItems,
        itemTraces,
        results,
        stateLabel: `pausado por seguranca: ${processed}/${total || '?'}`,
        operationLifecycle: logicalOperation ? 'paused_safety' : current?.operationLifecycle,
        operationTerminal: logicalOperation ? false : current?.operationTerminal,
        activeChunkJobId: logicalOperation ? null : current?.activeChunkJobId,
        queueReason: null,
        pauseReason: e.message,
        safetyPaused: true,
        resumable: e?.details?.resume_allowed !== false && processed < total,
        lastUpdate: Date.now(),
      }).catch(() => {});
    }
    await auditPromoJobEvent(job, "promotion_job_failed", "error", {
      total_items: total,
      processed,
      success,
      failed,
      application_source: applicationSource,
      selection_count: selectionCount,
      prevalidated_selection: prevalidatedSelection,
      safety_circuit_breaker: e instanceof PromotionSafetyCircuitBreakerError,
      safety_details:
        e instanceof PromotionSafetyCircuitBreakerError ? e.details : null,
      error: safeText(e?.message || String(e)),
    });
    done(e);
    return;
  }

  // Evita CSV vazio e melhora diagnóstico quando o job "inicia e para"
  // sem processar nenhum item (ex.: filtros/status divergentes entre pré-contagem e execução).
  if (processed === 0) {
    if (total > 0) {
      failed++;
      results.push({
        mlb_id: '-',
        status: 'error',
        success: false,
        defined_percent: resolveDefinedPercentForAudit({
          promotion_type,
          filters: normalizedFilters,
          options,
        }),
        requested_percent: resolveDefinedPercentForAudit({
          promotion_type,
          filters: normalizedFilters,
          options,
        }),
        estimated_percent: null,
        applied_percent: null,
        real_applied_percent: null,
        message: `Nenhum item foi processado na execução (estimado: ${total}). Revise filtros/status da campanha.`,
        error_message: `Nenhum item foi processado na execução (estimado: ${total}). Revise filtros/status da campanha.`,
      });
      failedItems.push({
        id: null,
        status: 412,
        error: 'no_items_processed',
        body: {
          promotion_id,
          promotion_type,
          estimated_total: total,
          processed,
          strict_offer_type: strictOfferType,
        },
      });
    } else {
      results.push({
        mlb_id: '-',
        status: 'info',
        success: true,
        defined_percent: resolveDefinedPercentForAudit({
          promotion_type,
          filters: normalizedFilters,
          options,
        }),
        requested_percent: resolveDefinedPercentForAudit({
          promotion_type,
          filters: normalizedFilters,
          options,
        }),
        estimated_percent: null,
        applied_percent: null,
        real_applied_percent: null,
        message: strictOfferType
          ? 'Nenhum item elegível retornado para PRE_NEGOTIATED/UNHEALTHY_STOCK com os filtros atuais.'
          : 'Nenhum item elegível retornado com os filtros atuais.',
        error_message: '',
      });
    }
  }

  // 🔧 CORREÇÃO 6: Finalização com dados completos
  const quarantineCounters = results.reduce(
    (acc, row) => {
      const status = String(row?.quarantine_status || '').toLowerCase();
      if (!status) return acc;
      acc.total += 1;
      if (status === 'resolved' || status === 'superseded') acc.resolved += 1;
      else if (status === 'critical_failed') acc.critical += 1;
      else acc.pending += 1;
      return acc;
    },
    { total: 0, pending: 0, resolved: 0, critical: 0 },
  );
  const logicalFinalLifecycle =
    quarantineCounters.pending > 0
      ? 'review_pending'
      : failed > 0
        ? 'partial'
        : 'completed';
  const logicalFinalTerminal = quarantineCounters.pending <= 0;

  const summary = {
    id: job.id,
    title: `${action === 'remove' ? 'Remover' : 'Aplicar'} ${promotion_type} ${promotion_id}`,
    status: logicalOperation ? logicalFinalLifecycle : 'completed',
    terminal: logicalOperation ? logicalFinalTerminal : true,
    total,
    processed,
    success,
    failed,
    failed_items: failedItems,
    item_traces: itemTraces,
    results,
    quarantine: quarantineCounters,
    account:
      accountKey || accountLabel
        ? { key: accountKey || null, label: accountLabel || accountKey || null }
        : null,
    finished_at: new Date().toISOString()
  };

  // grava rótulo final (aproveitado pela listagem)
  const finalData = {
    ...job.data,
    counters: { processed, total, success, failed },
    failedItems,
    itemTraces,
    results,
    quarantineCounters,
    operationTotal: total,
    operationLifecycle: logicalOperation ? logicalFinalLifecycle : job.data?.operationLifecycle,
    operationTerminal: logicalOperation ? logicalFinalTerminal : job.data?.operationTerminal,
    activeChunkJobId: logicalOperation ? null : job.data?.activeChunkJobId,
    queueReason: null,
    stateLabel:
      processed === 0 && total === 0
        ? 'concluído: nenhum item elegível'
        : quarantineCounters.pending > 0
          ? `em revisao: ${success} ok, ${failed} erros, ${quarantineCounters.pending} em remediacao`
          : `concluído: ${success} ok, ${failed} erros`,
    lastUpdate: Date.now()
  };

  try {
    await job.update(finalData);
    await job.progress(100);
    if (logicalOperation) {
      if (logicalFinalTerminal) {
        await settleCredits(finalData?.creditReservation, { release: false }).catch(() => {});
        await releaseCampaignGuard(finalData, String(job.id)).catch(() => {});
      } else {
        await claimCampaignGuard(finalData, String(job.id)).catch(() => {});
      }
    }
    console.log(`[PromoJobsService] Job ${job.id} - Finalizado: ${success} ok, ${failed} erros`);
  } catch (e) {
    console.error(`[PromoJobsService] Job ${job.id} - Erro ao finalizar:`, e.message);
  }

  await auditPromoJobEvent(job, "promotion_job_completed", failed > 0 ? "warn" : "success", {
    total_items: total,
    processed,
    success,
    failed,
    quarantine: quarantineCounters,
    application_source: applicationSource,
    selection_count: selectionCount,
    prevalidated_selection: prevalidatedSelection,
  });

  done(null, summary);
}



/* ------------------------------ API do serviço ---------------------------- */

module.exports = {
  init() {
    return ensureQueue();
  },

  initWorker() {
    const q = ensureQueue();
    if (workerStarted) return q;

    workerStarted = true;
    writeWorkerHeartbeat(q).catch(() => {});
    workerHeartbeatTimer = setInterval(() => {
      writeWorkerHeartbeat(q).catch(() => {});
    }, PROMO_WORKER_HEARTBEAT_MS);
    workerHeartbeatTimer.unref?.();

    workerWatchdogTimer = setInterval(async () => {
      try {
        const active = await q.getJobs(['active'], 0, 100, false).catch(() => []);
        const now = Date.now();
        for (const activeJob of active) {
          const d = activeJob?.data || {};
          const last = Number(d.lastUpdate || activeJob.processedOn || activeJob.timestamp || now);
          if (now - last <= PROMO_ACTIVE_STALE_MS) continue;
          const previous = Number(d.watchdogWarningAt || 0);
          if (previous && now - previous < PROMO_ACTIVE_STALE_MS) continue;
          console.error(
            `[PromoJobsService] watchdog: job ${activeJob.id} sem atualizacao ha ${Math.round((now - last) / 1000)}s`,
          );
          await activeJob.update({
            ...d,
            watchdogWarningAt: now,
            watchdogWarning:
              'Worker manteve o job ativo sem atualizar progresso dentro da janela esperada.',
          }).catch(() => {});
        }
      } catch (error) {
        console.warn('[PromoJobsService] watchdog falhou:', error?.message || error);
      }
    }, Math.max(30000, Math.floor(PROMO_ACTIVE_STALE_MS / 3)));
    workerWatchdogTimer.unref?.();

    // Antes de aceitar novos jobs no worker, limpa duplicatas que ainda nao
    // iniciaram. Jobs ativos nunca sao removidos por esta reconciliacao.
    reconcileQueuedDuplicateCampaignJobs(q)
      .catch((error) => {
        console.warn('[PromoJobsService] reconciliacao inicial falhou:', error?.message || error);
      })
      .finally(() => {
        q.process(CONCURRENCY, runPromoJob);
        console.log(
          `PromoJobsService worker inicializado (Bull) - concurrency=${CONCURRENCY}, max_por_conta=${PROMO_MAX_ACTIVE_JOBS_PER_ACCOUNT}, chunk=${PROMO_JOB_CHUNK_SIZE}`,
        );
      });
    return q;
  },

  stopWorkerHealth() {
    if (workerHeartbeatTimer) clearInterval(workerHeartbeatTimer);
    if (workerWatchdogTimer) clearInterval(workerWatchdogTimer);
    workerHeartbeatTimer = null;
    workerWatchdogTimer = null;
    try {
      promoOrchestrationRedis().del('promo:worker:heartbeat').catch(() => {});
    } catch {}
  },

  async workerHealth() {
    return getWorkerHealth();
  },

  /**
   * Cria job de aplicação/remoção em massa.
   * @param {object} opts
   *  - mlCreds, accountKey
   *  - promotion {id, type}
   *  - filters {status, maxDesc, mlb}
   *  - price_policy 'min' | 'max'
   *  - action 'apply' | 'remove'
   *  - options { dryRun?: boolean, expected_total?: number }
   */
  async enqueueBulkApply(opts) {
    const q = ensureQueue();
    const accountKey = normalizeAccountKey(opts?.accountKey);
    if (!accountKey) {
      throw new Error('Conta obrigatoria para iniciar job de promocao.');
    }
    const action = opts?.action === 'remove' ? 'remove' : 'apply';
    const baseData = {
      ...opts,
      action,
      accountKey,
      accountLabel: opts?.accountLabel || accountKey,
      price_policy: normalizePricePolicy(opts?.price_policy),
      promotion: {
        id: String(opts?.promotion?.id || ''),
        type: String(opts?.promotion?.type || '').toUpperCase(),
      },
      auditContext: opts?.auditContext || null,
      orchestrationVersion: PROMO_ORCHESTRATION_VERSION,
      kind: 'promotion-operation',
      operationId:
        opts?.operationId ||
        opts?.options?.operation_id ||
        `OP-${crypto.randomUUID()}`,
      operationLifecycle: 'queued',
      operationTerminal: false,
      activeChunkJobId: null,
      createdAt: Date.now(),
    };
    baseData.options = {
      ...(baseData.options || {}),
      operation_id: baseData.operationId,
    };
    baseData.operationTotal = inferOperationTotal(baseData);
    baseData.requestFingerprint = buildPromoRequestFingerprint(baseData);
    baseData.campaignGuardKey = campaignGuardKey(baseData);

    // Dupla protecao: primeiro detecta jobs ja existentes (inclusive legados);
    // depois reserva atomicamente a campanha no Redis para fechar a janela de
    // corrida entre dois cliques simultaneos.
    const existing = await findOpenCampaignJob(q, baseData);
    if (existing?.job) {
      return {
        id: String(existing.job.id),
        reused: true,
        reusedReason: existing.reason,
        lifecycle_status:
          existing.state === 'active'
            ? 'processing'
            : existing.state === 'failed'
              ? 'paused_safety'
              : existing.state === 'completed'
                ? 'review_pending'
                : 'queued',
      };
    }

    let reservation = await acquireCampaignCreationReservation(baseData);
    if (!reservation) {
      const owner = await waitForCampaignReservationOwner(q, baseData);
      if (owner?.job) {
        return {
          id: String(owner.job.id),
          reused: true,
          reusedReason: owner.reason || 'campaign_busy',
          lifecycle_status:
            owner.state === 'active'
              ? 'processing'
              : owner.state === 'failed'
                ? 'paused_safety'
                : owner.state === 'completed'
                  ? 'review_pending'
                  : 'queued',
        };
      }
      reservation = await acquireCampaignCreationReservation(baseData);
      if (!reservation) {
        const error = new Error(
          'Ja existe uma operacao sendo criada para esta campanha. Aguarde alguns segundos e tente novamente.',
        );
        error.statusCode = 409;
        error.code = 'PROMO_CAMPAIGN_CREATION_LOCKED';
        throw error;
      }
    }

    const unitCount = Math.max(
      1,
      Number(opts?.options?.expected_total || 0),
      Array.isArray(opts?.filters?.mlbs) ? opts.filters.mlbs.length : 0,
      Array.isArray(opts?.selectionItems) ? opts.selectionItems.length : 0,
    );

    let creditReservation = null;
    let job = null;
    try {
      creditReservation = await reserveCredits({
        mlCreds: opts?.mlCreds || null,
        operationKey: action === 'remove' ? 'promotions.remove' : 'promotions.apply',
        units: unitCount,
        idempotencyKey: `promotions:${baseData.requestFingerprint}`,
      });

      const data = {
        ...baseData,
        creditReservation,
        counters: baseData?.counters || {
          processed: 0,
          total: Number(baseData.operationTotal || 0),
          success: 0,
          failed: 0,
        },
        operationTotal: Number(baseData.operationTotal || 0),
        operationLifecycle: 'queued',
        operationTerminal: false,
        stateLabel: 'na fila: aguardando worker',
        queueReason: 'worker_queue',
      };

      job = await q.add(data, {
        jobId: opts?.queueJobId || undefined,
        // O pai e um registro logico duravel. Ele conclui no Bull apos agendar
        // o primeiro chunk, mas permanece consultavel ate a operacao logica terminar.
        removeOnComplete: false,
        removeOnFail: false,
        attempts: 1,
      });

      await reservation.finalize(job.id);
      await trackLogicalOperation(job, { open: true });
      await job.update({
        ...(job.data || data),
        operationId: data.operationId,
        options: data.options,
        requestFingerprint: data.requestFingerprint,
        campaignGuardKey: data.campaignGuardKey,
        stateLabel: 'na fila: aguardando worker',
        queueReason: 'worker_queue',
        lastUpdate: Date.now(),
      }).catch(() => {});

      console.log(
        `[PromoJobsService] Job ${job.id} criado para ${data.action} ${data.promotion.type} ${data.promotion.id}`,
      );
      return {
        id: String(job.id),
        reused: false,
        reusedReason: null,
        lifecycle_status: 'queued',
      };
    } catch (error) {
      if (creditReservation) {
        await settleCredits(creditReservation, { release: true }).catch(() => {});
      }
      await reservation.release().catch(() => {});
      throw error;
    }
  },

  async enqueueListValidation(opts) {
    const q = ensureQueue();
    const accountKey = normalizeAccountKey(opts?.accountKey);
    if (!accountKey) {
      throw new Error('Conta obrigatoria para iniciar job de validacao de lista.');
    }
    const openJobs = await countOpenListValidationJobsForAccount(q, accountKey);
    if (openJobs >= LIST_VALIDATION_MAX_ACTIVE_PER_ACCOUNT) {
      const err = new Error(
        `Ja existem ${openJobs} validacoes de lista em andamento para esta conta. Aguarde uma delas finalizar antes de iniciar outra.`,
      );
      err.statusCode = 409;
      err.code = 'LIST_VALIDATION_CONCURRENCY_LIMIT';
      throw err;
    }

    const mlbs = normalizeMlbFilterList(opts?.mlbs || opts?.filters?.mlbs || opts?.raw_list || []);
    const creditReservation = await reserveCredits({
      mlCreds: opts?.mlCreds || null,
      operationKey: 'promotions.validate',
      units: Math.max(1, mlbs.length),
    });
    const data = {
      ...opts,
      kind: 'list-validation',
      action: 'validate-list',
      accountKey,
      accountLabel: opts?.accountLabel || accountKey,
      promotion: {
        id: String(opts?.promotion?.id || ''),
        type: String(opts?.promotion?.type || '').toUpperCase(),
        name: String(opts?.promotion?.name || opts?.promotion?.id || ''),
      },
      raw_list: opts?.raw_list || mlbs,
      filters: {
        ...(opts?.filters || {}),
        mlbs,
        percent_max: toNum(opts?.filters?.percent_max ?? opts?.percent_max),
        status: opts?.filters?.status || null,
      },
      auditContext: opts?.auditContext || null,
      creditReservation,
      createdAt: Date.now(),
    };

    let job;
    try {
      job = await q.add(data, {
        removeOnComplete: 10,
        removeOnFail: false,
        attempts: 1,
      });
    } catch (error) {
      await settleCredits(creditReservation, { release: true });
      throw error;
    }

    console.log(`[PromoJobsService] Job ${job.id} criado para validar lista ${data.promotion.type} ${data.promotion.id}`);
    return job?.id;
  },

  // 🔎 Jobs para o painel (lista) - 🔧 CORREÇÃO 8: Melhorar normalização
  async listRecent(n = 25, { accountKey = null } = {}) {
    const q = ensureQueue();
    
    try {
      // Evita chamar getState() individualmente para cada card. Em Redis remoto
      // isso virava dezenas de round-trips e o HAR real mostrou /jobs levando
      // ~20 s. Buscamos cada bucket já com o estado conhecido e depois mesclamos.
      const stateBuckets = await Promise.all(
        ['active', 'waiting', 'delayed', 'failed', 'completed'].map(async (state) => {
          const rows = await q.getJobs([state], 0, Math.max(n - 1, 0), false).catch(() => []);
          return rows.map((job) => ({ job, state }));
        }),
      );
      // Um mesmo Job Bull pode aparecer por alguns milissegundos em dois
      // buckets durante uma transicao (ex.: active + completed). Nunca enviamos
      // duas representacoes do mesmo ID ao navegador. So os IDs conflitados
      // exigem getState(), preservando a latencia baixa do endpoint.
      const trackedLogical = await getTrackedLogicalOperations(q, {
        accountKey,
        limit: Math.max(100, n * 4),
      });
      // Pais logicos podem estar no bucket Bull "completed" enquanto chunks
      // internos continuam executando. O indice Redis garante que eles nao
      // desaparecam do painel quando o bucket completed tiver muitos jobs.
      const rawEntries = [...stateBuckets.flat(), ...trackedLogical];
      const entriesById = new Map();
      for (const entry of rawEntries) {
        const id = String(entry?.job?.id ?? '');
        if (!id) continue;
        if (!entriesById.has(id)) entriesById.set(id, []);
        entriesById.get(id).push(entry);
      }
      const canonicalEntries = [];
      for (const entries of entriesById.values()) {
        if (entries.length === 1) {
          canonicalEntries.push(entries[0]);
          continue;
        }
        const canonicalJob =
          (await q.getJob(entries[0].job.id).catch(() => null)) || entries[0].job;
        const canonicalState = await canonicalJob.getState().catch(() => {
          // Enquanto houver conflito, um estado nao terminal vence um terminal
          // para impedir "concluido" prematuro durante processamento.
          const priority = ['active', 'waiting', 'delayed', 'failed', 'completed'];
          return entries
            .map((entry) => entry.state)
            .sort((a, b) => priority.indexOf(a) - priority.indexOf(b))[0] || 'unknown';
        });
        canonicalEntries.push({ job: canonicalJob, state: canonicalState });
      }

      const workerHealth = await getWorkerHealth();
      const queuedEntries = canonicalEntries
        .filter(({ state, job }) =>
          ['waiting', 'delayed'].includes(state) &&
          canAccessJobData(job?.data || {}, accountKey) &&
          job?.data?.kind !== 'promotion-remediation' &&
          job?.data?.internalJob !== true
        )
        .sort((a, b) => Number(a?.job?.timestamp || 0) - Number(b?.job?.timestamp || 0));
      const queuePositions = new Map(
        queuedEntries.map((entry, index) => [String(entry.job.id), index + 1]),
      );

      // Remediacoes sao detalhes internos do processo pai. Mantemos execucao e
      // auditoria no Bull, mas evitamos cards duplicados no painel principal.
      const scopedJobs = canonicalEntries
        .filter(({ job: j }) => canAccessJobData(j.data || {}, accountKey))
        .filter(({ job: j }) => j.data?.kind !== 'promotion-remediation' && j.data?.internalJob !== true)
        .sort((a, b) => {
          const aJob = a.job;
          const bJob = b.job;
          const aTs = Number(aJob?.data?.lastUpdate || aJob?.finishedOn || aJob?.processedOn || aJob?.timestamp || 0);
          const bTs = Number(bJob?.data?.lastUpdate || bJob?.finishedOn || bJob?.processedOn || bJob?.timestamp || 0);
          return bTs - aTs;
        })
        .slice(0, n);
      const map = await Promise.all(
        scopedJobs.map(async ({ job: j, state: bullState }) => {
          try {
            const d = j.data || {};
            const logicalLifecycle = logicalPromotionLifecycle(d, bullState);
            const state =
              logicalLifecycle === 'processing'
                ? 'active'
                : logicalLifecycle === 'queued' || logicalLifecycle === 'retry_wait'
                  ? 'waiting'
                  : logicalLifecycle === 'paused_safety' || logicalLifecycle === 'failed'
                    ? 'failed'
                    : logicalLifecycle === 'review_pending' ||
                        logicalLifecycle === 'partial' ||
                        logicalLifecycle === 'completed' ||
                        logicalLifecycle === 'canceled'
                      ? 'completed'
                      : bullState;
            const {
              processed,
              total,
              success,
              failed,
              result,
              results,
              failedItems,
            } = resolvePromoJobMetrics(j, state);

            // 🔧 CORREÇÃO 9: Progresso mais confiável
            let progress = 0;
            if (total > 0) {
              progress = clampPct((processed / total) * 100);
            } else {
              const jobProgress = await readBullJobProgress(j, 0);
              progress = clampPct(jobProgress);
            }

            // título padrão
            const isRemediationJob = d?.kind === 'promotion-remediation';
            const title = isRemediationJob
              ? `Corrigindo ${d?.itemId || 'item'} em quarentena`
              : d?.kind === 'list-validation'
              ? `Validando lista ${d?.promotion?.type || ''} ${d?.promotion?.name || d?.promotion?.id || ''}`.trim()
              : d?.promotion?.id
              ? `${d.action === 'remove' ? 'Removendo' : 'Aplicando'} ${d.promotion.type} ${d.promotion.id}`
              : 'Job de promoção';

            // 🔧 CORREÇÃO 10: Label mais consistente
            const account =
              d.accountKey || d.accountLabel
                ? {
                    key: d.accountKey || null,
                    label: d.accountLabel || d.accountKey || null,
                  }
                : null;

            let stateLabel = d.stateLabel || state;
            if (d.stateLabel === 'cancelado') {
              stateLabel = 'cancelado';
            } else if (d.cancelRequested === true) {
              stateLabel = 'cancelando';
            } else if (d.transientRetry?.active === true) {
              stateLabel =
                d.stateLabel ||
                `aguardando retomada automatica: tentativa ${d.transientRetry?.attempt || '?'}`
            } else if (state === 'active') {
              stateLabel = total > 0 ? `active ${processed}/${total}` : `active ${processed}/?`;
            } else if (state === 'completed') {
              stateLabel = d.stateLabel === 'cancelado'
                ? 'cancelado'
                : ['list-validation', 'promotion-remediation'].includes(d?.kind) && d.stateLabel
                  ? d.stateLabel
                  : `concluído: ${success} ok, ${failed} erros`;
            } else if (state === 'waiting' || state === 'delayed') {
              stateLabel = isRemediationJob
                ? d.stateLabel || 'quarentena aguardando'
                : d.stateLabel || 'na fila: aguardando worker';
            } else if (state === 'failed') {
              stateLabel = d.stateLabel === 'cancelado'
                ? 'cancelado'
                : d.safetyPaused === true
                  ? d.stateLabel || 'pausado por seguranca'
                  : 'falhou';
            }

            const remediationPending = Number(d.quarantineCounters?.pending || 0);
            const reviewPending =
              logicalLifecycle === 'review_pending' ||
              (remediationPending > 0 && state === 'completed');
            const completedForReview =
              ((state === 'completed' && !reviewPending) ||
                state === 'failed') &&
              d.stateLabel !== 'cancelado';
            const queuePosition = ['waiting', 'delayed'].includes(state)
              ? queuePositions.get(String(j.id)) || null
              : null;
            const queueWaitSeconds = ['waiting', 'delayed'].includes(state)
              ? Math.max(0, Math.floor((Date.now() - Number(j.timestamp || Date.now())) / 1000))
              : 0;
            const activeStale =
              state === 'active' &&
              Date.now() -
                Number(d.lastUpdate || j.processedOn || j.timestamp || Date.now()) >
                PROMO_ACTIVE_STALE_MS;
            const hasCsvData =
              results.length > 0 ||
              failedItems.length > 0;
            const isListValidationJob = d?.kind === 'list-validation';
            const fullReportUrl = isListValidationJob
              ? `/api/promocoes/jobs/${encodeURIComponent(`promo:${j.id}`)}/download.csv`
              : `/api/promocoes/jobs/${encodeURIComponent(`promo:${j.id}`)}/download.xlsx`;

            return attachJobReview({
              id: j.id,
              title,
              state: stateLabel,
              progress,
              processed,
              total,
              success,
              failed,
              errors: failed,
              completed: completedForReview && d.safetyPaused !== true,
              can_cancel: reviewPending ? false : undefined,
              lifecycle_status:
                d.stateLabel === 'cancelado'
                  ? 'canceled'
                  : d.safetyPaused === true
                    ? 'paused_safety'
                    : d.transientRetry?.active === true
                      ? 'retry_wait'
                      : reviewPending
                        ? 'review_pending'
                        : state === 'active'
                          ? 'processing'
                          : state === 'waiting' || state === 'delayed'
                            ? 'queued'
                            : state === 'failed'
                              ? 'failed'
                              : state === 'completed'
                                ? (failed > 0 ? 'partial' : 'completed')
                                : undefined,
              counters: { processed, total, success, failed },
              created_at: new Date(j.timestamp).toISOString(),
              updated_at: new Date(d.lastUpdate || j.finishedOn || j.processedOn || j.timestamp).toISOString(),
              account,
              label: title, // 🔧 CORREÇÃO 11: Adicionar label para compatibilidade
              safety_paused: d.safetyPaused === true,
              resumable: d.resumable === true,
              pending: Math.max(0, total - processed),
              retry_wait: d.transientRetry?.active === true,
              retry_at: d.transientRetry?.retryAt || null,
              retry_attempt: d.transientRetry?.attempt || null,
              retry_max_attempts: d.transientRetry?.maxAttempts || null,
              retry_reason: d.transientRetry?.reason || null,
              cancel_requested: d.cancelRequested === true,
              operation_id: d.operationId || d.options?.operation_id || null,
              remediation_total: Number(d.quarantineCounters?.total || 0),
              remediation_pending: Number(d.quarantineCounters?.pending || 0),
              remediation_resolved: Number(d.quarantineCounters?.resolved || 0),
              remediation_critical: Number(d.quarantineCounters?.critical || 0),
              queue_position: queuePosition,
              queue_wait_seconds: queueWaitSeconds,
              queue_reason: d.queueReason || null,
              worker_status:
                workerHealth?.online === true
                  ? 'online'
                  : workerHealth?.online === false
                    ? 'offline'
                    : 'unknown',
              worker_last_seen: workerHealth?.last_seen || null,
              worker_instance: workerHealth?.instance || null,
              worker_delayed:
                ['waiting', 'delayed'].includes(state) &&
                workerHealth?.online === false,
              stalled_warning: activeStale,
              failed_reason: state === 'failed' ? j.failedReason || null : null,
              items_per_minute: toNum(d.performance?.itemsPerMinute),
              eta_seconds: toNum(d.performance?.etaSeconds),
              item_concurrency: toNum(d.performance?.currentConcurrency),
              item_concurrency_max: toNum(d.performance?.maxConcurrency) ?? PROMO_ITEM_MAX_CONCURRENCY,
              last_item_duration_ms: toNum(d.performance?.lastItemDurationMs),
              resume_url: d.resumable === true
                ? `/api/promocoes/jobs/promo:${j.id}/resume`
                : null,
              full_report_url: fullReportUrl,
            }, {
              basePath: '/api/promocoes/jobs',
              jobId: `promo:${j.id}`,
              hasCsv: completedForReview || reviewPending || hasCsvData,
              label: isListValidationJob
                ? failed > 0 ? 'Ver e corrigir' : 'Baixar CSV'
                : 'Baixar Excel',
              url: isListValidationJob && failed > 0
                ? `/api/promocoes/jobs/${encodeURIComponent(`promo:${j.id}`)}/reviews.csv`
                : fullReportUrl,
            });
          } catch (e) {
            // Falha momentanea ao serializar um card nao pode transformar um
            // job ativo/aguardando em terminal. O #2427 aparecia como 100%/0
            // itens porque o getter progress() do Bull 4 e sincrono e o codigo
            // anterior tentava chamar .catch() no numero retornado.
            console.error(`[PromoJobsService] Erro ao processar job ${j.id}:`, e.message);
            const d = j.data || {};
            const processed = Number(d?.counters?.processed || 0);
            const total = Number(d?.counters?.total || 0);
            const success = Number(d?.counters?.success || 0);
            const failed = Number(d?.counters?.failed || 0);
            const rawProgress = total > 0
              ? clampPct((processed / total) * 100)
              : clampPct(await readBullJobProgress(j, 0));
            const account =
              d.accountKey || d.accountLabel
                ? {
                    key: d.accountKey || null,
                    label: d.accountLabel || d.accountKey || null,
                  }
                : null;
            const lifecycleStatus =
              d.stateLabel === 'cancelado'
                ? 'canceled'
                : d.safetyPaused === true
                  ? 'paused_safety'
                  : d.transientRetry?.active === true
                    ? 'retry_wait'
                    : state === 'active'
                      ? 'processing'
                      : state === 'waiting' || state === 'delayed'
                        ? 'queued'
                        : state === 'failed'
                          ? 'failed'
                          : state === 'completed'
                            ? (failed > 0 ? 'partial' : 'completed')
                            : 'queued';
            const isTerminal = ['failed', 'partial', 'completed', 'canceled'].includes(lifecycleStatus);
            const fallbackTitle = d?.promotion?.id
              ? `${d.action === 'remove' ? 'Removendo' : 'Aplicando'} ${d.promotion.type} ${d.promotion.id}`
              : 'Job de promocao';
            return {
              id: j.id,
              title: fallbackTitle,
              state: d.stateLabel || state || 'aguardando',
              lifecycle_status: lifecycleStatus,
              progress: rawProgress,
              processed,
              total,
              success,
              failed,
              errors: failed,
              completed: isTerminal,
              counters: { processed, total, success, failed },
              created_at: new Date(j.timestamp).toISOString(),
              updated_at: new Date(d.lastUpdate || j.processedOn || j.timestamp || Date.now()).toISOString(),
              account,
              accountKey: account?.key || null,
              accountLabel: account?.label || null,
              result: null,
              label: fallbackTitle,
              serialization_warning: e?.message || String(e),
            };
          }
        })
      );
      
      const canceled = await listCanceledTombstones(accountKey, n);
      const merged = [...map, ...canceled]
        .sort((a, b) => Date.parse(b.updated_at || b.created_at || 0) - Date.parse(a.updated_at || a.created_at || 0))
        .slice(0, n);
      console.log(`[PromoJobsService] Retornando ${merged.length} jobs`);
      return merged;
    } catch (e) {
      console.error('[PromoJobsService] Erro ao listar jobs:', e.message);
      return [];
    }
  },

  // 🔎 Detalhe do job (para a barra acompanhar certinho) - 🔧 CORREÇÃO 12
  async jobDetail(job_id, { accountKey = null } = {}) {
    const q = ensureQueue();
    
    try {
      const j = await q.getJob(job_id);
      if (!j) {
        const tombstones = await listCanceledTombstones(accountKey, 200);
        return (
          tombstones.find((row) => String(row?.id || '') === String(job_id || '')) ||
          null
        );
      }
      if (!canAccessJobData(j.data || {}, accountKey)) return null;

      const bullState = await j.getState().catch(() => 'unknown');
      const workerHealth = await getWorkerHealth();
      const d = j.data || {};
      const logicalLifecycle = logicalPromotionLifecycle(d, bullState);
      const state =
        logicalLifecycle === 'processing'
          ? 'active'
          : logicalLifecycle === 'queued' || logicalLifecycle === 'retry_wait'
            ? 'waiting'
            : logicalLifecycle === 'paused_safety' || logicalLifecycle === 'failed'
              ? 'failed'
              : logicalLifecycle === 'review_pending' ||
                  logicalLifecycle === 'partial' ||
                  logicalLifecycle === 'completed' ||
                  logicalLifecycle === 'canceled'
                ? 'completed'
                : bullState;
      const {
        processed,
        total,
        success,
        failed,
        result: detailResult,
        results,
        failedItems,
      } = resolvePromoJobMetrics(j, state);

      let progress = 0;
      if (total > 0) {
        progress = clampPct((processed / total) * 100);
      } else {
        const jobProgress = await readBullJobProgress(j, 0);
        progress = clampPct(jobProgress);
      }

      let stateLabel = d.stateLabel || state;
      if (d.stateLabel === 'cancelado') {
        stateLabel = 'cancelado';
      } else if (d.cancelRequested === true) {
        stateLabel = 'cancelando';
      } else if (d.transientRetry?.active === true) {
        stateLabel =
          d.stateLabel ||
          `aguardando retomada automatica: tentativa ${d.transientRetry?.attempt || '?'}`
      } else if (state === 'active') {
        stateLabel = total > 0 ? `active ${processed}/${total}` : `active ${processed}/?`;
      } else if (state === 'completed') {
        stateLabel = d.stateLabel === 'cancelado'
          ? 'cancelado'
          : ['list-validation', 'promotion-remediation'].includes(d?.kind) && d.stateLabel
            ? d.stateLabel
            : `concluído: ${success} ok, ${failed} erros`;
      } else if (state === 'failed') {
        stateLabel = d.stateLabel === 'cancelado'
          ? 'cancelado'
          : d.safetyPaused === true
            ? d.stateLabel || 'pausado por seguranca'
            : 'falhou';
      }
      const remediationPending = Number(d.quarantineCounters?.pending || 0);
      const reviewPending =
        logicalLifecycle === 'review_pending' ||
        (remediationPending > 0 && state === 'completed');
      const completedForReview =
        ((state === 'completed' && !reviewPending) || state === 'failed') &&
        d.stateLabel !== 'cancelado';
      const queueWaitSeconds = ['waiting', 'delayed'].includes(state)
        ? Math.max(0, Math.floor((Date.now() - Number(j.timestamp || Date.now())) / 1000))
        : 0;
      const activeStale =
        state === 'active' &&
        Date.now() -
          Number(d.lastUpdate || j.processedOn || j.timestamp || Date.now()) >
          PROMO_ACTIVE_STALE_MS;
      const hasCsvData =
        results.length > 0 ||
        failedItems.length > 0;
      const isListValidationJob = d?.kind === 'list-validation';
      const fullReportUrl = isListValidationJob
        ? `/api/promocoes/jobs/${encodeURIComponent(`promo:${j.id}`)}/download.csv`
        : `/api/promocoes/jobs/${encodeURIComponent(`promo:${j.id}`)}/download.xlsx`;

      return attachJobReview({
        id: j.id,
        state: stateLabel,
        progress,
        processed,
        total,
        success,
        failed,
        errors: failed,
        completed: completedForReview && d.safetyPaused !== true,
        can_cancel: reviewPending ? false : undefined,
        lifecycle_status:
          d.stateLabel === 'cancelado'
            ? 'canceled'
            : d.safetyPaused === true
              ? 'paused_safety'
              : d.transientRetry?.active === true
                ? 'retry_wait'
                : reviewPending
                  ? 'review_pending'
                  : state === 'active'
                    ? 'processing'
                    : state === 'waiting' || state === 'delayed'
                      ? 'queued'
                      : state === 'failed'
                        ? 'failed'
                        : state === 'completed'
                          ? (failed > 0 ? 'partial' : 'completed')
                          : undefined,
        safety_paused: d.safetyPaused === true,
        resumable: d.resumable === true,
        pending: Math.max(0, total - processed),
        resume_url: d.resumable === true
          ? `/api/promocoes/jobs/promo:${j.id}/resume`
          : null,
        full_report_url: fullReportUrl,
        retry_wait: d.transientRetry?.active === true,
        retry_at: d.transientRetry?.retryAt || null,
        retry_attempt: d.transientRetry?.attempt || null,
        retry_max_attempts: d.transientRetry?.maxAttempts || null,
        retry_reason: d.transientRetry?.reason || null,
        cancel_requested: d.cancelRequested === true,
        operation_id: d.operationId || d.options?.operation_id || null,
        remediation_total: Number(d.quarantineCounters?.total || 0),
        remediation_pending: Number(d.quarantineCounters?.pending || 0),
        remediation_resolved: Number(d.quarantineCounters?.resolved || 0),
        remediation_critical: Number(d.quarantineCounters?.critical || 0),
        queue_wait_seconds: queueWaitSeconds,
        queue_reason: d.queueReason || null,
        worker_status:
          workerHealth?.online === true
            ? 'online'
            : workerHealth?.online === false
              ? 'offline'
              : 'unknown',
        worker_last_seen: workerHealth?.last_seen || null,
        worker_instance: workerHealth?.instance || null,
        worker_delayed:
          ['waiting', 'delayed'].includes(state) && workerHealth?.online === false,
        stalled_warning: activeStale,
        failed_reason: state === 'failed' ? j.failedReason || null : null,
        items_per_minute: toNum(d.performance?.itemsPerMinute),
        eta_seconds: toNum(d.performance?.etaSeconds),
        item_concurrency: toNum(d.performance?.currentConcurrency),
        item_concurrency_max: toNum(d.performance?.maxConcurrency) ?? PROMO_ITEM_MAX_CONCURRENCY,
        last_item_duration_ms: toNum(d.performance?.lastItemDurationMs),
        account:
          d.accountKey || d.accountLabel
            ? {
                key: d.accountKey || null,
                label: d.accountLabel || d.accountKey || null,
              }
            : null,
        data: {
          ...publicPromoJobData(d, { processed, total, success, failed }),
        },
        result: detailResult
      }, {
        basePath: '/api/promocoes/jobs',
        jobId: `promo:${j.id}`,
        hasCsv: completedForReview || reviewPending || hasCsvData,
        label: isListValidationJob
          ? failed > 0 ? 'Ver e corrigir' : 'Baixar CSV'
          : 'Baixar Excel',
        url: isListValidationJob && failed > 0
          ? `/api/promocoes/jobs/${encodeURIComponent(`promo:${j.id}`)}/reviews.csv`
          : fullReportUrl,
      });
    } catch (e) {
      console.error(`[PromoJobsService] Erro ao obter detalhes do job ${job_id}:`, e.message);
      return null;
    }
  },

  // 🔧 CORREÇÃO 13: Método para compatibilidade com rota existente
  async enqueueApplyMass(opts) {
    const result = await this.enqueueBulkApply(opts);
    return result && typeof result === 'object' ? result : { id: result };
  },

  async resumePendingJob(job_id, { accountKey = null } = {}) {
    const q = ensureQueue();
    const sourceJob = await q.getJob(job_id);
    if (!sourceJob || !canAccessJobData(sourceJob.data || {}, accountKey)) return null;

    const sourceState = await sourceJob.getState().catch(() => 'unknown');
    const data = sourceJob.data || {};
    if (data.stateLabel === 'cancelado' || data.cancelRequested === true) {
      return {
        ok: false,
        status: 'cancelado',
        error: 'Job cancelado pelo usuario e nao pode ser retomado.',
      };
    }
    const logicalPaused =
      isLogicalPromotionOperationData(data) &&
      logicalPromotionLifecycle(data, sourceState) === 'paused_safety';
    if (
      (!logicalPaused && sourceState !== 'failed') ||
      data.safetyPaused !== true ||
      data.resumable !== true ||
      data.resumedByJobId
    ) {
      return {
        ok: false,
        status: sourceState,
        error: 'Somente jobs pausados por seguranca podem ser retomados.',
      };
    }

    const sourceIds = normalizeMlbFilterList(
      Array.isArray(data.selectionItems) && data.selectionItems.length
        ? data.selectionItems.map((item) => item?.id || item?.item_id || item)
        : data.filters?.mlbs || [],
    );
    const pendingIds = resolvePendingResumeIds(sourceIds, data.results);
    if (!pendingIds.length) {
      return { ok: false, status: sourceState, error: 'Nao existem itens pendentes para retomar.' };
    }

    const pendingSet = new Set(pendingIds);
    const selectionItems = Array.isArray(data.selectionItems)
      ? data.selectionItems.filter((item) =>
          pendingSet.has(String(item?.id || item?.item_id || item).trim().toUpperCase()),
        )
      : null;
    await releaseCampaignGuard(data, String(sourceJob.id));
    let resumedEnqueue;
    try {
      resumedEnqueue = await this.enqueueBulkApply({
      mlCreds: data.mlCreds,
      accountKey: data.accountKey,
      accountLabel: data.accountLabel,
      action: data.action || 'apply',
      promotion: data.promotion,
      filters: {
        ...(data.filters || {}),
        mlb: null,
        mlbs: pendingIds,
      },
      selectionItems:
        Array.isArray(selectionItems) && selectionItems.length === pendingIds.length
          ? selectionItems
          : null,
      price_policy: data.price_policy,
      options: {
        ...(data.options || {}),
        expected_total: pendingIds.length,
        prevalidated_selection: true,
        resumed_from_job_id: String(job_id),
      },
      auditContext: data.auditContext || null,
      resumedFromJobId: String(job_id),
      queueJobId: `promotion-resume-${job_id}`,
      });
    } catch (error) {
      await claimCampaignGuard(data, String(sourceJob.id));
      throw error;
    }
    const normalizedResume =
      resumedEnqueue && typeof resumedEnqueue === 'object'
        ? resumedEnqueue
        : { id: resumedEnqueue };
    const newJobId = String(normalizedResume.id);

    await sourceJob.update({
      ...data,
      resumable: false,
      resumedByJobId: String(newJobId),
      stateLabel: `retomado no job ${newJobId}`,
      lastUpdate: Date.now(),
    }).catch(() => {});
    await auditPromoJobEvent(sourceJob, 'promotion_job_resumed', 'success', {
      resumed_job_id: String(newJobId),
      pending_items: pendingIds.length,
    });

    return { ok: true, id: newJobId, pending: pendingIds.length };
  },

  async cancelJob(job_id, { accountKey = null, cancelAuditContext = null } = {}) {
    const q = ensureQueue();
    const rootJob = await q.getJob(job_id);
    if (!rootJob) return null;
    if (!canAccessJobData(rootJob.data || {}, accountKey)) return null;

    const visited = new Set();
    const cancelOne = async (j, { isRoot = false } = {}) => {
      if (!j || visited.has(String(j.id))) return { ok: true, status: 'cancelado' };
      visited.add(String(j.id));
      if (!canAccessJobData(j.data || {}, accountKey)) {
        return { ok: false, status: 'forbidden', error: 'Job pertence a outra conta.' };
      }

      const state = await j.getState().catch(() => 'unknown');
      const data = j.data || {};
      const knownProcessed = Number(data?.counters?.processed || 0);
      const knownTotal = Number(
        Number(data?.counters?.total || 0) > 0
          ? data.counters.total
          : Number(data?.options?.expected_total || 0) > 0
            ? data.options.expected_total
            : Array.isArray(data?.selectionItems) && data.selectionItems.length > 0
              ? data.selectionItems.length
              : Array.isArray(data?.filters?.mlbs) && data.filters.mlbs.length > 0
                ? data.filters.mlbs.length
                : data?.filters?.mlb
                  ? 1
                  : 0,
      );
      const knownCounters = {
        ...(data.counters || {}),
        processed: knownProcessed,
        total: knownTotal,
      };

      // Se esta operacao ja gerou uma retomada, cancele primeiro o job descendente.
      if (data.resumedByJobId) {
        const child = await q.getJob(data.resumedByJobId).catch(() => null);
        if (child) {
          const childResult = await cancelOne(child);
          if (!childResult?.ok) return childResult;
        }
      }

      if (data.stateLabel === 'cancelado') {
        return { ok: true, status: 'cancelado', processed: data?.counters?.processed || 0, total: data?.counters?.total || 0 };
      }

      if (isLogicalPromotionOperationData(data) && data?.operationTerminal !== true) {
        const updated = {
          ...data,
          counters: knownCounters,
          operationLifecycle: 'processing',
          operationTerminal: false,
          stateLabel: 'cancelando',
          cancelRequested: true,
          cancelRequestedAt: data.cancelRequestedAt || Date.now(),
          cancelRequestedBy: cancelAuditContext || data.cancelRequestedBy || null,
          resumable: false,
          transientRetry: null,
          lastUpdate: Date.now(),
        };
        await j.update(updated).catch(() => {});

        const activeChunkId = String(data?.activeChunkJobId || '').trim();
        const activeChunk = activeChunkId ? await q.getJob(activeChunkId).catch(() => null) : null;
        const chunkState = activeChunk ? await activeChunk.getState().catch(() => 'unknown') : 'missing';

        if (activeChunk && ['waiting', 'delayed'].includes(chunkState)) {
          await activeChunk.remove().catch(() => {});
          const canceledData = {
            ...updated,
            operationLifecycle: 'canceled',
            operationTerminal: true,
            activeChunkJobId: null,
            stateLabel: 'cancelado',
            queueReason: null,
            cancelRequested: false,
            cancelCompletedAt: Date.now(),
            lastUpdate: Date.now(),
          };
          await j.update(canceledData).catch(() => {});
          await storeCanceledTombstone(j, canceledData).catch(() => {});
          await settleCredits(canceledData?.creditReservation, { release: true }).catch(() => {});
          await releaseCampaignGuard(canceledData, String(j.id)).catch(() => {});
          await auditPromoJobEvent(j, 'promotion_job_canceled', 'warn', {
            current_state: state,
            processed: knownProcessed,
            total: knownTotal,
            canceled_queued_chunk: true,
          });
          return { ok: true, status: 'cancelado', processed: knownProcessed, total: knownTotal };
        }

        await auditPromoJobEvent(j, 'promotion_job_cancel_requested', 'warn', {
          current_state: logicalPromotionLifecycle(updated, state),
          processed: knownProcessed,
          total: knownTotal,
          active_chunk_job_id: activeChunkId || null,
        });
        return {
          ok: true,
          status: 'cancelando',
          processed: knownProcessed,
          total: knownTotal,
        };
      }

      if (state === 'completed') {
        await auditPromoJobEvent(j, "promotion_job_cancel_rejected", "warn", {
          current_state: state,
          reason: 'already_completed',
        });
        return { ok: false, status: state, error: 'Job ja concluido.' };
      }

      // Jobs pausados por seguranca ficam em "failed" no Bull, mas ainda podem ter
      // pendentes e retomada habilitada. Cancelar aqui deve desabilitar qualquer retomada.
      if (state === 'failed') {
        if (data.safetyPaused === true || data.resumable === true || data.resumedByJobId) {
          const updated = {
            ...data,
            stateLabel: 'cancelado',
            cancelRequested: false,
            cancelRequestedAt: data.cancelRequestedAt || Date.now(),
            cancelRequestedBy: cancelAuditContext || data.cancelRequestedBy || null,
            cancelCompletedAt: Date.now(),
            safetyPaused: false,
            resumable: false,
            transientRetry: null,
            pauseReason: data.pauseReason || null,
            lastUpdate: Date.now(),
          };
          await j.update(updated);
          const counters = updated.counters || {};
          const processed = Number(counters.processed || 0);
          const total = Number(counters.total || 0);
          await j.progress(total > 0 ? clampPct((processed / total) * 100) : 0).catch(() => {});
          await auditPromoJobEvent(j, "promotion_job_canceled", "warn", {
            current_state: state,
            processed,
            total,
            pending: Math.max(0, total - processed),
            canceled_from_safety_pause: true,
          });
          await releaseCampaignGuard(updated, String(j.id));
          return { ok: true, status: 'cancelado', processed, total };
        }

        await auditPromoJobEvent(j, "promotion_job_cancel_rejected", "warn", {
          current_state: state,
          reason: 'already_failed_terminal',
        });
        return { ok: false, status: state, error: 'Job ja finalizado com falha.' };
      }

      if (state === 'waiting' || state === 'delayed') {
        await j.update({
          ...data,
          counters: knownCounters,
          stateLabel: 'cancelando',
          cancelRequested: true,
          cancelRequestedAt: data.cancelRequestedAt || Date.now(),
          cancelRequestedBy: cancelAuditContext || data.cancelRequestedBy || null,
          safetyPaused: false,
          resumable: false,
          transientRetry: null,
          lastUpdate: Date.now(),
        }).catch(() => {});
        const immediate = await immediateQueuedCancel(j, {
          reason: 'cancelado pelo usuario antes de iniciar/retomar',
          cancelAuditContext,
        });
        return (
          immediate || {
            ok: true,
            status: 'cancelando',
            processed: Number(knownCounters.processed || 0),
            total: Number(knownCounters.total || 0),
          }
        );
      }

      const updated = {
        ...data,
        counters: knownCounters,
        stateLabel: 'cancelando',
        cancelRequested: true,
        cancelRequestedAt: data.cancelRequestedAt || Date.now(),
        cancelRequestedBy: cancelAuditContext || data.cancelRequestedBy || null,
        resumable: false,
        transientRetry: null,
        lastUpdate: Date.now(),
      };
      await j.update(updated);
      await auditPromoJobEvent(j, "promotion_job_cancel_requested", "warn", {
        current_state: state,
        processed: Number(updated?.counters?.processed || 0),
        total: Number(updated?.counters?.total || 0),
        root_job: isRoot,
      });
      return {
        ok: true,
        status: 'cancelando',
        processed: Number(updated?.counters?.processed || 0),
        total: Number(updated?.counters?.total || 0),
      };
    };

    return cancelOne(rootJob, { isRoot: true });
  },

  async getJobCsv(job_id, { accountKey = null, reviewsOnly = false } = {}) {
    const q = ensureQueue();
    const j = await q.getJob(job_id);
    if (!j) return null;
    if (!canAccessJobData(j.data || {}, accountKey)) return null;

    const rows = Array.isArray(j.data?.results)
      ? j.data.results
      : Array.isArray(j.returnvalue?.results)
        ? j.returnvalue.results
        : [];

    if (String(j.data?.kind || '').toLowerCase() === 'list-validation') {
      const diagnostics = Array.isArray(j.data?.listDiagnostics)
        ? j.data.listDiagnostics
        : Array.isArray(j.returnvalue?.diagnostics)
          ? j.returnvalue.diagnostics
          : rows;
      return {
        filename: `validacao_lista_promocoes_${job_id}.csv`,
        csv: '\ufeff' + buildListValidationCsv(diagnostics),
      };
    }

    const exportRows = reviewsOnly ? rows.filter(isPromotionReviewRow) : rows;
    const csv = buildCsv(
      exportRows.map((row) => [
        row?.mlb_id || '',
        row?.status || (row?.success ? 'success' : 'error'),
        row?.review_status || '',
        row?.review_severity || '',
        promoResultRequestedPercent(row),
        promoResultEstimatedPercent(row),
        promoResultRealAppliedPercent(row),
        row?.post_apply_confirmed == null
          ? ""
          : row.post_apply_confirmed
            ? "sim"
            : "nao",
        row?.safety_circuit_breaker ? "sim" : "nao",
        row?.batch_decision || '',
        row?.batch_decision_code || '',
        row?.batch_decision_reason || '',
        row?.quarantine_status || '',
        row?.remediation_job_id || '',
        row?.remediation_attempts ?? '',
        row?.remediation_last_error || '',
        row?.rollback_attempted ? "sim" : "nao",
        row?.rollback_confirmed ? "sim" : "nao",
        row?.rollback_status ?? '',
        row?.rollback_error || '',
        row?.message || '',
        promoResultErrorMessage(row),
        promotionCsvErrorExplanation(row),
      ]),
      [
        'mlb_id',
        'status',
        'status_revisao',
        'gravidade',
        'percentual_solicitado',
        'percentual_estimado_pre_validacao',
        'percentual_aplicado_real',
        'confirmado_pos_aplicacao',
        'disjuntor_seguranca',
        'decisao_do_lote',
        'codigo_decisao_do_lote',
        'motivo_decisao_do_lote',
        'status_quarentena',
        'job_remediacao',
        'tentativas_remediacao',
        'ultimo_erro_remediacao',
        'rollback_tentado',
        'rollback_confirmado',
        'rollback_http_status',
        'rollback_erro',
        'message',
        'erro_motivo',
        'explicacao',
      ],
    );

    return {
      filename: reviewsOnly
        ? `promocoes_revisoes_${job_id}.csv`
        : `promocoes_completo_${job_id}.csv`,
      csv: '\ufeff' + csv,
    };
  },

  async getJobXlsx(job_id, { accountKey = null } = {}) {
    const q = ensureQueue();
    const j = await q.getJob(job_id);
    if (!j) return null;
    if (!canAccessJobData(j.data || {}, accountKey)) return null;

    const rows = Array.isArray(j.data?.results)
      ? j.data.results
      : Array.isArray(j.returnvalue?.results)
        ? j.returnvalue.results
        : [];
    const state = await j.getState().catch(() => 'unknown');
    const metrics = resolvePromoJobMetrics(j, state);
    const operationId = j.data?.operationId || j.data?.options?.operation_id || null;
    let operationAuditEvents = [];
    if (operationId) {
      try {
        const audit = await listAuthEvents(
          { operation_id: operationId, limit: 50000 },
          { exportAll: true },
        );
        operationAuditEvents = Array.isArray(audit?.events)
          ? audit.events.filter((event) => event?.metadata?.operation_id === operationId)
          : [];
      } catch (error) {
        console.warn('[PromoJobsService] Falha ao carregar auditoria persistente da operacao:', error?.message || error);
      }
    }

    return {
      filename: `promocoes_${job_id}.xlsx`,
      buffer: await buildPromotionResultsWorkbook(rows, {
        jobId: job_id,
        jobData: j.data || {},
        counters: {
          processed: metrics.processed,
          total: metrics.total,
          success: metrics.success,
          failed: metrics.failed,
        },
        itemTraces: Array.isArray(j.data?.itemTraces) ? j.data.itemTraces : [],
        operationAuditEvents,
        stateLabel: j.data?.stateLabel || state,
        createdAt: j.timestamp ? new Date(j.timestamp).toISOString() : '',
        updatedAt: new Date(j.data?.lastUpdate || j.finishedOn || j.processedOn || j.timestamp || Date.now()).toISOString(),
      }),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  },

  _test: {
    computeDealDiscountRange,
    isDealPercentWithinRange,
    isManualPercentApplicable,
    isEligible,
    resolveApplyMethodForItem,
    pickPromotionItemByStatus,
    evaluatePostApplySnapshot,
    evaluateAcceptedApplyResponse,
    confirmSmartOfferResourceIdentity,
    classifyPostApplyReview,
    decidePostApplyContinuation,
    evaluatePromotionBatchFailure,
    buildPromotionResultsWorkbook,
    buildPromotionRollbackUrl,
    isPromotionReviewRow,
    resolvePendingResumeIds,
    readBullJobProgress,
    buildPromoRequestFingerprint,
    campaignGuardIdentity,
    jobHasPendingRemediation,
    isInternalYieldError,
    canCooperativelyYield,
    inferOperationTotal,
    logicalPromotionLifecycle,
    isLogicalPromotionOperationData,
    selectOfferWithinPercentCap,
  },
};

