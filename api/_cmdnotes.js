// Call notes -> KW Command. Command has no API this dashboard can use, so
// the Oasis Mini (a Cowork scheduled task driving its Chrome, already
// signed in to Command) picks up the Prospecting call notes that aren't in
// Command yet and adds them to each contact as a note, then reports back.
//
//   GET  ?job=cmd-notes  -> { pending: [{ id, name, phone, email,
//                             commandUrl, newNotes }] }
//   POST ?job=cmd-notes  { id, synced, result }  -- `synced` is the notes
//                             text that is now in Command; result is
//                             'added' | 'not-in-command' | 'failed: ...'
//
// Both need the x-docket-secret header (MINI_HEARTBEAT_SECRET), the same
// one the Mini's heartbeat uses. Dispatched from api/machine-status.js.

const REPO = 'oritandscott/docket-dashboard';
const FILE_PATH = 'data/hotlist.json';
const BRANCH = 'main';

function gh() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw Object.assign(new Error('Missing required environment variable: GITHUB_TOKEN.'), { status: 500 });
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}

// Only what's new since the last copy, when the notes were added to.
export function newNotes(h) {
  if (h.cmdNotesSynced === undefined) return '';
  const now = String(h.notes || '').trim();
  const done = String(h.cmdNotesSynced || '').trim();
  if (!now || now === done) return '';
  return done && now.startsWith(done) ? now.slice(done.length).trim() : now;
}

export async function runCmdNotes(req, res) {
  const secret = process.env.MINI_HEARTBEAT_SECRET;
  if (!secret || req.headers['x-docket-secret'] !== secret) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const headers = gh();
    const url = `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`;
    const read = async () => {
      const r = await fetch(`${url}?ref=${BRANCH}`, { headers });
      if (!r.ok) throw Object.assign(new Error('Could not read the Hot List from GitHub'), { status: 502 });
      const d = await r.json();
      return { sha: d.sha, list: JSON.parse(Buffer.from(d.content, 'base64').toString('utf-8')) };
    };

    if (req.method === 'GET') {
      const { list } = await read();
      const pending = list.filter((h) => newNotes(h)).map((h) => ({
        id: h.id, name: h.name, phone: h.phone || '', email: h.email || '', commandUrl: h.commandUrl || '', newNotes: newNotes(h),
      }));
      return res.status(200).json({ ok: true, pending });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { id, synced, result } = req.body || {};
    if (!id || typeof synced !== 'string') return res.status(400).json({ error: 'id and synced (the notes text now in Command) are required' });
    for (let attempt = 0; attempt < 2; attempt++) {
      const { sha, list } = await read();
      const h = list.find((x) => x.id === id);
      if (!h) return res.status(404).json({ error: 'Not on the prospecting lists' });
      const outcome = String(result || 'added').slice(0, 200);
      // Only mark copied when it really went in; otherwise just record why.
      if (outcome === 'added') h.cmdNotesSynced = synced.slice(0, 8000);
      h.cmdNotesAt = new Date().toISOString();
      h.cmdNotesResult = outcome;
      const w = await fetch(url, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `Prospecting: call notes to Command -- ${h.name} (${outcome})`, sha, branch: BRANCH, content: Buffer.from(JSON.stringify(list, null, 2) + '\n').toString('base64') }),
      });
      if (w.ok) return res.status(200).json({ ok: true });
      if (w.status !== 409) break;
    }
    return res.status(502).json({ error: 'Could not save to GitHub' });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
}
