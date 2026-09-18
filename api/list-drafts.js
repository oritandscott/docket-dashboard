// Called by the dashboard's "Blog Drafts" panel. Talks to the Docket Blog
// Bridge WordPress plugin using a shared secret header instead of the
// standard Authorization header (which is being stripped on this host).
//
// Also handles Dismiss (POST), merged in here (rather than its own
// api/dismiss-draft.js) to stay under Vercel Hobby's 12-serverless-function
// cap -- this repo was already sitting at exactly 12. GET = list drafts,
// POST = dismiss one (moves it to WP Trash, never a permanent delete).

async function handleList(req, res, WP_SITE_URL, DOCKET_SHARED_SECRET) {
  const wpRes = await fetch(`${WP_SITE_URL.replace(/\/$/, '')}/wp-json/docket/v1/list-drafts`, {
    headers: { 'X-Docket-Secret': DOCKET_SHARED_SECRET },
  });

  if (!wpRes.ok) {
    const errText = await wpRes.text();
    return res.status(502).json({ error: 'Could not reach WordPress', detail: errText });
  }

  const data = await wpRes.json();
  return res.status(200).json(data);
}

async function handleDismiss(req, res, WP_SITE_URL, DOCKET_SHARED_SECRET) {
  const { postId } = req.body || {};
  if (!postId) {
    return res.status(400).json({ error: 'postId is required.' });
  }

  const wpRes = await fetch(`${WP_SITE_URL.replace(/\/$/, '')}/wp-json/docket/v1/trash-draft`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Docket-Secret': DOCKET_SHARED_SECRET,
    },
    body: JSON.stringify({ postId }),
  });

  if (!wpRes.ok) {
    const errText = await wpRes.text();
    return res.status(502).json({ error: 'WordPress rejected the trash request', detail: errText });
  }

  const data = await wpRes.json();
  return res.status(200).json({ success: true, ...data });
}

export default async function handler(req, res) {
  try {
    const WP_SITE_URL = process.env.WP_SITE_URL;
    const DOCKET_SHARED_SECRET = process.env.DOCKET_SHARED_SECRET;

    if (!WP_SITE_URL || !DOCKET_SHARED_SECRET) {
      return res.status(500).json({ error: 'Missing one or more required environment variables.' });
    }

    if (req.method === 'GET') {
      return await handleList(req, res, WP_SITE_URL, DOCKET_SHARED_SECRET);
    }
    if (req.method === 'POST') {
      return await handleDismiss(req, res, WP_SITE_URL, DOCKET_SHARED_SECRET);
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
