/**
 * Rate limiter da Tray.
 * Mantem o throughput perto de 180 requisicoes por minuto com espacamento seguro.
 */
export class RateLimiter {
  private requests: number[] = [];
  private maxRequests: number;
  private timeWindow: number;
  private queue: Promise<void> = Promise.resolve();
  private nextAllowedAt = 0;

  constructor(maxRequests: number = 180, timeWindowMinutes: number = 1) {
    this.maxRequests = maxRequests;
    this.timeWindow = timeWindowMinutes * 60 * 1000;
  }

  private cleanOldRequests(): void {
    const now = Date.now();
    const cutoff = now - this.timeWindow;
    this.requests = this.requests.filter((timestamp) => timestamp > cutoff);
  }

  canMakeRequest(): boolean {
    this.cleanOldRequests();
    return this.requests.length < this.maxRequests;
  }

  getRemainingRequests(): number {
    this.cleanOldRequests();
    return Math.max(0, this.maxRequests - this.requests.length);
  }

  getWaitTime(): number {
    this.cleanOldRequests();

    if (this.canMakeRequest()) {
      return 0;
    }

    const oldestRequest = this.requests[0];
    const timeUntilExpire = oldestRequest + this.timeWindow - Date.now();
    return Math.max(0, timeUntilExpire);
  }

  async waitIfNeeded(): Promise<void> {
    const waitTime = this.getWaitTime();

    if (waitTime > 0) {
      const seconds = (waitTime / 1000).toFixed(1);
      console.log(`Rate limit atingido. Aguardando ${seconds}s...`);
      await new Promise((resolve) => setTimeout(resolve, waitTime + 100));
    }
  }

  recordRequest(): void {
    this.cleanOldRequests();
    this.requests.push(Date.now());

    const remaining = this.getRemainingRequests();
    if (remaining < 20) {
      console.log(`Rate limit: ${remaining} requisicoes restantes`);
    }
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      const spacingMs = Math.ceil(this.timeWindow / this.maxRequests);
      const spacingWait = Math.max(0, this.nextAllowedAt - Date.now());

      if (spacingWait > 0) {
        await new Promise((resolve) => setTimeout(resolve, spacingWait));
      }

      await this.waitIfNeeded();
      this.recordRequest();
      this.nextAllowedAt = Date.now() + spacingMs;

      return fn();
    };

    const scheduled = this.queue.then(run, run);
    this.queue = scheduled.then(
      () => undefined,
      () => undefined,
    );

    return scheduled;
  }

  getStats(): {
    requestsInWindow: number;
    remaining: number;
    maxRequests: number;
    utilizationPercent: number;
  } {
    this.cleanOldRequests();
    const requestsInWindow = this.requests.length;
    const remaining = this.getRemainingRequests();
    const utilizationPercent = (requestsInWindow / this.maxRequests) * 100;

    return {
      requestsInWindow,
      remaining,
      maxRequests: this.maxRequests,
      utilizationPercent: Math.round(utilizationPercent * 10) / 10,
    };
  }

  reset(): void {
    this.requests = [];
    this.queue = Promise.resolve();
    this.nextAllowedAt = 0;
    console.log('Rate limiter resetado');
  }
}

export const trayRateLimiter = new RateLimiter(180, 1);
