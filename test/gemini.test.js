'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-gemini-'));
const credPath = path.join(tmp, 'oauth_creds.json');
const agySnapPath = path.join(tmp, 'usage-snapshot.json');
process.env.USAGE_WIDGET_GEMINI_CREDENTIALS = credPath;
process.env.USAGE_WIDGET_ANTIGRAVITY_SNAPSHOT = agySnapPath;
process.env.USAGE_WIDGET_GEMINI_CLIENT_ID = 'test-client-id';
process.env.USAGE_WIDGET_GEMINI_CLIENT_SECRET = 'test-client-secret';

const store = require('../src/store');
store.init(fs.mkdtempSync(path.join(os.tmpdir(), 'uw-gemini-store-')));

const { getGeminiUsage, parseQuotaBuckets, parseAntigravityQuota } = require('../src/gemini');

function writeCreds(expiresInMs) {
  fs.writeFileSync(
    credPath,
    JSON.stringify({
      access_token: 'test-gemini-token',
      refresh_token: 'test-gemini-refresh',
      expiry_date: Date.now() + expiresInMs,
      token_type: 'Bearer',
    })
  );
}

let fetchCalls = 0;
let handler = null;
global.fetch = async (url, opts) => {
  fetchCalls++;
  if (!handler) throw new Error(`unexpected fetch to ${url}`);
  return handler(url, opts);
};

const loadAssistOk = () => ({
  ok: true,
  status: 200,
  json: async () => ({
    cloudaicompanionProject: 'my-gemini-project',
    currentTier: { id: 'standard-tier', name: 'Gemini Code Assist Standard' },
  }),
});

const quotaOk = () => ({
  ok: true,
  status: 200,
  json: async () => ({
    buckets: [
      { modelId: 'gemini-2.5-pro', tokenType: 'REQUESTS', remainingFraction: 0.72, resetTime: '2026-06-13T07:00:00Z' },
      { modelId: 'gemini-3-pro-preview', tokenType: 'REQUESTS', remainingFraction: 0.65, resetTime: '2026-06-13T07:00:00Z' },
      { modelId: 'gemini-2.5-flash', tokenType: 'REQUESTS', remainingFraction: 0.9, resetTime: '2026-06-13T07:00:00Z' },
      { modelId: 'gemini-2.5-flash-lite', tokenType: 'REQUESTS', remainingFraction: 0.99, resetTime: '2026-06-13T07:00:00Z' },
    ],
  }),
});

test('maps loadCodeAssist and retrieveUserQuota buckets into Pro and Flash windows', async () => {
  writeCreds(3600_000);
  handler = async (url) => {
    if (url.includes('loadCodeAssist')) return loadAssistOk();
    if (url.includes('retrieveUserQuota')) return quotaOk();
    throw new Error(`unexpected url: ${url}`);
  };

  const r = await getGeminiUsage(true);
  assert.equal(r.error, undefined);
  assert.equal(r.pro.usedPercent, 35); // tightest Pro bucket: 1 - 0.65
  assert.equal(r.pro.resetsAt, Date.parse('2026-06-13T07:00:00Z'));
  assert.equal(r.flash.usedPercent, 10); // regular flash (excluding flash-lite): 1 - 0.90
  assert.equal(r.plan, 'Gemini Code Assist Standard');
  assert.ok(!r.stale);
});

test('serves the cache inside the poll window without hitting the API', async () => {
  const before = fetchCalls;
  const r = await getGeminiUsage();
  assert.equal(fetchCalls, before);
  assert.equal(r.pro.usedPercent, 35);
});

test('429 backs off and keeps serving the last good data as stale', async () => {
  handler = async () => ({ ok: false, status: 429, headers: { get: () => '120' } });
  const r = await getGeminiUsage(true);
  assert.ok(r.stale);
  assert.match(r.staleReason, /429/);
  assert.equal(r.pro.usedPercent, 35);

  const before = fetchCalls;
  const r2 = await getGeminiUsage();
  assert.equal(fetchCalls, before);
  assert.equal(r2.pro.usedPercent, 35);
});

test('refreshes an expired token and writes it back atomically', async () => {
  writeCreds(-60_000);
  let refreshed = false;
  handler = async (url) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      refreshed = true;
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'fresh-gemini-token', expires_in: 3600 }),
      };
    }
    if (url.includes('retrieveUserQuota')) return quotaOk();
    return loadAssistOk();
  };

  const r = await getGeminiUsage(true);
  assert.ok(refreshed);
  assert.ok(!r.stale);
  assert.equal(r.pro.usedPercent, 35);
  const saved = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  assert.equal(saved.access_token, 'fresh-gemini-token');
});

test('handles proto3 omitted remainingFraction for exhausted buckets', () => {
  const { pro, flash } = parseQuotaBuckets([
    { modelId: 'gemini-2.5-pro', tokenType: 'REQUESTS', resetTime: '2026-06-13T07:00:00Z' },
    { modelId: 'gemini-2.5-flash', tokenType: 'REQUESTS', remainingFraction: 1, resetTime: '2026-06-13T07:00:00Z' },
  ]);
  assert.equal(pro.usedPercent, 100);
  assert.equal(flash.usedPercent, 0);
});

test('parses Antigravity statusLine quota buckets', () => {
  const parsed = parseAntigravityQuota({
    'gemini-5h': { remaining_fraction: 0.8, reset_in_seconds: 3600 },
    'gemini-weekly': { remaining_fraction: 0.9378, reset_time: '2026-07-06T07:50:32Z', reset_in_seconds: 560580 },
  }, 1780000000000);
  assert.equal(parsed.primary.label, '5h');
  assert.equal(parsed.primary.usedPercent, 20);
  assert.equal(parsed.secondary.label, '7d');
  assert.equal(parsed.secondary.usedPercent, 6.2);
  assert.equal(parsed.secondary.resetsAt, Date.parse('2026-07-06T07:50:32Z'));
});

test('agy-quota-hook writes snapshot from stdin and getGeminiUsage reads it', async () => {
  const hookPath = path.join(__dirname, '..', 'scripts', 'agy-quota-hook.js');
  execFileSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      product: 'antigravity',
      plan_tier: 'Pro',
      quota: {
        'gemini-weekly': {
          remaining_fraction: 0.75,
          reset_time: '2026-11-30T08:00:00Z',
          reset_in_seconds: 500000,
        },
      },
    }),
    env: { ...process.env, USAGE_WIDGET_ANTIGRAVITY_SNAPSHOT: agySnapPath },
  });

  const r = await getGeminiUsage();
  assert.equal(r.source, 'antigravity');
  assert.equal(r.plan, 'Pro');
  assert.equal(r.primary, null);
  assert.equal(r.secondary.label, '7d');
  assert.equal(r.secondary.usedPercent, 25);
  assert.equal(r.secondary.resetsAt, Date.parse('2026-11-30T08:00:00Z'));
});
