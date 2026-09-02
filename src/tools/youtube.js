import { WEB_TOOL_TIMEOUT_MS } from "../config.js";

// search.list costs 100 units (1% of the whole daily 10,000-unit quota per
// call); channels.list/playlistItems.list cost 1 unit each. So the whole
// point of this module is to NEVER call search.list unless every cheap
// path has already failed - see resolveChannelId below.

async function fetchYoutube(env, resource, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  url.searchParams.set("key", env.YOUTUBE_API_KEY);

  let resp;
  try {
    resp = await fetch(url.toString(), { signal: AbortSignal.timeout(WEB_TOOL_TIMEOUT_MS) });
  } catch (err) {
    const timedOut = err && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new Error(timedOut ? `YouTube API timeout بعد از ${WEB_TOOL_TIMEOUT_MS / 1000}s` : `YouTube API خطای شبکه: ${err.message || err}`);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`YouTube API خطای HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  return resp.json();
}

// Resolves a channel handle/URL/name/ID to a channel ID using only the
// cheap 1-unit endpoints when at all possible. search.list (100 units) is
// the absolute last resort.
async function resolveChannelId(env, input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) throw new Error("نام یا آیدی کانال خالیه.");

  // Already a raw channel ID (UC + 22 chars).
  if (/^UC[\w-]{22}$/.test(trimmed)) return trimmed;

  let handle = null;
  const urlMatch = trimmed.match(
    /youtube\.com\/(?:@([\w.-]+)|channel\/(UC[\w-]{22})|c\/([\w.-]+)|user\/([\w.-]+))/i
  );
  if (urlMatch) {
    if (urlMatch[2]) return urlMatch[2];
    handle = urlMatch[1] || urlMatch[3] || urlMatch[4];
  } else if (trimmed.startsWith("@")) {
    handle = trimmed.slice(1);
  } else {
    handle = trimmed;
  }

  // 1 unit
  let resp = await fetchYoutube(env, "channels", { part: "id", forHandle: handle });
  if (resp.items && resp.items.length) return resp.items[0].id;

  // 1 unit (legacy usernames)
  resp = await fetchYoutube(env, "channels", { part: "id", forUsername: handle });
  if (resp.items && resp.items.length) return resp.items[0].id;

  // Last resort: 100 units
  resp = await fetchYoutube(env, "search", { part: "id", q: trimmed, type: "channel", maxResults: 1 });
  if (resp.items && resp.items.length) return resp.items[0].id.channelId;

  throw new Error(`کانالی برای «${input}» پیدا نشد.`);
}

async function getUploadsPlaylistId(env, channelId) {
  const resp = await fetchYoutube(env, "channels", { part: "contentDetails,snippet", id: channelId });
  const item = resp.items?.[0];
  if (!item) throw new Error(`کانال با آیدی ${channelId} پیدا نشد.`);
  return {
    uploadsPlaylistId: item.contentDetails.relatedPlaylists.uploads,
    channelTitle: item.snippet.title,
  };
}

async function getLatestFromPlaylist(env, playlistId) {
  const resp = await fetchYoutube(env, "playlistItems", { part: "snippet,contentDetails", playlistId, maxResults: 1 });
  const item = resp.items?.[0];
  if (!item) return null;
  const videoId = item.contentDetails.videoId;
  return {
    videoId,
    title: item.snippet.title,
    description: (item.snippet.description || "").slice(0, 500),
    publishedAt: item.contentDetails.videoPublishedAt || item.snippet.publishedAt,
    url: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

export const definitions = [
  {
    type: "function",
    function: {
      name: "get_latest_youtube_video",
      description:
        "Get the most recently uploaded video from a YouTube channel, given a handle (@name), full channel URL, legacy username, or channel ID.",
      parameters: {
        type: "object",
        properties: { channel: { type: "string", description: "Channel handle, URL, username, or ID." } },
        required: ["channel"],
      },
    },
  },
];

export async function execute(name, args, { env }) {
  if (name !== "get_latest_youtube_video") throw new Error(`unknown youtube tool: ${name}`);
  if (!env.YOUTUBE_API_KEY) return { ok: false, error: "YOUTUBE_API_KEY تنظیم نشده." };

  const channelId = await resolveChannelId(env, args.channel);
  const { uploadsPlaylistId, channelTitle } = await getUploadsPlaylistId(env, channelId);
  const latest = await getLatestFromPlaylist(env, uploadsPlaylistId);

  if (!latest) return { ok: true, channelTitle, video: null, note: "این کانال هنوز ویدیویی آپلود نکرده." };
  return { ok: true, channelTitle, video: latest };
}