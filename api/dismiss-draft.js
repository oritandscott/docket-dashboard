// Called by the dashboard's "Blog Drafts" panel when you hit Dismiss on a
// draft you don't want to keep. Moves the WordPress post to Trash (not a
// permanent delete) -- nothing happens except when a human clicks Dismiss.

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
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
