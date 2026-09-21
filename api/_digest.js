// Daily Dashboard Digest -- builds and emails one morning summary of anything
// new in the Docket Dashboard: Book-A-Call form entries, YouTube comments on
// both channels, new Ghostwriter blog drafts, and the next few days of Google
// Calendar (every calendar the account can see).
//
// Lives in api/_digest.js (underscore-prefixed, so Vercel does NOT count it as
// a serverless function -- this repo sits at exactly 12) and is invoked from
// api/machine-status.js when called as /api/machine-status?job=digest. The
// daily cron in vercel.json calls that URL at 13:00 UTC (6:00am Phoenix; on
// Vercel Hobby the run lands somewhere between 6:00 and 6:59am).
//
// READ-ONLY everywhere: never replies to comments, never dismisses drafts,
// never contacts clients. The only thing it sends is this one email, to the
// two team inboxes below. The HTTP response never contains lead data.
//
// "New since last digest" is a fixed 24-hour window ending at the most recent
// 6:00am Phoenix (13:00 UTC), so cron jitter inside the hour can never cause
// gaps or double-reporting, and no state has to be stored (a stored marker
// would mean a GitHub commit -- and a Vercel redeploy -- every morning).

const DASHBOARD_URL = 'https://docket-dashboard-two.vercel.app';
const BOOKACALL_FORM_ID = '1420zf0e7MpsflMaM7KScrTaozxVxQP12cfPfvItJd08';
const RECIPIENTS = ['oritandscott@gmail.com', 'scott@oasisgroupaz.com'];
const TZ = 'America/Phoenix';
const CALENDAR_DAYS_AHEAD = 3; // today + next 3 days
const STALE_DRAFT_DAYS = 3;

// ---------- small helpers ----------

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const fmt = (date, opts) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts }).format(date);

function phoenixDateISO(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// Window = [end - 24h, end) where end is the latest 13:00 UTC (6:00am Phoenix)
// at or before "now".
function digestWindow(now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 13, 0, 0));
  if (end > now) end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return { start, end };
}

const inWindow = (iso, { start, end }) => {
  if (!iso) return false;
  const t = new Date(iso);
  return t >= start && t < end;
};

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

// Each section returns { ok: true, ... } or { ok: false, error } and never throws.
async function safe(fn) {
  try {
    return { ok: true, ...(await fn()) };
  } catch (err) {
    return { ok: false, error: err.message || 'unknown error' };
  }
}

// ---------- section: Book-A-Call ----------

async function loadBookACall(win) {
  const { BOOKACALL_CLIENT_ID: id, BOOKACALL_CLIENT_SECRET: secret, BOOKACALL_REFRESH_TOKEN: refresh } = process.env;
  if (!id || !secret || !refresh) throw new Error('Book-A-Call credentials are not set up');
  const token = await googleAccessToken(id, secret, refresh, 'Book-A-Call');
  const headers = { Authorization: `Bearer ${token}` };

  const res = await fetch(`https://forms.googleapis.com/v1/forms/${BOOKACALL_FORM_ID}/responses`, { headers });
  if (!res.ok) throw new Error(`Google Forms returned ${res.status}`);
  const data = await res.json();
  const fresh = (data.responses || []).filter((r) => inWindow(r.lastSubmittedTime || r.createTime, win));

  // Question titles need the form definition, which this token may not be
  // allowed to read. Fail soft: fall back to "Answer 1", "Answer 2"...
  const titles = new Map();
  try {
    const formRes = await fetch(`https://forms.googleapis.com/v1/forms/${BOOKACALL_FORM_ID}`, { headers });
    if (formRes.ok) {
      const form = await formRes.json();
      (form.items || []).forEach((item) => {
        const qid = item.questionItem && item.questionItem.question && item.questionItem.question.questionId;
        if (qid) titles.set(qid, item.title || '');
      });
    }
  } catch (_) { /* ignore */ }

  const entries = fresh
    .sort((a, b) => new Date(a.lastSubmittedTime || a.createTime) - new Date(b.lastSubmittedTime || b.createTime))
    .map((r) => {
      let n = 0;
      const fields = Object.entries(r.answers || {}).map(([qid, a]) => {
        n += 1;
        const value = ((a.textAnswers && a.textAnswers.answers) || []).map((x) => x.value).join(', ');
        return { label: titles.get(qid) || `Answer ${n}`, value };
      });
      return { at: r.lastSubmittedTime || r.createTime, email: r.respondentEmail || '', fields };
    });
  return { entries };
}

