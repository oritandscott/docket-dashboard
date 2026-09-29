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
// 3. The Prospecting panel's shared call list (data/prospects.json) --
//    people for Scott to call: manual adds, open house sign-ins (pasted in
//    bulk), and past clients picked from the anniversary suggestions.
//    Body: { resource: 'prospect', id?, name, phone?, email?, source
//    ('manual'|'openhouse'|'pastclient'), reason?, notes?, status
//    ('to-call'|'follow-up'|'done'), sourceId?, logCall? } -- or
//    { resource: 'prospect', bulk: [ {name, phone?, email?, ...}, ... ] } to
//    add many at once (skips anyone already on the list by email/phone/name).
//    DELETE { resource: 'prospect', id } removes one.
//
// 4. The Prospecting panel's Hot List (data/hotlist.json) -- the handful of
//    people closest to buying or selling right now. Body: { resource:
//    'hotlist', id?, name, phone?, email?, type ('buyer'|'seller'|'both'),
//    source (see HOT_SOURCES), tier ('hot'|'medium'|'long'), notes?,
//    commandUrl?, logCall? }. Three lists share this file, told apart by
//    tier: the Hot List, Watchlist Medium Term and Watchlist Long Term.
//    Priority order within a list is the order of the array; changing a
//    contact's tier moves them to the bottom of the new list. Reorder with
//    { resource: 'hotlist', reorder: { tier, ids: [...] } }.
//    DELETE { resource: 'hotlist', id } removes one.
//
// 5. The "Notes for Claude" inbox, shared by the Prospecting notes box and
//    the Linear Escrow Tracker's command box (topic: 'tracker'). Originally
//    the Prospecting panel's "Notes for Claude" inbox
//    (data/prospecting-inbox.json) -- typed or dictated notes about who
//    should be added to the lists, for Claude to read and act on in a
//    session. Body: { resource: 'inbox', text } adds one; { resource:
//    'inbox', id, status ('new'|'done') } updates one; DELETE { id } removes.
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
  prospect: 'data/prospects.json',
  hotlist: 'data/hotlist.json',
  inbox: 'data/prospecting-inbox.json',
};

async function handleInbox(req, res, ghHeaders) {
  const { parsed, contentsUrl, sha } = await readJsonFile(ghHeaders, FILES.inbox);
  const current = Array.isArray(parsed) ? parsed : [];
  const body = req.body || {};
  const now = new Date().toISOString();
  if (req.method === 'DELETE' || body.id) {
    const idx = current.findIndex(n => n.id === body.id);
    if (idx === -1) return res.status(404).json({ error: 'Note not found.' });
    if (req.method === 'DELETE') {
      current.splice(idx, 1);
      await writeJsonFile(ghHeaders, contentsUrl, sha, current, 'Prospecting inbox: remove note');
      return res.status(200).json({ ok: true });
    }
    if (!['new', 'done'].includes(body.status)) return res.status(400).json({ error: "status must be 'new' or 'done'." });
    current[idx] = Object.assign({}, current[idx], { status: body.status, updatedAt: now });
    await writeJsonFile(ghHeaders, contentsUrl, sha, current, `Prospecting inbox: mark ${body.status}`);
    return res.status(200).json({ ok: true, record: current[idx] });
  }
  const text = str(body.text, 8000);
  if (!text) return res.status(400).json({ error: 'The note is empty.' });
  const record = {
    id: 'note-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    text,
    // 'tracker' = a Linear Escrow Tracker command (update Navigator + the
    // Google Sheet); anything else is a Prospecting note.
    topic: body.topic === 'tracker' ? 'tracker' : 'prospecting',
    dictated: !!body.dictated,
    status: 'new',
    createdAt: now,
    updatedAt: now,
  };
  current.unshift(record);
  await writeJsonFile(ghHeaders, contentsUrl, sha, current, record.topic === 'tracker' ? 'Tracker command: new' : 'Prospecting inbox: new note');
  return res.status(200).json({ ok: true, record });
}

const HOT_TYPES = ['buyer', 'seller', 'both'];
const HOT_TIERS = ['hot', 'medium', 'long'];
const HOT_SOURCES = ['referral', 'pastclient', 'youtube', 'online', 'openhouse', 'sphere', 'other'];

