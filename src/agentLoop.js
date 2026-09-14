import { BASE_SYSTEM_PROMPT, CHAT_MODEL, MAX_TOOL_ITERATIONS, TURN_SOFT_DEADLINE_MS, statusTextFor } from "./config.js";
import { currentTimeBlock, getDayWindow, safeJsonParse, escapeHtml } from "./util.js";
import { callChatCompletions } from "./aiRouter.js";
import { allToolDefinitions, dispatchTool } from "./tools/index.js";
import { downloadTelegramFile, sendMessage, sendMarkdown, editMessage, deleteMessage, sendOwnerAlert } from "./telegram.js";
import { freestyleWriteFile } from "./freestyleClient.js";
import { base64ToBytes } from "./util.js";

const UPLOADS_DIR = "/home/ubuntu/uploads";

function sanitizeFilename(filename) {
  let cleaned = filename.replace(/[^a-zA-Z0-9_\-\.]/g, "_");
  cleaned = cleaned.replace(/^\.+/, "");
  if (!cleaned) cleaned = "file_" + Date.now();
  if (cleaned.length > 100) cleaned = cleaned.slice(-100);
  return cleaned;
}

function guessFilename(ref) {
  const ext = ref.mimeType ? ref.mimeType.split("/").pop() : ref.kind || "bin";
  return `file_${Date.now()}.${ext}`;
}

export async function saveIncomingFileToMainSandbox(env, stub, ref) {
  const mainSandbox = await stub.getMainSandbox();
  if (!mainSandbox) throw new Error("هیچ سندباکس اصلی ثبت نشده - با /setmainsandbox یکی رو مشخص کن.");
  const { base64 } = await downloadTelegramFile(env, ref.fileId);
  const rawFilename = sanitizeFilename(ref.filename || guessFilename(ref));
  const ts = Date.now();
  const filename = `${ts}_${rawFilename}`;
  const path = `${UPLOADS_DIR}/${filename}`;
  await freestyleWriteFile(env, mainSandbox.vm_id, path, base64ToBytes(base64));
  return { path, filename };
}

// ===========================================================================
// System prompt assembly
// ===========================================================================

async function buildSystemPrompt(stub) {
  const [memoryProfile, planBlock, skills, currentRollup, sandboxes] = await Promise.all([
    stub.getMemoryProfile(),
    stub.renderPlanBlock(),
    stub.listSkills(),
    stub.getCurrentRollup(),
    stub.listSandboxes(),
  ]);

  const sections = [BASE_SYSTEM_PROMPT, currentTimeBlock()];

  if (memoryProfile) {
    sections.push(`--- حافظه‌ی بلندمدت درباره‌ی کاربر ---\n${memoryProfile}`);
  }
  if (skills.length) {
    const skillLines = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    sections.push(`--- Skillهای موجود (برای دیدن متن کامل هرکدوم از view_skill استفاده کن) ---\n${skillLines}`);
  }
  if (sandboxes.length) {
    const lines = sandboxes.map((s) => `- ${s.code}${s.is_main ? " (پیش‌فرض/اصلی)" : ""}: ${s.description || "بدون توضیح"}`).join("\n");
    sections.push(`--- سندباکس‌های موجود (برای run_code_sandbox / get_sandbox_file / look از پارامتر sandbox_code استفاده کن؛ اگه ندی، سندباکس اصلی استفاده می‌شه) ---\n${lines}`);
  }
  if (currentRollup) {
    sections.push(
      `--- خلاصه‌ی فشرده‌ی مکالمات قدیمی‌تر (${currentRollup.covers_from_day} تا ${currentRollup.covers_to_day}) ---\n${currentRollup.summary}`
    );
  }
  if (planBlock) {
    sections.push(`--- ${planBlock}`);
  }

  return sections.join("\n\n");
}

// ===========================================================================
// History assembly (today + yesterday, media rehydrated inline)
// ===========================================================================

