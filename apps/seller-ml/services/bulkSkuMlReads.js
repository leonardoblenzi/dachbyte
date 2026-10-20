"use strict";

function withRetry(ml, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  return {
    get: async (...args) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try { return await ml.get(...args); }
        catch (error) {
          const status = Number(error?.status || error?.statusCode || 0);
          if (![429, 500, 502, 503, 504].includes(status) || attempt === 2) throw error;
          await sleep(500 * (attempt + 1));
        }
      }
      throw new Error("Falha inesperada na leitura do ML.");
    },
    request: (...args) => ml.request(...args),
  };
}

module.exports = { withRetry };
