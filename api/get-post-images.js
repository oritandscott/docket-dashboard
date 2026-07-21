// Called by the Blog Drafts panel's "Manage Images" view.

export default async function handler(req, res) {
  try {
    const WP_SITE_URL = process.env.WP_SITE_URL;
    const DOCKET_SHARED_SECRET = process.env.DOCKET_SHARED_SECRET;
    const postId = req.query.postId;

    if (!WP_SITE_URL || !DOCKET_SHARED_SECRET) {
      return res.status(500).json({ error: 'Missing one or more required environment variables.' });
    }
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
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