// ---------- section: YouTube comments ----------

async function loadYouTube(win) {
  const { YT_CLIENT_ID: cid, YT_CLIENT_SECRET: csecret } = process.env;
  const channels = [
    { id: process.env.YT_CHANNEL_1_ID, label: process.env.YT_CHANNEL_1_NAME || 'Channel 1', refresh: process.env.YT_CHANNEL_1_REFRESH_TOKEN, anchor: 'comments-channel1' },
    { id: process.env.YT_CHANNEL_2_ID, label: process.env.YT_CHANNEL_2_NAME || 'Channel 2', refresh: process.env.YT_CHANNEL_2_REFRESH_TOKEN, anchor: 'comments-channel2' },
  ].filter((c) => c.id && c.refresh);
  if (!cid || !csecret || channels.length === 0) throw new Error('YouTube credentials are not set up');

  const perChannel = await Promise.all(
    channels.map(async (c) => {
      const r = await safe(async () => {
        const token = await googleAccessToken(cid, csecret, c.refresh, `YouTube (${c.label})`);
        const url = new URL('https://www.googleapis.com/youtube/v3/commentThreads');
        url.searchParams.set('part', 'snippet');
        url.searchParams.set('allThreadsRelatedToChannelId', c.id);
        url.searchParams.set('order', 'time');
        url.searchParams.set('maxResults', '100');
        url.searchParams.set('textFormat', 'plainText');
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(`YouTube returned ${res.status} for ${c.label}`);
        const data = await res.json();
        const comments = (data.items || [])
          .map((item) => {
            const top = item.snippet.topLevelComment.snippet;
            return {
              id: item.snippet.topLevelComment.id,
              author: top.authorDisplayName,
              text: top.textDisplay,
              at: top.publishedAt,
              videoId: top.videoId,
              replyCount: item.snippet.totalReplyCount || 0,
            };
          })
          .filter((cm) => inWindow(cm.at, win));

        // Video titles (best effort).
        const titles = new Map();
        const ids = [...new Set(comments.map((cm) => cm.videoId))];
        if (ids.length) {
          const vUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
          vUrl.searchParams.set('part', 'snippet');
          vUrl.searchParams.set('id', ids.slice(0, 50).join(','));
          const vRes = await fetch(vUrl, { headers: { Authorization: `Bearer ${token}` } });
          if (vRes.ok) ((await vRes.json()).items || []).forEach((v) => titles.set(v.id, v.snippet.title));
        }
        return { comments: comments.map((cm) => ({ ...cm, videoTitle: titles.get(cm.videoId) || '' })) };
      });
      return { label: c.label, anchor: c.anchor, ...r };
    })
  );
  return { channels: perChannel };
}

// ---------- section: Ghostwriter blog drafts ----------

async function loadDrafts(win) {
  const { WP_SITE_URL, DOCKET_SHARED_SECRET } = process.env;
  if (!WP_SITE_URL || !DOCKET_SHARED_SECRET) throw new Error('WordPress connection is not set up');
  const res = await fetch(`${WP_SITE_URL.replace(/\/$/, '')}/wp-json/docket/v1/list-drafts`, {
    headers: { 'X-Docket-Secret': DOCKET_SHARED_SECRET },
  });
  if (!res.ok) throw new Error(`WordPress returned ${res.status}`);
  const drafts = (await res.json()).drafts || [];
  const staleCutoff = new Date(win.end.getTime() - STALE_DRAFT_DAYS * 24 * 60 * 60 * 1000);
  return {
    fresh: drafts.filter((d) => inWindow(d.date, win)),
    stale: drafts.filter((d) => d.date && new Date(d.date) < staleCutoff),
  };
}

// ---------- section: Google Calendar (every calendar the account can see) ----------

