// Runs on a daily schedule (see vercel.json). Researches a trending real
// estate topic, drafts a post in The Oasis Team's voice, and saves it to
// WordPress as a DRAFT for human review. Nothing is ever published
// automatically.

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  // If Vercel's CRON_SECRET is set, only Vercel's own scheduler (or someone
  // with the secret) can trigger this.
  if (process.env.CRON_SECRET) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    const WP_SITE_URL = process.env.WP_SITE_URL; // e.g. https://oasisarizonaliving.com
    const WP_USERNAME = process.env.WP_USERNAME;
    const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD;

    if (!ANTHROPIC_API_KEY || !WP_SITE_URL || !WP_USERNAME || !WP_APP_PASSWORD) {
      return res.status(500).json({ error: 'Missing one or more required environment variables.' });
    }

    // ~75% local Phoenix-area focus, ~25% national
    const focusLocal = Math.random() < 0.75;
    const focusInstruction = focusLocal
      ? 'Focus specifically on the Phoenix, Arizona metro real estate market (Phoenix, Scottsdale, Tempe, Gilbert, Chandler, Mesa, Queen Creek, San Tan Valley, etc).'
      : 'Focus on a national U.S. real estate trend, but where it makes sense, tie it back to what it means for Phoenix-area buyers and sellers.';

    const systemPrompt = `You are a ghostwriter for The Oasis Team, a Phoenix-area real estate team (Orit & Scott Vacek, Keller Williams Realty Phoenix). Write in their established voice: confident, warm, locally expert, punchy hook-style headlines. Byline the post "Orit & Scott, The Oasis Team."

Hard rules:
- Never write anything that could be read as politically partisan or politically leaning in any direction.
- Never give specific legal or financial advice; you can describe options and point readers to talk to a professional.
- Never describe a neighborhood, school, or area in terms of who "belongs" there or use language that could raise Fair Housing concerns. Describe places by amenities, price, commute, lifestyle features only.
- Base the post on a real, currently trending real estate search topic that you find via web search today. Do not invent statistics; if you cite a number, it should come from something you found in search.
- ${focusInstruction}
- Target length: 700-900 words.

First use web search to find a real, currently trending real estate topic. Once you have enough information, call the publish_blog_post tool exactly once with the finished post. Do not output the post as plain text -- it must be submitted through the tool call.`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 4000,
        system: systemPrompt,
        messages: [
          { role: 'user', content: "Find a real, currently trending real estate topic and write today's post now." },
        ],
        tools: [
          { type: 'web_search_20250305', name: 'web_search' },
          {
            name: 'publish_blog_post',
            description: 'Submit the finished, ready-to-publish blog post.',
            input_schema: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Post headline' },
                body_html: { type: 'string', description: 'Full WordPress-ready HTML body using <p>, <h2>, <ul>/<li> as needed. No <html>, <head>, or <body> tags.' },
                excerpt: { type: 'string', description: 'One or two sentence summary' },
              },
              required: ['title', 'body_html', 'excerpt'],
            },
          },
        ],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      return res.status(502).json({ error: 'Claude API request failed', detail: errText });
    }

    const claudeData = await claudeRes.json();
    const toolUse = (claudeData.content || []).find((b) => b.type === 'tool_use' && b.name === 'publish_blog_post');

    if (!toolUse) {
      return res.status(502).json({ error: 'Claude did not submit a post via the expected tool call', raw: claudeData.content });
    }

    const post = toolUse.input;

    const wpAuth = Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString('base64');
    const wpRes = await fetch(`${WP_SITE_URL.replace(/\/$/, '')}/wp-json/wp/v2/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${wpAuth}`,
      },
      body: JSON.stringify({
        title: post.title,
        content: post.body_html,
        excerpt: post.excerpt || '',
        status: 'draft',
      }),
    });

    if (!wpRes.ok) {
      const errText = await wpRes.text();
      return res.status(502).json({ error: 'WordPress rejected the draft', detail: errText });
    }

    const wpData = await wpRes.json();
    return res.status(200).json({
      success: true,
      postId: wpData.id,
      title: post.title,
      editLink: `${WP_SITE_URL.replace(/\/$/, '')}/wp-admin/post.php?post=${wpData.id}&action=edit`,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
