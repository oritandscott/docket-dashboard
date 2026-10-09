// Receives a heartbeat from a machine running Docket automations (the Oasis
// Mini, first and foremost) so the Master Project List panel can show
// whether it's actually online and what it last did, instead of Scott having
// to check by hand. Same pattern as api/save-weekender-status.js: called
// server-to-server with a shared secret, overwrites data/machine-status.json
// via the GitHub Contents API (this app has no database, so the JSON file
// IS the store, and a commit here triggers a normal Vercel redeploy).
//
// Intended caller: a Cowork scheduled task bound to the Oasis Mini,
// requiring the local device, firing every 15-30 minutes, that POSTs here
// with whatever it can see about its own machine and the automations it's
// running. GET is public (no secret) so the dashboard can poll it, though
// the dashboard can also just fetch /data/machine-status.json directly.

const REPO = 'oritandscott/docket-dashboard';
const FILE_PATH = 'data/machine-status.json';
const BRANCH = 'main';

export default async function handler(req, res) {
  // Daily Dashboard Digest (see api/_digest.js). Merged in here rather than
  // given its own file to stay under Vercel Hobby's 12-function cap. Called
  // by the cron in vercel.json as /api/machine-status?job=digest; every other
  // request behaves exactly as before.
  if (req.query && req.query.job === 'digest') {
    const { runDigest } = await import('./_digest.js');
    return runDigest(req, res);
  }

  // Dispatches to api/_calendar.js: today's calendar events grouped by KW
  // office, for the dashboard's Today panel. Merged in here rather than
  // given its own file to stay under Vercel Hobby's 12-function cap. Called
  // by the dashboard as /api/machine-status?job=calendar.
  if (req.query && req.query.job === 'calendar') {
    const { loadTodayCalendar } = await import('./_calendar.js');
    try {
      const data = await loadTodayCalendar();
      return res.status(200).json({ ok: true, ...data });
    } catch (err) {
      return res.status(200).json({ ok: false, error: err.message });
    }
  }

  // Dispatches to api/_snapshot.js: Navigator's live listing/escrow snapshot
  // for the Linear Escrow Tracker panel, fetched server-side so
  // DOCKET_SHARED_SECRET never reaches the browser. Merged in here rather
  // than given its own file to stay under Vercel Hobby's 12-function cap.
  // Called by the dashboard as /api/machine-status?job=snapshot.
  if (req.query && req.query.job === 'snapshot') {
    const { loadSnapshot } = await import('./_snapshot.js');
    res.setHeader('Cache-Control', 'no-store');
    try {
      const data = await loadSnapshot();
      return res.status(200).json(data);
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  // Dispatches to api/_apply.js: Confirm / Skip for a Claude-proposed
  // Linear Escrow Tracker change (writes to Navigator). POST only; the
  // change itself is read from the committed inbox file, never the request.
  // Dispatches to api/_ohpink.js: which phones/emails are pink (found by us,
  // not given) in the OPEN HOUSE ATTENDANCE sheets.
  if (req.query && req.query.job === 'oh-pink') {
    const { runOhPink } = await import('./_ohpink.js');
    return runOhPink(req, res);
  }

  // Dispatches to api/_command.js: "Sync with Command" contact lookup.
  if (req.query && req.query.job === 'command-lookup') {
    const { runCommandLookup } = await import('./_command.js');
    return runCommandLookup(req, res);
  }

  // Dispatches to api/_data.js: the dashboard's data files, read live from
  // GitHub so saving doesn't need a redeploy.
  if (req.query && req.query.job === 'data') {
    const { runData } = await import('./_data.js');
    return runData(req, res);
  }

  // Moves the black today box on the Google Sheet Linear Tracker (api/_ltsheet.js).
  if (req.query && req.query.job === 'lt-today') {
    const { moveTodayBox } = await import('./_ltsheet.js');
    try {
      return res.status(200).json({ ok: true, result: await moveTodayBox() });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  // Dispatches to api/_cmdnotes.js: Prospecting call notes waiting to be
  // added to KW Command by the Oasis Mini.
  if (req.query && req.query.job === 'cmd-notes') {
    const { runCmdNotes } = await import('./_cmdnotes.js');
    return runCmdNotes(req, res);
  }

  // "Run now" button: fires the Docket inbox routine on demand. Needs
  // ROUTINE_FIRE_URL and ROUTINE_FIRE_TOKEN (the routine's API trigger) set
  // in Vercel; without them it says so instead of failing.
  if (req.query && req.query.job === 'run-now') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only.' });
    const url = process.env.ROUTINE_FIRE_URL, token = process.env.ROUTINE_FIRE_TOKEN;
    if (!url || !token) return res.status(501).json({ error: 'not-connected' });
    const now = Date.now();
    if (globalThis.__runNowAt && now - globalThis.__runNowAt < 120000) return res.status(429).json({ error: 'Claude was just started -- give it a couple of minutes.' });
    globalThis.__runNowAt = now;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'experimental-cc-routine-2026-04-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Run now: tapped on the dashboard' }),
      });
      if (!r.ok) { globalThis.__runNowAt = 0; return res.status(502).json({ error: `Trigger failed (HTTP ${r.status}).` }); }
      return res.status(200).json({ ok: true });
    } catch (e) {
      globalThis.__runNowAt = 0;
      return res.status(502).json({ error: e.message });
    }
  }

  // Applies pending routine tracker changes (see AUTO_OPS in _apply.js).
  if (req.query && req.query.job === 'apply-pending') {
    const { runApplyPending } = await import('./_apply.js');
    return runApplyPending(req, res);
  }

  if (req.query && (req.query.job === 'apply' || req.query.job === 'skip')) {
    const { runApply, runSkip } = await import('./_apply.js');
    return req.query.job === 'apply' ? runApply(req, res) : runSkip(req, res);
  }

  try {
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    if (!GITHUB_TOKEN) {
      return res.status(500).json({ error: 'Missing required environment variable: GITHUB_TOKEN.' });
    }
    const ghHeaders = {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const contentsUrl = `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`;

    if (req.method === 'GET') {
      const getRes = await fetch(`${contentsUrl}?ref=${BRANCH}`, { headers: ghHeaders });
      if (!getRes.ok) {
        const errText = await getRes.text();
        return res.status(502).json({ error: 'Could not read machine-status.json from GitHub', detail: errText });
      }
      const getData = await getRes.json();
      const current = JSON.parse(Buffer.from(getData.content, 'base64').toString('utf-8'));
      return res.status(200).json(current);
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const MINI_HEARTBEAT_SECRET = process.env.MINI_HEARTBEAT_SECRET;
    if (!MINI_HEARTBEAT_SECRET) {
      return res.status(500).json({ error: 'Missing required environment variable: MINI_HEARTBEAT_SECRET.' });
    }
    if (req.headers['x-docket-secret'] !== MINI_HEARTBEAT_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { machine, status, note, runningTasks } = req.body || {};
    const allowedMachines = ['mini', 'macbook'];
    if (!machine || !allowedMachines.includes(machine)) {
      return res.status(400).json({ error: `machine must be one of: ${allowedMachines.join(', ')}` });
    }

    const getRes = await fetch(`${contentsUrl}?ref=${BRANCH}`, { headers: ghHeaders });
    if (!getRes.ok) {
      const errText = await getRes.text();
      return res.status(502).json({ error: 'Could not read machine-status.json from GitHub', detail: errText });
    }
    const getData = await getRes.json();
    const current = JSON.parse(Buffer.from(getData.content, 'base64').toString('utf-8'));

    current[machine] = {
      status: status || 'online',
      note: note || '',
      runningTasks: Array.isArray(runningTasks) ? runningTasks : (current[machine] && current[machine].runningTasks) || [],
      lastHeartbeat: new Date().toISOString(),
    };

    const updatedContent = Buffer.from(JSON.stringify(current, null, 2) + '\n').toString('base64');
    const putRes = await fetch(contentsUrl, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Machine heartbeat: ${machine}`,
        content: updatedContent,
        sha: getData.sha,
        branch: BRANCH,
      }),
    });
    if (!putRes.ok) {
      const errText = await putRes.text();
      return res.status(502).json({ error: 'Could not write machine-status.json to GitHub', detail: errText });
    }

    // Each Mini heartbeat (~every 30 min) also applies pending routine
    // tracker changes, so they go through without a Confirm tap.
    let autoApplied = null;
    try {
      const { applyAllPending } = await import('./_apply.js');
      autoApplied = await applyAllPending({ budgetMs: 40000 });
    } catch (e) {
      autoApplied = { error: e.message };
    }
    return res.status(200).json({ ok: true, record: current[machine], autoApplied });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
