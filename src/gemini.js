'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const store = require('./store');

const AGY_CLI_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli');
const AGY_SETTINGS_PATH = path.join(AGY_CLI_DIR, 'settings.json');
const AGY_SNAPSHOT_PATH =
  process.env.USAGE_WIDGET_ANTIGRAVITY_SNAPSHOT || path.join(AGY_CLI_DIR, 'usage-snapshot.json');
const HOOK_SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'agy-quota-hook.js');

const CRED_PATH =
  process.env.USAGE_WIDGET_GEMINI_CREDENTIALS ||
  path.join(process.env.GEMINI_CLI_HOME || process.env.GEMINI_HOME || os.homedir(), '.gemini', 'oauth_creds.json');

const LOAD_ASSIST_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const POLL_MS = 3 * 60_000;
const ERROR_RETRY_MS = 60_000;

let cached = null;
let cachedProject = null;
let cachedPlan = null;
let lastError = null;
let nextFetchAt = 0;
let nextAgyRefreshAt = 0;
let agyRefreshInFlight = null;
let hookChecked = false;
let hookConflict = false;

const AGY_PTY_SCRIPT = [
  'import os, pty, select, subprocess, sys, time',
  'agy_bin, snap_path = sys.argv[1], sys.argv[2]',
  'def mtime(p):',
  '    try: return os.stat(p).st_mtime_ns',
  '    except OSError: return 0',
  't_before = mtime(snap_path)',
  'master, slave = pty.openpty()',
  'proc = subprocess.Popen([agy_bin], stdin=slave, stdout=slave, stderr=slave, close_fds=True)',
  'os.close(slave)',
  't0 = time.monotonic()',
  'updated_at = None',
  'exited_at = None',
  'while time.monotonic() - t0 < 9.0:',
  '    r, _, _ = select.select([master], [], [], 0.15)',
  '    if r:',
  '        try: os.read(master, 4096)',
  '        except OSError: break',
  '    now = time.monotonic()',
  '    if updated_at is None and mtime(snap_path) > t_before:',
  '        updated_at = now',
  '    if exited_at is None and ((updated_at is not None and now - updated_at >= 0.4) or now - t0 >= 5.0):',
  '        try:',
  '            os.write(master, b"\\x04")',
  '            time.sleep(0.12)',
  '            os.write(master, b"\\x04")',
  '        except OSError: pass',
  '        exited_at = time.monotonic()',
  '    if proc.poll() is not None:',
  '        break',
  '    if exited_at is not None and now - exited_at >= 1.5:',
  '        break',
  'if proc.poll() is None:',
  '    proc.terminate()',
  '    try: proc.wait(timeout=2)',
  '    except Exception: proc.kill()',
  'os.close(master)',
].join('\n');

function findAgyBinary() {
  if (process.platform === 'win32') return null;
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'agy'),
    '/usr/local/bin/agy',
    '/opt/homebrew/bin/agy',
  ];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(dir, 'agy'));
  }
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

function refreshAntigravitySnapshot() {
  if (agyRefreshInFlight) return agyRefreshInFlight;
  if (
    hookConflict ||
    process.env.USAGE_WIDGET_NO_HOOK_SETUP === '1' ||
    process.env.USAGE_WIDGET_ANTIGRAVITY_SNAPSHOT ||
    process.env.USAGE_WIDGET_GEMINI_CREDENTIALS
  ) {
    return Promise.resolve();
  }
  const agyBin = findAgyBinary();
  if (!agyBin) return Promise.resolve();

  nextAgyRefreshAt = Date.now() + POLL_MS;
  agyRefreshInFlight = new Promise((resolve) => {
    execFile(
      'python3',
      ['-c', AGY_PTY_SCRIPT, agyBin, AGY_SNAPSHOT_PATH],
      { timeout: 12_000 },
      () => {
        agyRefreshInFlight = null;
        resolve();
      }
    );
  });
  return agyRefreshInFlight;
}

