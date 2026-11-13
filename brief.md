# Engineering Brief for Claude Code: GalbernAI v2.1 Upgrade
(Prompts, Line-Numbered Patching, Per-Message Timestamps & Telegram Bot API 10.1–10.3 Rich UI)

Implement the following upgrades in the `GalbernAI` Cloudflare Worker + Durable Object (`AgentDO`) codebase.

## Global Constraints (Read First)
- **NO Telegram Premium features:** Do **NOT** use `<tg-emoji>` or `icon_custom_emoji_id` anywhere. Use standard Unicode emojis (`📌`, `✅`, `🗑`, `🔄`, `📖`, `⭐`, `⛔`) only.
- **NO streaming drafts (`sendMessageDraft` / `sendRichMessageDraft`):** `src/aiRouter.js` uses non-streaming JSON responses, and active drafts break Android UX (hiding the send button). Keep the existing `StatusPing` (`sendMessage` / `editMessageText` / `deleteMessage`) architecture.
- **Keep `node:sqlite` test compatibility:** `tests/runTests.js` instantiates `AgentDO` directly in Node via `node:sqlite` (`DatabaseSync`). Do not introduce Workers-only APIs inside `AgentDO` methods without safe fallbacks.
- **All Persian UI/prompt text must be natural Persian (`fa`).**

---

## Reference Spec: Telegram Bot API 9.4–10.3 Rich Messages (Verified Docs)

Since Telegram Bot API 10.1–10.3 (June–August 2026) postdates older training cutoffs, **follow this exact verified API specification — do not invent tags or fields**:

### 1. `sendRichMessage` & `editMessageText`
- **Endpoint:** `POST https://api.telegram.org/bot<TOKEN>/sendRichMessage`
- **JSON Request Body:**
  - `chat_id` (number | string)
  - `rich_message` (`InputRichMessage` object):
    - **Exactly ONE of:** `markdown` (string), `html` (string), or `blocks` (array of `InputRichBlock`)
    - `is_rtl`: `boolean` (pass `true` for Persian RTL!)
    - `skip_entity_detection`: `boolean` (optional)
    - `media`: `InputRichMessageMedia[]` (optional; only needed when `html` or `markdown` references `tg://photo?id=...`, `tg://video?id=...`, `tg://document?id=...`, `tg://audio?id=...`)
  - Optional top-level fields: `reply_markup`, `reply_parameters`, `disable_notification`, `message_thread_id`.
- **Editing a Rich Message (`editMessageText`):**
  - `POST https://api.telegram.org/bot<TOKEN>/editMessageText`
  - Pass `{ chat_id, message_id, rich_message: { html: "...", is_rtl: true }, reply_markup }` (**omit** `text` and `parse_mode` when passing `rich_message`).
  - Note: Do not mix plain `sendMessage` and `editMessageText` with `rich_message` on the same message ID.

### 2. Limits & Real-World Gotchas (CRITICAL)
- **Text limit:** Up to **32,768 UTF-8 characters** (clients show "Show More" around ~8,000 chars), max 500 blocks, max nesting 16.
- **20-media practical server cap:** Although docs mention 50 media items, Telegram production servers drop attachments starting at the 21st item. **Never put more than 20 media items in a single Rich Message** — batch larger galleries into groups of `<= 20`.
- **iOS/Mac Table Button Bug:** Buttons placed inside `<table>` cells are **not tappable** on iPhone/iPad/Mac (`Telegram-iOS #2299`). **Never put `<tg-button>` inside `<table>` cells.** Place `<tg-button-row>` as a standalone block between paragraphs/items instead.
- **Fallback required:** Always wrap `sendRichMessage` calls with automatic fallback to classic `sendMessage` (or `sendMediaGroup` for photos) if Telegram returns `!resp.ok`.

### 3. Rich HTML & Rich Markdown Syntax
- **Rich Markdown (`rich_message.markdown`):**
  - GFM-compatible: `**bold**`, `*italic*`, `~~strike~~`, `==marked==`, `||spoiler||`, `` `code` ``, fenced code blocks, `# H1`..`###### H6`, `- ` / `1. ` lists, `- [ ]` / `- [x]` task lists, GFM tables (`| col | col |`), `$inline math$`, `$$block math$$`, `---` divider, `> quote`, footnotes `[^id]`, plus embedded HTML like `<details open><summary>Title</summary>...</details>`, `<u>`, `<sub>`, `<sup>`.
  - **Do NOT escape** MarkdownV2 punctuation in Rich Markdown (`\_`, `\.` would appear literally).
