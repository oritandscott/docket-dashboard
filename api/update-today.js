// Called directly from the dashboard's Today panel (add appointment, add
// task, check off a task, remove an item) to persist Schedule/Top 3 Tasks
// into data/today.json via the GitHub Contents API. Same trust model as
// update-anniversary.js -- no shared secret, since this is meant to be
// called straight from the browser. The GITHUB_TOKEN that actually
// authorizes the write stays server-side the whole time.
//
// This is a full replace of the schedule/tasks arrays rather than a set of
// discrete operations: the dashboard already keeps the full Today state in
// memory client-side, so it just posts whatever it has after each edit --
// mirroring how this data used to be written straight to localStorage.

const REPO = 'oritandscott/docket-dashboard';
const FILE_PATH = 'data/today.json';
const BRANCH = 'main';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    if (!GITHUB_TOKEN) {
      return res.status(500).json({ error: 'Missing required environment variable: GITHUB_TOKEN.' });
    }

    const schedule = Array.isArray(req.body?.schedule) ? req.body.schedule : null;
    const tasks = Array.isArray(req.body?.tasks) ? req.body.tasks : null;
    if (!schedule || !tasks) {
      return res.status(400).json({ error: 'Both schedule and tasks arrays are required.' });
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
      return res.status(502).json({ error: 'Could not read today.json from GitHub', detail: errText });
    }
    const getData = await getRes.json();

    const updated = { schedule, tasks };
    const updatedContent = Buffer.from(JSON.stringify(updated, null, 2) + '\n').toString('base64');

    const putRes = await fetch(contentsUrl, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Update Today (Schedule/Top 3 Tasks) from dashboard',
        content: updatedContent,
        sha: getData.sha,
        branch: BRANCH,
      }),
    });

    if (!putRes.ok) {
      const errText = await putRes.text();
      return res.status(502).json({ error: 'Could not write today.json to GitHub', detail: errText });
    }

    return res.status(200).json({ ok: true, schedule, tasks });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
