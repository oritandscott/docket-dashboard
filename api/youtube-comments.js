// Called by the dashboard's "Comments" panel. Pulls recent top-level
// comments from both YouTube channels, plus the title and publish date of
// the video each one was left on, so they can be reviewed and replied to
// from the dashboard. Read-only -- never posts anything.

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

// Looks up title + publish date for a batch of video IDs in one call.
// videos.list accepts up to 50 comma-separated IDs per request.
async function fetchVideoDetails(videoIds, accessToken) {
  const details = new Map();
  const uniqueIds = [...new Set(videoIds)];

  for (let i = 0; i < uniqueIds.length; i += 50) {
    const batch = uniqueIds.slice(i, i + 50);
    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('id', batch.join(','));

    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      // Don't fail the whole request just because video lookups didn't work --
      // comments are still useful without titles attached.
      continue;
    }
    const data = await res.json();
    (data.items || []).forEach((item) => {
      details.set(item.id, {
        title: item.snippet.title,
        publishedAt: item.snippet.publishedAt,
      });
    });
  }

  return details;
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

    const perChannel = await Promise.all(
      channels.map(async (c) => {
        const accessToken = await getAccessToken(c.refreshToken);
        const comments = await fetchChannelComments(c.key, c.id, c.label, accessToken);
        return { comments, accessToken };
      })
    );

    const allComments = perChannel.flatMap((r) => r.comments);
    const anyAccessToken = perChannel[0]?.accessToken;

    let videoDetails = new Map();
    if (anyAccessToken && allComments.length > 0) {
      videoDetails = await fetchVideoDetails(
        allComments.map((c) => c.videoId),
        anyAccessToken
      );
    }

    const comments = allComments
      .map((c) => {
        const details = videoDetails.get(c.videoId);
        return {
          ...c,
          videoTitle: details?.title || null,
          videoPublishedAt: details?.publishedAt || null,
        };
      })
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    return res.status(200).json({ comments });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