- **Inline / Mid-Text Buttons (`rich_message.html` or inside `rich_message.markdown`):**
  - Added in Bot API 10.3. Up to 8 buttons per `<tg-button-row>`.
  - Exact syntax:
    ```html
    <tg-button-row align="left">
      <tg-button type="callback_data" style="primary" data="note:view:12:1">📖 مشاهده</tg-button>
      <tg-button type="callback_data" style="danger" data="note:del:12:1">🗑 حذف</tg-button>
    </tg-button-row>
    ```
  - Supported `style` values on `<tg-button>` and `InlineKeyboardButton`: `"primary"` (blue), `"success"` (green), `"danger"` (red). (`style="link"` exists for `RichMessageButton` if desired).
  - Supported `type` values: `"callback_data"` (`data="..."`), `"url"` (`url="..."`), `"copy_text"` (`text="..."`), `"disabled"`.
  - Note: Classic `InlineKeyboardMarkup` buttons below the message also accept `style: "primary" | "success" | "danger"`.
- **Slideshow & Collage with Local Binary Upload (`multipart/form-data`):**
  - Use `InputRichMessageMedia`:
    - `id`: `1-64` chars matching `^[A-Za-z0-9_-]+$` (e.g. `"p0"`, `"p1"`)
    - `media`: `{ type: "photo", media: "attach://" + id }`
  - Reference in `rich_message.html`:
    ```html
    <tg-slideshow>
      <img src="tg://photo?id=p0"/>
      <img src="tg://photo?id=p1"/>
      <figcaption>توضیح آلبوم</figcaption>
    </tg-slideshow>
    ```
    (Or `<tg-collage>...</tg-collage>` for a grid.)
  - Send as `FormData`:
    - `form.append("chat_id", String(chatId))`
    - `form.append("rich_message", JSON.stringify({ html, is_rtl: true, media }))`
    - `form.append("p0", new Blob([bytes0], { type: mime0 }), filename0)`

---

## Reference Code Snippets & Implementation Guide

### Part 1: Per-Message Timestamps (`src/util.js`, `src/agentLoop.js`, `src/cron.js`)

#### `src/util.js`
Fix midnight `24:xx` formatting and add `formatMessageTimestamp`:
```javascript
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
```

#### `src/agentLoop.js` (`buildHistoryMessages`)
Attach `formatMessageTimestamp(row.ts)` dynamically to `user` and non-empty `assistant` messages (leaving empty tool-calling `assistant` turns untouched):
```javascript
import { formatMessageTimestamp, currentTimeBlock, getDayWindow, safeJsonParse, escapeHtml } from "./util.js";

export async function buildHistoryMessages(stub, env) {
  const rows = await stub.getTodayAndYesterday();
  const messages = [];
  for (const row of rows) {
    const tsPrefix = formatMessageTimestamp(row.ts);
    if (row.role === "user") {
      const content = [];
      const textBody = row.content ? `${tsPrefix}\n${row.content}` : tsPrefix;
      content.push({ type: "text", text: textBody });
      const mediaRefs = safeJsonParse(row.media_refs, []);
      if (mediaRefs && mediaRefs.length) {
        const parts = await Promise.all(
          mediaRefs.map((ref) =>
            resolveMediaContentPart(env, stub, ref).catch(async (err) => {
              await sendOwnerAlert(
                env,
                `⚠️ <b>یک فایل رسانه‌ای در بازسازی تاریخچه رد شد</b>\nkind: ${ref.kind}\n<code>${String(err.message || err).slice(0, 1000)}</code>`
              );
              return null;
            })
          )
        );
        content.push(...parts.filter(Boolean));
      }
      messages.push({
        role: "user",
        content: content.length === 1 && content[0].type === "text" ? content[0].text : content,
      });
    } else if (row.role === "assistant") {
      const toolCalls = safeJsonParse(row.tool_calls, null);
      const rawText = row.content || "";
      const text = rawText.trim() ? `${tsPrefix}\n${rawText}` : "";
      const msg = { role: "assistant", content: text };
      if (toolCalls) msg.tool_calls = toolCalls;
      messages.push(msg);
    } else if (row.role === "tool") {
      messages.push({ role: "tool", tool_call_id: row.tool_call_id, name: row.tool_name, content: row.content || "" });
    }
  }
  return messages;
}
```

