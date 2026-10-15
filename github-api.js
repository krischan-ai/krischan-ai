"use strict";

const { setTimeout: sleep } = require("node:timers/promises");

const NETWORK_CODES = new Set([
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE",
  "ETIMEDOUT", "EAI_AGAIN",
]);

function transientNetworkError(error) {
  for (let cause = error; cause; cause = cause.cause) {
    if (NETWORK_CODES.has(cause.code) || cause.name === "TimeoutError") return true;
  }
  return false;
}

// One limiter per client covers nested repository/branch pools and response bodies.
function createGithubClient({ headers, apiUrl = "https://api.github.com",
  concurrency = 3, maxAttempts = 4, timeoutMs = 30000,
  baseDelayMs = 1000, maxDelayMs = 30000, fetchImpl = fetch,
  sleepImpl = sleep, random = Math.random, warn = console.warn } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 5) {
    throw new Error("GitHub API concurrency must be an integer between 1 and 5.");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new Error("GitHub API maxAttempts must be an integer between 1 and 5.");
  }
  let active = 0;
  const queue = [];
  async function limited(worker) {
    await new Promise((resolve) => {
      if (active < concurrency) { active += 1; resolve(); }
      else queue.push(resolve);
    });
    try { return await worker(); }
    finally {
      const next = queue.shift();
      if (next) next();
      else active -= 1;
    }
  }

  return async function github(path, params = {}) {
    const url = new URL(path, apiUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await limited(async () => {
          const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
          if (response.ok) return await response.json();
          const body = await response.text();
          const retryAfter = response.headers.get("retry-after");
          const rateLimited = response.status === 429 || (response.status === 403 &&
            (retryAfter !== null || response.headers.get("x-ratelimit-remaining") === "0" ||
              /(?:secondary )?rate limit|abuse detection/i.test(body)));
          const error = new Error(`GitHub API ${response.status} for ${url.pathname}: ${body.slice(0, 300)}`);
          error.status = response.status;
          error.retryable = rateLimited || [500, 502, 503, 504].includes(response.status);
          let delay = retryAfter === null ? 0 : Number(retryAfter) * 1000;
          if (!Number.isFinite(delay)) delay = Date.parse(retryAfter) - Date.now();
          if (rateLimited && response.headers.get("x-ratelimit-remaining") === "0") {
            delay = Math.max(delay || 0, Number(response.headers.get("x-ratelimit-reset")) * 1000 - Date.now());
          }
          error.retryDelayMs = Math.max(0, delay || 0);
          throw error;
        });
      } catch (error) {
        const retryable = error.retryable || transientNetworkError(error);
        // Do not retry early when GitHub asks us to wait longer than our budget.
        if (!retryable || attempt === maxAttempts || error.retryDelayMs > maxDelayMs) {
          const causeCode = error.cause?.code || error.code || error.name;
          const final = new Error(`GitHub request ${url.pathname} failed after ${attempt} attempt(s): ${error.message} [${causeCode}]`, { cause: error });
          final.status = error.status;
          final.retryable = Boolean(retryable);
          throw final;
        }
        const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1) + Math.floor(random() * baseDelayMs));
        const delay = Math.max(backoff, error.retryDelayMs || 0);
        warn(`Retrying GitHub ${url.pathname} after attempt ${attempt}/${maxAttempts}: ${error.message} [${error.cause?.code || error.code || error.status || error.name}]; waiting ${delay}ms.`);
        await sleepImpl(delay);
      }
    }
  };
}

module.exports = { createGithubClient };
