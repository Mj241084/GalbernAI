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
    hourCycle: "h23",
  });
  return fmt.format(nowMs);
}

export function formatMessageTimestamp(ts) {
  const ms = Number.isFinite(ts) ? ts : Date.now();
  return `[🕒 ایران: ${formatHumanDateTime(ms, IRAN_TZ)} | آمریکا: ${formatHumanDateTime(ms, US_REFERENCE_TZ)}]`;
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

export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// Line-numbered viewing & safe patching (notes & memory profile)
// ---------------------------------------------------------------------------

export function formatNumberedLines(text) {
  if (!text) return "";
  return String(text)
    .split("\n")
    .map((line, idx) => `${idx + 1} | ${line}`)
    .join("\n");
}

function assertNoNumberPrefixLeak(text, fieldName) {
  if (!text) return;
  const lines = String(text).split("\n");
  if (lines.length >= 2 && lines.every((l) => !l.trim() || /^\s*\d+\s*\|/.test(l))) {
    throw new Error(
      `پیشوند شماره خط ("1 | ") داخل ${fieldName} فرستاده شده. شماره خط فقط برای خواندن است؛ متن خالص بدون "N | " بفرست.`
    );
  }
}

/**
 * Applies a list of patch operations atomically to `originalText`.
 * Each op is either:
 *   1) { old_text, new_text }  (exact unique match, Claude Code str_replace style)
 *   2) { start_line, end_line, expected_first_line, new_text } (1-based inclusive line range + anchor guard)
 */
export function applySafePatches(originalText, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new Error("حداقل یک عملیات ویرایش (patch) لازم است.");
  }
  let current = String(originalText ?? "");
  let lastEditCenterLine = 1;

  for (const op of ops) {
    assertNoNumberPrefixLeak(op.new_text, "new_text");

    if (op.old_text !== undefined) {
      assertNoNumberPrefixLeak(op.old_text, "old_text");
      const needle = String(op.old_text);
      if (!needle) throw new Error("old_text نمی‌تواند خالی باشد.");
      const firstIdx = current.indexOf(needle);
      if (firstIdx === -1) {
        throw new Error(`old_text در متن پیدا نشد. اول متن جدید را بخوان و دقیقاً کپی کن.`);
      }
      const secondIdx = current.indexOf(needle, firstIdx + 1);
      if (secondIdx !== -1) {
        throw new Error(`old_text بیش از یک بار پیدا شد. ۱-۲ خط قبل یا بعدش را هم اضافه کن تا یکتا شود.`);
      }
      const replacement = String(op.new_text ?? "");
      current = current.slice(0, firstIdx) + replacement + current.slice(firstIdx + needle.length);
      lastEditCenterLine = current.slice(0, firstIdx).split("\n").length;
      continue;
    }

    if (Number.isInteger(op.start_line)) {
      const lines = current === "" ? [] : current.split("\n");
      const start = op.start_line;
      const end = Number.isInteger(op.end_line) ? op.end_line : start;
      if (start < 1 || end < start || end > lines.length) {
        throw new Error(`بازه‌ی خط ${start}..${end} نامعتبر است (تعداد کل خطوط: ${lines.length}).`);
      }
      const actualFirst = lines[start - 1];
      const expected = String(op.expected_first_line ?? "").trim();
      if (!expected) {
        throw new Error(`برای ویرایش خطی، پارامتر expected_first_line الزامی است تا از تغییر خط اشتباهی جلوگیری شود.`);
      }
      if (!actualFirst.trim().includes(expected)) {
        const from = Math.max(0, start - 3);
        const to = Math.min(lines.length, start + 2);
        const context = lines
          .slice(from, to)
          .map((l, i) => `${from + i + 1} | ${l}`)
          .join("\n");
        throw new Error(
          `خط ${start} با expected_first_line مطابقت ندارد (احتمال جابه‌جایی شماره خط). خطوط فعلی اطراف آن:\n${context}`
        );
      }
      const replacementLines = op.new_text === "" ? [] : String(op.new_text ?? "").split("\n");
      lines.splice(start - 1, end - start + 1, ...replacementLines);
      current = lines.join("\n");
      lastEditCenterLine = start;
      continue;
    }

    throw new Error("هر پچ باید یا old_text/new_text داشته باشد یا start_line/expected_first_line/new_text.");
  }

  // Return updated snippet around the edited area
  const resultLines = current === "" ? [] : current.split("\n");
  const from = Math.max(0, lastEditCenterLine - 4);
  const to = Math.min(resultLines.length, lastEditCenterLine + 5);
  const preview = resultLines
    .slice(from, to)
    .map((l, i) => `${from + i + 1} | ${l}`)
    .join("\n");

  return { text: current, lineCount: resultLines.length, preview };
}