#### `src/cron.js` (`checkRollover`)
Include message timestamps in `conversationText` AND separate Vectorize indexing from the cumulative system-prompt rollup:
```javascript
import { formatHumanDateTime } from "./util.js";
import { EMBEDDING_DIMENSIONS, IRAN_TZ } from "./config.js";

// Inside checkRollover:
  const conversationText = agedMessages
    .map((m) => {
      const stamp = formatHumanDateTime(m.ts, IRAN_TZ);
      if (m.role === "user") return m.content ? `[${stamp}] کاربر: ${m.content}` : null;
      if (m.role === "assistant") return m.content ? `[${stamp}] دستیار: ${m.content}` : null;
      return null;
    })
    .filter(Boolean)
    .join("\n");
```
- Also in `checkRollover`: compute a **window-only summary** of `agedMessages` (`oldestAged..boundary`) for `MEMORY_INDEX.upsert` (using `callEmbeddings`) so Vectorize stores distinct chronological chunks instead of repeating Day 1..N inside every single vector! Keep `currentRollup` (`setCurrentRollup`) as the rolling summary for `<older_rollup>` in the system prompt, and improve `summarizationPrompt` to preserve exact dates/times and distinguish confirmed user decisions vs unconfirmed assistant suggestions.

---

### Part 2: Line-Numbered Views & Safe Patching (`src/util.js`, `src/agentDO.js`, `src/tools/notes.js`, `src/tools/memory.js`, `src/agentLoop.js`)

#### `src/util.js`
```javascript
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
```
- **Important details:**
  1. Never persist line numbers in SQLite (`notes.body` and `memory_profile.content` always stay unnumbered raw text).
  2. Keep `stub.getNote(id)` returning raw `note` so `src/index.js` (`/notes` UI) sends clean text to the user without `1 | ` prefixes.
  3. In `src/tools/notes.js`:
     - `get_note` returns `{ ok: true, note: { id, title, tags, created_at, updated_at, line_count, numbered_body: formatNumberedLines(note.body) } }`.
     - Add `patch_note` (`id`, `edits`, optional `expected_updated_at`, optional `title`, optional `tags`) calling `stub.patchNote(...)`.
     - Update `edit_note` description to emphasize full-body replacement only; prefer `patch_note` or `append_note`.
     - Update `search_notes` description to remind the model to try shorter stems, tags, or Persian/Arabic letter variants (`ی/ي`, `ک/ك`) if 0 matches return.
  4. In `src/tools/memory.js`:
     - Add `patch_memory` (`edits` using the same `applySafePatches` schema) calling `stub.patchMemoryProfile(args.edits)`.
     - Update `update_memory` description to reserve it for initial setup or major full-profile reorganizations.
  5. In `src/agentLoop.js` (`buildSystemPrompt`):
     - Render `<user_profile>` with `formatNumberedLines(memoryProfile)` and add a short header note that `N | ` prefixes are read-only display markers.

---

### Part 3: Telegram Bot API 10.1–10.3 Rich UI (`src/telegram.js`, `src/index.js`, `src/tools/sandbox.js`)

#### `src/telegram.js`
```javascript
const RICH_CHUNK_SIZE = 30000; // Telegram RichMessage hard limit is 32,768 UTF-8 chars
const MAX_RICH_MEDIA_ITEMS = 20; // Telegram server caps media at 20 in practice (docs say 50)

export async function sendRichMessage(env, chatId, richMessage, extra = {}, mediaItems = null) {
  const payloadRich = { is_rtl: true, ...richMessage };
  let fetchOpts;

  if (Array.isArray(mediaItems) && mediaItems.length > 0) {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    const mediaDescriptors = mediaItems.map((item) => ({
      id: item.id,
      media: { type: item.type || "photo", media: `attach://${item.id}` },
    }));
    form.append("rich_message", JSON.stringify({ ...payloadRich, media: mediaDescriptors }));
    for (const [key, val] of Object.entries(extra)) {
      if (val === undefined || val === null) continue;
      form.append(key, typeof val === "object" ? JSON.stringify(val) : String(val));
    }
    for (const item of mediaItems) {
      form.append(
        item.id,
        new Blob([item.bytes], { type: item.mimeType || "image/jpeg" }),
        item.filename || `${item.id}.jpg`
      );
    }
    fetchOpts = {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(Math.max(TELEGRAM_API_TIMEOUT_MS, 120000)),
    };
  } else {
    fetchOpts = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, rich_message: payloadRich, ...extra }),
      signal: AbortSignal.timeout(Math.max(TELEGRAM_API_TIMEOUT_MS, 30000)),
    };
  }

  try {
    const resp = await fetch(`${TG_API(env.TELEGRAM_BOT_TOKEN)}/sendRichMessage`, fetchOpts);
    return await resp.json().catch(() => null);
  } catch (err) {
    console.error("sendRichMessage failed:", err.message || err);
    return null;
  }
}

