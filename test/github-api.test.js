"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGithubClient } = require('../github-api');
const socket = () => new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
function setup(fetchImpl, extra = {}) {
  const delays = [], warnings = [];
  const client = createGithubClient({ fetchImpl, sleepImpl: async ms => delays.push(ms), random: () => 0, warn: msg => warnings.push(msg), ...extra });
  return { client, delays, warnings };
}
test('socket disconnects recover with bounded exponential backoff and preserve params/headers', async () => {
  let calls = 0;
  const { client, delays, warnings } = setup(async (url, options) => {
    assert.equal(url.searchParams.get('sha'), 'topic/a');
    assert.equal(options.headers.Authorization, 'Bearer fixture');
    assert.ok(options.signal instanceof AbortSignal);
    if (++calls < 4) throw socket();
    return Response.json({ sha: 'ok' });
  }, { headers: { Authorization: 'Bearer fixture' } });
  assert.deepEqual(await client('/repos/a/b/commits', { sha: 'topic/a' }), { sha: 'ok' });
  assert.deepEqual(delays, [1000, 2000, 4000]);
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /UND_ERR_SOCKET/);
});
test('body read disconnects also retry', async () => {
  let calls = 0;
  const { client } = setup(async () => ++calls === 1 ? { ok: true, json: async () => { throw socket(); } } : Response.json([1]));
  assert.deepEqual(await client('/body'), [1]);
});
test('persistent disconnect fails after four attempts with original cause', async () => {
  let calls = 0;
  const { client, delays } = setup(async () => { calls++; throw socket(); });
  await assert.rejects(client('/broken'), error => {
    assert.match(error.message, /\/broken.*4 attempt.*UND_ERR_SOCKET/);
    assert.equal(error.cause.cause.code, 'UND_ERR_SOCKET'); return true;
  });
  assert.equal(calls, 4); assert.equal(delays.length, 3);
});
for (const status of [400, 401, 403, 404, 422]) {
  test(`HTTP ${status} fails immediately and retains diagnostic body`, async () => {
    let calls = 0;
    const { client, delays } = setup(async () => { calls++; return new Response('real permission or parameter error', { status }); });
    await assert.rejects(client('/invalid'), error => error.status === status && !error.retryable && /real permission or parameter error/.test(error.message));
    assert.equal(calls, 1); assert.deepEqual(delays, []);
  });
}
for (const status of [429, 500, 502, 503, 504]) {
  test(`transient HTTP ${status} recovers`, async () => {
    let calls = 0;
    const { client } = setup(async () => ++calls === 1 ? new Response('temporary', { status }) : Response.json({ ok: true }));
    assert.deepEqual(await client('/temporary'), { ok: true });
  });
}
test('secondary limit honors Retry-After', async () => {
  let calls = 0;
  const { client, delays } = setup(async () => ++calls === 1 ? new Response('secondary rate limit', { status: 403, headers: { 'retry-after': '2' } }) : Response.json([]));
  await client('/limited'); assert.deepEqual(delays, [2000]);
});
test('long primary rate limit fails without early retry', async () => {
  let calls = 0;
  const { client, delays } = setup(async () => { calls++; return new Response('API rate limit exceeded', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now()/1000)+3600) } }); });
  await assert.rejects(client('/limited'), error => error.status === 403 && error.retryable);
  assert.equal(calls, 1); assert.deepEqual(delays, []);
});
test('invalid JSON and configuration errors are not retried', async () => {
  let calls = 0;
  const { client } = setup(async () => { calls++; return new Response('{bad'); });
  await assert.rejects(client('/json'), /SyntaxError/); assert.equal(calls, 1);
  for (const concurrency of [0, -1, 1.5, NaN, 6]) assert.throws(() => createGithubClient({ concurrency }), /concurrency/);
});
test('global limiter caps nested pools and holds slot until JSON consumed', async () => {
  let active = 0, peak = 0;
  const { client } = setup(async () => {
    peak = Math.max(peak, ++active);
    return { ok: true, json: async () => { await new Promise(resolve => setTimeout(resolve, 2)); active--; return []; } };
  });
  await Promise.all(Array.from({ length: 5 }, () => Promise.all(Array.from({ length: 3 }, () => client('/nested')))));
  assert.equal(peak, 3); assert.equal(active, 0);
});
test('timed out requests recover', async () => {
  let calls = 0;
  const { client } = setup(async () => { if (++calls === 1) throw new DOMException('timed out', 'TimeoutError'); return Response.json([]); });
  await client('/timeout'); assert.equal(calls, 2);
});
