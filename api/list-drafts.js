// Called by the dashboard's "Blog Drafts" panel. Keeps the WordPress
// Application Password on the server side only -- the browser never sees it.

export default async function handler(req, res) {
  try {
    const WP_SITE_URL = process.env.WP_SITE_URL;
    const WP_USERNAME = process.env.WP_USERNAME;
    const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD;

    if (!WP_SITE_URL || !WP_USERNAME || !WP_APP_PASSWORD) {
      return res.status(500).json({ error: 'Missing one or more required environment variables.' });
    }

    const wpAuth = Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString('base64');
    const wpRes = await fetch(
      `${WP_SITE_URL.replace(/\/$/, '')}/wp-json/wp/v2/posts?status=draft&per_page=20&orderby=date&order=desc`,
      { headers: { Authorization: `Basic ${wpAuth}` } }
    );

    if (!wpRes.ok) {
      const errText = await wpRes.text();
      return res.status(502).json({ error: 'Could not reach WordPress', detail: errText });
    }

    const drafts = await wpRes.json();
    const simplified = drafts.map((d) => ({
      id: d.id,
      title: d.title.rendered,
      date: d.date,
      excerpt: (d.excerpt.rendered || '').replace(/<[^>]+>/g, '').trim(),
      editLink: `${WP_SITE_URL.replace(/\/$/, '')}/wp-admin/post.php?post=${d.id}&action=edit`,
    }));

    return res.status(200).json({ drafts: simplified });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
