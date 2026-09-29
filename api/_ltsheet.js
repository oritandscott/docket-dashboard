// Copies a Navigator transaction onto Orit & Scott's original Google Sheet,
// "LINEAR ESCROW & LISTING TRACKING CALENDAR", so the old tracker keeps
// agreeing with Navigator and the dashboard's Linear Tracker.
//
// The sheet's layout (Sheet1): one column per day, starting at column A =
// Dec 1, 2025 (row 6 = day of month, row 7 = weekday), and the 2026 block of
// transaction lines below it (rows 8 until the "2025 LISTINGS & ESCROWS"
// header). A line is the client label in the cell before the first day, the
// day cells (listing days, then escrow days counting from 0 at contract,
// with codes like INSP / BNSR / OPEN HAUS in place of a number), COE, and
// the label again in the cell after. Rows are reused: a new line goes on the
// first row that is empty across its whole span.
//
// Writing needs the service account (see _google.js) added to that sheet as
// an EDITOR. Called after a Confirmed tracker change (api/_apply.js).

import { googleGet, googleToken, serviceAccount } from './_google.js';

const SHEET_ID = '1UBjjxdrOp3bVRtsmENnwJkgnlodaR0CLDPOnUVTAprE';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const BASE = Date.UTC(2025, 11, 1); // column A
const DAY = 86400000;

const rgb = (hex) => ({ red: parseInt(hex.slice(0, 2), 16) / 255, green: parseInt(hex.slice(2, 4), 16) / 255, blue: parseInt(hex.slice(4, 6), 16) / 255 });
// The sheet's own colors.
const COLOR = {
  gray: rgb('D9D9D9'), dd: rgb('FFFF00'), esc: rgb('B6D7A8'), contract: rgb('FF00FF'),
  coe: rgb('FF0000'), cs: rgb('EAD1DC'), oh: rgb('9900FF'), white: rgb('FFFFFF'),
};

const dayOf = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
};
const colOf = (t) => Math.round((t - BASE) / DAY); // 0-based column index

