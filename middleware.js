// Password gate for the whole dashboard -- the page, /data/*.json (client
// names, phones, call notes) and every /api route. Vercel Routing
// Middleware: runs before anything is served.
//
// - Set DASHBOARD_PASSWORD in the docket-dashboard Vercel project. Until it
//   is set, everything stays open exactly as before (so nobody gets locked
//   out by deploying this first).
// - Logging in sets a signed cookie for 90 days; /logout clears it.
// - Server-to-server callers are let through untouched so automations keep
//   working: requests carrying the x-docket-secret / x-docket-shared-secret
//   header (each of those endpoints still checks the secret itself) and
//   Vercel's own cron requests.
//
// "Let the request continue" = a response with x-middleware-next: 1 (what
// @vercel/functions' next() returns), so this needs no npm dependency.

export const config = { matcher: '/:path*' };

const COOKIE = 'docket_auth';
const MAX_AGE = 60 * 60 * 24 * 90;

function next() {
  return new Response(null, { headers: { 'x-middleware-next': '1' } });
}

async function token(password) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('docket-dashboard-v1'));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(request, name) {
  const all = request.headers.get('cookie') || '';
  const hit = all.split(/;\s*/).find((c) => c.startsWith(name + '='));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : '';
}

function loginPage(message) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Oasis Docket Dashboard</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0B0B0C;color:#ECECEC;font-family:Inter,system-ui,sans-serif;}
  form{background:#19191B;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:2rem 1.8rem;width:min(340px,90vw);}
  h1{font-family:Georgia,serif;font-style:italic;color:#C9A15D;font-size:1.5rem;margin:0 0 1.2rem;}
  input{width:100%;box-sizing:border-box;padding:.7rem .8rem;border-radius:4px;border:1px solid rgba(255,255,255,.2);background:#0B0B0C;color:#ECECEC;font-size:1rem;}
  button{margin-top:1rem;width:100%;padding:.7rem;border:none;border-radius:4px;background:#C9A15D;color:#111;font-weight:700;font-size:1rem;cursor:pointer;}
  p{color:#CC5C42;font-size:.85rem;margin:.8rem 0 0;}
</style></head><body>
<form method="POST" action="/login">
  <h1>Oasis Docket Dashboard</h1>
  <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password" required>
  <button type="submit">Open dashboard</button>
  ${message ? `<p>${message}</p>` : ''}
</form></body></html>`;
  return new Response(html, { status: 401, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

export default async function middleware(request) {
  const password = (process.env.DASHBOARD_PASSWORD || '').trim();
  if (!password) return next();

  const url = new URL(request.url);
  const expected = await token(password);

  if (url.pathname === '/login') {
    if (request.method === 'POST') {
      const form = await request.formData().catch(() => null);
      const given = form ? String(form.get('password') || '').trim() : '';
      if (given && sameString(await token(given), expected)) {
        return new Response(null, {
          status: 303,
          headers: {
            location: '/',
            'set-cookie': `${COOKIE}=${expected}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
            'cache-control': 'no-store',
          },
        });
      }
      await new Promise((r) => setTimeout(r, 800)); // slow down guessing
      return loginPage('That password didn’t match. Try again.');
    }
    return loginPage('');
  }

  if (url.pathname === '/logout') {
    return new Response(null, {
      status: 303,
      headers: { location: '/login', 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` },
    });
  }

  // Automations: each of these endpoints verifies its own secret.
  if (request.headers.get('x-docket-secret') || request.headers.get('x-docket-shared-secret')) return next();
  if ((request.headers.get('user-agent') || '').startsWith('vercel-cron')) return next();

  if (sameString(readCookie(request, COOKIE), expected)) return next();

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/data/')) {
    return new Response(JSON.stringify({ error: 'Not signed in to the dashboard' }), {
      status: 401, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
  return loginPage('');
}
