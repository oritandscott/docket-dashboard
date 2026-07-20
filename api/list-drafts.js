// Called by the dashboard's "Blog Drafts" panel. Talks to the Docket Blog
// Bridge WordPress plugin using a shared secret header instead of the
// standard Authorization header (which is being stripped on this host).

export default async function handler(req, res) {
  try {
    const WP_SITE_URL = process.env.WP_SITE_URL;
    const DOCKET_SHARED_SECRET = process.env.DOCKET_SHARED_SECRET;

    if (!WP_SITE_URL || !DOCKET_SHARED_SECRET) {
      return res.status(500).json({ error: 'Missing one or more required environment variables.' });
    }

    const wpRes = await fetch(`${WP_SITE_URL.replace(/\/$/, '')}/wp-json/docket/v1/list-drafts`, {
      headers: { 'X-Docket-Secret': DOCKET_SHARED_SECRET },
    });

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