async function loadCalendar(now) {
  const { GCAL_CLIENT_ID: id, GCAL_CLIENT_SECRET: secret, GCAL_REFRESH_TOKEN: refresh } = process.env;
  if (!id || !secret || !refresh) throw new Error('Calendar credentials are not set up');
  const token = await googleAccessToken(id, secret, refresh, 'Calendar');
  const headers = { Authorization: `Bearer ${token}` };

  // Phoenix has no DST, so midnight local is always 07:00 UTC.
  const todayISO = phoenixDateISO(now);
  const timeMin = new Date(`${todayISO}T00:00:00-07:00`);
  const timeMax = new Date(timeMin.getTime() + (CALENDAR_DAYS_AHEAD + 1) * 24 * 60 * 60 * 1000);

  const listRes = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250', { headers });
  if (!listRes.ok) throw new Error(`Google Calendar returned ${listRes.status}`);
  const calendars = ((await listRes.json()).items || []).filter((c) => !c.deleted && !c.hidden);

  const seen = new Set();
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
        const key = `${ev.iCalUID || ev.id}|${startISO}`;
        if (seen.has(key)) return; // same event on several calendars
        seen.add(key);
        events.push({
          title: ev.summary || '(no title)',
          allDay,
          startISO,
          endISO: allDay ? ev.end && ev.end.date : ev.end && ev.end.dateTime,
          location: ev.location || '',
          calendar: cal.summaryOverride || cal.summary || cal.id,
          dayISO: allDay ? ev.start.date : phoenixDateISO(new Date(startISO)),
          sortMs: allDay ? new Date(`${ev.start.date}T00:00:00-07:00`).getTime() : new Date(startISO).getTime(),
        });
      });
    })
  );

  events.sort((a, b) => a.sortMs - b.sortMs || Number(b.allDay) - Number(a.allDay));
  return { events, calendarCount: calendars.length, failedCalendars, todayISO };
}

// ---------- email rendering ----------

const C = { navy: '#101F35', text: '#2b2b2b', muted: '#6b7280', line: '#e5e7eb', accent: '#b8862b', bg: '#f6f4ef' };

const h2 = (t) => `<h2 style="margin:28px 0 8px;font:600 17px Georgia,serif;color:${C.navy};border-bottom:1px solid ${C.line};padding-bottom:6px;">${esc(t)}</h2>`;
const p = (t, extra = '') => `<p style="margin:6px 0;font:15px/1.5 Arial,sans-serif;color:${C.text};${extra}">${t}</p>`;
const muted = (t) => p(esc(t), `color:${C.muted};`);
const problem = (name, err) => p(`Couldn't check ${esc(name)} this morning (${esc(err)}). Worth a look in the dashboard.`, `color:#9a3412;`);
const link = (href, text) => `<a href="${esc(href)}" style="color:${C.accent};">${esc(text)}</a>`;

