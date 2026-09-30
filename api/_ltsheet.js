// Copies a Navigator transaction onto Orit & Scott's original Google Sheet,
// "LINEAR ESCROW & LISTING TRACKING CALENDAR", so the Google Sheet Linear Tracker keeps
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
  black: rgb('000000'), sellerText: rgb('FF00FF'), buyerText: rgb('0000FF'),
};

// Text styles copied from the lines already on the sheet: labels are Arial
// bold at the normal size (pink for sellers, blue for buyers), right-aligned
// before the line so they spill left and stay readable, left-aligned after
// it; day numbers 13 bold; COE 12 bold white; short codes (INSP, BNSR
// SENT, OPEN HAUS...) tiny 6 bold and wrapped.
function cellFormat(kind, bg, buyer) {
  const f = { backgroundColor: bg || COLOR.white, verticalAlignment: 'MIDDLE', wrapStrategy: 'OVERFLOW_CELL' };
  const text = (size, color) => ({ fontFamily: 'Arial', bold: true, ...(size ? { fontSize: size } : {}), foregroundColor: color });
  if (kind === 'labelStart' || kind === 'labelEnd') {
    f.horizontalAlignment = kind === 'labelStart' ? 'RIGHT' : 'LEFT';
    f.textFormat = text(10, buyer ? COLOR.buyerText : COLOR.sellerText);
  } else if (kind === 'number' || kind === 'blank') {
    f.horizontalAlignment = 'CENTER';
    f.textFormat = text(13, bg === COLOR.contract ? COLOR.white : COLOR.black);
  } else if (kind === 'coe') {
    f.horizontalAlignment = 'CENTER';
    f.textFormat = text(12, COLOR.white);
  } else if (kind === 'short') { // CS, A
    f.horizontalAlignment = 'CENTER';
    f.textFormat = text(12, COLOR.black);
  } else { // event codes
    f.horizontalAlignment = 'CENTER';
    f.wrapStrategy = 'WRAP';
    f.textFormat = text(6, bg === COLOR.oh || bg === COLOR.contract ? COLOR.white : COLOR.black);
  }
  return f;
}
const kindOf = (v) => (v === null || v === '' ? 'blank' : typeof v === 'number' ? 'number' : v === 'COE' ? 'coe' : v === 'CS' || v === 'A' ? 'short' : 'code');

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
    throw Object.assign(new Error(`The Google Sheet Linear Tracker isn't shared with ${sa ? sa.client_email : 'the service account'} as an Editor yet.`), { status: 503, code: 'not_shared' });
  }
  if (!r.ok) throw Object.assign(new Error(`Google Sheets answered ${r.status}`), { status: 502 });
  return r.json();
}

