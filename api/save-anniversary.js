// Called by the daily "home-anniversary-outreach" Cowork task after it drafts
// a congratulations email. Upserts one record into data/anniversaries.json via
// the GitHub Contents API (this app has no database, so the JSON file in the
// repo IS the store, and a commit here triggers a normal Vercel redeploy).
// Uses its own ANNIVERSARY_SHARED_SECRET rather than the WordPress bridge's
// DOCKET_SHARED_SECRET, since that one is a write-only "Sensitive" Vercel var
// (can't be read back once saved) and is load-bearing for unrelated endpoints.

const REPO = 'oritandscott/docket-dashboard';
const FILE_PATH = 'data/anniversaries.json';
const BRANCH = 'main';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const ANNIVERSARY_SHARED_SECRET = process.env.ANNIVERSARY_SHARED_SECRET;
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

    if (!ANNIVERSARY_SHARED_SECRET || !GITHUB_TOKEN) {
      return res.status(500).json({ error: 'Missing one or more required environment variables.' });
    }

    if (req.headers['x-docket-secret'] !== ANNIVERSARY_SHARED_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { id, name, address, purchaseDate, emailVariant, draftId } = req.body || {};
    if (!id || !name || !purchaseDate || !draftId) {
      return res.status(400).json({ error: 'Missing required fields: id, name, purchaseDate, draftId' });
    }

    const ghHeaders = {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const contentsUrl = `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`;

    const getRes = await fetch(`${contentsUrl}?ref=${BRANCH}`, { headers: ghHeaders });
    if (!getRes.ok) {
      const errText = await getRes.text();
      return res.status(502).json({ error: 'Could not read anniversaries.json from GitHub', detail: errText });
    }
    const getData = await getRes.json();
    const current = JSON.parse(Buffer.from(getData.content, 'base64').toString('utf-8'));

    const existingIndex = current.findIndex(r => r.id === id);
    const record = {
      id,
      name,
      address: address || '',
      purchaseDate,
      emailVariant: emailVariant || 'A',
      draftId,
      addedAt: existingIndex === -1 ? new Date().toISOString() : current[existingIndex].addedAt,
    };

    if (existingIndex === -1) {
      current.push(record);
    } else {
      current[existingIndex] = record;
    }

    const updatedContent = Buffer.from(JSON.stringify(current, null, 2) + '\n').toString('base64');

    const putRes = await fetch(contentsUrl, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Add home anniversary: ${name}`,
        content: updatedContent,
        sha: getData.sha,
        branch: BRANCH,
      }),
    });

    if (!putRes.ok) {
      const errText = await putRes.text();
      return res.status(502).json({ error: 'Could not write anniversaries.json to GitHub', detail: errText });
    }

    return res.status(200).json({ ok: true, record });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