function renderBookACall(r) {
  if (!r.ok) return h2('Book-A-Call') + problem('Book-A-Call', r.error);
  if (r.entries.length === 0) return h2('Book-A-Call') + muted('No new entries overnight.');
  const cards = r.entries.map((e) => {
    const rows = e.fields.filter((f) => f.value).map((f) =>
      `<div style="margin:2px 0;font:14px/1.45 Arial,sans-serif;"><span style="color:${C.muted};">${esc(f.label)}:</span> ${esc(f.value)}</div>`).join('');
    const when = fmt(new Date(e.at), { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    return `<div style="margin:10px 0;padding:12px 14px;background:#fff;border:1px solid ${C.line};border-left:4px solid ${C.accent};border-radius:6px;">
      <div style="font:600 13px Arial,sans-serif;color:${C.accent};margin-bottom:4px;">Submitted ${esc(when)}</div>${rows || muted('(no answers recorded)')}
      ${e.email ? `<div style="margin:2px 0;font:14px Arial,sans-serif;"><span style="color:${C.muted};">Email:</span> ${esc(e.email)}</div>` : ''}</div>`;
  }).join('');
  return h2(`Book-A-Call: ${r.entries.length} new`) + p('Someone wants to connect. Worth a reply today.') + cards +
    p(link(`https://docs.google.com/forms/d/${BOOKACALL_FORM_ID}/edit#responses`, 'Open all responses'));
}

function renderYouTube(r) {
  if (!r.ok) return h2('YouTube comments') + problem('YouTube', r.error);
  const total = r.channels.reduce((n, c) => n + (c.ok ? c.comments.length : 0), 0);
  let html = h2(total ? `YouTube comments: ${total} new` : 'YouTube comments');
  if (total === 0 && r.channels.every((c) => c.ok)) return html + muted('No new comments overnight.');
  r.channels.forEach((c) => {
    if (!c.ok) { html += problem(c.label, c.error); return; }
    if (c.comments.length === 0) return;
    html += `<div style="margin:12px 0 4px;font:600 14px Arial,sans-serif;color:${C.navy};">${esc(c.label)} (${c.comments.length})</div>`;
    c.comments.forEach((cm) => {
      const text = cm.text.length > 220 ? cm.text.slice(0, 220).trimEnd() + '…' : cm.text;
      html += `<div style="margin:8px 0;padding:8px 12px;background:#fff;border:1px solid ${C.line};border-radius:6px;font:14px/1.45 Arial,sans-serif;">
        <div><strong>${esc(cm.author)}</strong>${cm.replyCount === 0 ? ` <span style="color:${C.accent};">&middot; unanswered</span>` : ''}</div>
        <div style="margin:3px 0;">${esc(text)}</div>
        <div style="color:${C.muted};font-size:12px;">${cm.videoTitle ? `on “${esc(cm.videoTitle)}”` : ''}</div></div>`;
    });
    html += p(link(`${DASHBOARD_URL}/#${c.anchor}`, 'Reply in the dashboard'));
  });
  return html;
}

function renderDrafts(r) {
  if (!r.ok) return h2('Blog drafts') + problem('blog drafts', r.error);
  let html = h2(r.fresh.length ? `Blog drafts: ${r.fresh.length} new` : 'Blog drafts');
  if (r.fresh.length === 0) html += muted('No new drafts overnight.');
  r.fresh.forEach((d) => {
    html += `<div style="margin:8px 0;padding:8px 12px;background:#fff;border:1px solid ${C.line};border-radius:6px;font:14px/1.45 Arial,sans-serif;">
      <div><strong>${esc(d.title)}</strong></div>${d.excerpt ? `<div style="color:${C.muted};margin:3px 0;">${esc(d.excerpt)}</div>` : ''}
      <div>${link(d.editLink, 'Review draft →')}</div></div>`;
  });
  if (r.stale.length) {
    html += p(`${r.stale.length} older draft${r.stale.length === 1 ? ' is' : 's are'} still waiting on a review (${r.stale.map((d) => esc(d.title)).join('; ')}).`, `color:${C.muted};`);
  }
  return html + p(link(`${DASHBOARD_URL}/#blogdrafts`, 'Open Ghostwriter'));
}

function renderCalendar(r) {
  if (!r.ok) return h2('Calendar') + problem('the calendar', r.error);
  let html = h2('On the calendar');
  if (r.events.length === 0) return html + muted(`Nothing scheduled across ${r.calendarCount} calendars for the next few days.`);
  const byDay = new Map();
  r.events.forEach((e) => { if (!byDay.has(e.dayISO)) byDay.set(e.dayISO, []); byDay.get(e.dayISO).push(e); });
  [...byDay.entries()].forEach(([dayISO, evs]) => {
    const long = fmt(new Date(`${dayISO}T12:00:00-07:00`), { weekday: 'long', month: 'short', day: 'numeric' });
    const heading = dayISO === r.todayISO ? `Today, ${long}` : long;
    html += `<div style="margin:12px 0 4px;font:600 14px Arial,sans-serif;color:${C.navy};">${esc(heading)}</div>`;
    evs.forEach((e) => {
      const time = e.allDay ? 'All day'
        : fmt(new Date(e.startISO), { hour: 'numeric', minute: '2-digit' }) + (e.endISO ? '–' + fmt(new Date(e.endISO), { hour: 'numeric', minute: '2-digit' }) : '');
      html += `<div style="margin:3px 0;font:14px/1.45 Arial,sans-serif;"><span style="display:inline-block;min-width:118px;color:${C.muted};">${esc(time)}</span><strong>${esc(e.title)}</strong>
        <span style="color:${C.muted};font-size:12px;"> &middot; ${esc(e.calendar)}</span>${e.location ? `<div style="margin-left:118px;color:${C.muted};font-size:12px;">${esc(e.location)}</div>` : ''}</div>`;
    });
  });
  if (r.failedCalendars) html += muted(`${r.failedCalendars} calendar(s) couldn't be read this morning.`);
  return html;
}

function buildEmail({ book, yt, drafts, cal }, now) {
  const newBook = book.ok ? book.entries.length : 0;
  const newComments = yt.ok ? yt.channels.reduce((n, c) => n + (c.ok ? c.comments.length : 0), 0) : 0;
  const newDrafts = drafts.ok ? drafts.fresh.length : 0;
  const n = newBook + newComments + newDrafts;

  const dateLabel = fmt(now, { weekday: 'short', month: 'short', day: 'numeric' });
  const subject = `Dashboard digest — ${dateLabel} — ${n === 0 ? 'quiet morning' : `${n} new`}`;

  const intro = n === 0
    ? 'Good morning, Orit & Scott. Quiet morning: nothing new in the dashboard overnight. Here is what is on the calendar.'
    : `Good morning, Orit & Scott. Here is what is new in the dashboard since yesterday morning${newBook ? ', including a Book-A-Call entry' : ''}.`;

  // Book-A-Call goes first when there is anything, since it is the most time-sensitive.
  const sections = newBook > 0
    ? [renderBookACall(book), renderYouTube(yt), renderDrafts(drafts), renderCalendar(cal)]
    : [renderCalendar(cal), renderBookACall(book), renderYouTube(yt), renderDrafts(drafts)];

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:${C.bg};">
  <div style="max-width:640px;margin:0 auto;padding:24px 20px;">
    <div style="font:600 12px Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:${C.accent};">Docket Dashboard</div>
    <h1 style="margin:4px 0 8px;font:600 24px Georgia,serif;color:${C.navy};">Your morning digest</h1>
    ${p(esc(intro))}
    ${sections.join('\n')}
    <p style="margin:32px 0 0;font:12px Arial,sans-serif;color:${C.muted};border-top:1px solid ${C.line};padding-top:12px;">
      Sent automatically each morning by your Docket Dashboard. It only reads; it never replies, dismisses, or contacts anyone. ${link(DASHBOARD_URL, 'Open the dashboard')}</p>
  </div></body></html>`;
  return { subject, html, counts: { newBook, newComments, newDrafts } };
}

// ---------- sending ----------

async function sendViaResend({ subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not set');
  const from = process.env.DIGEST_FROM || 'Docket Dashboard <onboarding@resend.dev>';
  const send = (to) => fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html }),
  });

  let res = await send(RECIPIENTS);
  if (res.ok) return { sentTo: RECIPIENTS };

  // Resend's shared test sender only delivers to the account owner's address
  // until a domain is verified. Fall back to that inbox so the digest still arrives.
  const firstErr = await res.text();
  if (res.status === 403 || res.status === 422) {
    res = await send([RECIPIENTS[0]]);
    if (res.ok) return { sentTo: [RECIPIENTS[0]], note: 'Sent to oritandscott@gmail.com only; verify a domain in Resend to reach both inboxes.' };
  }
  throw new Error(`Resend rejected the email (${res.status}): ${firstErr.slice(0, 200)}`);
}

// ---------- entry point ----------

export async function runDigest(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Vercel's scheduler sends "Authorization: Bearer $CRON_SECRET" when CRON_SECRET
  // is set (and its dashboard "Run" button does too). If it isn't set, accept
  // only Vercel's cron user-agent. Either way nothing sensitive is returned.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    if (req.headers['authorization'] !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });
  } else if (!String(req.headers['user-agent'] || '').startsWith('vercel-cron')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const now = new Date();
    const win = digestWindow(now);
    const [book, yt, drafts, cal] = await Promise.all([
      safe(() => loadBookACall(win)),
      safe(() => loadYouTube(win)),
      safe(() => loadDrafts(win)),
      safe(() => loadCalendar(now)),
    ]);
    const email = buildEmail({ book, yt, drafts, cal }, now);
    const sent = await sendViaResend(email);
    return res.status(200).json({
      ok: true,
      subject: email.subject,
      counts: email.counts,
      sections: {
        bookACall: book.ok ? 'ok' : book.error,
        youtube: yt.ok ? 'ok' : yt.error,
        drafts: drafts.ok ? 'ok' : drafts.error,
        calendar: cal.ok ? `ok (${cal.calendarCount} calendars, ${cal.events.length} events)` : cal.error,
      },
      ...sent,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// Exported for local testing only.
export const __test = { digestWindow, buildEmail };
