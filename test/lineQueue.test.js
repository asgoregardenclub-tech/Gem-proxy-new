import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLineQueue, LineTimeoutError } from '../src/lib/lineQueue.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fast = { baseDelayMs: 40, maxDelayMs: 160, staggerMs: 20 };

test('healthy model: straight through, no wait', async () => {
  const q = createLineQueue(fast);
  const t = await q.joinLine('m');
  assert.equal(t.waitedMs, 0);
  assert.equal(t.isProbe, false);
  t.success();
  q.reset();
});

test('after a 503 only ONE request probes at a time; the rest cost nothing', async () => {
  const q = createLineQueue(fast);
  const first = await q.joinLine('m');
  first.overloaded();

  let sent = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const results = [];
  const run = async (id, front) => {
    const t = await q.joinLine('m', { front });
    sent++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(5);
    inFlight--;
    // model stays overloaded for the first 3 probes, then recovers
    if (sent <= 3) {
      t.overloaded();
      return run(id, true);
    }
    t.success();
    results.push(id);
  };

  await Promise.all([run('a', true), run('b'), run('c'), run('d')]);
  assert.equal(results.length, 4);
  // 3 overloaded probes + 4 real requests = 7 sends, never more than 1 in flight while overloaded
  assert.equal(sent, 7);
  q.reset();
});

test('backoff grows on repeated failures', async () => {
  const q = createLineQueue({ baseDelayMs: 50, maxDelayMs: 1000, staggerMs: 5 });
  const a = await q.joinLine('m'); a.overloaded();
  const s1 = q.snapshot('m').nextInMs;
  const p = await q.joinLine('m', { front: true });
  assert.equal(p.isProbe, true);
  p.overloaded();
  const s2 = q.snapshot('m').nextInMs;
  assert.ok(s2 > s1 * 1.3, `expected growth, got ${s1} -> ${s2}`);
  q.reset();
});

test('concurrent in-flight 503s do not escalate backoff', async () => {
  const q = createLineQueue({ baseDelayMs: 100, maxDelayMs: 10_000, staggerMs: 5 });
  const tickets = await Promise.all([q.joinLine('m'), q.joinLine('m'), q.joinLine('m')]);
  tickets.forEach((t) => t.overloaded());
  assert.equal(q.snapshot('m').failures, 1);
  q.reset();
});

test('client abort removes the request from the line (no ghost request later)', async () => {
  const q = createLineQueue(fast);
  (await q.joinLine('m')).overloaded();
  const ac = new AbortController();
  const waiting = q.joinLine('m', { signal: ac.signal });
  await sleep(5);
  assert.equal(q.snapshot('m').waiting, 1);
  ac.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(q.snapshot('m').waiting, 0);
  q.reset();
});

test('deadline rejects with LineTimeoutError', async () => {
  const q = createLineQueue({ baseDelayMs: 5000, maxDelayMs: 5000, staggerMs: 5 });
  (await q.joinLine('m')).overloaded();
  await assert.rejects(q.joinLine('m', { deadline: Date.now() + 30 }), LineTimeoutError);
  q.reset();
});

test('models have independent lines', async () => {
  const q = createLineQueue({ baseDelayMs: 5000, maxDelayMs: 5000, staggerMs: 5 });
  (await q.joinLine('gemini-3.7-flash')).overloaded();
  const t = await q.joinLine('gemini-3.8-flash');
  assert.equal(t.waitedMs, 0);
  t.success();
  q.reset();
});

test('release() on a failed probe frees the slot', async () => {
  const q = createLineQueue(fast);
  (await q.joinLine('m')).overloaded();
  const probe = await q.joinLine('m', { front: true });
  probe.release(); // e.g. network error
  const next = await q.joinLine('m', { front: true });
  assert.equal(next.isProbe, true);
  next.success();
  q.reset();
});
