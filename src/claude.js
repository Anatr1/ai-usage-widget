'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const store = require('./store');

// Override mainly exists for tests; it also helps non-standard setups.
const CRED_PATH =
  process.env.USAGE_WIDGET_CLAUDE_CREDENTIALS || path.join(os.homedir(), '.claude', '.credentials.json');
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
// Public OAuth client id used by Claude Code itself.
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

// On macOS Claude Code stores credentials in the Keychain, not in a file.
function useKeychain() {
  return process.platform === 'darwin' && !process.env.USAGE_WIDGET_CLAUDE_CREDENTIALS;
}

function readCredentials() {
  if (useKeychain()) {
    try {
      const out = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
        encoding: 'utf8',
      });
      return JSON.parse(out.trim());
    } catch {
      /* fall through to the file — some macOS setups use it too */
    }
  }
  try {
    return JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function keychainAccount() {
  try {
    const meta = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE], { encoding: 'utf8' });
    const m = meta.match(/"acct"<blob>="([^"]*)"/);
    if (m) return m[1];
  } catch {
    /* item missing: fall back to the current user */
  }
  return os.userInfo().username;
}

function writeCredentials(creds) {
  if (useKeychain()) {
    try {
      execFileSync('security', [
        'add-generic-password',
        '-U', // update the existing item in place
        '-a',
        keychainAccount(),
        '-s',
        KEYCHAIN_SERVICE,
        '-w',
        JSON.stringify(creds),
      ]);
    } catch {
      // Keychain write denied: keep the refreshed token in memory only rather than
      // creating a second credential source the rest of the system won't read.
    }
    return;
  }
  // Atomic write so a crash can never leave Claude Code with a corrupt file.
  const tmp = CRED_PATH + '.usage-widget.tmp';
  fs.writeFileSync(tmp, JSON.stringify(creds), 'utf8');
  fs.renameSync(tmp, CRED_PATH);
}

function tokenIsFresh(oauth) {
  return oauth && oauth.accessToken && (!oauth.expiresAt || oauth.expiresAt > Date.now() + 60_000);
}

async function refreshAccessToken() {
  // Re-read first: Claude Code may have refreshed the token since we last looked.
  const creds = readCredentials();
  const oauth = creds && creds.claudeAiOauth;
  if (tokenIsFresh(oauth)) return oauth;
  if (!oauth || !oauth.refreshToken) return null;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: oauth.refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) return null;
  const tok = await res.json();
  if (!tok.access_token) return null;

  oauth.accessToken = tok.access_token;
  if (tok.refresh_token) oauth.refreshToken = tok.refresh_token;
  oauth.expiresAt = Date.now() + (tok.expires_in || 3600) * 1000;
  if (tok.scope) oauth.scopes = tok.scope.split(' ');
  writeCredentials(creds);
  return oauth;
}

function parseWindow(w) {
  if (!w) return null;
  return {
    usedPercent: typeof w.utilization === 'number' ? w.utilization : null,
    resetsAt: w.resets_at ? Date.parse(w.resets_at) : null,
  };
}

const POLL_MS = 3 * 60_000; // minimum gap between live API hits
const ERROR_RETRY_MS = 60_000;

let cached = null; // last successful result
let lastError = null;
let nextFetchAt = 0; // throttle gate; pushed out further by 429 Retry-After

// On failure, back off but keep serving the last good data (marked stale) so the
// widget never blanks out over a transient error.
function fail(message, backoffMs) {
  nextFetchAt = Date.now() + backoffMs;
  lastError = message;
  if (cached) return { ...cached, stale: true, staleReason: message };
  return { error: message };
}

async function getClaudeUsage(force = false) {
  // Survive restarts: seed the cache from disk so a throttled launch still shows data.
  if (cached === null) cached = store.get('claudeUsageCache', null) || undefined;

  const now = Date.now();
  if (!force && now < nextFetchAt) {
    if (cached) return cached;
    if (lastError) return { error: lastError };
  }

  const creds = readCredentials();
  if (!creds || !creds.claudeAiOauth) {
    return fail('Claude Code credentials not found — log in with `claude` first', ERROR_RETRY_MS);
  }

  let oauth = creds.claudeAiOauth;
  if (!tokenIsFresh(oauth)) {
    try {
      oauth = await refreshAccessToken();
    } catch {
      oauth = null;
    }
    if (!oauth) return fail('Claude token expired — open Claude Code once to refresh it', ERROR_RETRY_MS);
  }

  let res;
  try {
    res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${oauth.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });
  } catch (err) {
    return fail(`Network error: ${err.message}`, ERROR_RETRY_MS);
  }
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after'));
    const waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 5 * 60_000;
    return fail(`rate-limited (429), retrying in ~${Math.max(1, Math.ceil(waitMs / 60_000))}m`, waitMs);
  }
  if (!res.ok) return fail(`Anthropic API error ${res.status}`, ERROR_RETRY_MS);

  const data = await res.json();
  const extra = data.extra_usage;
  cached = {
    fiveHour: parseWindow(data.five_hour),
    week: parseWindow(data.seven_day),
    plan: creds.claudeAiOauth.subscriptionType || null,
    extraUsage:
      extra && extra.is_enabled && extra.used_credits > 0
        ? { usedCredits: extra.used_credits, monthlyLimit: extra.monthly_limit, currency: extra.currency }
        : null,
    fetchedAt: Date.now(),
  };
  lastError = null;
  nextFetchAt = now + POLL_MS;
  store.set({ claudeUsageCache: cached });
  return cached;
}

module.exports = { getClaudeUsage };
