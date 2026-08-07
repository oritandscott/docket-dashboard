// Called by the Home Anniversaries panel in the browser when Orit/Scott pick
// a different email template for an 8-30-day-out entry, or hit Dismiss.
// Unlike save-anniversary.js (which the daily Cowork automation calls
// server-to-server with ANNIVERSARY_SHARED_SECRET), this endpoint is meant to
// be called directly from the dashboard UI, so it does not require that
// secret -- same trust model as the existing Blog Drafts panel endpoints
// (dismiss-draft.js / list-drafts.js). The GITHUB_TOKEN that actually
// authorizes the write stays server-side the whole time.

const REPO = 'oritandscott/docket-dashboard';
const FILE_PATH = 'data/anniversaries.json';
const BRANCH = 'main';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    if (!GITHUB_TOKEN) {
      return res.status(500).json({ error: 'Missing required environment variable: GITHUB_TOKEN.' });
    }

    const { id, emailVariant, dismissed } = req.body || {};
    if (!id) {
      return res.status(400).json({ error: 'id is required.' });
    }
    if (emailVariant === undefined && dismissed === undefined) {
      return res.status(400).json({ error: 'Provide emailVariant and/or dismissed to update.' });
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
    if (existingIndex === -1) {
      return res.status(404).json({ error: `No anniversary record found for id ${id}` });
    }

    const record = { ...current[existingIndex] };
    if (emailVariant !== undefined) record.emailVariant = emailVariant;
    if (dismissed !== undefined) record.dismissed = !!dismissed;
    current[existingIndex] = record;

    const updatedContent = Buffer.from(JSON.stringify(current, null, 2) + '\n').toString('base64');

    const putRes = await fetch(contentsUrl, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: dismissed ? `Dismiss home anniversary: ${record.name}` : `Update template for home anniversary: ${record.name}`,
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
