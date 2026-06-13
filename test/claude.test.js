'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the module at a fixture credentials file BEFORE requiring it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-claude-'));
const credPath = path.join(tmp, 'credentials.json');
process.env.USAGE_WIDGET_CLAUDE_CREDENTIALS = credPath;

const store = require('../src/store');
store.init(fs.mkdtempSync(path.join(os.tmpdir(), 'uw-claude-store-')));

const { getClaudeUsage } = require('../src/claude');

function writeCreds(expiresInMs) {
  fs.writeFileSync(
    credPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'test-token',
        refreshToken: 'test-refresh',
        expiresAt: Date.now() + expiresInMs,
        subscriptionType: 'pro',
      },
    })
  );
}

let fetchCalls = 0;
let responses = [];
global.fetch = async () => {
  fetchCalls++;
  if (responses.length === 0) throw new Error('unexpected fetch');
  return responses.shift();
};

const okResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({
    five_hour: { utilization: 17, resets_at: '2026-06-12T23:39:59+00:00' },
    seven_day: { utilization: 19, resets_at: '2026-06-14T06:59:59+00:00' },
    extra_usage: { is_enabled: true, used_credits: 0, monthly_limit: 2300, currency: 'EUR' },
  }),
});

// These tests share module state on purpose: they exercise the cache/backoff
// lifecycle in order, the way the widget actually uses it.

test('maps the usage response', async () => {
  writeCreds(3600_000);
  responses = [okResponse()];
  const r = await getClaudeUsage(true);
  assert.equal(r.error, undefined);
  assert.equal(r.fiveHour.usedPercent, 17);
  assert.equal(r.fiveHour.resetsAt, Date.parse('2026-06-12T23:39:59+00:00'));
  assert.equal(r.week.usedPercent, 19);
  assert.equal(r.plan, 'pro');
  assert.equal(r.extraUsage, null); // zero used credits: hidden
  assert.ok(!r.stale);
});

test('serves the cache inside the poll window without hitting the API', async () => {
  const before = fetchCalls;
  const r = await getClaudeUsage();
  assert.equal(fetchCalls, before);
  assert.equal(r.fiveHour.usedPercent, 17);
});

test('429 backs off and keeps serving the last good data as stale', async () => {
  responses = [{ ok: false, status: 429, headers: { get: () => '120' } }];
  const r = await getClaudeUsage(true); // force a live hit
  assert.ok(r.stale);
  assert.match(r.staleReason, /429/);
  assert.equal(r.fiveHour.usedPercent, 17); // old data still there

  // Subsequent non-forced calls stay on the cache while backed off.
  const before = fetchCalls;
  const r2 = await getClaudeUsage();
  assert.equal(fetchCalls, before);
  assert.equal(r2.fiveHour.usedPercent, 17);
});

test('force bypasses the backoff and recovers', async () => {
  responses = [okResponse()];
  const r = await getClaudeUsage(true);
  assert.ok(!r.stale);
  assert.equal(r.fiveHour.usedPercent, 17);
});
