// Live data for the dashboard page. The data/*.json files are saved by
// committing to GitHub; the page used to read the copies baked into the
// last Vercel deployment, so every save had to redeploy the whole site --
// which ran the Hobby plan out of its 100 deployments/day. Now the page
// reads the current file straight from GitHub through this job, and
// vercel.json skips deployments for data-only commits.
//
// GET /api/machine-status?job=data&file=<name>   (name without .json)
// Behind the dashboard password (middleware.js).

const REPO = 'oritandscott/docket-dashboard';
const BRANCH = 'main';

// Current text of data/<name>.json on main, straight from GitHub.
export function readDataText(name) {
  return readRepoText(`data/${name}.json`, `No data file named ${name}`);
}

// Any file in this repo on main (e.g. index.html for the digest).
export async function readRepoText(path, notFound) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw Object.assign(new Error('Missing required environment variable: GITHUB_TOKEN.'), { status: 500 });
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}?ref=${BRANCH}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (r.status === 404) throw Object.assign(new Error(notFound || `No file ${path}`), { status: 404 });
  if (!r.ok) throw Object.assign(new Error(`GitHub answered ${r.status}`), { status: 502 });
  return r.text();
}

export async function runData(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const name = String((req.query && req.query.file) || '');
  if (!/^[a-z0-9-]{1,60}$/.test(name)) return res.status(400).json({ error: 'Bad file name' });
  res.setHeader('Cache-Control', 'no-store');
  try {
    const text = await readDataText(name);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).send(text);
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
}
