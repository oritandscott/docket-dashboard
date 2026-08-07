// Called by the Home Anniversaries panel's "+ Add Template" / edit form.
// Upserts one entry into data/email-templates.json via the GitHub Contents
// API, same storage pattern as save-anniversary.js. Browser-callable, no
// shared secret required (this dashboard has no login) -- the GITHUB_TOKEN
// that actually authorizes the write stays server-side.

const REPO = 'oritandscott/docket-dashboard';
const FILE_PATH = 'data/email-templates.json';
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

    const { id, label, subject, body } = req.body || {};
    if (!label || !subject || !body) {
      return res.status(400).json({ error: 'Missing required fields: label, subject, body.' });
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
      return res.status(502).json({ error: 'Could not read email-templates.json from GitHub', detail: errText });
    }
    const getData = await getRes.json();
    const current = JSON.parse(Buffer.from(getData.content, 'base64').toString('utf-8'));

    // New templates get a short random id; editing an existing one reuses its id.
    const templateId = id || `custom-${Date.now().toString(36)}`;
    const existingIndex = current.findIndex(t => t.id === templateId);
    const record = { id: templateId, label, subject, body };

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
        message: existingIndex === -1 ? `Add email template: ${label}` : `Edit email template: ${label}`,
        content: updatedContent,
        sha: getData.sha,
        branch: BRANCH,
      }),
    });

    if (!putRes.ok) {
      const errText = await putRes.text();
      return res.status(502).json({ error: 'Could not write email-templates.json to GitHub', detail: errText });
    }

    return res.status(200).json({ ok: true, record });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
