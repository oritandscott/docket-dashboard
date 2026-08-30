// Called by the daily "Docket morning brief" Cowork scheduled task after it
// gathers today's calendar + inbox. Upserts today's Schedule items and fills
// remaining Top 3 Tasks slots directly into data/today.json via the GitHub
// Contents API (this app has no database -- the JSON file in the repo IS the
// store, and a commit here triggers a normal Vercel redeploy).
//
// This replaces the old approach of driving the dashboard's UI with browser
// automation, which was slow, fragile, and depended on a specific computer
// being online, unlocked, and already logged into the dashboard. Calling
// this endpoint directly works regardless of which (if any) computer is
// online. Uses its own TODAY_SHARED_SECRET, mirroring save-anniversary.js's
// ANNIVERSARY_SHARED_SECRET pattern -- a separate env var so this doesn't
// share a blast radius with unrelated endpoints.

const REPO = 'oritandscott/docket-dashboard';
const FILE_PATH = 'data/today.json';
const BRANCH = 'main';

function phoenixTodayISO() {
  // Arizona doesn't observe DST, but the Vercel function itself runs in UTC,
  // so "today" per Date() alone would be wrong for several hours a day.
  // Intl with an explicit IANA zone sidesteps that.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Phoenix',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function readCurrent(ghHeaders, contentsUrl) {
  const getRes = await fetch(`${contentsUrl}?ref=${BRANCH}`, { headers: ghHeaders });
  if (!getRes.ok) {
    const errText = await getRes.text();
    const err = new Error('Could not read today.json from GitHub');
    err.detail = errText;
    err.status = 502;
    throw err;
  }
  const getData = await getRes.json();
  const raw = JSON.parse(Buffer.from(getData.content, 'base64').toString('utf-8'));
  return {
    current: {
      schedule: Array.isArray(raw.schedule) ? raw.schedule : [],
      tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
    },
    sha: getData.sha,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const TODAY_SHARED_SECRET = process.env.TODAY_SHARED_SECRET;
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

    if (!TODAY_SHARED_SECRET || !GITHUB_TOKEN) {
      return res.status(500).json({ error: 'Missing one or more required environment variables.' });
    }
    if (req.headers['x-docket-secret'] !== TODAY_SHARED_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // schedule: [{ time: "HH:MM", title: "..." }, ...]
    // tasks: ["...", "...", "..."]  (plain strings, priority order)
    const scheduleIn = Array.isArray(req.body?.schedule) ? req.body.schedule : [];
    const tasksIn = Array.isArray(req.body?.tasks) ? req.body.tasks : [];

    const ghHeaders = {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const contentsUrl = `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`;
    const todayStr = phoenixTodayISO();

    let result = null;
    let attempt = 0;
    // One retry if the sha changed between our read and write (another save
    // landed in between). Rare -- this endpoint only runs once a day -- but
    // cheap to guard against rather than fail the whole morning brief on it.
    while (attempt < 2 && !result) {
      attempt++;
      const { current, sha } = await readCurrent(ghHeaders, contentsUrl);

      // Drop schedule items from before today. This is the daily rollover --
      // the same thing the dashboard used to do client-side when this data
      // lived in localStorage.
      const keptSchedule = current.schedule.filter((item) => item.date && item.date >= todayStr);

      const addedSchedule = [];
      scheduleIn.forEach((item) => {
        const time = (item && item.time ? String(item.time) : '').trim();
        const title = (item && item.title ? String(item.title) : '').trim();
        if (!time || !title) return;
        const isDup = keptSchedule.some(
          (s) => s.date === todayStr && s.time === time && s.title.toLowerCase() === title.toLowerCase()
        );
        if (isDup) return;
        const rec = { id: uid(), time, title, date: todayStr, source: 'automation' };
        keptSchedule.push(rec);
        addedSchedule.push(rec);
      });

      const keptTasks = current.tasks.slice();
      const addedTasks = [];
      const skippedTasks = [];
      let openSlots = Math.max(0, 3 - keptTasks.length);
      tasksIn.forEach((text) => {
        const t = (typeof text === 'string' ? text : '').trim();
        if (!t) return;
        const isDup = keptTasks.some((k) => k.text.toLowerCase() === t.toLowerCase());
        if (isDup) {
          skippedTasks.push(t);
          return;
        }
        if (openSlots <= 0) {
          skippedTasks.push(t);
          return;
        }
        const rec = { id: uid(), text: t, done: false, source: 'automation' };
        keptTasks.push(rec);
        addedTasks.push(rec);
        openSlots--;
      });

      const updated = { schedule: keptSchedule, tasks: keptTasks };
      const updatedContent = Buffer.from(JSON.stringify(updated, null, 2) + '\n').toString('base64');

      const putRes = await fetch(contentsUrl, {
        method: 'PUT',
        headers: { ...ghHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `Daily brief: +${addedSchedule.length} schedule, +${addedTasks.length} tasks (${todayStr})`,
          content: updatedContent,
          sha,
          branch: BRANCH,
        }),
      });

      if (putRes.status === 409 && attempt < 2) continue;
      if (!putRes.ok) {
        const errText = await putRes.text();
        return res.status(502).json({ error: 'Could not write today.json to GitHub', detail: errText });
      }

      result = { ok: true, date: todayStr, addedSchedule, addedTasks, skippedTasks, current: updated };
    }

    return res.status(200).json(result);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, detail: err.detail });
  }
}
