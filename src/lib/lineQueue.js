// "Waiting in line" for overloaded models (LINE_WAITING=true).
//
// Problem: when Gemini answers 503 (model overloaded), every retry is another
// real request that counts against the free-tier daily quota. Plain retry
// (RETRY_ATTEMPTS) makes it worse — N users x M retries each, all hammering
// an already-overloaded model.
//
// What this does instead — one shared line PER MODEL:
//
//   * Healthy model (no recent 503): requests go straight through. Zero
//     added latency, zero added cost.
//   * A request gets a 503: the model is marked "overloaded". That request
//     does NOT retry on its own and is NOT answered with the 503. It goes to
//     the FRONT of the line and waits.
//   * While overloaded, only ONE request (the head of the line) is allowed
//     to try, once per backoff interval. Everyone else just waits, spending
//     nothing. The "probe" is the user's real request, not a throwaway ping,
//     so a successful probe costs exactly one request total.
//   * Probe 503s again -> goes back to the front, backoff grows (capped).
//   * Probe succeeds (or gets any non-503 answer) -> the model is healthy
//     again and the line is let out gradually (staggered, so ten waiting
//     requests don't all slam the model in the same millisecond and trigger
//     the next 503).
//
// Honest limit: Google gives no "capacity is free now" signal, so the only
// way to find out is to send a request. This can't make waiting free — it
// makes it cost ONE request per backoff interval for the whole line, instead
// of one per user per retry.

export class LineTimeoutError extends Error {
  constructor(waitedMs) {
    super(`Gave up waiting in line after ${Math.round(waitedMs / 1000)}s.`);
    this.name = 'LineTimeoutError';
    this.waitedMs = waitedMs;
  }
}

function abortError() {
  const err = new Error('Aborted while waiting in line.');
  err.name = 'AbortError';
  return err;
}

export function createLineQueue({ baseDelayMs = 10_000, maxDelayMs = 60_000, staggerMs = 1_500 } = {}) {
  const lines = new Map(); // model -> line state

  function getLine(model) {
    let line = lines.get(model);
    if (!line) {
      line = { failures: 0, nextAt: 0, probing: false, queue: [], timer: null };
      lines.set(model, line);
    }
    return line;
  }

  function backoffFor(failures) {
    const raw = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, failures - 1));
    return Math.round(raw * (0.8 + Math.random() * 0.4)); // +/-20% jitter
  }

  // Decides who goes next. Safe to call any time; only ever keeps ONE timer.
  function pump(line) {
    if (line.timer || line.queue.length === 0) return;

    // Recovered: let waiters out one at a time, staggerMs apart.
    if (line.failures === 0) {
      line.timer = setTimeout(() => {
        line.timer = null;
        const waiter = line.queue.shift();
        if (waiter) waiter.grant(false);
        pump(line);
      }, staggerMs);
      return;
    }

    // Still overloaded: one probe at a time, no sooner than nextAt.
    if (line.probing) return;
    const delay = Math.max(0, line.nextAt - Date.now());
    line.timer = setTimeout(() => {
      line.timer = null;
      if (line.failures === 0 || line.probing) return pump(line);
      const waiter = line.queue.shift();
      if (!waiter) return;
      line.probing = true;
      waiter.grant(true);
    }, delay);
  }

  function makeTicket(line, isProbe, waitedMs) {
    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      fn();
      pump(line);
    };
    return {
      isProbe,
      waitedMs,
      // Gemini gave a real answer (anything that isn't an overload status):
      // the model is up. Open the line.
      success() {
        settle(() => {
          if (isProbe) line.probing = false;
          line.failures = 0;
          line.nextAt = 0;
        });
      },
      // Gemini said "overloaded". Call joinLine(..., { front: true }) again
      // afterwards to wait for the next turn.
      overloaded() {
        settle(() => {
          if (isProbe) line.probing = false;
          // Only the probe (or the very first failure) escalates the
          // backoff — otherwise 5 requests that were already in flight when
          // the model went down would each bump it.
          if (isProbe || line.failures === 0) {
            line.failures += 1;
            line.nextAt = Date.now() + backoffFor(line.failures);
          }
        });
      },
      // Neither (client hung up, network error, our own timeout): free the
      // probe slot without changing what we know about the model.
      release() {
        settle(() => {
          if (isProbe) line.probing = false;
        });
      },
    };
  }

  // Resolves with a ticket when it's this request's turn. Rejects with
  // AbortError (signal fired) or LineTimeoutError (deadline passed).
  function joinLine(model, { signal, deadline, front = false } = {}) {
    const line = getLine(model);
    const enqueuedAt = Date.now();

    // Overload verdict gone stale (nobody has tried this model for a long
    // while): forget it and treat the model as healthy again.
    if (line.failures > 0 && !line.probing && line.queue.length === 0 && enqueuedAt > line.nextAt + maxDelayMs * 5) {
      line.failures = 0;
      line.nextAt = 0;
    }

    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());

      // Healthy and nobody waiting: straight through.
      if (!front && line.failures === 0 && line.queue.length === 0) {
        return resolve(makeTicket(line, false, 0));
      }

      let deadlineTimer;
      const onAbort = () => {
        remove();
        reject(abortError());
      };
      const waiter = {
        grant(isProbe) {
          cleanup();
          resolve(makeTicket(line, isProbe, Date.now() - enqueuedAt));
        },
      };
      function cleanup() {
        clearTimeout(deadlineTimer);
        signal?.removeEventListener('abort', onAbort);
      }
      function remove() {
        cleanup();
        const i = line.queue.indexOf(waiter);
        if (i !== -1) line.queue.splice(i, 1);
      }

      signal?.addEventListener('abort', onAbort, { once: true });
      if (deadline) {
        deadlineTimer = setTimeout(() => {
          remove();
          reject(new LineTimeoutError(Date.now() - enqueuedAt));
        }, Math.max(0, deadline - Date.now()));
      }

      if (front) line.queue.unshift(waiter);
      else line.queue.push(waiter);
      pump(line);
    });
  }

  function snapshot(model) {
    const line = lines.get(model);
    return line
      ? { failures: line.failures, waiting: line.queue.length, probing: line.probing, nextInMs: Math.max(0, line.nextAt - Date.now()) }
      : { failures: 0, waiting: 0, probing: false, nextInMs: 0 };
  }

  function reset() {
    for (const line of lines.values()) clearTimeout(line.timer);
    lines.clear();
  }

  return { joinLine, snapshot, reset };
}