export async function editRichMessage(env, chatId, messageId, richMessage, extra = {}) {
  try {
    const resp = await fetch(`${TG_API(env.TELEGRAM_BOT_TOKEN)}/editMessageText`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        rich_message: { is_rtl: true, ...richMessage },
        ...extra,
      }),
      signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
    });
    return await resp.json().catch(() => null);
  } catch (err) {
    console.error("editRichMessage failed:", err.message || err);
    return null;
  }
}

function shouldUseRichMarkdown(text) {
  if (!text) return false;
  if (text.length > CHUNK_SIZE) return true;
  // GFM pipe tables
  if (/^\|.+\|\s*\n\|[\s:|-]+\|/m.test(text)) return true;
  // Collapsible details
  if (/<details[\s>]/i.test(text)) return true;
  // Block math $$...$$
  if (/\$\$[\s\S]+?\$\$/m.test(text)) return true;
  return false;
}

export async function sendMarkdown(env, chatId, markdownText, extra = {}) {
  const src = String(markdownText || "");
  if (shouldUseRichMarkdown(src)) {
    const parts = [];
    for (let i = 0; i < src.length; i += RICH_CHUNK_SIZE) {
      parts.push(src.slice(i, i + RICH_CHUNK_SIZE));
    }
    let last = null;
    let richFailed = false;
    for (const part of parts) {
      const res = await sendRichMessage(env, chatId, { markdown: part, is_rtl: true }, extra);
      if (!res?.ok) {
        richFailed = true;
        break;
      }
      last = res;
    }
    if (!richFailed) return last;
  }
  return sendMessage(env, chatId, markdownToTelegramHtml(src), extra);
}

