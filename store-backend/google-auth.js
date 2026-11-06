// Google service-account access token (Drive + Sheets), cached until shortly before expiry.
// Credentials come from GOOGLE_SERVICE_ACCOUNT_JSON and never reach the browser.
const crypto = require('crypto');

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets'
].join(' ');

let cache = { token: '', expiresAt: 0 };
let pending = null;

function readCredentials() {
  let credentials;
  try {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.');
  }
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('Google service account is not configured.');
  }
  return credentials;
}

function serviceAccountEmail() {
  try { return readCredentials().client_email; } catch { return ''; }
}

async function requestToken() {
  const credentials = readCredentials();
  const now = Math.floor(Date.now() / 1000);
  const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
    iss: credentials.client_email,
    scope: SCOPES,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  })}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  sign.end();
  const assertion = `${unsigned}.${sign.sign(credentials.private_key).toString('base64url')}`;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(`Google token request failed: ${data.error_description || data.error || response.status}`);
  }
  cache = { token: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 };
  return cache.token;
}

async function getGoogleAccessToken() {
  if (cache.token && cache.expiresAt > Date.now() + 60_000) return cache.token;
  if (!pending) pending = requestToken().finally(() => { pending = null; });
  return pending;
}

module.exports = { getGoogleAccessToken, serviceAccountEmail };
