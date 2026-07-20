// TEMPORARY diagnostic tool. Calls WordPress's "who am I" endpoint using the
// stored credentials and returns exactly what WordPress says back. Safe to
// delete once troubleshooting is done.

export default async function handler(req, res) {
  try {
    const WP_SITE_URL = process.env.WP_SITE_URL;
    const WP_USERNAME = process.env.WP_USERNAME;
    const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD;

    if (!WP_SITE_URL || !WP_USERNAME || !WP_APP_PASSWORD) {
      return res.status(500).json({ error: 'Missing one or more required environment variables.' });
    }

    const wpAuth = Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString('base64');
    const wpRes = await fetch(`${WP_SITE_URL.replace(/\/$/, '')}/wp-json/wp/v2/users/me`, {
      headers: { Authorization: `Basic ${wpAuth}` },
    });

    const bodyText = await wpRes.text();

    return res.status(200).json({
      httpStatusFromWordPress: wpRes.status,
      wordpressResponse: bodyText,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