export async function sendRichMediaGallery(env, chatId, items, { mode = "slideshow", caption } = {}) {
  const tag = mode === "collage" ? "tg-collage" : "tg-slideshow";
  let last = null;
  for (let offset = 0; offset < items.length; offset += MAX_RICH_MEDIA_ITEMS) {
    const batch = items.slice(offset, offset + MAX_RICH_MEDIA_ITEMS);
    const mediaItems = batch.map((it, idx) => ({
      id: `p${idx}`,
      type: "photo",
      bytes: it.bytes,
      mimeType: it.mimeType || "image/jpeg",
      filename: it.filename || `photo${idx}.jpg`,
    }));
    const imgsHtml = mediaItems.map((m) => `<img src="tg://photo?id=${m.id}"/>`).join("");
    const capHtml = offset === 0 && caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : "";
    const html = `<${tag}>${imgsHtml}${capHtml}</${tag}>`;

    const res = await sendRichMessage(env, chatId, { html, is_rtl: true }, {}, mediaItems);
    if (!res?.ok) {
      // Fallback to classic sendMediaGroup in chunks of 10
      for (let i = 0; i < batch.length; i += 10) {
        const chunk = batch.slice(i, i + 10).map((it, j) => ({
          ...it,
          caption: offset === 0 && i === 0 && j === 0 ? caption : undefined,
        }));
        last = await sendMediaGroup(env, chatId, chunk);
      }
    } else {
      last = res;
    }
  }
  return last;
}
```
- Also in `src/tools/sandbox.js` (`send_sandbox_files`):
  - Add optional parameter `display` (`enum: ["slideshow", "collage", "album"]`, default `"slideshow"` when `validPhotos.length > 1`, or `"album"` if explicitly requested).
  - Note: when `display !== "album"`, collect valid photo batches up to 20 items (`sendRichMediaGallery`) instead of slicing by 10! Keep the existing 10-per-`sendMediaGroup` path when `display === "album"`.

#### `src/index.js` (Interactive Mid-Text Button UIs for `/notes`, `/todos`, `/sandboxes`, `/wakeups`, `/skills`)
Example pattern for `/notes` using `sendRichMessage` + `editRichMessage` + `<tg-button-row>` (never put buttons inside `<table>` cells):
```javascript
async function renderNotesPageRich(stub, page = 1) {
  const { notes, totalCount, totalPages, page: currentPage } = await stub.listNotesPaginated({ page, pageSize: NOTES_PAGE_SIZE });
  if (!notes.length) {
    return { html: "<p>هیچ یادداشتی ثبت نشده.</p>" };
  }
  const blocks = [
    `<h3>📝 لیست یادداشت‌ها</h3>`,
    `<p>صفحه ${currentPage} از ${totalPages} — کل: ${totalCount}</p>`,
  ];
  for (const n of notes) {
    const tagsHtml = n.tags ? ` <code>${escapeHtml(n.tags)}</code>` : "";
    const dateStr = new Date(n.updated_at).toLocaleDateString("fa-IR", { timeZone: "Asia/Tehran" });
    blocks.push(
      `<p><b>[${n.id}] ${escapeHtml(n.title)}</b>${tagsHtml}<br><i>به‌روزرسانی: ${escapeHtml(dateStr)}</i></p>` +
      `<tg-button-row align="left">` +
      `<tg-button type="callback_data" style="primary" data="note:view:${n.id}:${currentPage}">📖 مشاهده</tg-button>` +
      `<tg-button type="callback_data" style="danger" data="note:del:${n.id}:${currentPage}">🗑 حذف</tg-button>` +
      `</tg-button-row>`
    );
  }
  const navButtons = [];
  if (currentPage > 1) {
    navButtons.push(`<tg-button type="callback_data" data="note:page:${currentPage - 1}">⬅️ قبلی</tg-button>`);
  }
  navButtons.push(`<tg-button type="disabled">صفحه ${currentPage}/${totalPages}</tg-button>`);
  if (currentPage < totalPages) {
    navButtons.push(`<tg-button type="callback_data" data="note:page:${currentPage + 1}">بعدی ➡️</tg-button>`);
  }
  blocks.push(`<hr/><tg-button-row align="center">${navButtons.join("")}</tg-button-row>`);
  return { html: blocks.join("\n"), is_rtl: true };
}
```
Apply the same rich mid-text `<tg-button-row>` interactive list pattern (with fallback to `sendMessage` if `sendRichMessage` fails) to `/todos` (`done` / `del`), `/sandboxes` (`main` / `enable|disable` / `del`), `/wakeups` (`enable|disable` / `del`), and `/skills` (`enable|disable` / `del`). Add corresponding `toggleWakeSlot` / `toggleSkill` helpers in `src/agentDO.js` and handle all callbacks cleanly in `src/index.js`.
- Note on `note:view`: keep `stub.getNote(noteId)` returning raw text, and when viewing a short note (`<= 3500` chars) inside the rich message, update via `editRichMessage` with a `<tg-button-row>` back button (`⬅️ بازگشت به لیست`). When `note.body.length > 3500`, send via `sendMarkdown` (which routes long notes up to 32k chars cleanly through `sendRichMessage`!).

---

### Part 4: Agent Loop, Prompt & Sub-Prompt Fixes (`src/config.js`, `src/agentLoop.js`, `src/sandboxAssets/imgsearch.js`, `src/tools/*.js`)

#### `src/agentLoop.js`
1. **Fix `StatusPing` double-edit (`content` vs `report_message`):**
   Only call `status.updateThinking` when `message.content.trim()` is non-empty **and** differs from the first tool call's `report_message`:
   ```javascript
   const firstReport = message.tool_calls[0]?.function?.arguments
     ? safeJsonParse(message.tool_calls[0].function.arguments, {})?.report_message?.trim()
     : null;
   if (message.content && message.content.trim() && message.content.trim() !== firstReport) {
     await status.updateThinking(message.content.trim());
   }
   ```
2. **Fix `[SILENT]` handling in `proactive_wake`:**
   Do NOT send `[SILENT]` to Telegram; record an internal closed assistant turn instead of appending raw `[SILENT]`:
   ```javascript
   // Right after the tool loop breaks with finalText:
   if (finalText.trim() === "[SILENT]") {
     await stub.appendMessage({
       dayWindow: today,
       role: "assistant",
       content: "[سکوت خودکار — پیامی ارسال نشد]",
     });
     logSafe(stub, { kind: "turn_end", status: "ok", detail: "proactive_silent", latencyMs: Date.now() - turnStartedAt });
     return;
   }
   await stub.appendMessage({ dayWindow: today, role: "assistant", content: finalText });
   ```
   (Remove the earlier `await stub.appendMessage({ dayWindow: today, role: "assistant", content: finalText });` inside the `for` loop so it only appends once after checking `[SILENT]`.)
3. **Remove the 50,000-char truncation in `compressSandboxResult` COMPLETELY:**
   - Do **NOT** slice `combined` (`combined.slice(0, 50000)` or head/tail slicing). When the agent reads files/outputs in `run_code_sandbox`, slicing silently drops file content before `fast` filters it.
   - Pass the **full** `${combined}` directly to the `fast` model inside `compressSandboxResult`!
4. **Update `buildSystemPrompt(stub)`:**
   Wrap every dynamic section in clean XML tags instead of `--- ... ---`:
   `<clock>`, `<user_profile>`, `<notes_index>`, `<available_skills>`, `<sandboxes>`, `<older_rollup>`, `<active_plan>`.
   Format `<user_profile>` with `formatNumberedLines(memoryProfile)`.
5. **Update `transcribeAudioRef`:**
   Add one line instructing the `fast` model to keep English technical terms in English script rather than translating or transliterating them unnecessarily.

#### `src/config.js`
1. Refactor `BASE_SYSTEM_PROMPT` into compact XML sections (`<role>`, `<formatting>`, `<tools_and_skills>`, `<memory_and_state>`, `<error_handling>`):
   - **Formatting:** GFM tables, headings, `$...$` math, and `<details>` collapsible blocks work; never place clickable elements inside table cells; in casual/personal/emotional chats skip headers and bullets.
   - **Timestamps:** Explicitly tell the model that `[🕒 ...]` on history messages is system metadata and it must **never** echo or generate `[🕒 ...]` in its own replies.
   - **Skills & Tools:** Mandatory `view_skill` check before acting on tasks matching `<available_skills>`; put live status **only** in `report_message` and leave `message.content` empty during tool calls; after the last tool call, reply directly without repeating pre-tool chatter, tool-delivered content (`create_plan`, `speak`, `send_sandbox_files`), or `"انجام شد."`.
   - **Memory & Notes:** 3-month durability test for `patch_memory` / `update_memory`; working-notebook test + search-before-saying-unknown (`search_notes` / `search_memory`) + read-before-patch (`get_note` -> `patch_note` / `append_note`) for notes, with concise Good/Bad examples.
2. Update `PROACTIVE_GUIDELINES` to require returning exact `[SILENT]` when choosing not to send a message.

#### `src/sandboxAssets/imgsearch.js` & `src/tools/*.js`
- **`imgsearch.js`:** Enhance the batch vision-filter prompt with clear rejection criteria (watermarked stock images, blurry/low-res thumbnails, unrelated collages, text-heavy screenshots when clean photos are requested) and an explicit JSON example `{"selected_ids": ["img0"]}` (or `{"selected_ids": []}`).
- **`tools/*.js`:** Add concise `WHEN NOT TO USE` / guardrails to `tts.js` (`speak`), `web.js` (`web_search`), `sandbox.js` (`get_sandbox_file` vs `send_sandbox_files`), and `notes.js` (`edit_note`, `search_notes`).

---

## Part 5: `tests/runTests.js` Verification Checklist
Expand `tests/runTests.js` with `node:sqlite` + `globalThis.fetch` mocks covering:
1. `formatHumanDateTime` at `00:15` (verifies `hourCycle: "h23"` produces `00:15`, never `24:15`) and `formatMessageTimestamp` + `buildHistoryMessages` (text turn, photo-only turn with empty `content`, assistant turn, tool turn).
2. `formatNumberedLines`, `applySafePatches`, `stub.patchNote`, and `stub.patchMemoryProfile`:
   - Exact `old_text` patch succeeds & updates `updated_at`.
   - Missing or ambiguous `old_text` throws without mutating DB.
   - Line-range patch succeeds with matching `expected_first_line`, rejects off-by-one mismatch with numbered context preview.
   - Rejects accidental `1 | ` line-prefix leaks.
   - `stub.getNote(id)` still returns unnumbered raw body for Telegram UI, while `tools/notes.js` `get_note` returns `numbered_body`.
3. `[SILENT]` handling in `runAgentTurnLocked` on `proactive_wake` (verifies 0 Telegram sends and closed assistant turn in SQLite).
4. `compressSandboxResult` sends full `>50,000`-char `stdout` to the `fast` model without `.slice(0, 50000)` truncation.
5. `sendMarkdown` routing (table/long text -> `/sendRichMessage` with `is_rtl: true`, fallback to `/sendMessage` on HTTP 400).
6. `sendRichMediaGallery` splits >20 photos into batches of `<= 20` and never emits `<tg-emoji>` or `icon_custom_emoji_id`.
7. Rich `/notes` HTML rendering uses `<tg-button-row>` outside tables and `style="primary|danger"`.

Run `npm test` after finishing and report exact pass/fail counts and any warnings.