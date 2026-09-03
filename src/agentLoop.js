import { BASE_SYSTEM_PROMPT, CHAT_MODEL, MAX_TOOL_ITERATIONS } from "./config.js";
import { currentTimeBlock, getDayWindow, safeJsonParse, escapeHtml } from "./util.js";
import { callChatCompletions } from "./aiRouter.js";
import { allToolDefinitions, dispatchTool } from "./tools/index.js";
import { downloadTelegramFile, sendMessage, sendMarkdown, editMessage, deleteMessage, sendOwnerAlert } from "./telegram.js";
import { StatusMessages } from "./StatusMessages.js";

// ===========================================================================
// System prompt assembly
// ===========================================================================

async function buildSystemPrompt(stub) {
  const memoryProfile = await stub.getMemoryProfile();
  const planBlock = await stub.renderPlanBlock();
  const skills = await stub.listSkills();
  const currentRollup = await stub.getCurrentRollup();

  const sections = [BASE_SYSTEM_PROMPT, currentTimeBlock()];

  if (memoryProfile) {
    sections.push(`--- حافظه‌ی بلندمدت درباره‌ی کاربر ---\n${memoryProfile}`);
  }
  if (skills.length) {
    const skillLines = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    sections.push(`--- Skillهای موجود (برای دیدن متن کامل هرکدوم از view_skill استفاده کن) ---\n${skillLines}`);
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

async function buildHistoryMessages(stub, env) {
  const rows = await stub.getTodayAndYesterday();
  const messages = [];
  for (const row of rows) {
    if (row.role === "user") {
      const content = [];
      if (row.content) content.push({ type: "text", text: row.content });
      const mediaRefs = safeJsonParse(row.media_refs, []);
      for (const ref of mediaRefs || []) {
        try {
          let cached = await stub.getCachedMedia(ref.fileId);
          if (!cached) {
            const downloaded = await downloadTelegramFile(env, ref.fileId);
            cached = { base64: downloaded.base64, mimeType: downloaded.mimeType };
            await stub.setCachedMedia(ref.fileId, cached.base64, cached.mimeType);
          }
          if (cached.mimeType.startsWith("image/")) {
            content.push({ type: "image_url", image_url: { url: `data:${cached.mimeType};base64,${cached.base64}` } });
          }
        } catch (err) {
          await sendOwnerAlert(
            env,
            `⚠️ <b>یک فایل رسانه‌ای در بازسازی تاریخچه رد شد</b>\nkind: ${ref.kind}\n<code>${String(err.message || err).slice(0, 300)}</code>`
          );
        }
      }
      messages.push({ role: "user", content: content.length === 1 && content[0].type === "text" ? content[0].text : content });
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
  constructor(env, chatId) {
    this.env = env;
    this.chatId = chatId;
    this.messageId = null;
  }
  async showInitialThinking() {
    try {
      const text = StatusMessages.getRandom("thinking");
      const sent = await sendMessage(this.env, this.chatId, text);
      this.messageId = sent?.result?.message_id || null;
    } catch {
      // ignore
    }
  }
  async update(toolName) {
    const text = StatusMessages.getRandom(toolName);
    try {
      if (!this.messageId) {
        const sent = await sendMessage(this.env, this.chatId, text);
        this.messageId = sent?.result?.message_id || null;
      } else {
        await editMessage(this.env, this.chatId, this.messageId, text);
      }
    } catch {
      // never let a status-ping hiccup kill the turn
    }
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

// ===========================================================================
// Main entry point. `trigger` is one of:
//   {kind: "user_message", text, mediaRefs}
//   {kind: "todo_fired", todo}
//   {kind: "proactive", theme}
// ===========================================================================

export async function runAgentTurnLocked({ env, ctx, stub, chatId, trigger }) {
  const today = getDayWindow();
  const turnStartedAt = Date.now();
  logSafe(stub, { kind: "turn_start", status: "ok", detail: trigger.kind });

  if (trigger.kind === "user_message") {
    stub.appendMessage({
      dayWindow: today,
      role: "user",
      content: trigger.text || "",
      mediaRefs: trigger.mediaRefs && trigger.mediaRefs.length ? trigger.mediaRefs : null,
    });
  } else if (trigger.kind === "todo_fired") {
    const syntheticId = `todo_fired_${trigger.todo.id}_${Date.now()}`;
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
  }

  const systemPrompt = await buildSystemPrompt(stub);
  const history = await buildHistoryMessages(stub, env);
  const messages = [{ role: "system", content: systemPrompt }, ...history];

  const status = new StatusPing(env, chatId);
  if (trigger.kind === "user_message") {
    await status.showInitialThinking();
  }
  const toolContext = { env, ctx, stub, chatId };

  let finalText = null;
  let loopError = null;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
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

      for (const call of message.tool_calls) {
        const toolName = call.function.name;
        await status.update(toolName);
        const args = safeJsonParse(call.function.arguments, {});
        let resultPayload;
        try {
          resultPayload = await dispatchTool(toolName, args, toolContext);
        } catch (err) {
          resultPayload = { ok: false, error: String(err.message || err) };
        }
        const resultText = JSON.stringify(resultPayload);
        messages.push({ role: "tool", tool_call_id: call.id, name: toolName, content: resultText });
        stub.appendMessage({ dayWindow: today, role: "tool", toolCallId: call.id, toolName, content: resultText });
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