// Writes (or rewrites) one Navigator record's line. Returns a short summary.
export async function writeTrackerLine(l, { today = Date.now(), fresh = false } = {}) {
  const todayT = Math.floor(today / DAY) * DAY;
  const line = lineCells(l, todayT);
  if (!line) return 'Nothing to copy to the Google Sheet Linear Tracker yet (no dates).';
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
    throw Object.assign(new Error('The Google Sheet Linear Tracker layout changed (column A is no longer Mon Dec 1, 2025) -- not writing.'), { status: 409 });
  }
  let blockEnd = rows.findIndex((r, i) => i > 7 && /2025 LISTINGS/.test(String(r[0] || '')));
  if (blockEnd === -1) blockEnd = 45;
  // Line rows run from row 9 to just above the next year's header.
  const lastRow = blockEnd - 2;

  const startCol = colOf(line.first) - 1; // label before the first day
  const endCol = colOf(line.last) + 1; // label after the last day
  if (startCol < 0) throw Object.assign(new Error('This transaction starts before the Google Sheet Linear Tracker does.'), { status: 409 });

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
  if (row === -1) throw Object.assign(new Error('No free row in the 2026 section of the Google Sheet Linear Tracker for this line.'), { status: 409 });

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
        fields: 'userEnteredValue,userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)',
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
    // fresh: rewrite every cell (fixes a line this code wrote earlier).
    const keepHandTyped = clear && !fresh && have && !isNum(have) && have !== 'COE' && !norm(have).includes(key) && isNum(want);
    const keepLabel = clear && !fresh && want === label && have && norm(have).includes(key);
    if (clear && !fresh && (want === have || keepHandTyped || keepLabel)) { flush(); continue; }
    const kind = c === startCol ? 'labelStart' : c === endCol ? 'labelEnd' : kindOf(v);
    const cell = { userEnteredFormat: cellFormat(kind, kind.startsWith('label') ? null : color, l.dealType === 'BUYER') };
    if (want) cell.userEnteredValue = typeof v === 'number' ? { numberValue: v } : { stringValue: want };
    if (!run) run = { start: c, values: [] };
    run.values.push(cell);
  }
  flush();
  if (!requests.length) return 'The Google Sheet Linear Tracker already matches.';
  // Same row height as the other lines.
  requests.push({ updateDimensionProperties: { range: { sheetId: props.sheetId, dimension: 'ROWS', startIndex: row, endIndex: row + 1 }, properties: { pixelSize: 26 }, fields: 'pixelSize' } });
  await sheetsFetch(token, `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests }),
  });
  return `${clear ? 'Updated' : 'Added'} the line on the Google Sheet Linear Tracker (row ${row + 1}, ${colName(startCol)}-${colName(endCol)}).`;
}

// The black "today" box: a thin outline down one day column (rows 6-23 on
// the sheet). Moves it to today's column (Phoenix date). Run every morning
// by the digest cron, after each Confirmed tracker change, and on demand
// via ?job=lt-today.
export async function moveTodayBox({ today = Date.now() } = {}) {
  // Phoenix is UTC-7 all year (no daylight saving).
  const todayT = Math.floor((today - 7 * 3600000) / DAY) * DAY;
  const col = colOf(todayT);
  const token = await googleToken(SCOPE);
  const fields = 'sheets(properties(sheetId,title),data(rowData(values(effectiveFormat(borders)))))';
  const d = await sheetsFetch(token, `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?ranges=${encodeURIComponent('A6:ZZ23')}&fields=${encodeURIComponent(fields)}`);
  const sheet = d.sheets[0];
  const sheetId = sheet.properties.sheetId;
  const rows = (sheet.data && sheet.data[0] && sheet.data[0].rowData) || [];
  const b = (r, c) => (((rows[r] || {}).values || [])[c] || {}).effectiveFormat?.borders || {};
  const has = (side) => side && side.style && side.style !== 'NONE';
  // Old box = columns outlined left+right on both the header (row 7) and a
  // spacer row inside the box (row 8).
  const width = Math.max(...rows.map((r) => (r.values || []).length), 0);
  const old = [];
  for (let c = 0; c < width; c++) if (has(b(1, c).left) && has(b(1, c).right) && has(b(2, c).left) && has(b(2, c).right)) old.push(c);
  if (old.length === 1 && old[0] === col) return 'The today box is already on today.';
  const none = { style: 'NONE' };
  const thin = { style: 'SOLID', color: COLOR.black };
  const requests = [];
  for (const c of old) {
    if (c === col) continue;
    for (let r = 0; r < rows.length; r++) {
      const cell = b(r, c);
      // Inside the box, leave cells that are part of some other outline.
      const inner = r > 0 && r < rows.length - 1;
      if (inner && (has(cell.top) || has(cell.bottom))) continue;
      requests.push({ updateBorders: { range: { sheetId, startRowIndex: 5 + r, endRowIndex: 6 + r, startColumnIndex: c, endColumnIndex: c + 1 },
        left: none, right: none, ...(r === 0 ? { top: none } : {}), ...(r === rows.length - 1 ? { bottom: none } : {}) } });
    }
  }
  requests.push({ updateBorders: { range: { sheetId, startRowIndex: 5, endRowIndex: 23, startColumnIndex: col, endColumnIndex: col + 1 }, left: thin, right: thin, top: thin, bottom: thin } });
  await sheetsFetch(token, `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) });
  return `Moved the today box to ${colName(col)} (${new Date(todayT).toISOString().slice(0, 10)}).`;
}