async function handleHotlist(req, res, ghHeaders) {
  const { parsed, contentsUrl, sha } = await readJsonFile(ghHeaders, FILES.hotlist);
  const current = Array.isArray(parsed) ? parsed : [];
  const body = req.body || {};
  const now = new Date().toISOString();

  if (req.method === 'DELETE') {
    if (!body.id) return res.status(400).json({ error: 'Missing required field: id.' });
    const idx = current.findIndex(p => p.id === body.id);
    if (idx === -1) return res.status(404).json({ error: 'Not on the Hot List.' });
    const [removed] = current.splice(idx, 1);
    await writeJsonFile(ghHeaders, contentsUrl, sha, current, `Hot List: remove ${removed.name}`);
    return res.status(200).json({ ok: true });
  }

  if (body.reorder) {
    const tier = body.reorder.tier;
    const ids = Array.isArray(body.reorder.ids) ? body.reorder.ids : null;
    if (!HOT_TIERS.includes(tier) || !ids) return res.status(400).json({ error: 'reorder needs a tier and an ids array.' });
    const inTier = current.filter(p => (p.tier || 'hot') === tier);
    const byId = new Map(inTier.map(p => [p.id, p]));
    const ordered = ids.map(id => byId.get(id)).filter(Boolean);
    inTier.forEach(p => { if (!ids.includes(p.id)) ordered.push(p); });
    const rest = current.filter(p => (p.tier || 'hot') !== tier);
    const updated = rest.concat(ordered);
    await writeJsonFile(ghHeaders, contentsUrl, sha, updated, `Prospecting: reorder ${tier} list`);
    return res.status(200).json({ ok: true, records: updated });
  }

  const idx = body.id ? current.findIndex(p => p.id === body.id) : -1;
  if (body.id && idx === -1) return res.status(404).json({ error: 'Not on the Hot List.' });
  const existing = idx !== -1 ? current[idx] : null;
  if (!existing && current.some(p => prospectKey(p) === prospectKey(body))) {
    return res.status(409).json({ error: `${str(body.name)} is already on one of your prospecting lists.` });
  }
  const pick = (k, max) => (body[k] !== undefined ? str(body[k], max) : existing ? existing[k] || '' : '');
  const commandUrl = pick('commandUrl', 500);
  if (commandUrl && !/^https:\/\//i.test(commandUrl)) {
    return res.status(400).json({ error: 'The Command link must start with https://' });
  }
  const record = {
    id: existing ? existing.id : 'hot-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name: pick('name', 120),
    phone: pick('phone', 40),
    email: pick('email', 160),
    type: HOT_TYPES.includes(body.type) ? body.type : existing ? existing.type : 'buyer',
    source: HOT_SOURCES.includes(body.source) ? body.source : existing ? existing.source : 'other',
    tier: HOT_TIERS.includes(body.tier) ? body.tier : existing ? existing.tier || 'hot' : 'hot',
    notes: pick('notes', 8000),
    // true = a phone/email Orit & Scott looked up themselves rather than one
    // the person gave them (pink on the sign-in sheet); shown in bright pink.
    phoneFound: typeof body.phoneFound === 'boolean' ? body.phoneFound : existing ? !!existing.phoneFound : false,
    emailFound: typeof body.emailFound === 'boolean' ? body.emailFound : existing ? !!existing.emailFound : false,
    commandUrl,
    // Call notes already copied into the Command contact by the Oasis Mini
    // (api/_cmdnotes.js). Records from before this existed start with their
    // current notes counted as copied, so only new notes go to Command.
    cmdNotesSynced: existing ? (existing.cmdNotesSynced !== undefined ? existing.cmdNotesSynced : existing.notes || '') : '',
    cmdNotesAt: existing ? existing.cmdNotesAt || null : null,
    cmdNotesResult: existing ? existing.cmdNotesResult || '' : '',
    callCount: (existing ? existing.callCount || 0 : 0) + (body.logCall ? 1 : 0),
    lastCalledAt: body.logCall ? now : existing ? existing.lastCalledAt || null : null,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  };
  if (!record.name) return res.status(400).json({ error: 'Name cannot be blank.' });
  if (existing && (existing.tier || 'hot') !== record.tier) {
    // Moved to another list: goes to the bottom of that list.
    current.splice(idx, 1);
    current.push(record);
  } else if (existing) {
    current[idx] = record;
  } else {
    current.push(record);
  }
  await writeJsonFile(ghHeaders, contentsUrl, sha, current, `Prospecting: ${existing ? 'update' : 'add'} ${record.name} (${record.tier})`);
  return res.status(200).json({ ok: true, record });
}

const PROSPECT_SOURCES = ['manual', 'openhouse', 'pastclient'];
// 'dismissed' = a past-client suggestion Orit & Scott chose not to call this
// year; hidden from the call list, and keeps the suggestion from coming back.
const PROSPECT_STATUSES = ['to-call', 'follow-up', 'done', 'dismissed'];

function str(v, max = 500) {
  return (v === undefined || v === null ? '' : String(v)).trim().slice(0, max);
}

function prospectKey(p) {
  const email = str(p.email).toLowerCase();
  if (email) return 'e:' + email;
  const phone = str(p.phone).replace(/\D/g, '');
  if (phone.length >= 7) return 'p:' + phone.slice(-10);
  return 'n:' + str(p.name).toLowerCase();
}

