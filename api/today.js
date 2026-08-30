// Single endpoint for everything the "Today" panel (Schedule + Top 3 Tasks)
// needs to persist, merged into one file specifically to stay under Vercel
// Hobby's 12-serverless-function-per-deployment cap -- this repo was already
// sitting at exactly 12. Two request shapes share this one function:
//
// 1. Daily automation upsert (server-to-server, from the Cowork scheduled
//    task): send header X-Docket-Secret: <TODAY_SHARED_SECRET> with a body
//    of { schedule: [{time, title}], tasks: ["...", ...] } -- items are
//    merged into today's data (deduped, tasks capped at 3 total), same as
//    save-anniversary.js's upsert pattern.
// 2. Dashboard UI full-replace (browser, no secret): body of
//    { schedule: [...], tasks: [...] } with the *entire* current arrays,
//    exactly as the dashboard already keeps them in memory -- same trust
//    model as update-anniversary.js (no secret; call is only ever made by
//    the page itself).
//
// Both branches read/write data/today.json via the GitHub Contents API --
// this app has no database, the JSON file in the repo IS the store, and a
// commit here triggers a normal Vercel redeploy.

const REPO = 'oritandscott/docket-dashboard';
const FILE_PATH = 'data/today.json';
const BRANCH = 'main';

function phoenixTodayISO() {
  // Arizona doesn't observe DST, but the Vercel function itself runs in UTC,
  // so "today" per Date() alone would be wrong for several hours a day.
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

async function writeCurrent(ghHeaders, contentsUrl, updated, sha, message) {
  const updatedContent = Buffer.from(JSON.stringify(updated, null, 2) + '\n').toString('base64');
  return fetch(contentsUrl, {
    method: 'PUT',
    headers: { ...ghHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: updatedContent, sha, branch: BRANCH }),
  });
}

async function handleAutomationUpsert(req, res, ghHeaders, contentsUrl) {
  const scheduleIn = Array.isArray(req.body?.schedule) ? req.body.schedule : [];
  const tasksIn = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
  const todayStr = phoenixTodayISO();

  let result = null;
  let attempt = 0;
  // One retry if the sha changed between our read and write (another save
  // landed in between). Rare -- this runs once a day -- but cheap to guard.
  while (attempt < 2 && !result) {
    attempt++;
    const { current, sha } = await readCurrent(ghHeaders, contentsUrl);

    // Drop schedule items from before today -- the daily rollover.
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
    const putRes = await writeCurrent(
      ghHeaders,
      contentsUrl,
      updated,
      sha,
      `Daily brief: +${addedSchedule.length} schedule, +${addedTasks.length} tasks (${todayStr})`
    );

    if (putRes.status === 409 && attempt < 2) continue;
    if (!putRes.ok) {
      const errText = await putRes.text();
      return res.status(502).json({ error: 'Could not write today.json to GitHub', detail: errText });
    }

    result = { ok: true, date: todayStr, addedSchedule, addedTasks, skippedTasks, current: updated };
  }

  return res.status(200).json(result);
}

async function handleUiReplace(req, res, ghHeaders, contentsUrl) {
  const schedule = Array.isArray(req.body?.schedule) ? req.body.schedule : null;
  const tasks = Array.isArray(req.body?.tasks) ? req.body.tasks : null;
  if (!schedule || !tasks) {
    return res.status(400).json({ error: 'Both schedule and tasks arrays are required.' });
  }

  const { sha } = await readCurrent(ghHeaders, contentsUrl);
  const updated = { schedule, tasks };
  const putRes = await writeCurrent(ghHeaders, contentsUrl, updated, sha, 'Update Today (Schedule/Top 3 Tasks) from dashboard');

  if (!putRes.ok) {
    const errText = await putRes.text();
    return res.status(502).json({ error: 'Could not write today.json to GitHub', detail: errText });
  }

  return res.status(200).json({ ok: true, schedule, tasks });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
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
    const contentsUrl = `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`;

    const secretHeader = req.headers['x-docket-secret'];
    if (secretHeader) {
      const TODAY_SHARED_SECRET = process.env.TODAY_SHARED_SECRET;
      if (!TODAY_SHARED_SECRET) {
        return res.status(500).json({ error: 'Missing required environment variable: TODAY_SHARED_SECRET.' });
      }
      if (secretHeader !== TODAY_SHARED_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      return handleAutomationUpsert(req, res, ghHeaders, contentsUrl);
    }

    return handleUiReplace(req, res, ghHeaders, contentsUrl);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, detail: err.detail });
  }
}