function buildHookCommand() {
  if (process.platform === 'win32') return `node "${HOOK_SCRIPT_PATH}"`;
  // Inside Electron, ELECTRON_RUN_AS_NODE=1 executes the hook with bundled Node even if node isn't in GUI PATH.
  return `ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${HOOK_SCRIPT_PATH}"`;
}

function ensureAgyStatusLineHook() {
  if (hookChecked) return;
  hookChecked = true;
  if (
    process.env.USAGE_WIDGET_NO_HOOK_SETUP === '1' ||
    process.env.USAGE_WIDGET_ANTIGRAVITY_SNAPSHOT ||
    process.env.USAGE_WIDGET_GEMINI_CREDENTIALS
  ) {
    return;
  }
  if (!fs.existsSync(AGY_CLI_DIR)) return;

  let settings = {};
  if (fs.existsSync(AGY_SETTINGS_PATH)) {
    try {
      settings = JSON.parse(fs.readFileSync(AGY_SETTINGS_PATH, 'utf8'));
    } catch {
      return; // Never overwrite a corrupt or hand-edited non-JSON settings file.
    }
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return;

  if (settings.statusLine && typeof settings.statusLine === 'object') {
    const cmd = String(settings.statusLine.command || '');
    if (cmd.includes('agy-quota-hook.js')) {
      const desired = buildHookCommand();
      if (cmd !== desired || settings.statusLine.stack_with_default !== true) {
        settings.statusLine = { type: 'command', command: desired, stack_with_default: true };
        writeJsonAtomic(AGY_SETTINGS_PATH, settings);
      }
      return;
    }
    if (cmd) {
      hookConflict = true;
      return;
    }
  }

  settings.statusLine = {
    type: 'command',
    command: buildHookCommand(),
    stack_with_default: true,
  };
  writeJsonAtomic(AGY_SETTINGS_PATH, settings);
}

function writeJsonAtomic(filePath, value) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.usage-widget.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, filePath);
  } catch {
    /* non-fatal */
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function parseAntigravityBucket(info, capturedAt) {
  if (!info || typeof info !== 'object' || info.disabled) return null;
  let frac = null;
  if (typeof info.remaining_fraction === 'number') {
    frac = Math.max(0, Math.min(1, info.remaining_fraction));
  } else if (info.reset_time || typeof info.reset_in_seconds === 'number') {
    frac = 0;
  }
  if (frac === null) return null;

  let resetsAt = info.reset_time ? Date.parse(info.reset_time) : null;
  if (!Number.isFinite(resetsAt) && typeof info.reset_in_seconds === 'number') {
    resetsAt = (capturedAt || Date.now()) + info.reset_in_seconds * 1000;
  }
  return {
    usedPercent: Math.round((1 - frac) * 1000) / 10,
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
    resetInSeconds: typeof info.reset_in_seconds === 'number' ? info.reset_in_seconds : null,
  };
}

function shortBucketLabel(id) {
  return id.replace(/^gemini[-_]/i, '').slice(0, 6) || 'Quota';
}

function parseAntigravityQuota(quota, capturedAt) {
  if (!quota || typeof quota !== 'object') return null;
  const all = Object.entries(quota)
    .map(([id, info]) => ({ id, win: parseAntigravityBucket(info, capturedAt) }))
    .filter((e) => e.win !== null);
  if (all.length === 0) return null;

  const geminiEntries = all.filter((e) => /gemini/i.test(e.id));
  const pool = geminiEntries.length > 0 ? geminiEntries : all;

  const fiveHour = pool.find(
    (e) => /5h|five.?hour|session|short/i.test(e.id) || (e.win.resetInSeconds !== null && e.win.resetInSeconds <= 6 * 3600)
  );
  const week = pool.find(
    (e) => e !== fiveHour && (/week|7d/i.test(e.id) || (e.win.resetInSeconds !== null && e.win.resetInSeconds > 6 * 3600))
  );

  if (fiveHour || week) {
    return {
      primary: fiveHour ? { usedPercent: fiveHour.win.usedPercent, resetsAt: fiveHour.win.resetsAt, label: '5h' } : null,
      secondary: week ? { usedPercent: week.win.usedPercent, resetsAt: week.win.resetsAt, label: '7d' } : null,
    };
  }

  const pro = pool.find((e) => /pro/i.test(e.id));
  const flash = pool.find((e) => e !== pro && /flash/i.test(e.id));
  if (pro || flash) {
    return {
      primary: pro ? { usedPercent: pro.win.usedPercent, resetsAt: pro.win.resetsAt, label: 'Pro' } : null,
      secondary: flash ? { usedPercent: flash.win.usedPercent, resetsAt: flash.win.resetsAt, label: 'Flash' } : null,
    };
  }

  return {
    primary: pool[0] ? { usedPercent: pool[0].win.usedPercent, resetsAt: pool[0].win.resetsAt, label: shortBucketLabel(pool[0].id) } : null,
    secondary: pool[1] ? { usedPercent: pool[1].win.usedPercent, resetsAt: pool[1].win.resetsAt, label: shortBucketLabel(pool[1].id) } : null,
  };
}

function readAntigravitySnapshot() {
  const snap = readJson(AGY_SNAPSHOT_PATH);
  if (!snap || !snap.quota) return null;
  const parsed = parseAntigravityQuota(snap.quota, snap.capturedAt);
  if (!parsed || (!parsed.primary && !parsed.secondary)) return null;
  return {
    source: 'antigravity',
    primary: parsed.primary,
    secondary: parsed.secondary,
    pro: parsed.primary,
    flash: parsed.secondary,
    plan: snap.planTier || null,
    capturedAt: typeof snap.capturedAt === 'number' ? snap.capturedAt : null,
    fetchedAt: Date.now(),
  };
}

// ----- Legacy / Enterprise Gemini CLI fallback (~/.gemini/oauth_creds.json) -----

function readCredentials() {
  return readJson(CRED_PATH);
}

function writeCredentials(creds) {
  writeJsonAtomic(CRED_PATH, creds);
}

function getAccessToken(creds) {
  return (creds && (creds.access_token || creds.accessToken)) || null;
}

function getRefreshToken(creds) {
  return (creds && (creds.refresh_token || creds.refreshToken)) || null;
}

function getExpiryMs(creds) {
  if (!creds) return null;
  if (typeof creds.expiry_date === 'number') return creds.expiry_date;
  if (typeof creds.expiresAt === 'number') return creds.expiresAt;
  return null;
}

function tokenIsFresh(creds) {
  const token = getAccessToken(creds);
  if (!token) return false;
  const expiry = getExpiryMs(creds);
  return !expiry || expiry > Date.now() + 60_000;
}

function findInstalledOAuthClient() {
  if (process.env.USAGE_WIDGET_GEMINI_CLIENT_ID && process.env.USAGE_WIDGET_GEMINI_CLIENT_SECRET) {
    return {
      clientId: process.env.USAGE_WIDGET_GEMINI_CLIENT_ID,
      clientSecret: process.env.USAGE_WIDGET_GEMINI_CLIENT_SECRET,
    };
  }

  const candidates = [];
  const bundleDirs = [];
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const bin = path.join(dir, process.platform === 'win32' ? 'gemini.cmd' : 'gemini');
    try {
      const real = fs.realpathSync(bin);
      const root = path.dirname(path.dirname(real));
      candidates.push(
        path.join(root, 'node_modules', '@google', 'gemini-cli-core', 'dist', 'src', 'code_assist', 'oauth2.js'),
        path.join(root, 'lib', 'node_modules', '@google', 'gemini-cli', 'node_modules', '@google', 'gemini-cli-core', 'dist', 'src', 'code_assist', 'oauth2.js')
      );
      bundleDirs.push(
        path.join(root, 'bundle'),
        path.join(root, 'lib', 'node_modules', '@google', 'gemini-cli', 'bundle')
      );
    } catch {
      /* binary not in this PATH entry */
    }
  }

  for (const dir of bundleDirs) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith('chunk-') && name.endsWith('.js')) {
          candidates.push(path.join(dir, name));
        }
      }
    } catch {
      /* ignore missing bundle dir */
    }
  }

  for (const file of candidates) {
    try {
      const src = fs.readFileSync(file, 'utf8');
      const idMatch = src.match(/OAUTH_CLIENT_ID\s*=\s*['"]([^'"]+)['"]/);
      const secMatch = src.match(/OAUTH_CLIENT_SECRET\s*=\s*['"]([^'"]+)['"]/);
      if (idMatch && secMatch) {
        return { clientId: idMatch[1], clientSecret: secMatch[1] };
      }
    } catch {
      /* ignore unreadable candidate */
    }
  }
  return null;
}

