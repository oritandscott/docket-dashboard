// "Sync with Command" lookup for the Prospecting lists. KW Command has no
// API this dashboard can use, but API Nation keeps a copy of every Command
// contact in the Google Sheet "OASIS TEAM CONTACTS FROM COMMAND VIA API
// NATION". This reads that sheet with the Google service account (see
// _google.js) and finds a contact by phone, email or name.
//
// Dispatched from api/machine-status.js as POST ?job=command-lookup
// (Vercel Hobby's 12-function cap). Returns only the few fields the
// dashboard needs -- never the whole contact list.

import { readSheetValues } from './_google.js';

const SHEET_ID = '1oZ03wqwq7HL9frTt0CgKT_9yMxHBL9YDyXdmkpkVw5g';
const RANGE = 'Sheet1!A1:AP5000';
// Best-known Command contact page format; Orit & Scott can correct a link
// with "Change link" on the dashboard if Command's URL differs.
const CONTACT_URL = (id) => `https://console.command.kw.com/command/contacts/${encodeURIComponent(id)}`;

let cache = null; // { at, contacts }

const digits = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

async function contacts() {
  if (cache && Date.now() - cache.at < 5 * 60 * 1000) return cache.contacts;
  const rows = await readSheetValues(SHEET_ID, RANGE);
  const head = (rows[0] || []).map((h) => String(h).trim());
  const col = (name) => head.indexOf(name);
  const c = { first: col('First Name'), last: col('Last Name'), email: col('Primary Email'), phone: col('Primary Phone'), id: col('ID'), spouse: col('Spouse Full Name'), partner: col('Partner Full Name') };
  const list = rows.slice(1).map((r) => ({
    id: r[c.id] || '',
    name: `${r[c.first] || ''} ${r[c.last] || ''}`.trim(),
    email: r[c.email] || '',
    phone: r[c.phone] || '',
    also: [r[c.spouse], r[c.partner]].filter(Boolean).join(' '),
  })).filter((x) => x.id && x.name);
  cache = { at: Date.now(), contacts: list };
  return list;
}

export async function runCommandLookup(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { name, phone, email, loose } = req.body || {};
  // loose: the "Already in Command? Find them" button -- also list same-last-name
  // contacts so the right one can be picked by hand.
  const minScore = loose ? 10 : 50;
  try {
    const all = await contacts();
    const p = digits(phone);
    const e = String(email || '').trim().toLowerCase();
    const nameWords = norm(name).split(' ').filter((w) => w.length > 1 && w !== 'and');
    // Couples ("Tim & Mary K Duckworth") -- also try each person on their own.
    const people = String(name || '').split(/\s*(?:&|\band\b)\s*/i).map(norm).filter(Boolean);
    const last = nameWords[nameWords.length - 1];

    const scored = all.map((ct) => {
      let score = 0;
      if (p.length === 10 && digits(ct.phone) === p) score += 100;
      if (e && ct.email.toLowerCase() === e) score += 100;
      const cn = norm(ct.name);
      if (cn && people.some((pp) => pp === cn || (pp.split(' ').length > 1 && cn === pp))) score += 60;
      else if (last && cn.split(' ').pop() === last && nameWords.some((w) => cn.split(' ')[0] === w)) score += 50;
      else if (last && cn.split(' ').pop() === last) score += 10;
      return { ct, score };
    }).filter((x) => x.score >= minScore).sort((a, b) => b.score - a.score).slice(0, 5);

    return res.status(200).json({
      ok: true,
      matches: scored.map(({ ct, score }) => ({
        id: ct.id, name: ct.name, phone: ct.phone, email: ct.email, url: CONTACT_URL(ct.id), strong: score >= 100, score,
      })),
    });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code || null });
  }
}
