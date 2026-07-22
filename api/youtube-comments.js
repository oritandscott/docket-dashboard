// Called by the dashboard's "Comments" panel. Pulls recent top-level
// comments from both YouTube channels so they can be reviewed and replied
// to from the dashboard. Read-only -- never posts anything.

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

async function fetchChannelComments(channelKey, channelId, channelLabel, accessToken) {
  const url = new URL('https://www.googleapis.com/youtube/v3/commentThreads');
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('allThreadsRelatedToChannelId', channelId);
  url.searchParams.set('order', 'time');
  url.searchParams.set('maxResults', '25');
  url.searchParams.set('textFormat', 'plainText');

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    throw new Error(`YouTube API error for ${channelLabel}: ${await res.text()}`);
  }
  const data = await res.json();
  return (data.items || []).map((item) => {
    const top = item.snippet.topLevelComment.snippet;
    const commentId = item.snippet.topLevelComment.id;
    return {
      id: commentId,
      channel: channelKey,
      channelLabel,
      authorName: top.authorDisplayName,
      text: top.textDisplay,
      publishedAt: top.publishedAt,
      videoId: top.videoId,
      videoUrl: `https://www.youtube.com/watch?v=${top.videoId}&lc=${commentId}`,
      replyCount: item.snippet.totalReplyCount || 0,
    };
  });
}

export default async function handler(req, res) {
  try {
    const channels = [
      {
        key: 'channel1',
        id: process.env.YT_CHANNEL_1_ID,
        label: process.env.YT_CHANNEL_1_NAME || 'Channel 1',
        refreshToken: process.env.YT_CHANNEL_1_REFRESH_TOKEN,
      },
      {
        key: 'channel2',
        id: process.env.YT_CHANNEL_2_ID,
        label: process.env.YT_CHANNEL_2_NAME || 'Channel 2',
        refreshToken: process.env.YT_CHANNEL_2_REFRESH_TOKEN,
      },
    ].filter((c) => c.id && c.refreshToken);

    if (!process.env.YT_CLIENT_ID || !process.env.YT_CLIENT_SECRET || channels.length === 0) {
      return res.status(500).json({
        error: "YouTube isn't configured yet -- missing YT_CLIENT_ID/YT_CLIENT_SECRET or per-channel env vars.",
      });
    }

    const results = await Promise.all(
      channels.map(async (c) => {
        const accessToken = await getAccessToken(c.refreshToken);
        return fetchChannelComments(c.key, c.id, c.label, accessToken);
      })
    );

    const comments = results
      .flat()
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    return res.status(200).json({ comments });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
