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
  const secret = process.env.DOCKET_SHARED_SECRET;
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
    const err = new Error(`Navigator snapshot returned ${navRes.status}`);
    err.status = 502;
    throw err;
  }
  return navRes.json();
}