/**
 * یک مدیا-رفرنس تلگرام رو به یک content part برای مدل تبدیل می‌کنه.
 * ترتیب: اول کش حافظه (سریع‌ترین)، بعد کش SQLite، بعد دانلود از تلگرام.
 * جدا نوشتنش (به‌جای این‌که مستقیم توی حلقه باشه) لازمه تا بشه با
 * Promise.all چند عکس رو هم‌زمان resolve کرد.
 */
async function resolveMediaContentPart(env, stub, ref) {
  if (ref.fileId && ref.fileId.startsWith("sandbox:")) {
    const cached = await stub.getCachedMedia(ref.fileId);
    if (!cached) return null;
    return { type: "image_url", image_url: { url: `data:${cached.mimeType};base64,${cached.base64}` } };
  }
  let cached = await stub.getCachedMedia(ref.fileId);
  if (!cached) {
    const downloaded = await downloadTelegramFile(env, ref.fileId);
    cached = { base64: downloaded.base64, mimeType: downloaded.mimeType };
    await stub.setCachedMedia(ref.fileId, cached.base64, cached.mimeType);
  }
  if (!cached.mimeType.startsWith("image/")) return null;
  return { type: "image_url", image_url: { url: `data:${cached.mimeType};base64,${cached.base64}` } };
}