async function refreshAccessToken() {
  const creds = readCredentials();
  if (tokenIsFresh(creds)) return creds;
  const refreshToken = getRefreshToken(creds);
  if (!refreshToken) return null;

  const client =
    creds.client_id && creds.client_secret
      ? { clientId: creds.client_id, clientSecret: creds.client_secret }
      : findInstalledOAuthClient();
  if (!client) return null;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) return null;

  const tok = await res.json();
  if (!tok.access_token) return null;

  creds.access_token = tok.access_token;
  if (tok.refresh_token) creds.refresh_token = tok.refresh_token;
  creds.expiry_date = Date.now() + (tok.expires_in || 3600) * 1000;
  if (tok.token_type) creds.token_type = tok.token_type;
  if (tok.scope) creds.scope = tok.scope;
  writeCredentials(creds);
  return creds;
}

function normalizePlan(data) {
  const tier = (data && (data.paidTier || data.currentTier)) || null;
  if (!tier) return null;
  const raw = tier.name || tier.id || null;
  if (!raw || typeof raw !== 'string') return null;
  return raw.replace(/-tier$/i, '').replace(/[_-]+/g, ' ').trim() || null;
}

function extractProject(data) {
  if (!data || !data.cloudaicompanionProject) return null;
  if (typeof data.cloudaicompanionProject === 'string') return data.cloudaicompanionProject;
  if (typeof data.cloudaicompanionProject.id === 'string') return data.cloudaicompanionProject.id;
  return null;
}

