// Called by the Video Production panel's Project Links list (add / edit /
// remove). Upserts or deletes one entry in data/video-links.json via the
// GitHub Contents API, same storage pattern as save-template.js -- this is
// what makes the list shared across both of your machines instead of stuck
// in one browser's localStorage. Browser-callable, no shared secret required
// (this dashboard has no login) -- the GITHUB_TOKEN that actually authorizes
// the write stays server-side.
//
// GET also lives here (merged in to stay under Vercel Hobby's 12-function
// cap) -- it checks whether anyone has submitted the "Book-A-Call" Google
// Form yet, for the status line at the top of the Video Production panel.
// Uses a dedicated, read-only-scoped Google OAuth client ("Book-A-Call
// Response Checker" in the Oasis Navigator Google Cloud project) -- separate
// from the YouTube and NextAuth credentials -- so it can only ever read this
// one form's responses, never write anything or touch any other data.

const REPO = 'oritandscott/docket-dashboard';
const FILE_PATH = 'data/video-links.json';
const BRANCH = 'main';

// The "MOVING TO PHOENIX - LET'S CONNECT" Book-A-Call form.
const BOOKACALL_FORM_ID = '1420zf0e7MpsflMaM7KScrTaozxVxQP12cfPfvItJd08';

async function handleBookACallStatus(req, res) {
  const CLIENT_ID = process.env.BOOKACALL_CLIENT_ID;
  const CLIENT_SECRET = process.env.BOOKACALL_CLIENT_SECRET;
  const REFRESH_TOKEN = process.env.BOOKACALL_REFRESH_TOKEN;

  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    // Not configured yet -- fail soft so the dashboard can show a quiet
    // "not set up" line instead of an error.
    return res.status(200).json({ ok: true, configured: false });
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: REFRESH_TOKEN,
        grant_type: 'refresh_token',
      }),
    });
    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      return res.status(502).json({ error: 'Book-A-Call token refresh failed', detail: errText });
    }
    const { access_token } = await tokenRes.json();

    const formsRes = await fetch(
      `https://forms.googleapis.com/v1/forms/${BOOKACALL_FORM_ID}/responses`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    if (!formsRes.ok) {
      const errText = await formsRes.text();
      return res.status(502).json({ error: 'Book-A-Call Forms API error', detail: errText });
    }
    const formsData = await formsRes.json();
    const responses = formsData.responses || [];
    const count = responses.length;
    const latestResponseAt = responses.reduce((latest, r) => {
      const t = r.lastSubmittedTime || r.createTime;
      if (!t) return latest;
      return !latest || new Date(t) > new Date(latest) ? t : latest;
    }, null);

    return res.status(200).json({
      ok: true,
      configured: true,
      hasResponses: count > 0,
      count,
      latestResponseAt,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return handleBookACallStatus(req, res);
  }

  if (req.method !== 'POST' && req.method !== 'DELETE') {
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

    const getRes = await fetch(`${contentsUrl}?ref=${BRANCH}`, { headers: ghHeaders });
    if (!getRes.ok) {
      const errText = await getRes.text();
      return res.status(502).json({ error: 'Could not read video-links.json from GitHub', detail: errText });
    }
    const getData = await getRes.json();
    const current = JSON.parse(Buffer.from(getData.content, 'base64').toString('utf-8'));

    let commitMessage;
    let record = null;

    if (req.method === 'DELETE') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Missing required field: id.' });
      const idx = current.findIndex(l => l.id === id);
      if (idx === -1) return res.status(404).json({ error: 'Link not found.' });
      const [removed] = current.splice(idx, 1);
      commitMessage = `Remove project link: ${removed.name}`;
    } else {
      const { id, name, url } = req.body || {};
      if (!name || !url) {
        return res.status(400).json({ error: 'Missing required fields: name, url.' });
      }
      const linkId = id || `link-${Date.now().toString(36)}`;
      const existingIndex = current.findIndex(l => l.id === linkId);
      record = { id: linkId, name, url };
      if (existingIndex === -1) {
        current.push(record);
        commitMessage = `Add project link: ${name}`;
      } else {
        current[existingIndex] = record;
        commitMessage = `Edit project link: ${name}`;
      }
    }

    const updatedContent = Buffer.from(JSON.stringify(current, null, 2) + '\n').toString('base64');

    const putRes = await fetch(contentsUrl, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: commitMessage,
        content: updatedContent,
        sha: getData.sha,
        branch: BRANCH,
      }),
    });

    if (!putRes.ok) {
      const errText = await putRes.text();
      return res.status(502).json({ error: 'Could not write video-links.json to GitHub', detail: errText });
    }

    return res.status(200).json({ ok: true, record });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
