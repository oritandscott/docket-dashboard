// Called by the "weekender-build-jul23" Cowork scheduled task: once at the
// start of each Thursday run (state: "running"), and once at the end
// (state: "done" or "error"), so the dashboard's Thursday Weekender panel
// reflects live status. Overwrites data/weekender-status.json via the GitHub
// Contents API (this app has no database, so the JSON file in the repo IS
// the store, and a commit here triggers a normal Vercel redeploy) -- same
// pattern as save-anniversary.js, but a single object instead of an array
// since there's only ever one "current" status.

const REPO = 'oritandscott/docket-dashboard';
const FILE_PATH = 'data/weekender-status.json';
const BRANCH = 'main';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const WEEKENDER_SHARED_SECRET = process.env.WEEKENDER_SHARED_SECRET;
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

    if (!WEEKENDER_SHARED_SECRET || !GITHUB_TOKEN) {
      return res.status(500).json({ error: 'Missing one or more required environment variables.' });
    }

    if (req.headers['x-docket-secret'] !== WEEKENDER_SHARED_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { state, message, campaignTitle, editUrl } = req.body || {};
    const allowedStates = ['idle', 'running', 'done', 'error'];
    if (!state || !allowedStates.includes(state)) {
      return res.status(400).json({ error: `state must be one of: ${allowedStates.join(', ')}` });
    }

    const ghHeaders = {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const contentsUrl = `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`;

    const getRes = await fetch(`${contentsUrl}?ref=${BRANCH}`, { headers: ghHeaders });
    if (!getRes.ok) {
      const errText = await getRes.text();
      return res.status(502).json({ error: 'Could not read weekender-status.json from GitHub', detail: errText });
    }
    const getData = await getRes.json();
    const current = JSON.parse(Buffer.from(getData.content, 'base64').toString('utf-8'));

    const now = new Date().toISOString();
    const record = {
      state,
      message: message || null,
      campaignTitle: campaignTitle || null,
      editUrl: editUrl || null,
      updatedAt: now,
      lastSuccessAt: state === 'done' ? now : (current.lastSuccessAt || null),
    };

    const updatedContent = Buffer.from(JSON.stringify(record, null, 2) + '\n').toString('base64');

    const putRes = await fetch(contentsUrl, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Weekender status: ${state}`,
        content: updatedContent,
        sha: getData.sha,
        branch: BRANCH,
      }),
    });

    if (!putRes.ok) {
      const errText = await putRes.text();
      return res.status(502).json({ error: 'Could not write weekender-status.json to GitHub', detail: errText });
    }

    return res.status(200).json({ ok: true, record });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
