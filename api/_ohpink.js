// Pink check for the Prospecting lists. In Orit & Scott's OPEN HOUSE
// ATTENDANCE Google Sheets, a phone or email typed in PINK means the person
// did NOT give it to us -- Orit & Scott found it themselves. This reads the
// sheets' values AND colors directly through the Google Sheets API (no file
// downloads) with the service account in _google.js, finds each contact's
// row, and reports whether their phone/email cell is pink.
//
// Dispatched from api/machine-status.js as POST ?job=oh-pink
// (Vercel Hobby's 12-function cap). Needs the service account to be able to
// see the sheets (share their Drive folder with it as Viewer).

import { googleToken } from './_google.js';

const SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/spreadsheets.readonly';
let cache = null; // { at, people: [...] }

const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const digits = (v) => String(v || '').replace(/\D/g, '').slice(-10);

// Pink/magenta text, or a pink cell fill (but not light red).
function isPink(cell) {
  const f = (cell && cell.effectiveFormat) || {};
  const t = (f.textFormat && (f.textFormat.foregroundColorStyle?.rgbColor || f.textFormat.foregroundColor)) || null;
  const bg = f.backgroundColorStyle?.rgbColor || f.backgroundColor || null;
  const c = (o) => ({ r: o.red || 0, g: o.green || 0, b: o.blue || 0 });
  if (t) { const { r, g, b } = c(t); if (r >= 0.75 && b >= 0.45 && g <= 0.55) return true; }
  if (bg) { const { r, g, b } = c(bg); if (r >= 0.88 && b >= 0.6 && g <= 0.86 && b > g + 0.02) return true; }
  return false;
}

async function listSheets(token) {
  const files = [];
  let pageToken = '';
  do {
    const q = encodeURIComponent("name contains 'OPEN HOUSE ATTENDANCE' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false");
    const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=nextPageToken,files(id,name)&pageSize=200&includeItemsFromAllDrives=true&supportsAllDrives=true${pageToken ? `&pageToken=${pageToken}` : ''}`,
      { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw Object.assign(new Error(`Google Drive answered ${r.status}`), { status: 502 });
    const d = await r.json();
    files.push(...(d.files || []));
    pageToken = d.nextPageToken || '';
  } while (pageToken);
  return files;
}

async function readPeople(token, file) {
  const fields = 'sheets(data(rowData(values(formattedValue,effectiveFormat(textFormat(foregroundColor,foregroundColorStyle),backgroundColor,backgroundColorStyle)))))';
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${file.id}?ranges=${encodeURIComponent('A1:Z150')}&fields=${encodeURIComponent(fields)}`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return [];
  const d = await r.json();
  const rows = d.sheets?.[0]?.data?.[0]?.rowData || [];
  const text = (row, i) => String(row.values?.[i]?.formattedValue || '').trim();
  const hi = rows.findIndex((row) => (row.values || []).some((v) => String(v.formattedValue || '').trim() === 'CELL PHONE'));
  if (hi === -1) return [];
  const head = (rows[hi].values || []).map((v) => String(v.formattedValue || '').trim());
  const col = { first: head.indexOf('FIRST'), last: head.indexOf('LAST'), phone: head.indexOf('CELL PHONE'), email: head.indexOf('PERSONAL EMAIL') };
  if (col.first < 0 || col.last < 0) return [];
  const out = [];
  for (const row of rows.slice(hi + 1)) {
    const first = text(row, col.first), last = text(row, col.last);
    if (!first && !last) continue;
    const phoneCell = row.values?.[col.phone], emailCell = row.values?.[col.email];
    out.push({
      name: `${first} ${last}`.trim(), first: norm(first), last: norm(last),
      phone: text(row, col.phone), email: col.email >= 0 ? text(row, col.email) : '',
      phonePink: !!(phoneCell?.formattedValue && isPink(phoneCell)),
      emailPink: !!(emailCell?.formattedValue && isPink(emailCell)),
      sheet: file.name,
    });
  }
  return out;
}

async function allPeople() {
  if (cache && Date.now() - cache.at < 15 * 60 * 1000) return cache.people;
  const token = await googleToken(SCOPES);
  const files = await listSheets(token);
  const people = [];
  for (let i = 0; i < files.length; i += 8) {
    const batch = await Promise.all(files.slice(i, i + 8).map((f) => readPeople(token, f).catch(() => [])));
    batch.forEach((b) => people.push(...b));
  }
  cache = { at: Date.now(), people };
  return people;
}

export async function runOhPink(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const contacts = Array.isArray(req.body?.contacts) ? req.body.contacts.slice(0, 100) : [];
  try {
    const people = await allPeople();
    const results = [];
    for (const c of contacts) {
      const p = digits(c.phone), e = String(c.email || '').trim().toLowerCase();
      // Couples ("Tim & Mary K Duckworth"): any of the people named.
      const words = norm(c.name).split(' ');
      const last = words[words.length - 1];
      const firsts = String(c.name || '').split(/\s*(?:&|\band\b)\s*/i).map((s) => norm(s).split(' ')[0]).filter(Boolean);
      const rows = people.filter((x) =>
        (p.length === 10 && digits(x.phone) === p) ||
        (e && x.email.toLowerCase() === e) ||
        (last && x.last === last && firsts.some((f) => x.first === f || x.first.split(' ')[0] === f)));
      if (!rows.length) continue;
      const phoneRow = rows.find((x) => p.length === 10 && digits(x.phone) === p) || rows.find((x) => x.phone);
      const emailRow = rows.find((x) => e && x.email.toLowerCase() === e) || rows.find((x) => x.email);
      results.push({
        id: c.id,
        phone: phoneRow ? phoneRow.phone : '', phonePink: phoneRow ? phoneRow.phonePink : false,
        email: emailRow ? emailRow.email : '', emailPink: emailRow ? emailRow.emailPink : false,
        sheet: (phoneRow || emailRow || rows[0]).sheet,
      });
    }
    return res.status(200).json({ ok: true, results });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code || null });
  }
}