async function buildHistoryMessages(stub, env) {
  const rows = await stub.getTodayAndYesterday();
  const messages = [];
  for (const row of rows) {
    if (row.role === "user") {
      const content = [];
      if (row.content) content.push({ type: "text", text: row.content });
      const mediaRefs = safeJsonParse(row.media_refs, []);
      if (mediaRefs && mediaRefs.length) {
        const parts = await Promise.all(
          mediaRefs.map((ref) =>
            resolveMediaContentPart(env, stub, ref).catch(async (err) => {
              await sendOwnerAlert(
                env,
                `⚠️ <b>یک فایل رسانه‌ای در بازسازی تاریخچه رد شد</b>
kind: ${ref.kind}
<code>${String(err.message || err).slice(0, 300)}</code>`
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
      const msg = { role: "assistant", content: row.content || "" };
      const toolCalls = safeJsonParse(row.tool_calls, null);
      if (toolCalls) msg.tool_calls = toolCalls;
      messages.push(msg);
    } else if (row.role === "tool") {
      messages.push({ role: "tool", tool_call_id: row.tool_call_id, name: row.tool_name, content: row.content || "" });
    }
  }
  return messages;
}

// ===========================================================================
// Status ping (single evolving message, edited as each tool runs) - hardened
// so a Telegram hiccup while updating/deleting the ping can never abort the
// turn itself.
// ===========================================================================

class StatusPing {
  constructor(env, stub, chatId) {
    this.env = env;
    this.stub = stub;
    this.chatId = chatId;
    this.messageId = null;
    this.lastSentText = null;
    this.turnStartedAt = Date.now();
  }

  async showInitialThinking() {
    await this._send("⏳ در حال بررسی...");
  }

  // متن آزاد خودِ مدل قبل از صدا زدن ابزار (content) - بدون برچسب ثابت
  async updateThinking(text) {
    await this._send(escapeHtml(text));
  }

  // هر بار صدا زدن یک ابزار - همیشه یک برچسب قطعی مخصوص همون ابزار داره
  async update(toolName, reportMessage = null) {
    let text = statusTextFor(toolName);
    if (reportMessage && reportMessage.trim()) text += `\n${escapeHtml(reportMessage.trim())}`;
    await this._send(text);
  }

  async _send(text) {
    if (text === this.lastSentText) {
      const elapsedSec = Math.round((Date.now() - this.turnStartedAt) / 1000);
      text = `${text} ⏱️${elapsedSec}s`;
    }
    try {
      const result = this.messageId
        ? await editMessage(this.env, this.chatId, this.messageId, text)
        : await sendMessage(this.env, this.chatId, text);

      if (result?.ok) {
        this.messageId = result.result?.message_id ?? this.messageId;
        this.lastSentText = text;
        return;
      }
      if (result?.error_code === 429 && result?.parameters?.retry_after) {
        await new Promise((r) => setTimeout(r, Math.min(result.parameters.retry_after * 1000, 5000)));
        const retry = this.messageId
          ? await editMessage(this.env, this.chatId, this.messageId, text)
          : await sendMessage(this.env, this.chatId, text);
        if (retry?.ok) {
          this.messageId = retry.result?.message_id ?? this.messageId;
          this.lastSentText = text;
        }
        return;
      }
      if (result && !result.ok && !/message is not modified/i.test(result.description || "")) {
        this._logFailure(result);
        this.messageId = null;
      }
    } catch {
      // مشکل شبکه‌ای خودِ status ping نباید کل turn رو بخوابونه
    }
  }

  _logFailure(result) {
    try {
      const p = this.stub.appendLog({ kind: "status_ping", status: "error", detail: JSON.stringify(result).slice(0, 300) });
      if (p?.catch) p.catch(() => {});
    } catch {}
  }

  async finish() {
    if (this.messageId) {
      try {
        await deleteMessage(this.env, this.chatId, this.messageId);
      } catch {
        // best effort
      }
    }
  }
}

function logSafe(stub, entry) {
  try {
    const p = stub.appendLog(entry);
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {
    // logging must never break the turn
  }
}

function fallbackReport(toolName, args) {
  if (!args) return null;
  if (toolName === "run_code_sandbox") return `کد ${args.language || "python"}: ${(args.code || "").slice(0, 60)}...`;
  if (toolName === "web_search") return `جستجو: ${args.query || ""}`;
  if (toolName === "web_extract") return `استخراج: ${args.url || ""}`;
  if (toolName === "get_sandbox_file") return `فایل: ${args.path || ""}`;
  return null;
}

function looksLikeJson(text) {
  const t = (text || "").trim();
  if (!t) return false;
  const wrapped =
    (t.startsWith("{") && t.endsWith("}")) ||
    (t.startsWith("[") && t.endsWith("]"));
  if (!wrapped) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

function cleanCommonLogs(text) {
  if (!text) return "";
  return text
    .replace(/(?:^|\n)Reading package lists\.\.\.[\s\S]*?Unpacking[\s\S]*?\n/g, "\n[لاگ نصب پکیج‌ها خلاصه‌شد]\n")
    .replace(/^[ \t]*Downloading [^\n]+\n/gm, "")
    .replace(/(?:^|\n)\s*[\d\.]+%?\s*(?:\||█|\[).*?(?:it\/s|[KMGT]?B\/s|%)(?=\r|\n|$)/g, "")
    .replace(/(?:^|\n)(?:frame=\s*\d+\s+fps=[\s\S]*?\r?\n){3,}/g, "\n[لاگ رندر فریم‌های ffmpeg خلاصه‌شد]\n");
}

async function compressSandboxResult(env, resultPayload) {
  if (!resultPayload?.ok) return resultPayload;

  // گارد ساختاری: اگر stdout خودش یک JSON کامله (خروجی CLIها مثل OfficeCLI)، دست‌نخورده برگردان
  if (looksLikeJson(resultPayload.stdout)) {
    return resultPayload;
  }

  let combined = `${resultPayload.stdout || ""}\n${resultPayload.stderr || ""}`.trim();

  // ۱. اگر خطوط کم بود (زیر ۶ خط) یا طول زیر ۱۰۰۰ کاراکتر بود، دست‌نخورده نگه دار
  if (combined.split("\n").length <= 6 || combined.length < 1000) {
    return resultPayload;
  }

  // ۲. تمیزکاری با الگوی Regex متنی
  combined = cleanCommonLogs(combined);
  if (combined.length < 1000) {
    return { ...resultPayload, stdout: combined, stderr: "" };
  }

  // ۳. خلاصه‌سازی با مدل fast (با ۱ بار retry)
  const prompt = `تو یک فشرده‌ساز خروجی خط‌فرمان هستی، نه خلاصه‌نویس آزاد. این خروجی ممکنه از هر ابزاری باشه (نصب پکیج، بیلد، تست، CLI مدیریت اسناد/فایل، یا هر ابزار دیگه‌ای) — نمی‌دونی کدومه، پس بر اساس شکل محتوا تصمیم بگیر، نه حدس درباره‌ی ابزار.

بین دو نوع محتوا فرق بذار:

۱) نویز فرایندی (اجازه داری کاملاً حذف یا خیلی خلاصه کنی):
- خط‌های تکراری/تقریباً یکسان (retry، polling، heartbeat)
- نوار پیشرفت دانلود/نصب/build، درصد، spinner
- بنر/ASCII art، خط‌جداکننده‌ی تزئینی
- پیام‌های "دارم انجام میدم..." بدون هیچ داده‌ی جدید

۲) داده/نتیجه (هرگز پارافریز، بازنویسی، یا حذف نکن — کلمه‌به‌کلمه نگه‌دار):
- هر بلوک JSON یا آرایه‌ی JSON کامل. اگه با { یا [ شروع می‌شه، فرضت اینه دست‌نخورده برگردونیش. اگه واقعاً خیلی طولانی بود، فقط مجازی آیتم‌های وسطِ یک آرایه رو حذف کنی و بنویسی «... و N مورد دیگر» — ولی هیچ‌وقت key یا value داخل یک آبجکت رو عوض یا حذف نکن.
- هر پیام خطا، stack trace، شماره خط، مسیر فایل، exit code
- هر مقدار محاسبه‌شده، متن استخراج‌شده، محتوای واقعی یک فایل/سند (مثل متن یک پاراگراف، سلول، شکل)، هر مسیر/ID ساختاری (مثل /slide[1]/shape[2])
- تایید نهایی موفقیت یا شکست عملیات
- هر خطی که مطمئن نیستی نویزه یا داده — با آن مثل داده رفتار کن؛ وقتی شک داری، نگه‌دار نه حذف

قوانین خروجی:
- فقط و فقط متن نهایی رو برگردون، بدون مقدمه/موخره/توضیح اضافه (مثلاً نگو "این هم خلاصه:").
- کارت انتخابِ کدوم خط بمونه‌ست، نه بازنویسیِ محتوا با کلمات خودت.

خروجی خام:
${combined.slice(0, 50000)}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await callChatCompletions(env, {
        model: "fast",
        messages: [{ role: "user", content: prompt }],
      });
      const summary = resp.choices?.[0]?.message?.content?.trim();
      if (summary) {
        return {
          ...resultPayload,
          stdout: summary,
          stderr: "",
          summarized: true,
          original_length: combined.length,
        };
      }
    } catch (err) {
      if (attempt === 2) {
        await sendOwnerAlert(env, `⚠️ خلاصه‌سازی خروجی سندباکس با مدل fast ناموفق بود. خروجی کامل استفاده شد.`);
      }
    }
  }

  return resultPayload;
}

// ===========================================================================
// Main entry point. `trigger` is one of:
//   {kind: "user_message", text, mediaRefs}
//   {kind: "todo_fired", todo}
//   {kind: "proactive", theme}
// ===========================================================================

export async function runAgentTurnLocked({ env, ctx, stub, chatId, trigger, dedupeKey }) {
  if (dedupeKey) {
    if (await stub.wasDedupeKeySeen(dedupeKey)) {
      logSafe(stub, { kind: "turn_dedupe_skip", status: "ok", detail: dedupeKey });
      return;
    }
    await stub.markDedupeKeySeen(dedupeKey);
  }

  const today = getDayWindow();
  const turnStartedAt = Date.now();
  logSafe(stub, { kind: "turn_start", status: "ok", detail: trigger.kind });

  if (trigger.kind === "user_message") {
    let text = trigger.text || "";
    const imageRefs = [];
    for (const ref of trigger.mediaRefs || []) {
      if (ref.kind === "image") {
        imageRefs.push(ref);
        continue;
      }
      try {
        const saved = await saveIncomingFileToMainSandbox(env, stub, ref);
        text += `\n📎 فایل «${saved.filename}» (${ref.mimeType || ref.kind}) در سندباکس اصلی ذخیره شد؛ مسیر: ${saved.path}`;
      } catch (err) {
        text += `\n⚠️ فایل (${ref.kind}) دریافت شد ولی ذخیره در سندباکس با خطا مواجه شد: ${String(err.message || err)}`;
      }
    }
    stub.appendMessage({
      dayWindow: today,
      role: "user",
      content: text,
      mediaRefs: imageRefs.length ? imageRefs : null,
    });
  } else if (trigger.kind === "todo_fired") {
    const syntheticId = `todo_fired_${trigger.todo.id}_${Date.now()}`;
    stub.appendMessage({
      dayWindow: today,
      role: "user",
      content: "⏰ [یادآوری خودکار]",
    });
    stub.appendMessage({
      dayWindow: today,
      role: "assistant",
      content: "",
      toolCalls: [{ id: syntheticId, type: "function", function: { name: "todo_check", arguments: "{}" } }],
    });
    stub.appendMessage({
      dayWindow: today,
      role: "tool",
      toolCallId: syntheticId,
      toolName: "todo_check",
      content: `⏰ زمان یادآوری «${trigger.todo.title}» رسیده.${trigger.todo.description ? ` توضیحات: ${trigger.todo.description}` : ""}`,
    });
  } else if (trigger.kind === "proactive_wake") {
    const syntheticId = `proactive_${Date.now()}`;
    stub.appendMessage({
      dayWindow: today,
      role: "user",
      content: "⏰ [بیدارباش خودکار]",
    });
    stub.appendMessage({
      dayWindow: today,
      role: "assistant",
      content: "",
      toolCalls: [{ id: syntheticId, type: "function", function: { name: "proactive_wake", arguments: "{}" } }],
    });
    stub.appendMessage({
      dayWindow: today,
      role: "tool",
      toolCallId: syntheticId,
      toolName: "proactive_wake",
      content: `⏰ الان یکی از زمان‌های بیدارشدن خودکاره. موضوعی که خودت برای این ساعت تعیین کرده بودی: «${trigger.theme}».\nبر همین اساس (با کمک web_search و/یا حافظه‌ی بلندمدت در صورت نیاز) تصمیم بگیر چیکار کنی؛ اگه چیزی برای گفتن پیدا کردی بفرست، وگرنه لازم نیست هرقیمتی پیام بدی.`,
    });
  } else if (trigger.kind === "continue_turn") {
    // هیچ پیام جدیدی به تاریخچه اضافه نمی‌شود - فقط در این invocation ادامه داده می‌شود.
  }

  const systemPrompt = await buildSystemPrompt(stub);
  const history = await buildHistoryMessages(stub, env);
  const messages = [{ role: "system", content: systemPrompt }, ...history];

  const status = new StatusPing(env, stub, chatId);
  if (trigger.kind === "user_message") {
    await status.showInitialThinking();
  }
  const toolContext = { env, ctx, stub, chatId };

  let finalText = null;
  let loopError = null;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    if (Date.now() - turnStartedAt > TURN_SOFT_DEADLINE_MS) {
      await env.TURNS_QUEUE.send({ chatId, trigger: { kind: "continue_turn" } });
      await status.finish();
      logSafe(stub, {
        kind: "turn_yield",
        status: "ok",
        detail: "soft deadline reached, continuation enqueued",
        latencyMs: Date.now() - turnStartedAt,
      });
      return;
    }

    let response;
    const selectedModel = (await stub.getMeta("selected_chat_model")) || CHAT_MODEL;
    try {
      response = await callChatCompletions(env, { model: selectedModel, messages, tools: allToolDefinitions() });
    } catch (err) {
      loopError = err;
      break;
    }

    const message = response.choices?.[0]?.message;
    if (!message) {
      loopError = new Error("پاسخ نامعتبری از مدل گرفته شد (بدون message).");
      break;
    }

    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      messages.push({ role: "assistant", content: message.content || "", tool_calls: message.tool_calls });
      stub.appendMessage({
        dayWindow: today,
        role: "assistant",
        content: message.content || "",
        toolCalls: message.tool_calls,
      });

      if (message.content && message.content.trim()) {
        await status.updateThinking(message.content.trim());
      }

      for (const call of message.tool_calls) {
        const toolName = call.function.name;
        const rawArgs = call.function.arguments;
        const args = safeJsonParse(rawArgs, undefined);

        if (args === undefined) {
          await sendOwnerAlert(env, `🚨 JSON نامعتبر در آرگومان "${toolName}"\n<code>${escapeHtml((rawArgs || "").slice(0, 500))}</code>`);
          await status.update(toolName, "⚠️ خطا در دریافت آرگومان‌ها از مدل");
          const errResult = { ok: false, error: "آرگومان‌های ارسالی قابل parse نبودند، دوباره تلاش کن." };
          const resultText = JSON.stringify(errResult);
          messages.push({ role: "tool", tool_call_id: call.id, name: toolName, content: resultText });
          stub.appendMessage({ dayWindow: today, role: "tool", toolCallId: call.id, toolName, content: resultText });
          continue;
        }

        console.log(`[DEBUG_TOOL] Call: ${toolName}, Args:`, JSON.stringify(args));
        const reportMessage = (args.report_message && args.report_message.trim())
          ? args.report_message.trim()
          : fallbackReport(toolName, args);

        await status.update(toolName, reportMessage);
        let resultPayload;
        try {
          resultPayload = await dispatchTool(toolName, args, toolContext);
          if (toolName === "run_code_sandbox") {
            resultPayload = await compressSandboxResult(env, resultPayload);
          }
        } catch (err) {
          resultPayload = { ok: false, error: String(err.message || err) };
        }
        const resultText = JSON.stringify(resultPayload);
        messages.push({ role: "tool", tool_call_id: call.id, name: toolName, content: resultText });
        stub.appendMessage({ dayWindow: today, role: "tool", toolCallId: call.id, toolName, content: resultText });

        if (resultPayload?.__pendingImage) {
          const { cacheKey, mimeType } = resultPayload.__pendingImage;
          const imgRef = { fileId: cacheKey, kind: "image", mimeType };
          const imagePart = await resolveMediaContentPart(env, stub, imgRef);
          if (imagePart) {
            messages.push({ role: "user", content: [{ type: "text", text: "👁️ [تصویری که ابزار look خوند]" }, imagePart] });
          }
          stub.appendMessage({ dayWindow: today, role: "user", content: "👁️ [تصویری که ابزار look خوند]", mediaRefs: [imgRef] });
        }
      }
      continue;
    }

    finalText = message.content || "";
    stub.appendMessage({ dayWindow: today, role: "assistant", content: finalText });
    break;
  }

  await status.finish();

  if (loopError) {
    logSafe(stub, {
      kind: "turn_error",
      status: "error",
      detail: String(loopError.message || loopError).slice(0, 500),
      latencyMs: Date.now() - turnStartedAt,
    });
    await sendOwnerAlert(
      env,
      `🚨 <b>خطا در فراخوانی AI router از agent</b>\n<code>${escapeHtml(String(loopError.message || loopError)).slice(0, 500)}</code>`
    );
    if (trigger.kind === "user_message") {
      await sendMessage(env, chatId, "یک مشکل فنی پیش اومد، دوباره امتحان کن.");
    }
    return;
  }

  if (finalText === null) {
    logSafe(stub, {
      kind: "turn_error",
      status: "error",
      detail: "max tool iterations exceeded",
      latencyMs: Date.now() - turnStartedAt,
    });
    if (trigger.kind === "user_message") {
      await sendMessage(env, chatId, "چند مرحله ابزار رو رد کردم و هنوز به جواب نرسیدم - می‌تونی دوباره دقیق‌تر بپرسی؟");
    }
    return;
  }

  logSafe(stub, { kind: "turn_end", status: "ok", latencyMs: Date.now() - turnStartedAt });

  if (finalText.trim()) {
    try {
      await sendMarkdown(env, chatId, finalText);
    } catch {
      // last-resort fallback: never let the user get silence
      await sendMessage(env, chatId, escapeHtml(finalText));
    }
  }
}