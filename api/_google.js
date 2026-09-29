// Google service-account access for server-side Sheets reads (Command
// contacts lookup today; the Linear Tracker sheet sync later). No SDK: signs
// the OAuth JWT with node's crypto. Configure with the env var
// GOOGLE_SERVICE_ACCOUNT_JSON = the full JSON key file of a Google Cloud
// service account, and share each sheet with that account's client_email.

import { createSign } from 'node:crypto';

let cached = null; // { token, exp, scope }

export function serviceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const sa = JSON.parse(raw);
    if (!sa.client_email || !sa.private_key) return null;
    return sa;
  } catch {
    return null;
  }
}

function b64url(v) {
  return Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
}

export async function googleToken(scope) {
  const sa = serviceAccount();
  if (!sa) {
    const err = new Error('Google service account is not set up yet (GOOGLE_SERVICE_ACCOUNT_JSON).');
    err.status = 503;
    err.code = 'not_configured';
    throw err;
  }
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.scope === scope && cached.exp > now + 60) return cached.token;
  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
    iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
  });
  if (!r.ok) throw Object.assign(new Error(`Google sign-in failed (${r.status})`), { status: 502 });
  const d = await r.json();
  cached = { token: d.access_token, exp: now + (d.expires_in || 3600), scope };
  return cached.token;
}

// All values of one sheet tab, as an array of row arrays.
export async function readSheetValues(spreadsheetId, range) {
  const token = await googleToken('https://www.googleapis.com/auth/spreadsheets.readonly');
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (r.status === 403 || r.status === 404) {
    const sa = serviceAccount();
    throw Object.assign(new Error(`The sheet isn't shared with the service account yet -- share it with ${sa ? sa.client_email : 'the service account'} (Viewer).`), { status: 503, code: 'not_shared' });
  }
  if (!r.ok) throw Object.assign(new Error(`Google Sheets answered ${r.status}`), { status: 502 });
  return (await r.json()).values || [];
}
