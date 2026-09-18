// Backs two things on the dashboard, merged into one function to stay under
// Vercel Hobby's 12-serverless-function cap:
//
// 1. The "Master Project List" panel -- Orit/Scott's running list of every
//    automation, idea, and to-do for this dashboard, plus which machine each
//    one runs on (Oasis Mini / MacBook Pro / cloud) and any redundancy notes.
//    Upserts/deletes one entry in data/projects.json. Body: { resource:
//    'project', id?, title, notes?, kind ('automation'|'idea'), status
//    ('idea'|'planned'|'in-progress'|'running'|'blocked'|'needs-check'|'done'),
//    machine ('mini'|'macbook'|'cloud'|'unassigned'), redundancyNote?,
//    waitingOn? }.
//
// 2. The Thursday Weekender panel's "This weekend's open house" field --
//    a single record (not a list), full-replace. Body: { resource:
//    'openhouse', address?, date?, time?, notes? }.
//
// Same storage pattern as save-anniversary.js / save-video-link.js -- this
// app has no database, the JSON file in the repo IS the store, and a commit
// here triggers a normal Vercel redeploy. Browser-callable, no shared secret
// required (this dashboard has no login) -- the GITHUB_TOKEN that actually
// authorizes the write stays server-side.

const REPO = 'oritandscott/docket-dashboard';
const BRANCH = 'main';

const FILES = {
  project: 'data/projects.json',
  openhouse: 'data/open-house.json',
};

function uid() {
  return 'proj-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function readJsonFile(ghHeaders, filePath) {
  const contentsUrl = `https://api.github.com/repos/${REPO}/contents/${filePath}`;
  const getRes = await fetch(`${contentsUrl}?ref=${BRANCH}`, { headers: ghHeaders });
  if (!getRes.ok) {
    const errText = await getRes.text();
    throw new Error(`Could not read ${filePath} from GitHub: ${errText}`);
  }
  const getData = await getRes.json();
  const parsed = JSON.parse(Buffer.from(getData.content, 'base64').toString('utf-8'));
  return { parsed, sha: getData.sha, contentsUrl };
}

async function writeJsonFile(ghHeaders, contentsUrl, sha, value, commitMessage) {
  const updatedContent = Buffer.from(JSON.stringify(value, null, 2) + '\n').toString('base64');
  const putRes = await fetch(contentsUrl, {
    method: 'PUT',
    headers: { ...ghHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: commitMessage, content: updatedContent, sha, branch: BRANCH }),
  });
  if (!putRes.ok) {
    const errText = await putRes.text();
    throw new Error(`Could not write to GitHub: ${errText}`);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' });
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

    const resource = (req.body || {}).resource;
    if (!FILES[resource]) {
      return res.status(400).json({ error: "resource must be 'project' or 'openhouse'." });
    }
    const filePath = FILES[resource];

    if (resource === 'openhouse') {
      if (req.method === 'DELETE') {
        return res.status(400).json({ error: 'openhouse does not support delete -- save an empty record instead.' });
      }
      const { address, date, time, notes } = req.body || {};
      const { contentsUrl, sha } = await readJsonFile(ghHeaders, filePath);
      const record = {
        address: address || '',
        date: date || '',
        time: time || '',
        notes: notes || '',
        updatedAt: new Date().toISOString(),
      };
      await writeJsonFile(ghHeaders, contentsUrl, sha, record, 'Update this weekend\'s open house');
      return res.status(200).json({ ok: true, record });
    }

    // resource === 'project'
    const { parsed: current, contentsUrl, sha } = await readJsonFile(ghHeaders, filePath);

    if (req.method === 'DELETE') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Missing required field: id.' });
      const idx = current.findIndex(p => p.id === id);
      if (idx === -1) return res.status(404).json({ error: 'Project not found.' });
      const [removed] = current.splice(idx, 1);
      await writeJsonFile(ghHeaders, contentsUrl, sha, current, `Remove project: ${removed.title}`);
      return res.status(200).json({ ok: true });
    }

    const { id, title, notes, kind, status, machine, redundancyNote, waitingOn } = req.body || {};
    if (!title) {
      return res.status(400).json({ error: 'Missing required field: title.' });
    }
    const allowedKinds = ['automation', 'idea'];
    const allowedStatuses = ['idea', 'planned', 'in-progress', 'running', 'blocked', 'needs-check', 'done'];
    const allowedMachines = ['mini', 'macbook', 'cloud', 'unassigned'];
    const now = new Date().toISOString();

    const existingIndex = id ? current.findIndex(p => p.id === id) : -1;
    const existing = existingIndex !== -1 ? current[existingIndex] : null;

    const record = {
      id: id || uid(),
      title,
      notes: notes || '',
      kind: allowedKinds.includes(kind) ? kind : (existing ? existing.kind : 'idea'),
      status: allowedStatuses.includes(status) ? status : (existing ? existing.status : 'idea'),
      machine: allowedMachines.includes(machine) ? machine : (existing ? existing.machine : 'unassigned'),
      redundancyNote: redundancyNote !== undefined ? redundancyNote : (existing ? existing.redundancyNote : ''),
      waitingOn: waitingOn !== undefined ? waitingOn : (existing ? existing.waitingOn : ''),
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };

    let commitMessage;
    if (existingIndex === -1) {
      current.push(record);
      commitMessage = `Add project: ${title}`;
    } else {
      current[existingIndex] = record;
      commitMessage = `Update project: ${title}`;
    }

    await writeJsonFile(ghHeaders, contentsUrl, sha, current, commitMessage);
    return res.status(200).json({ ok: true, record });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
