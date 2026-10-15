// Events RSVP sync with the Oasis Mini. The Mini's "TorT RSVP Monitor +
// Print" task keeps each event's RSVP page (a claude.ai artifact) up to date;
// after each check it POSTs the page's guest list here so the dashboard's
// Events panel matches. Hand edits made on the dashboard (flagged pageSync
// by save-project.js) win over the Mini's copy and are handed back in the
// response for the Mini to write onto the RSVP page; once the Mini's list
// agrees with them, the flag clears.
//
// POST /api/machine-status?job=events-sync   header x-docket-secret
// Body: { eventId, guests:[{id,name,status,source,says,note,count,replied,date}],
//         formResponses?, lastChecked? }
// Reply: { ok, guests: <count>, pageEdits:[guests to write to the page], removed:[ids to delete] }

const REPO = 'oritandscott/docket-dashboard';
const PATH = 'data/events.json';
const FIELDS = ['name', 'status', 'source', 'says', 'note', 'count', 'replied', 'date'];
const KEEP = ['phone', 'email', 'commandUrl', 'editedAt']; // dashboard-only fields
const SAME = ['name', 'status', 'source', 'count', 'replied'];

export async function runEventsSync(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only.' });
  const secret = process.env.MINI_HEARTBEAT_SECRET;
  if (!secret || req.headers['x-docket-secret'] !== secret) return res.status(401).json({ error: 'Unauthorized' });
  const body = req.body || {};
  if (!Array.isArray(body.guests)) return res.status(400).json({ error: 'guests must be a list.' });
  const gh = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const url = `https://api.github.com/repos/${REPO}/contents/${PATH}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const got = await fetch(`${url}?ref=main`, { headers: gh });
    if (!got.ok) return res.status(502).json({ error: 'Could not read events.json' });
    const file = await got.json();
    const data = JSON.parse(Buffer.from(file.content, 'base64').toString('utf-8'));
    const events = data.events || [];
    const ev = body.eventId ? events.find((e) => e.id === body.eventId) : events.find((e) => e.rsvpPage);
    if (!ev) return res.status(404).json({ error: 'No event with that id.' });
    const before = JSON.stringify(ev);
    const old = new Map((ev.guests || []).map((g) => [g.id, g]));
    const removed = ev.removed || [];
    const out = [];
    const seen = new Set();
    for (const p of body.guests) {
      const id = String((p && p.id) || '').slice(0, 80);
      if (!id || seen.has(id) || removed.includes(id)) continue;
      seen.add(id);
      const mine = old.get(id);
      const g = { id };
      if (mine && mine.pageSync) {
        Object.assign(g, mine);
        if (SAME.every((k) => String(p[k] ?? '') === String(mine[k] ?? ''))) delete g.pageSync;
      } else {
        FIELDS.forEach((k) => { g[k] = p[k] ?? null; });
        if (mine) KEEP.forEach((k) => { if (mine[k]) g[k] = mine[k]; });
      }
      out.push(g);
    }
    // Hand-added guests the page doesn't have yet stay until the Mini adds them.
    for (const g of ev.guests || []) if (!seen.has(g.id) && g.pageSync) out.push(g);
    // A removal is done once the page no longer lists that guest.
    const stillThere = removed.filter((id) => body.guests.some((p) => p && p.id === id));
    if (stillThere.length) ev.removed = stillThere; else delete ev.removed;
    ev.guests = out;
    if (body.formResponses != null) ev.formResponses = body.formResponses;
    if (body.lastChecked) ev.lastChecked = String(body.lastChecked).slice(0, 60);
    const pageEdits = out.filter((g) => g.pageSync).map((g) => Object.fromEntries(['id', ...FIELDS].map((k) => [k, g[k] ?? null])));
    const reply = { ok: true, guests: out.length, pageEdits, removed: stillThere };
    if (JSON.stringify(ev) === before) return res.status(200).json(reply);
    const put = await fetch(url, {
      method: 'PUT',
      headers: { ...gh, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Events: sync RSVPs from the Oasis Mini', branch: 'main', sha: file.sha, content: Buffer.from(JSON.stringify(data, null, 2) + '\n').toString('base64') }),
    });
    if (put.ok) return res.status(200).json(reply);
    if (put.status !== 409 && put.status !== 422) return res.status(502).json({ error: 'Could not save events.json' });
  }
  return res.status(503).json({ error: 'events.json kept changing -- try again.' });
}
