import { escapeHtml, bytesToBase64 } from "./util.js";
import { TELEGRAM_API_TIMEOUT_MS } from "./config.js";

const TG_API = (token) => `https://api.telegram.org/bot${token}`;
const CHUNK_SIZE = 3500;

// Splits an HTML string (already in Telegram's parse_mode="HTML" subset)
// into chunks that each stay valid HTML on their own. A plain char-count cut
// can land in the middle of a tag, or leave one open at the end of a chunk
// with no matching close - Telegram rejects that outright, so a message that
// happens to straddle a `<pre><code>` block (or even just a `<b>`) could
// silently fail to send. This walks the string tracking which tags are
// currently open and, at each cut point, closes them to end that chunk
// validly then reopens the same tags at the top of the next one.
function splitIntoChunks(html, size = CHUNK_SIZE) {
  if (html.length <= size) return [html];
  const chunks = [];
  let pos = 0;
  let openTags = [];

  while (pos < html.length) {
    const reopen = openTags.map((t) => `<${t}>`).join("");
    const closeLen = openTags.reduce((s, t) => s + t.length + 3, 0);
    const budget = Math.max(size - reopen.length - closeLen, 200);
    let end = Math.min(pos + budget, html.length);

    const lastOpenBracket = html.lastIndexOf("<", end);
    const lastCloseBracket = html.lastIndexOf(">", end);
    if (lastOpenBracket > lastCloseBracket) end = lastOpenBracket;

    if (end < html.length) {
      const nl = html.lastIndexOf("\n", end);
      if (nl > pos + 200) end = nl + 1;
    }

    const slice = html.slice(pos, end);
    const tagRe = /<\/?([a-z0-9]+)[^>]*>/gi;
    let m;
    while ((m = tagRe.exec(slice))) {
      const isClose = m[0][1] === "/";
      const name = m[1].toLowerCase();
      if (isClose) {
        const i = openTags.lastIndexOf(name);
        if (i !== -1) openTags.splice(i, 1);
      } else if (!m[0].endsWith("/>")) {
        openTags.push(name);
      }
    }

    const closeSuffix = [...openTags].reverse().map((t) => `</${t}>`).join("");
    chunks.push(reopen + slice + closeSuffix);
    pos = end;
  }
  return chunks;
}

// Converts LLM-style Markdown into the small HTML subset Telegram's
// parse_mode="HTML" understands.
export function markdownToTelegramHtml(text) {
  if (!text) return "";
  let src = String(text);

  const blocks = [];
  src = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push({ lang, code: code.replace(/\n$/, "") });
    return `\u0000B${blocks.length - 1}\u0000`;
  });
  const spans = [];
  src = src.replace(/`([^`\n]+)`/g, (_, code) => {
    spans.push(code);
    return `\u0000S${spans.length - 1}\u0000`;
  });

  let out = escapeHtml(src);

  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `<a href="${url}">${label}</a>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  out = out.replace(/__([^_]+)__/g, "<b>$1</b>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>");
  out = out.replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, "$1<i>$2</i>");
  out = out.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  out = out.replace(/^#{1,6}\s+(.*)$/gm, "<b>$1</b>");
  out = out.replace(/^(\s*)[-*]\s+/gm, "$1• ");

  out = out.replace(/\u0000S(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(spans[Number(i)])}</code>`);
  out = out.replace(/\u0000B(\d+)\u0000/g, (_, i) => {
    const { lang, code } = blocks[Number(i)];
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    return `<pre><code${langAttr}>${escapeHtml(code)}</code></pre>`;
  });

  return out;
}

export async function sendMessage(env, chatId, text, extra = {}) {
  const chunks = splitIntoChunks(text, CHUNK_SIZE);
  let last = null;
  for (const chunk of chunks) {
    let resp;
    try {
      resp = await fetch(`${TG_API(env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: "HTML", disable_web_page_preview: true, ...extra }),
        signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
      });
    } catch (err) {
      console.error("sendMessage failed:", err.message || err);
      continue;
    }
    last = await resp.json().catch(() => null);
  }
  return last;
}

export async function sendMarkdown(env, chatId, markdownText, extra = {}) {
  return sendMessage(env, chatId, markdownToTelegramHtml(markdownText), extra);
}

export async function editMessage(env, chatId, messageId, text, extra = {}) {
  try {
    const resp = await fetch(`${TG_API(env.TELEGRAM_BOT_TOKEN)}/editMessageText`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", ...extra }),
      signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
    });
    return await resp.json().catch(() => null);
  } catch (err) {
    console.error("editMessage failed:", err.message || err);
    return null;
  }
}

