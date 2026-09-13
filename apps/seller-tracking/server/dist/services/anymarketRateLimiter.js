"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.anymarketRateLimiter = exports.AnymarketRateLimiter = void 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const parseHeaderNumber = (value) => {
    if (Array.isArray(value)) {
        return parseHeaderNumber(value[0]);
    }
    const normalized = String(value ?? '').trim();
    if (!normalized)
        return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
};
class AnymarketRateLimiter {
    queue = Promise.resolve();
    nextAllowedAt = 0;
    knownLimit = 30;
    knownRemaining = null;
    resetAt = 0;
    requestsInCurrentWindow = 0;
    windowStartedAt = Date.now();
    lastHeaderAppliedAt = null;
    refreshWindow() {
        const now = Date.now();
        if (this.resetAt > 0 && now >= this.resetAt) {
            this.resetAt = 0;
            this.knownRemaining = this.knownLimit;
            this.requestsInCurrentWindow = 0;
            this.windowStartedAt = now;
            return;
        }
        if (now - this.windowStartedAt >= 60_000) {
            this.windowStartedAt = now;
            this.requestsInCurrentWindow = 0;
            if (this.knownRemaining !== null) {
                this.knownRemaining = this.knownLimit;
            }
        }
    }
    getSpacingMs() {
        return Math.max(150, Math.ceil(60_000 / Math.max(this.knownLimit, 1)));
    }
    async waitForCapacity() {
        this.refreshWindow();
        const spacingWait = Math.max(0, this.nextAllowedAt - Date.now());
        if (spacingWait > 0) {
            await sleep(spacingWait);
        }
        this.refreshWindow();
        if (this.knownRemaining !== null && this.knownRemaining <= 0 && this.resetAt > Date.now()) {
            const waitTime = this.resetAt - Date.now() + 150;
            await sleep(waitTime);
            this.refreshWindow();
        }
    }
    recordRequest() {
        this.refreshWindow();
        this.requestsInCurrentWindow += 1;
        if (this.knownRemaining !== null) {
            this.knownRemaining = Math.max(0, this.knownRemaining - 1);
        }
        this.nextAllowedAt = Date.now() + this.getSpacingMs();
    }
    applyHeaders(headers) {
        if (!headers)
            return;
        const limit = parseHeaderNumber(headers['ratelimit-limit']);
        const remaining = parseHeaderNumber(headers['ratelimit-remaining']);
        const resetSeconds = parseHeaderNumber(headers['ratelimit-reset']);
        if (limit !== null && limit > 0) {
            this.knownLimit = limit;
        }
        if (remaining !== null && remaining >= 0) {
            this.knownRemaining = remaining;
        }
        if (resetSeconds !== null && resetSeconds >= 0) {
            this.resetAt = Date.now() + resetSeconds * 1000;
        }
        this.lastHeaderAppliedAt = Date.now();
    }
    getRetryWaitMs(headers) {
        const retryAfter = parseHeaderNumber(headers?.['retry-after']);
        if (retryAfter !== null && retryAfter >= 0) {
            return retryAfter * 1000 + 150;
        }
        const resetSeconds = parseHeaderNumber(headers?.['ratelimit-reset']);
        if (resetSeconds !== null && resetSeconds >= 0) {
            return resetSeconds * 1000 + 150;
        }
        return Math.max(this.getSpacingMs(), 1_000);
    }
    async execute(fn) {
        const run = async () => {
            for (let attempt = 0; attempt < 2; attempt += 1) {
                await this.waitForCapacity();
                this.recordRequest();
                try {
                    const result = await fn();
                    this.applyHeaders(result.headers || undefined);
                    return result.data;
                }
                catch (error) {
                    const headers = (error?.response?.headers || undefined);
                    this.applyHeaders(headers);
                    if (error?.response?.status === 429 && attempt === 0) {
                        await sleep(this.getRetryWaitMs(headers));
                        continue;
                    }
                    throw error;
                }
            }
            throw new Error('Falha inesperada no rate limiter do ANYMARKET.');
        };
        const scheduled = this.queue.then(run, run);
        this.queue = scheduled.then(() => undefined, () => undefined);
        return scheduled;
    }
    getStats() {
        this.refreshWindow();
        return {
            knownLimit: this.knownLimit,
            knownRemaining: this.knownRemaining !== null
                ? this.knownRemaining
                : Math.max(0, this.knownLimit - this.requestsInCurrentWindow),
            requestsInCurrentWindow: this.requestsInCurrentWindow,
            resetInSeconds: this.resetAt > Date.now()
                ? Math.ceil((this.resetAt - Date.now()) / 1000)
                : 0,
            spacingMs: this.getSpacingMs(),
            lastHeaderAppliedAt: this.lastHeaderAppliedAt,
        };
    }
    reset() {
        this.queue = Promise.resolve();
        this.nextAllowedAt = 0;
        this.knownLimit = 30;
        this.knownRemaining = null;
        this.resetAt = 0;
        this.requestsInCurrentWindow = 0;
        this.windowStartedAt = Date.now();
        this.lastHeaderAppliedAt = null;
    }
}
exports.AnymarketRateLimiter = AnymarketRateLimiter;
exports.anymarketRateLimiter = new AnymarketRateLimiter();
