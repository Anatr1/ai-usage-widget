#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT_PATH =
  process.env.USAGE_WIDGET_ANTIGRAVITY_SNAPSHOT ||
  path.join(os.homedir(), '.gemini', 'antigravity-cli', 'usage-snapshot.json');

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
        planTier: data.plan_tier || null,
        email: data.email || null,
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
