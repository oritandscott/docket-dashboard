// Called by the dashboard's "Comments" panel when you hit Send on a reply.
// Posts a single reply to a YouTube comment. This only ever runs when a
// human clicks Send in the dashboard -- nothing here is scheduled or
// automatic.

async function getAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.YT_CLIENT_ID,
      client_secret: process.env.YT_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    throw new Error(`Token refresh failed: ${await res.text()}`);
  }
  const data = await res.json();
  return data.access_token;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { channel, parentId, text } = req.body || {};

    if (!channel || !parentId || !text || !String(text).trim()) {
      return res.status(400).json({ error: 'Missing channel, parentId, or text.' });
    }

    const refreshTokenByChannel = {
      channel1: process.env.YT_CHANNEL_1_REFRESH_TOKEN,
      channel2: process.env.YT_CHANNEL_2_REFRESH_TOKEN,
    };
    const refreshToken = refreshTokenByChannel[channel];

    if (!refreshToken || !process.env.YT_CLIENT_ID || !process.env.YT_CLIENT_SECRET) {
      return res.status(500).json({ error: "YouTube isn't configured for this channel." });
    }

    const accessToken = await getAccessToken(refreshToken);

    const ytRes = await fetch('https://www.googleapis.com/youtube/v3/comments?part=snippet', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        snippet: { parentId, textOriginal: String(text).trim() },
      }),
    });

    if (!ytRes.ok) {
      const errText = await ytRes.text();
      return res.status(502).json({ error: `YouTube rejected the reply: ${errText}` });
    }

    const ytData = await ytRes.json();
    return res.status(200).json({ success: true, replyId: ytData.id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
