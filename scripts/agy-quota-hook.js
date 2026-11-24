#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT_PATH =
  process.env.USAGE_WIDGET_ANTIGRAVITY_SNAPSHOT ||
  path.join(os.homedir(), '.gemini', 'antigravity-cli', 'usage-snapshot.json');

function readPreviousPlan() {
  try {
    const prev = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
    return (prev && prev.planTier) || null;
  } catch {
    return null;
  }
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(raw);
    if (data && data.quota && typeof data.quota === 'object') {
      const snap = {
        quota: data.quota,
        planTier: data.plan_tier || readPreviousPlan(),
        version: data.version || null,
        capturedAt: Date.now(),
      };
      fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
      const tmp = OUT_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(snap, null, 2), 'utf8');
      fs.renameSync(tmp, OUT_PATH);
    }
  } catch {
    /* never fail the statusLine hook so agy keeps running it */
  }
});