function buildProspect(input, existing, now) {
  const src = PROSPECT_SOURCES.includes(input.source) ? input.source : (existing ? existing.source : 'manual');
  const status = PROSPECT_STATUSES.includes(input.status) ? input.status : (existing && existing.status !== 'dismissed' ? existing.status : 'to-call');
  const pick = (k, max) => (input[k] !== undefined ? str(input[k], max) : existing ? existing[k] || '' : '');
  const record = {
    id: existing ? existing.id : 'pros-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name: pick('name', 120),
    phone: pick('phone', 40),
    email: pick('email', 160),
    source: src,
    reason: pick('reason', 300),
    notes: pick('notes', 2000),
    sourceId: pick('sourceId', 120),
    status,
    callCount: existing ? existing.callCount || 0 : 0,
    lastCalledAt: existing ? existing.lastCalledAt || null : null,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  };
  if (input.logCall) {
    record.callCount += 1;
    record.lastCalledAt = now;
  }
  return record;
}

async function handleProspect(req, res, ghHeaders) {
  const { parsed, contentsUrl, sha } = await readJsonFile(ghHeaders, FILES.prospect);
  const current = Array.isArray(parsed) ? parsed : [];
  const body = req.body || {};
  const now = new Date().toISOString();

  if (req.method === 'DELETE') {
    if (!body.id) return res.status(400).json({ error: 'Missing required field: id.' });
    const idx = current.findIndex(p => p.id === body.id);
    if (idx === -1) return res.status(404).json({ error: 'Prospect not found.' });
    const [removed] = current.splice(idx, 1);
    await writeJsonFile(ghHeaders, contentsUrl, sha, current, `Remove prospect: ${removed.name}`);
    return res.status(200).json({ ok: true });
  }

  if (body.reorder && Array.isArray(body.reorder.ids)) {
    const ids = body.reorder.ids;
    const byId = new Map(current.map(p => [p.id, p]));
    const ordered = ids.map(id => byId.get(id)).filter(Boolean);
    current.forEach(p => { if (!ids.includes(p.id)) ordered.push(p); });
    await writeJsonFile(ghHeaders, contentsUrl, sha, ordered, 'Call list: reorder');
    return res.status(200).json({ ok: true });
  }

  if (Array.isArray(body.bulk)) {
    const seen = new Set(current.map(prospectKey));
    const added = [];
    let skipped = 0;
    body.bulk.slice(0, 200).forEach((item) => {
      if (!item || !str(item.name)) { skipped++; return; }
      const key = prospectKey(item);
      if (seen.has(key)) { skipped++; return; }
      seen.add(key);
      const rec = buildProspect(item, null, now);
      current.push(rec);
      added.push(rec);
    });
    if (added.length) {
      await writeJsonFile(ghHeaders, contentsUrl, sha, current, `Add ${added.length} prospect${added.length === 1 ? '' : 's'}`);
    }
    return res.status(200).json({ ok: true, added, skipped });
  }

  if (!str(body.name) && !body.id) {
    return res.status(400).json({ error: 'Missing required field: name.' });
  }
  let idx = body.id ? current.findIndex(p => p.id === body.id) : -1;
  if (body.id && idx === -1) return res.status(404).json({ error: 'Prospect not found.' });
  // A suggestion dismissed in an earlier year can be added (or dismissed) again.
  if (idx === -1) idx = current.findIndex(p => p.status === 'dismissed' && prospectKey(p) === prospectKey(body));
  const existing = idx !== -1 ? current[idx] : null;
  if (!existing && current.some(p => prospectKey(p) === prospectKey(body))) {
    return res.status(409).json({ error: `${str(body.name)} is already on the call list.` });
  }
  const record = buildProspect(body, existing, now);
  if (!record.name) return res.status(400).json({ error: 'Name cannot be blank.' });
  if (existing) current[idx] = record; else current.push(record);
  const verb = !existing ? 'Add' : body.logCall ? 'Log call:' : 'Update';
  await writeJsonFile(ghHeaders, contentsUrl, sha, current, `${verb} prospect ${record.name}`);
  return res.status(200).json({ ok: true, record });
}

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
      return res.status(400).json({ error: "resource must be 'project', 'openhouse', 'prospect', 'hotlist' or 'inbox'." });
    }
    const filePath = FILES[resource];

    if (resource === 'prospect') {
      return handleProspect(req, res, ghHeaders);
    }
    if (resource === 'hotlist') {
      return handleHotlist(req, res, ghHeaders);
    }
    if (resource === 'inbox') {
      return handleInbox(req, res, ghHeaders);
    }

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
