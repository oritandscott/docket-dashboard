// Confirm step for Linear Escrow Tracker commands. Claude reads a command
// from data/prospecting-inbox.json (topic 'tracker') and writes one or more
// `proposals` onto that note -- each a plain-English label plus one
// whitelisted Navigator operation. The dashboard shows each proposal with a
// Confirm button; this applies ONE of them by calling Navigator's
// POST /api/admin/apply-change with the shared secret, then records the
// result back on the note.
//
// Safety: the browser only sends {noteId, pid}. The operation itself is read
// from the committed inbox file, so this can only apply a change Claude
// already proposed -- never an arbitrary edit sent from the page (the
// dashboard has no login). Existing records are found by `match` text
// against the live snapshot and must resolve to exactly one record.
//
// Dispatched from api/machine-status.js as POST ?job=apply (Vercel Hobby's
// 12-function cap).

import { loadSnapshot, navSecret } from './_snapshot.js';
import { moveTodayBox, writeTrackerLine } from './_ltsheet.js';

const REPO = 'oritandscott/docket-dashboard';
const FILE_PATH = 'data/prospecting-inbox.json';
const BRANCH = 'main';
const APPLY_URL = 'https://nav.oasisgroupaz.com/api/admin/apply-change';
const OPS = ['create_transaction', 'set_escrow_dates', 'set_status', 'waive_appraisal', 'waive_inspection', 'private_sale', 'binsr', 'set_inspection', 'offer_terms', 'add_open_house', 'copy_to_sheet'];

// After a Navigator change, copy that record's line onto the old Google
// Sheet tracker. Never fails the Confirm -- the outcome is just noted.
async function syncSheet(navId) {
  try {
    const snap = await loadSnapshot();
    const rec = (snap.listings || []).find((l) => l.id === navId);
    if (!rec) return 'Google Sheet Linear Tracker: record not in the live snapshot, not copied.';
    const msg = await writeTrackerLine(rec);
    await moveTodayBox().catch(() => {});
    return 'Google Sheet Linear Tracker: ' + msg;
  } catch (e) {
    return 'Google Sheet Linear Tracker not updated: ' + String(e.message || e);
  }
}

function gh() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw Object.assign(new Error('Missing required environment variable: GITHUB_TOKEN.'), { status: 500 });
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}

async function readInbox(headers) {
  const url = `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`;
  const r = await fetch(`${url}?ref=${BRANCH}`, { headers });
  if (!r.ok) throw Object.assign(new Error('Could not read the inbox from GitHub'), { status: 502 });
  const d = await r.json();
  return { url, sha: d.sha, notes: JSON.parse(Buffer.from(d.content, 'base64').toString('utf-8')) };
}

async function writeInbox(headers, url, sha, notes, message) {
  return fetch(url, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sha, branch: BRANCH, content: Buffer.from(JSON.stringify(notes, null, 2) + '\n').toString('base64') }),
  });
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Find the one Navigator record a proposal means, by client name/address.
async function resolveTarget(match) {
  const q = norm(match);
  if (!q) throw new Error('This proposal has no client to match');
  const words = q.split(' ');
  const snap = await loadSnapshot();
  const hits = (snap.listings || []).filter((l) => {
    const hay = norm(`${l.clientNames} ${l.address}`);
    return words.every((w) => hay.includes(w));
  });
  if (hits.length !== 1) {
    throw new Error(hits.length
      ? `"${match}" matches ${hits.length} Navigator records (${hits.map((h) => `${h.clientNames} - ${h.dealType === 'BUYER' ? 'buyer' : 'seller'} - ${h.address}`).join('; ')}) -- reply with which one`
      : `No active Navigator record matches "${match}"`);
  }
  return hits[0];
}

export async function runApply(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { noteId, pid } = req.body || {};
  if (!noteId || !pid) return res.status(400).json({ error: 'noteId and pid are required' });

  try {
    const headers = gh();
    let { url, sha, notes } = await readInbox(headers);
    let note = notes.find((n) => n.id === noteId);
    let prop = note && Array.isArray(note.proposals) ? note.proposals.find((p) => p.pid === pid) : null;
    if (!prop) return res.status(404).json({ error: 'That proposal no longer exists' });
    if (prop.status === 'applied') return res.status(200).json({ ok: true, already: true, proposal: prop });
    if (!OPS.includes(prop.op)) return res.status(400).json({ error: `Operation "${prop.op}" is not allowed` });

    let result;
    try {
      const payload = { ...(prop.args || {}), op: prop.op };
      if (prop.op !== 'create_transaction') {
        const target = await resolveTarget(prop.match);
        payload.id = target.id;
      }
      if (prop.op === 'copy_to_sheet') {
        // Google Sheet Linear Tracker only -- no Navigator write.
        const rec = (await loadSnapshot()).listings.find((l) => l.id === payload.id);
        const sheet = await writeTrackerLine(rec, { fresh: !!(prop.args && prop.args.fresh) });
        await moveTodayBox().catch(() => {});
        result = { status: 'applied', result: sheet, navId: payload.id };
      } else {
        const r = await fetch(APPLY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-docket-shared-secret': navSecret() },
          body: JSON.stringify(payload),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `Navigator answered ${r.status}`);
        const navId = data.id || payload.id;
        const sheet = navId ? await syncSheet(navId) : '';
        result = { status: 'applied', result: [data.summary || 'Applied', sheet].filter(Boolean).join(' '), navId };
      }
    } catch (e) {
      result = { status: 'failed', result: String(e.message || e) };
    }

    // Record the outcome (re-read + one retry in case the file moved on).
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) ({ url, sha, notes } = await readInbox(headers));
      note = notes.find((n) => n.id === noteId);
      prop = note && note.proposals.find((p) => p.pid === pid);
      if (!prop) break;
      Object.assign(prop, result, { decidedAt: new Date().toISOString() });
      if (note.proposals.every((p) => p.status === 'applied' || p.status === 'skipped')) note.status = 'done';
      note.updatedAt = new Date().toISOString();
      const w = await writeInbox(headers, url, sha, notes, `Tracker command: ${result.status} -- ${prop.label || prop.op}`);
      if (w.ok) break;
      if (w.status !== 409) break;
    }
    return res.status(result.status === 'applied' ? 200 : 502).json({ ok: result.status === 'applied', proposal: prop, note });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
}

// Skip a proposal without touching Navigator.
export async function runSkip(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { noteId, pid } = req.body || {};
  try {
    const headers = gh();
    const { url, sha, notes } = await readInbox(headers);
    const note = notes.find((n) => n.id === noteId);
    const prop = note && Array.isArray(note.proposals) ? note.proposals.find((p) => p.pid === pid) : null;
    if (!prop) return res.status(404).json({ error: 'That proposal no longer exists' });
    if (prop.status === 'applied') return res.status(400).json({ error: 'Already applied' });
    Object.assign(prop, { status: 'skipped', decidedAt: new Date().toISOString() });
    if (note.proposals.every((p) => p.status === 'applied' || p.status === 'skipped')) note.status = 'done';
    const w = await writeInbox(headers, url, sha, notes, `Tracker command: skipped -- ${prop.label || prop.op}`);
    if (!w.ok) return res.status(502).json({ error: 'Could not save' });
    return res.status(200).json({ ok: true, proposal: prop, note });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
}