async function loadCodeAssist(accessToken) {
  try {
    const res = await fetch(LOAD_ASSIST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        metadata: {
          ideType: 'IDE_UNSPECIFIED',
          platform: 'PLATFORM_UNSPECIFIED',
          pluginType: 'GEMINI',
        },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const projectId = extractProject(data);
    const plan = normalizePlan(data);
    if (projectId) cachedProject = projectId;
    if (plan) cachedPlan = plan;
    return { projectId, plan };
  } catch {
    return null;
  }
}

function bucketFraction(b) {
  if (typeof b.remainingFraction === 'number') {
    return Math.max(0, Math.min(1, b.remainingFraction));
  }
  if (b.remainingAmount === '0' || b.remainingAmount === 0 || b.resetTime) {
    return 0;
  }
  return null;
}

function pickTightestWindow(buckets) {
  let tightest = null;
  for (const b of buckets) {
    const frac = bucketFraction(b);
    if (frac === null) continue;
    const resetsAt = b.resetTime ? Date.parse(b.resetTime) : null;
    if (!tightest || frac < tightest.frac) {
      tightest = {
        frac,
        usedPercent: Math.round((1 - frac) * 1000) / 10,
        resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
      };
    }
  }
  if (!tightest) return null;
  return { usedPercent: tightest.usedPercent, resetsAt: tightest.resetsAt };
}

function parseQuotaBuckets(buckets) {
  if (!Array.isArray(buckets) || buckets.length === 0) return { pro: null, flash: null };

  const reqBuckets = buckets.filter((b) => !b.tokenType || b.tokenType === 'REQUESTS');
  const pool = reqBuckets.length > 0 ? reqBuckets : buckets;

  const proBuckets = pool.filter((b) => typeof b.modelId === 'string' && /pro/i.test(b.modelId));
  const flashRegular = pool.filter(
    (b) => typeof b.modelId === 'string' && /flash/i.test(b.modelId) && !/lite/i.test(b.modelId)
  );
  const flashAll = pool.filter((b) => typeof b.modelId === 'string' && /flash/i.test(b.modelId));

  let pro = pickTightestWindow(proBuckets);
  let flash = pickTightestWindow(flashRegular.length > 0 ? flashRegular : flashAll);

  if (!pro && !flash) {
    pro = pickTightestWindow(pool.slice(0, 1));
    flash = pickTightestWindow(pool.slice(1, 2));
  }

  return {
    pro: pro ? { ...pro, label: 'Pro' } : null,
    flash: flash ? { ...flash, label: 'Flash' } : null,
  };
}

function fail(message, backoffMs) {
  nextFetchAt = Date.now() + backoffMs;
  lastError = message;
  if (cached) return { ...cached, stale: true, staleReason: message };
  return { error: message };
}

async function getGeminiUsage(force = false) {
  ensureAgyStatusLineHook();

  const now = Date.now();
  let agySnap = readAntigravitySnapshot();
  const agyStale = !agySnap || !agySnap.capturedAt || now - agySnap.capturedAt >= POLL_MS;
  if (fs.existsSync(AGY_CLI_DIR) && (force || (agyStale && now >= nextAgyRefreshAt))) {
    await refreshAntigravitySnapshot();
    agySnap = readAntigravitySnapshot();
  }

  if (agySnap) {
    cached = agySnap;
    lastError = null;
    store.set({ geminiUsageCache: cached });
    return agySnap;
  }

  if (cached === null) cached = store.get('geminiUsageCache', null) || undefined;

  if (!force && now < nextFetchAt) {
    if (cached) return cached;
    if (lastError) return { error: lastError };
  }

  let creds = readCredentials();
  if (!creds || !getAccessToken(creds)) {
    if (hookConflict) {
      return fail('Custom agy statusLine is active — pipe it to scripts/agy-quota-hook.js to sync quota', ERROR_RETRY_MS);
    }
    if (fs.existsSync(AGY_CLI_DIR) || process.env.USAGE_WIDGET_ANTIGRAVITY_SNAPSHOT) {
      return fail('No Antigravity quota snapshot yet — run `agy` once to sync', ERROR_RETRY_MS);
    }
    return fail('No Gemini/Antigravity data — run `agy` once to sync quota', ERROR_RETRY_MS);
  }

  if (!tokenIsFresh(creds)) {
    try {
      creds = await refreshAccessToken();
    } catch {
      creds = null;
    }
    if (!creds) return fail('Gemini token expired — re-authenticate your Gemini CLI', ERROR_RETRY_MS);
  }

  const accessToken = getAccessToken(creds);
  if (!cachedProject || !cachedPlan) {
    await loadCodeAssist(accessToken);
  }

  let res;
  try {
    res = await fetch(QUOTA_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(cachedProject ? { project: cachedProject } : {}),
    });
  } catch (err) {
    return fail(`Network error: ${err.message}`, ERROR_RETRY_MS);
  }

  if (res.status === 429) {
    const ra = Number(res.headers && res.headers.get('retry-after'));
    const waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 5 * 60_000;
    return fail(`rate-limited (429), retrying in ~${Math.max(1, Math.ceil(waitMs / 60_000))}m`, waitMs);
  }
  if (res.status === 401) {
    return fail('Gemini token expired — re-authenticate your Gemini CLI', ERROR_RETRY_MS);
  }
  if (!res.ok) return fail(`Gemini API error ${res.status}`, ERROR_RETRY_MS);

  const data = await res.json();
  const { pro, flash } = parseQuotaBuckets(data && data.buckets);
  if (!pro && !flash) {
    return fail('No Gemini quota buckets returned', ERROR_RETRY_MS);
  }

  cached = {
    source: 'gemini-cli',
    primary: pro,
    secondary: flash,
    pro,
    flash,
    plan: cachedPlan,
    fetchedAt: Date.now(),
  };
  lastError = null;
  nextFetchAt = now + POLL_MS;
  store.set({ geminiUsageCache: cached });
  return cached;
}

module.exports = { getGeminiUsage, parseQuotaBuckets, parseAntigravityQuota };
