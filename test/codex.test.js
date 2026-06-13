'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { getCodexUsage } = require('../src/codex');

const RESETS_PRIMARY = 1781307017;
const RESETS_SECONDARY = 1781875140;

function snapshotLine(usedPercent, timestamp) {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: usedPercent, window_minutes: 300, resets_at: RESETS_PRIMARY },
        secondary: { used_percent: 2, window_minutes: 10080, resets_at: RESETS_SECONDARY },
        plan_type: 'plus',
      },
    },
  });
}

function makeSessionsDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-codex-'));
  const day = path.join(dir, '2026', '06', '12');
  fs.mkdirSync(day, { recursive: true });
  return { dir, day };
}

test('finds the newest rate_limits snapshot, skipping malformed lines', async () => {
  const { dir, day } = makeSessionsDir();

  const older = path.join(day, 'rollout-old.jsonl');
  fs.writeFileSync(older, snapshotLine(50, '2026-06-12T10:00:00.000Z') + '\n');

  const newer = path.join(day, 'rollout-new.jsonl');
  fs.writeFileSync(
    newer,
    [
      '{"timestamp":"2026-06-12T17:59:00.000Z","type":"event_msg","payload":{"type":"agent_message"}}',
      snapshotLine(3, '2026-06-12T17:59:30.000Z'),
      snapshotLine(7, '2026-06-12T18:00:00.000Z'),
      '{"rate_limits": this line is corrupt', // must be skipped, not crash
    ].join('\n') + '\n'
  );

  // Make mtime ordering explicit: "older" was written long before "newer".
  const past = new Date('2026-06-12T10:00:01Z');
  fs.utimesSync(older, past, past);

  const r = await getCodexUsage(dir);
  assert.equal(r.error, undefined);
  assert.equal(r.fiveHour.usedPercent, 7); // last snapshot of the newest file wins
  assert.equal(r.fiveHour.windowMinutes, 300);
  assert.equal(r.fiveHour.resetsAt, RESETS_PRIMARY * 1000);
  assert.equal(r.week.usedPercent, 2);
  assert.equal(r.week.windowMinutes, 10080);
  assert.equal(r.plan, 'plus');
  assert.equal(r.capturedAt, Date.parse('2026-06-12T18:00:00.000Z'));
});

test('reports an error when the sessions directory is missing', async () => {
  const r = await getCodexUsage(path.join(os.tmpdir(), 'uw-codex-does-not-exist'));
  assert.ok(r.error);
});

test('reports an error when no file contains a snapshot', async () => {
  const { dir, day } = makeSessionsDir();
  fs.writeFileSync(path.join(day, 'rollout-empty.jsonl'), '{"timestamp":"2026-06-12T10:00:00Z","type":"event_msg","payload":{"type":"agent_message"}}\n');
  const r = await getCodexUsage(dir);
  assert.ok(r.error);
});
