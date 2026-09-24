// Today's Google Calendar events, grouped by KW office, for the dashboard's
// "Today" panel (Tempe / Gilbert / Scottsdale cards). This deliberately
// duplicates the office-normalization logic from api/_digest.js's
// loadCalendar()/normalizeKWLabel() rather than importing it, so a change to
// one can't silently change the other's behavior -- see
// claude/daily-digest-status.md in the project notes for why. If the KW
// office-detection rules ever change, update both files.
//
// Underscore-prefixed so Vercel doesn't count it as a serverless function
// (Hobby caps at 12; this repo already sits at exactly 12 counted files).
// Called from api/machine-status.js as /api/machine-status?job=calendar.

const TZ = 'America/Phoenix';

function phoenixDateISO(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

async function googleAccessToken(clientId, clientSecret, refreshToken, label) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`${label} sign-in failed (${res.status})`);
  return (await res.json()).access_token;
}

function colorFamily(hex) {
  if (!hex) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const r = parseInt(m[1].slice(0, 2), 16), g = parseInt(m[1].slice(2, 4), 16), b = parseInt(m[1].slice(4, 6), 16);
  if (r > 180 && g > 150 && b < 130) return 'yellow';
  if (b > r && b > g && b > 120) return 'blue';
  if (r > g && r > b && g < 130 && b < 130) return 'red';
  return null;
}

// Same address/color disambiguation as the digest email -- see that file's
// comment for the full rationale.
const MCDOWELL_RE = /6400\s*E\.?\s*McDowell/i;
const WARNER_RE = /2077\s*E\.?\s*Warner/i;
const STREET_ADDRESS_RE = /\d+\s+[A-Za-z].*\b(Rd|Rd\.|St|St\.|Ave|Ave\.|Dr|Dr\.|Ln|Ln\.|Blvd|Blvd\.|Way|Pkwy|Pkwy\.)\b|,\s*[A-Z]{2}\s*\d{5}/;

function normalizeKWLabel(calName, location, ev, cal, eventColors, calendarColors) {
  const isKWRP = /KWRP/i.test(calName);
  const isKWIF = /KWIF/i.test(calName);
  if (!isKWRP && !isKWIF) return { calName, location };

  if (isKWIF) {
    const keptLocation = STREET_ADDRESS_RE.test(location) ? '' : location;
    return { calName: 'KWIF Gilbert', location: keptLocation };
  }

  if (MCDOWELL_RE.test(location)) return { calName: 'KWRP Scottsdale', location: '' };
  if (WARNER_RE.test(location)) return { calName: 'KWRP Tempe', location: '' };
  if (!/Tempe|Scottsdale/i.test(calName)) {
    const eventHex = ev.colorId && eventColors[ev.colorId] && eventColors[ev.colorId].background;
    const calHex = cal.backgroundColor || (cal.colorId && calendarColors[cal.colorId] && calendarColors[cal.colorId].background);
    const family = colorFamily(eventHex) || colorFamily(calHex);
    const keptLocation = STREET_ADDRESS_RE.test(location) ? '' : location;
    if (family === 'blue') return { calName: 'KWRP Tempe', location: keptLocation };
    if (family === 'yellow') return { calName: 'KWRP Scottsdale', location: keptLocation };
    if (family === 'red') return { calName: 'KWIF Gilbert', location: keptLocation };
  }
  if (STREET_ADDRESS_RE.test(location)) return { calName, location: '' };
  return { calName, location };
}

const OFFICE_ORDER = ['KWRP Tempe', 'KWIF Gilbert', 'KWRP Scottsdale'];

// Today only (not tomorrow, unlike the digest email) -- this panel is named
// "Today" and the layout is a fixed 2x2 grid, so it stays compact by design.
export async function loadTodayCalendar() {
  const { GCAL_CLIENT_ID: id, GCAL_CLIENT_SECRET: secret, GCAL_REFRESH_TOKEN: refresh } = process.env;
  if (!id || !secret || !refresh) throw new Error('Calendar credentials are not set up');
  const token = await googleAccessToken(id, secret, refresh, 'Calendar');
  const headers = { Authorization: `Bearer ${token}` };

  const now = new Date();
  const todayISO = phoenixDateISO(now);
  const timeMin = new Date(`${todayISO}T00:00:00-07:00`);
  const timeMax = new Date(timeMin.getTime() + 24 * 60 * 60 * 1000);

  const [listRes, colorsRes] = await Promise.all([
    fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250', { headers }),
    fetch('https://www.googleapis.com/calendar/v3/colors', { headers }),
  ]);
  if (!listRes.ok) throw new Error(`Google Calendar returned ${listRes.status}`);
  const calendars = ((await listRes.json()).items || []).filter((c) => !c.deleted && !c.hidden);
  const colorsData = colorsRes.ok ? await colorsRes.json() : { event: {}, calendar: {} };
  const eventColors = colorsData.event || {};
  const calendarColors = colorsData.calendar || {};

  const seen = new Map();
  const events = [];
  let failedCalendars = 0;

  await Promise.all(
    calendars.map(async (cal) => {
      const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events`);
      url.searchParams.set('timeMin', timeMin.toISOString());
      url.searchParams.set('timeMax', timeMax.toISOString());
      url.searchParams.set('singleEvents', 'true');
      url.searchParams.set('orderBy', 'startTime');
      url.searchParams.set('maxResults', '100');
      url.searchParams.set('timeZone', TZ);
      const res = await fetch(url, { headers });
      if (!res.ok) { failedCalendars += 1; return; }
      ((await res.json()).items || []).forEach((ev) => {
        if (ev.status === 'cancelled') return;
        const me = (ev.attendees || []).find((a) => a.self);
        if (me && me.responseStatus === 'declined') return;
        const allDay = !!(ev.start && ev.start.date);
        const startISO = allDay ? ev.start.date : ev.start && ev.start.dateTime;
        if (!startISO) return;
        const rawCalName = cal.summaryOverride || cal.summary || cal.id;
        const { calName } = normalizeKWLabel(rawCalName, ev.location || '', ev, cal, eventColors, calendarColors);
        const key = `${(ev.summary || '').trim().toLowerCase()}|${startISO}`;
        if (seen.has(key)) {
          const existing = seen.get(key);
          if (!existing.calendars.includes(calName)) existing.calendars.push(calName);
          return;
        }
        const entry = {
          title: ev.summary || '(no title)',
          allDay,
          startISO,
          calendars: [calName],
          sortMs: allDay ? new Date(`${ev.start.date}T00:00:00-07:00`).getTime() : new Date(startISO).getTime(),
        };
        seen.set(key, entry);
        events.push(entry);
      });
    })
  );

  events.sort((a, b) => a.sortMs - b.sortMs || Number(b.allDay) - Number(a.allDay));

  const groups = { 'KWRP Tempe': [], 'KWIF Gilbert': [], 'KWRP Scottsdale': [], Other: [] };
  events.forEach((e) => {
    const key = OFFICE_ORDER.includes(e.calendars[0]) ? e.calendars[0] : 'Other';
    groups[key].push({ title: e.title, allDay: e.allDay, startISO: e.startISO });
  });

  return {
    todayISO,
    calendarCount: calendars.length,
    failedCalendars,
    tempe: groups['KWRP Tempe'],
    gilbert: groups['KWIF Gilbert'],
    scottsdale: groups['KWRP Scottsdale'],
    other: groups.Other,
  };
}
