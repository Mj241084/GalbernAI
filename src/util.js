import { HISTORY_DAY_TZ, IRAN_TZ, US_REFERENCE_TZ } from "./config.js";

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

// Plain calendar-day bucket (midnight-to-midnight) in the given timezone.
// Used for "today"/"yesterday" conversation history bucketing - distinct
// from the 12:30-Iran-time quota-reset bucket used by the router worker.
export function getDayWindow(nowMs = Date.now(), timeZone = HISTORY_DAY_TZ) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(nowMs).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Returns the day-window string N days before the given day-window string.
export function shiftDayWindow(dayWindowStr, deltaDays) {
  const [y, m, d] = dayWindowStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

export function formatHumanDateTime(nowMs, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return fmt.format(nowMs);
}

// Both clock anchors injected into the system prompt every turn.
export function currentTimeBlock(nowMs = Date.now()) {
  return (
    `زمان فعلی به وقت ایران (${IRAN_TZ}): ${formatHumanDateTime(nowMs, IRAN_TZ)}\n` +
    `زمان فعلی به وقت آمریکا (${US_REFERENCE_TZ}): ${formatHumanDateTime(nowMs, US_REFERENCE_TZ)}`
  );
}

// Current {hour, minute} in Tehran local time - used by the proactive
// wake-up scheduler in cron.js.
export function getIranHourMinute(nowMs = Date.now()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: IRAN_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(nowMs).map((p) => [p.type, p.value]));
  return { hour: parseInt(parts.hour, 10) % 24, minute: parseInt(parts.minute, 10) };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

// Races a promise against a timeout. This is a SAFETY NET, not a substitute
// for giving the real fetch() calls inside `promise` their own
// AbortSignal.timeout(): JS can't force-cancel an arbitrary in-flight
// promise, so if the timeout wins, the original work may keep running in
// the background - its eventual result is simply ignored (Promise.race
// itself attaches a handler to every input promise, so this does not
// produce an "unhandled rejection" warning even when the original later
// rejects).
export function withTimeout(promise, ms, message = "operation timed out") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function bytesToBase64(bytes) {
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function fetchImageAsDataUri(url, timeoutMs) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const contentType = resp.headers.get("content-type") || "";
  if (!contentType.startsWith("image/")) throw new Error(`not an image: ${contentType}`);
  const buf = await resp.arrayBuffer();
  const base64 = bytesToBase64(new Uint8Array(buf));
  return `data:${contentType};base64,${base64}`;
}

export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

export async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

// Decodes a base64 string (built from raw bytes, e.g. by
// telegram.js's downloadTelegramFile) back into a proper UTF-8 text
// string - needed when a downloaded file is expected to be text (e.g. a
// .md/.txt skill body uploaded as a document), since Persian/UTF-8
// multi-byte characters would come out garbled through a naive atob().
export function base64ToUtf8Text(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}