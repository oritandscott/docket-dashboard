// Called by the Blog Drafts panel's "Manage Images" view.
//
// Also handles the image swap (POST), merged in here (rather than its own
// api/swap-image.js) to stay under Vercel Hobby's 12-serverless-function
// cap -- this repo was already sitting at exactly 12. GET = list a post's
// images, POST = swap a placeholder image for a real one the user pasted in.

async function handleList(req, res, WP_SITE_URL, DOCKET_SHARED_SECRET) {
  const postId = req.query.postId;
  if (!postId) {
    return res.status(400).json({ error: 'postId query parameter is required.' });
  }

  const wpRes = await fetch(
    `${WP_SITE_URL.replace(/\/$/, '')}/wp-json/docket/v1/post-images?postId=${encodeURIComponent(postId)}`,
    { headers: { 'X-Docket-Secret': DOCKET_SHARED_SECRET } }
  );

  if (!wpRes.ok) {
    const errText = await wpRes.text();
    return res.status(502).json({ error: 'Could not reach WordPress', detail: errText });
  }

  const data = await wpRes.json();
  return res.status(200).json(data);
}

async function handleSwap(req, res, WP_SITE_URL, DOCKET_SHARED_SECRET) {
  const { postId, oldSrc, newSrc } = req.body || {};
  if (!postId || !oldSrc || !newSrc) {
    return res.status(400).json({ error: 'postId, oldSrc, and newSrc are required.' });
  }

  const wpRes = await fetch(`${WP_SITE_URL.replace(/\/$/, '')}/wp-json/docket/v1/swap-image`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Docket-Secret': DOCKET_SHARED_SECRET,
    },
    body: JSON.stringify({ postId, oldSrc, newSrc }),
  });

  if (!wpRes.ok) {
    const errText = await wpRes.text();
    return res.status(502).json({ error: 'WordPress rejected the swap', detail: errText });
  }

  const data = await wpRes.json();
  return res.status(200).json(data);
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
      return await handleSwap(req, res, WP_SITE_URL, DOCKET_SHARED_SECRET);
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
