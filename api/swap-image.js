// Called by the Blog Drafts panel's "Manage Images" view when the user
// pastes in a real image URL to replace a placeholder.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const WP_SITE_URL = process.env.WP_SITE_URL;
    const DOCKET_SHARED_SECRET = process.env.DOCKET_SHARED_SECRET;

    if (!WP_SITE_URL || !DOCKET_SHARED_SECRET) {
      return res.status(500).json({ error: 'Missing one or more required environment variables.' });
    }

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
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