function colName(i) {
  let s = '';
  for (let n = i + 1; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export function trackerLabel(l) {
  const names = String(l.clientNames || '').toUpperCase().trim();
  const addr = String(l.address || '').toUpperCase().trim();
  if (l.dealType === 'BUYER') return `${names} - BUYER${/&| AND /.test(names) ? 'S' : ''} - ${addr}`;
  const listed = l.dates && (l.dates.active || l.dates.comingSoon);
  return listed ? `${names} LISTING - ${addr}` : `${names} - SELLER${/&| AND /.test(names) ? 'S' : ''} - ${addr}`;
}

// Street number + first word of the street, e.g. "4824 E LA" -> used to
// find this property's existing line on the sheet.
function addressKey(addr) {
  const w = String(addr || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const i = w.findIndex((x) => /^\d+$/.test(x));
  if (i === -1) return '';
  const street = w.slice(i + 1).find((x) => !['N', 'S', 'E', 'W'].includes(x)) || '';
  return street ? `${w[i]} ${street}` : '';
}
// Upper-case words without N/S/E/W, so "15428 S 15TH" matches key "15428 15TH".
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter((w) => w && !['N', 'S', 'E', 'W'].includes(w)).join(' ');

// Day cells for one transaction: Map(dayTime -> {text, color}), plus span.
function lineCells(l, today) {
  const d = l.dates || {};
  const cells = new Map();
  const put = (t, text, color) => cells.set(t, { text, color });
  const contract = dayOf(d.contract);
  const coe = dayOf(d.closing);
  if (l.dealType !== 'BUYER') {
    const start = dayOf(d.active) || dayOf(d.comingSoon);
    if (start) {
      const stop = contract ? contract - DAY : Math.max(today, start);
      for (let t = start; t <= stop; t += DAY) put(t, (t - start) / DAY, COLOR.gray);
      if (dayOf(d.comingSoon) && dayOf(d.comingSoon) < (dayOf(d.active) || Infinity)) put(dayOf(d.comingSoon), 'CS', COLOR.cs);
      if (dayOf(d.active)) put(dayOf(d.active), 'A', COLOR.gray);
    }
  }
  if (contract && coe) {
    const ddEnd = dayOf(d.ddEnd);
    for (let t = contract; t < coe; t += DAY) {
      const n = (t - contract) / DAY;
      let color = COLOR.gray;
      if (l.dealType === 'BUYER') color = n === 0 ? COLOR.contract : ddEnd && t <= ddEnd ? COLOR.dd : COLOR.esc;
      put(t, n, color);
    }
    put(coe, 'COE', COLOR.coe);
  }
  (Array.isArray(l.events) ? l.events : []).forEach((ev) => {
    const t = dayOf(ev.date);
    if (!t || t === coe) return;
    const prev = cells.get(t);
    put(t, String(ev.code || ''), ev.code === 'OPEN HAUS' ? COLOR.oh : prev ? prev.color : null);
  });
  const ts = [...cells.keys()];
  if (!ts.length) return null;
  return { cells, first: Math.min(...ts), last: Math.max(...ts) };
}

async function sheetsFetch(token, url, init) {
  const r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  if (r.status === 403 || r.status === 404) {
    const sa = serviceAccount();
    throw Object.assign(new Error(`The old Linear Tracker sheet isn't shared with ${sa ? sa.client_email : 'the service account'} as an Editor yet.`), { status: 503, code: 'not_shared' });
  }
  if (!r.ok) throw Object.assign(new Error(`Google Sheets answered ${r.status}`), { status: 502 });
  return r.json();
}

// Writes (or rewrites) one Navigator record's line. Returns a short summary.
export async function writeTrackerLine(l, { today = Date.now() } = {}) {
  const todayT = Math.floor(today / DAY) * DAY;
  const line = lineCells(l, todayT);
  if (!line) return 'Nothing to copy to the old sheet yet (no dates).';
  const label = trackerLabel(l);
  const key = addressKey(l.address);

  const token = await googleToken(SCOPE);
  const meta = await sheetsFetch(token, `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties`);
  const props = meta.sheets[0].properties;
  const tab = props.title;
  const gr = await googleGet(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`'${tab}'!A1:ZZ60`)}`, token);
  if (gr.status === 403 || gr.status === 404) await sheetsFetch(token, `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=spreadsheetId`);
  const rows = (await gr.json()).values || [];
  const at = (r, c) => String((rows[r] || [])[c] ?? '').trim();

  // Sanity-check the layout before writing anything.
  if (at(5, 0) !== '1' || at(6, 0) !== 'M' || !/2026 LISTINGS/.test(at(3, 0))) {
    throw Object.assign(new Error('The old sheet layout changed (column A is no longer Mon Dec 1, 2025) -- not writing.'), { status: 409 });
  }
  let blockEnd = rows.findIndex((r, i) => i > 7 && /2025 LISTINGS/.test(String(r[0] || '')));
  if (blockEnd === -1) blockEnd = 45;
  // Line rows run from row 9 to just above the next year's header.
  const lastRow = blockEnd - 2;

  const startCol = colOf(line.first) - 1; // label before the first day
  const endCol = colOf(line.last) + 1; // label after the last day
  if (startCol < 0) throw Object.assign(new Error('This transaction starts before the old sheet does.'), { status: 409 });

  // Existing line for this property? Clear it first.
  let row = -1;
  let clear = null;
  if (key) {
    for (let r = 8; r <= lastRow && row === -1; r++) {
      const cells = rows[r] || [];
      const hits = [];
      cells.forEach((v, c) => { if (norm(v).includes(key)) hits.push(c); });
      // Only a line that is still current (ends after ~2 months ago).
      if (hits.length && hits[hits.length - 1] >= colOf(todayT) - 60) {
        row = r;
        const from = hits.length > 1 ? hits[hits.length - 2] : hits[0];
        clear = [Math.min(from, startCol), Math.max(hits[hits.length - 1], endCol)];
      }
    }
  }
  if (row === -1) {
    // First empty line row across the whole span (+1 spare cell each side).
    // Lines sit on rows 9, 11, 13... with a spacer row between.
    for (let r = 8; r <= lastRow; r += 2) {
      let free = true;
      for (let c = Math.max(0, startCol - 1); c <= endCol + 1 && free; c++) if (at(r, c)) free = false;
      if (free) { row = r; break; }
    }
  }
  if (row === -1) throw Object.assign(new Error('No free row in the 2026 section of the old sheet for this line.'), { status: 409 });

  const from = clear ? clear[0] : startCol;
  const to = clear ? clear[1] : endCol;
  // Only touch cells whose content changes, in contiguous runs, so an
  // updated line keeps the sheet's own colors and anything typed by hand
  // (e.g. "BNSR SENT" where Navigator would put a day number).
  const isNum = (x) => /^\d+$/.test(String(x).trim());
  const requests = [];
  let run = null;
  const flush = () => {
    if (!run) return;
    requests.push({
      updateCells: {
        range: { sheetId: props.sheetId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: run.start, endColumnIndex: run.start + run.values.length },
        rows: [{ values: run.values }],
        fields: 'userEnteredValue,userEnteredFormat.backgroundColor',
      },
    });
    run = null;
  };
  for (let c = from; c <= to; c++) {
    const t = BASE + c * DAY;
    let v = null;
    let color = null;
    if (c === startCol || c === endCol) v = label;
    else if (line.cells.has(t)) ({ text: v, color } = line.cells.get(t));
    const want = v === null ? '' : String(v);
    const have = at(row, c);
    const keepHandTyped = clear && have && !isNum(have) && have !== 'COE' && !norm(have).includes(key) && isNum(want);
    const keepLabel = clear && want === label && have && norm(have).includes(key);
    if (clear && (want === have || keepHandTyped || keepLabel)) { flush(); continue; }
    const cell = { userEnteredFormat: { backgroundColor: color || COLOR.white } };
    if (want) cell.userEnteredValue = typeof v === 'number' ? { numberValue: v } : { stringValue: want };
    if (!run) run = { start: c, values: [] };
    run.values.push(cell);
  }
  flush();
  if (!requests.length) return 'The old Linear Tracker sheet already matches.';
  await sheetsFetch(token, `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests }),
  });
  return `${clear ? 'Updated' : 'Added'} the line on the old Linear Tracker sheet (row ${row + 1}, ${colName(startCol)}-${colName(endCol)}).`;
}
