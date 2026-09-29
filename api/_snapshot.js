// Server-side proxy for the OASIS 2026 LINEAR ESCROW TRACKER panel. Fetches
// Navigator's read-only GET /api/admin/snapshot (every ACTIVE / OFF_MARKET
// listing and buyer with phase, day count, days-to-close and next
// milestone, computed by Navigator itself) and hands the JSON back to the
// dashboard. The whole point of routing through here is that the shared
// secret stays on the server -- the browser only ever calls same-origin
// /api/machine-status?job=snapshot and never sees DOCKET_SHARED_SECRET.
//
// Dispatched from api/machine-status.js rather than given its own file to
// stay under Vercel Hobby's 12-function cap (files starting with "_" aren't
// deployed as functions).

const SNAPSHOT_URL = 'https://nav.oasisgroupaz.com/api/admin/snapshot';

export async function loadSnapshot() {
  // Trimmed: a trailing space/newline pasted into Vercel causes a 401.
  const secret = (process.env.DOCKET_SHARED_SECRET || '').trim();
  if (!secret) {
    const err = new Error('Missing required environment variable: DOCKET_SHARED_SECRET.');
    err.status = 500;
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let navRes;
  try {
    navRes = await fetch(SNAPSHOT_URL, {
      headers: { 'x-docket-shared-secret': secret },
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (e) {
    const err = new Error(e.name === 'AbortError' ? 'Navigator did not respond within 10s' : `Could not reach Navigator: ${e.message}`);
    err.status = 502;
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!navRes.ok) {
    // Spell out the likely fix, since this message is shown on the panel.
    const hints = {
      401: 'the DOCKET_SHARED_SECRET values in the two Vercel projects do not match (or one was changed without redeploying)',
      404: 'the snapshot route is not deployed on nav.oasisgroupaz.com yet',
      500: 'DOCKET_SHARED_SECRET is not set in the oasis-navigator Vercel project (Production), or Navigator hit an error',
    };
    const detail = await navRes.text().catch(() => '');
    const err = new Error(
      `Navigator answered ${navRes.status}` +
      (hints[navRes.status] ? ` -- ${hints[navRes.status]}` : '') +
      (detail ? ` (${detail.slice(0, 160)})` : '')
    );
    err.status = 502;
    throw err;
  }
  return navRes.json();
}
