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

    return res.status(200).json({ ok: true, record: current[machine] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
