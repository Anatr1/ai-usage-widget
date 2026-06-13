'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Codex respects CODEX_HOME, so we do too. Same default on all platforms.
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const SESSIONS_DIR = path.join(CODEX_HOME, 'sessions');
const TAIL_BYTES = 512 * 1024;
const MAX_FILES = 12;

function listSessionFiles(dir) {
  const files = [];

  function walk(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      try {
        files.push({ path: full, mtime: fs.statSync(full).mtimeMs });
      } catch {
        /* file vanished mid-scan */
      }
    }
  }

  walk(dir);
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES);
}

function readTail(file) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const buf = Buffer.alloc(size - start);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  return buf.toString('utf8');
}

function parseWindow(w) {
  if (!w) return null;
  return {
    usedPercent: typeof w.used_percent === 'number' ? w.used_percent : null,
    resetsAt: w.resets_at ? w.resets_at * 1000 : null,
    windowMinutes: w.window_minutes || null,
  };
}

// Find the last rate_limits snapshot in a session file, scanning lines from the end.
function lastSnapshot(file) {
  const lines = readTail(file).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    try {
      const entry = JSON.parse(lines[i]);
      const rl = entry.payload && entry.payload.rate_limits;
      if (!rl) continue;
      return {
        fiveHour: parseWindow(rl.primary),
        week: parseWindow(rl.secondary),
        plan: rl.plan_type || null,
        capturedAt: entry.timestamp ? Date.parse(entry.timestamp) : null,
      };
    } catch {
      /* partial or malformed line (e.g. cut by the tail window) */
    }
  }
  return null;
}

async function getCodexUsage(sessionsDir = SESSIONS_DIR) {
  const files = listSessionFiles(sessionsDir);
  if (files.length === 0) return { error: 'No Codex sessions found in ~/.codex/sessions' };

  // Files are mtime-ordered; pick the snapshot with the newest capture time among
  // the first few that have one (a recently-touched file may lack rate_limits).
  let best = null;
  for (const f of files) {
    const snap = lastSnapshot(f.path);
    if (snap && (!best || (snap.capturedAt || 0) > (best.capturedAt || 0))) best = snap;
    if (best && best.capturedAt && f.mtime < best.capturedAt) break; // older files can't beat it
  }
  if (!best) return { error: 'No Codex usage snapshots found — run Codex once' };
  return { ...best, fetchedAt: Date.now() };
}

module.exports = { getCodexUsage };