export async function deleteMessage(env, chatId, messageId) {
  try {
    await fetch(`${TG_API(env.TELEGRAM_BOT_TOKEN)}/deleteMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
      signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
    });
  } catch {
    // best effort
  }
}

function extensionForMime(mimeType) {
  const map = {
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/ogg": "ogg",
    "audio/opus": "ogg",
  };
  return map[(mimeType || "").toLowerCase()] || "bin";
}

export async function sendVoiceWithTranscript(env, chatId, { audioBase64, mimeType, transcript }) {
  const bytes = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0));
  const isOgg = /ogg|opus/i.test(mimeType || "");
  const field = isOgg ? "voice" : "audio";
  const filename = isOgg ? "voice.ogg" : `speech.${extensionForMime(mimeType)}`;

  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append(field, new Blob([bytes], { type: mimeType || "audio/ogg" }), filename);

  let result = null;
  try {
    const resp = await fetch(`${TG_API(env.TELEGRAM_BOT_TOKEN)}/send${isOgg ? "Voice" : "Audio"}`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(Math.max(TELEGRAM_API_TIMEOUT_MS, 30000)),
    });
    result = await resp.json().catch(() => null);
  } catch (err) {
    console.error("sendVoiceWithTranscript upload failed:", err.message || err);
  }

  if (transcript) {
    await sendMessage(env, chatId, `<blockquote expandable>${escapeHtml(transcript)}</blockquote>`);
  }
  return result;
}

export async function sendPhoto(env, chatId, { base64, mimeType, caption }) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);
  form.append("photo", new Blob([bytes], { type: mimeType || "image/jpeg" }), "photo.jpg");
  try {
    const resp = await fetch(`${TG_API(env.TELEGRAM_BOT_TOKEN)}/sendPhoto`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(Math.max(TELEGRAM_API_TIMEOUT_MS, 30000)),
    });
    return await resp.json().catch(() => null);
  } catch (err) {
    console.error("sendPhoto failed:", err.message || err);
    return null;
  }
}

// Sends a photo by remote URL directly - Telegram fetches it server-side,
// so no download/re-upload round-trip is needed. Used by find_images:
// Serper's own imageUrl values are passed straight through.
export async function sendPhotoByUrl(env, chatId, { url, caption }) {
  try {
    const resp = await fetch(`${TG_API(env.TELEGRAM_BOT_TOKEN)}/sendPhoto`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, photo: url, caption: caption ? caption.slice(0, 1024) : undefined }),
      signal: AbortSignal.timeout(Math.max(TELEGRAM_API_TIMEOUT_MS, 30000)),
    });
    return await resp.json().catch(() => null);
  } catch (err) {
    console.error("sendPhotoByUrl failed:", err.message || err);
    return null;
  }
}

export async function downloadTelegramFile(env, fileId) {
  const infoResp = await fetch(`${TG_API(env.TELEGRAM_BOT_TOKEN)}/getFile?file_id=${encodeURIComponent(fileId)}`, {
    signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
  });
  const info = await infoResp.json();
  if (!info.ok) throw new Error(`getFile failed: ${JSON.stringify(info)}`);
  const filePath = info.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;
  const fileResp = await fetch(fileUrl, { signal: AbortSignal.timeout(Math.max(TELEGRAM_API_TIMEOUT_MS, 30000)) });
  if (!fileResp.ok) throw new Error(`file download failed: HTTP ${fileResp.status}`);
  const buf = await fileResp.arrayBuffer();
  const base64 = bytesToBase64(new Uint8Array(buf));
  const ext = (filePath.split(".").pop() || "").toLowerCase();
  const mimeMap = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    mp4: "video/mp4",
    mov: "video/quicktime",
    oga: "audio/ogg",
    ogg: "audio/ogg",
    md: "text/markdown",
    txt: "text/plain",
  };
  return { base64, mimeType: mimeMap[ext] || "application/octet-stream" };
}

export function extractIncomingMedia(message) {
  if (Array.isArray(message.photo) && message.photo.length) {
    const largest = message.photo[message.photo.length - 1];
    return { fileId: largest.file_id, kind: "image" };
  }
  if (message.video) return { fileId: message.video.file_id, kind: "video" };
  if (message.document) return { fileId: message.document.file_id, kind: "document", mimeType: message.document.mime_type };
  return null;
}

export async function sendOwnerAlert(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_OWNER_CHAT_ID) return;
  try {
    await sendMessage(env, env.TELEGRAM_OWNER_CHAT_ID, text);
  } catch {
    // best effort only
  }
}

export async function answerCallbackQuery(env, callbackQueryId, text = null) {
  try {
    await fetch(`${TG_API(env.TELEGRAM_BOT_TOKEN)}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: text || undefined }),
      signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
    });
  } catch {
    // best effort
  }
}