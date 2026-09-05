import { AgentDO } from "./agentDO.js";
import { handleScheduled } from "./cron.js";
import { runAgentTurnLocked } from "./agentLoop.js";
import { extractIncomingMedia, sendMessage, sendMarkdown, sendOwnerAlert, downloadTelegramFile, editMessage, answerCallbackQuery } from "./telegram.js";
import { NOTES_PAGE_SIZE } from "./config.js";
import { escapeHtml, safeJsonParse, base64ToUtf8Text } from "./util.js";

export { AgentDO };

function getStub(env) {
  const id = env.AGENT_DO.idFromName("global");
  return env.AGENT_DO.get(id);
}

const HELP_TEXT = `🤖 <b>دستیار شخصی</b>

هر پیام معمولی رو مستقیم به‌عنوان درخواست می‌فرستم برای ایجنت. دستورات مدیریتی:

/skills — لیست skillهای ثبت‌شده
/addskill — ساخت skill جدید، قدم‌به‌قدم (نام → توضیح → متن کامل، در هر تعداد پیام یا با آپلود فایل .md/.txt)
/cancel — لغو ساخت skill نیمه‌کاره
/delskill &lt;name&gt; — حذف یک skill
/wakeups — لیست زمان‌بندی بیدارباش‌های خودکار
/addwakeup HH:MM &lt;موضوع&gt; — افزودن زمان بیدارباش جدید (مثال: <code>/addwakeup 08:30 شعر صبحگاهی</code>)
/delwakeup &lt;id&gt; — حذف یک زمان بیدارباش
/unlock — آزادسازی فوری قفل نوبت ایجنت
/model — انتخاب مدل فعال چت از روتر به صورت زنده
/notes [صفحه] — لیست پیج‌بندی‌شده‌ی یادداشت‌ها
/memory — نمایش پروفایل حافظه‌ی فعلی
/todos — لیست یادآوری‌های در انتظار
/plan — نمایش برنامه‌ی فعال (اگر باشه)
/logs [تعداد] [status] — لاگ اخیر ابزارها، مثال: <code>/logs 20 error</code>
/stats [ساعت] — آمار فراخوانی ابزارها، مثال: <code>/stats 24</code>`;

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/" && request.method === "GET") {
        return new Response(JSON.stringify({ ok: true, service: "gemini-personal-agent" }), {
          headers: { "content-type": "application/json" },
        });
      }

      if (url.pathname === "/telegram/webhook" && request.method === "POST") {
        return await handleWebhook(request, env, ctx);
      }

      if (url.pathname === "/admin/telegram/setup" && request.method === "GET") {
        if (!env.TELEGRAM_WEBHOOK_SECRET || url.searchParams.get("secret") !== env.TELEGRAM_WEBHOOK_SECRET) {
          return new Response("forbidden", { status: 403 });
        }
        const webhookUrl = `${url.protocol}//${url.host}/telegram/webhook`;
        const setResp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: webhookUrl,
            secret_token: env.TELEGRAM_WEBHOOK_SECRET,
            allowed_updates: ["message", "callback_query"],
          }),
        });
        const info = await (await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`)).json();
        return new Response(JSON.stringify({ setWebhook: await setResp.json(), webhookInfo: info }, null, 2), {
          headers: { "content-type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      ctx.waitUntil(sendOwnerAlert(env, `🚨 <b>خطای کلی worker</b>\n<code>${escapeHtml(String(err.message || err)).slice(0, 500)}</code>`));
      return new Response("ok");
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env, ctx, getStub));
  },

  async queue(batch, env) {
    const stub = getStub(env);
    for (const message of batch.messages) {
      try {
        await runAgentTurnLocked({
          env,
          ctx: { waitUntil: () => {} },
          stub,
          chatId: message.body.chatId,
          trigger: message.body.trigger,
        });
      } catch (err) {
        await sendOwnerAlert(
          env,
          `🚨 <b>خطا در پردازش turn از صف</b>\n<code>${escapeHtml(String(err.message || err)).slice(0, 400)}</code>`
        );
      }
      message.ack();
    }
  },
};

async function handleWebhook(request, env, ctx) {
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    const got = request.headers.get("x-telegram-bot-api-secret-token");
    if (got !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("ok");
  }

  const callbackQuery = update.callback_query;
  if (callbackQuery) {
    const fromId = callbackQuery.from?.id;
    if (env.TELEGRAM_OWNER_CHAT_ID && String(fromId) !== String(env.TELEGRAM_OWNER_CHAT_ID)) {
      return new Response("ok");
    }
    const stub = getStub(env);
    ctx.waitUntil(
      handleNoteCallback(env, stub, callbackQuery).catch((err) =>
        sendOwnerAlert(env, `🚨 <b>خطا در callback تلگرام</b>\n<code>${escapeHtml(String(err.message || err)).slice(0, 300)}</code>`)
      )
    );
    return new Response("ok");
  }

  const message = update.message;
  if (!message) return new Response("ok");

  const chatId = message.chat.id;
  if (env.TELEGRAM_OWNER_CHAT_ID && String(chatId) !== String(env.TELEGRAM_OWNER_CHAT_ID)) {
    return new Response("ok");
  }

  const stub = getStub(env);
  const media = extractIncomingMedia(message);
  const mediaGroupId = message.media_group_id || null;

  // Album buffering: each photo/video of an album arrives as its own
  // webhook update sharing one media_group_id. Buffer them and let the DO's
  // debounce alarm fire ONE agent turn with everything once the album
  // stops growing (see agentDO.js's bufferMediaGroupItem/alarm).
  if (media && mediaGroupId) {
    ctx.waitUntil(
      stub
        .bufferMediaGroupItem({
          mediaGroupId: String(mediaGroupId),
          chatId,
          item: { fileId: media.fileId, kind: media.kind, mimeType: media.mimeType },
          caption: message.caption || null,
        })
        .catch((err) =>
          sendOwnerAlert(env, `🚨 <b>خطا در بافر کردن آلبوم</b>\n<code>${escapeHtml(String(err.message || err)).slice(0, 300)}</code>`)
        )
    );
    return new Response("ok");
  }

  const text = (message.text || message.caption || "").trim();

  // If a skill-adding wizard is in progress for this chat, everything
  // (text or a document upload) routes through it first - except /cancel,
  // which always works to bail out.
  let wizardState = null;
  try {
    const raw = await stub.getMeta(`wizard_${chatId}`);
    wizardState = raw ? safeJsonParse(raw, null) : null;
  } catch {
    wizardState = null;
  }

  if (wizardState) {
    if (text.toLowerCase() === "/cancel") {
      await stub.setMeta(`wizard_${chatId}`, "");
      await sendMessage(env, chatId, "لغو شد.");
      return new Response("ok");
    }
    await handleSkillWizardStep(env, stub, chatId, message, wizardState);
    return new Response("ok");
  }

  if (text.startsWith("/")) {
    await handleCommand(text, env, ctx, stub, chatId);
    return new Response("ok");
  }

  // Nothing usable in this update (e.g. a bare system message) - don't
  // start an empty agent turn over it.
  if (!text && !media) {
    return new Response("ok");
  }

  const mediaRefs = media ? [{ fileId: media.fileId, kind: media.kind, mimeType: media.mimeType }] : [];
  await env.TURNS_QUEUE.send({ chatId, trigger: { kind: "user_message", text, mediaRefs } });

  return new Response("ok");
}

// ===========================================================================
// Skill-adding wizard - replaces the old single-message /addskill format.
// A single long Telegram message gets auto-split by the client into
// several separate updates before your webhook even sees them, so any
// format that expected a whole multi-thousand-character skill in ONE
// message was broken from the start for any real skill. This instead
// walks name -> description -> body (any number of messages, or one
// document upload) -> /done.
// ===========================================================================

async function handleSkillWizardStep(env, stub, chatId, message, state) {
  if (state.step === "name") {
    const name = (message.text || "").trim();
    if (!name) {
      await sendMessage(env, chatId, "اسم نمی‌تونه خالی باشه. دوباره بفرست، یا /cancel برای لغو.");
      return;
    }
    await stub.setMeta(`wizard_${chatId}`, JSON.stringify({ step: "description", name }));
    await sendMessage(env, chatId, "توضیح کوتاه (کِی این skill باید استفاده بشه؟) رو بفرست.");
    return;
  }

  if (state.step === "description") {
    const description = (message.text || "").trim();
    if (!description) {
      await sendMessage(env, chatId, "توضیح نمی‌تونه خالی باشه. دوباره بفرست، یا /cancel برای لغو.");
      return;
    }
    await stub.setMeta(`wizard_${chatId}`, JSON.stringify({ step: "body", name: state.name, description, body: "" }));
    await sendMessage(
      env,
      chatId,
      "حالا متن کامل دستورالعمل رو بفرست - می‌تونی توی چند پیام جدا بفرستی (به بدنه اضافه می‌شن)، یا یک فایل .md/.txt آپلود کن. وقتی تموم شد /done رو بزن."
    );
    return;
  }

  if (state.step === "body") {
    if (message.document) {
      const mime = message.document.mime_type || "";
      const fname = (message.document.file_name || "").toLowerCase();
      const looksLikeText = mime.startsWith("text/") || fname.endsWith(".md") || fname.endsWith(".txt");
      if (!looksLikeText) {
        await sendMessage(env, chatId, "این فایل متنی (.md/.txt) به نظر نمی‌رسه. یا متن رو مستقیم بفرست، یا فایل متنی آپلود کن.");
        return;
      }
      try {
        const { base64 } = await downloadTelegramFile(env, message.document.file_id);
        const bodyText = base64ToUtf8Text(base64);
        await finalizeSkillWizard(env, stub, chatId, { ...state, body: bodyText });
      } catch (err) {
        await sendMessage(env, chatId, `❌ خطا در دانلود فایل: ${escapeHtml(String(err.message || err))}`);
      }
      return;
    }

    const chunk = message.text || "";
    if (chunk.trim().toLowerCase() === "/done") {
      if (!state.body || !state.body.trim()) {
        await sendMessage(env, chatId, "هنوز هیچ متنی نفرستادی. یا متن بفرست، یا /cancel برای لغو.");
        return;
      }
      await finalizeSkillWizard(env, stub, chatId, state);
      return;
    }

    const newBody = state.body ? `${state.body}\n${chunk}` : chunk;
    await stub.setMeta(`wizard_${chatId}`, JSON.stringify({ ...state, body: newBody }));
    await sendMessage(env, chatId, `➕ اضافه شد (${newBody.length} کاراکتر تا الان). وقتی تموم شد /done رو بزن.`);
    return;
  }
}

async function finalizeSkillWizard(env, stub, chatId, state) {
  await stub.setMeta(`wizard_${chatId}`, "");
  try {
    const skill = await stub.addSkill({ name: state.name, description: state.description, body: state.body.trim() });
    await sendMessage(env, chatId, `✅ skill «${escapeHtml(skill.name)}» ثبت شد (${state.body.trim().length} کاراکتر).`);
  } catch (err) {
    await sendMessage(env, chatId, `❌ خطا در ثبت skill: ${escapeHtml(String(err.message || err))}`);
  }
}

// ===========================================================================
// Slash commands
// ===========================================================================

async function handleCommand(text, env, ctx, stub, chatId) {
  const lines = text.split("\n");
  const [cmdRaw] = lines[0].trim().split(/\s+/);
  const cmd = cmdRaw.replace(/@\S+$/, "").toLowerCase();
  const args = lines[0].trim().split(/\s+/).slice(1);
  const restOfFirstLine = lines[0].trim().slice(cmdRaw.length).trim();

  try {
    switch (cmd) {
      case "/start":
      case "/help":
        await sendMessage(env, chatId, HELP_TEXT);
        break;

      case "/skills": {
        const skills = await stub.listSkills({ enabledOnly: false });
        if (!skills.length) {
          await sendMessage(env, chatId, "هیچ skillای ثبت نشده.");
        } else {
          const body = skills.map((s) => `${s.enabled ? "✅" : "⛔"} <b>${escapeHtml(s.name)}</b>\n${escapeHtml(s.description)}`).join("\n\n");
          await sendMessage(env, chatId, body);
        }
        break;
      }

      case "/addskill":
        await stub.setMeta(`wizard_${chatId}`, JSON.stringify({ step: "name" }));
        await sendMessage(env, chatId, "بیا قدم‌به‌قدم بسازیمش. اول اسم skill رو بفرست (یا /cancel برای لغو).");
        break;

      case "/cancel": {
        const raw = await stub.getMeta(`wizard_${chatId}`);
        if (raw) {
          await stub.setMeta(`wizard_${chatId}`, "");
          await sendMessage(env, chatId, "لغو شد.");
        } else {
          await sendMessage(env, chatId, "چیزی برای لغو کردن در جریان نیست.");
        }
        break;
      }

      case "/delskill": {
        if (!restOfFirstLine) {
          await sendMessage(env, chatId, "فرمت درست:\n<code>/delskill نام‌skill</code>");
          break;
        }
        await stub.deleteSkill(restOfFirstLine);
        await sendMessage(env, chatId, `🗑 skill «${escapeHtml(restOfFirstLine)}» حذف شد.`);
        break;
      }

      case "/wakeups": {
        const slots = await stub.listWakeSchedule();
        if (!slots.length) {
          await sendMessage(env, chatId, "هیچ زمان بیدارباشی ثبت نشده.");
        } else {
          const body = slots
            .map((s) => `${s.enabled ? "⏰" : "⛔"} <b>[${s.id}] ${escapeHtml(s.time_hhmm)}</b> — ${escapeHtml(s.theme)}`)
            .join("\n");
          await sendMessage(env, chatId, body);
        }
        break;
      }

      case "/addwakeup": {
        const match = restOfFirstLine.match(/^(\d{2}:\d{2})\s+(.+)$/s);
        if (!match) {
          await sendMessage(env, chatId, "فرمت درست:\n<code>/addwakeup HH:MM موضوع بیدارباش</code>\nمثال: <code>/addwakeup 08:30 شعر و داستان صبحگاهی</code>");
          break;
        }
        const [, timeHHMM, theme] = match;
        const slot = await stub.addWakeSlot({ timeHHMM, theme });
        await sendMessage(env, chatId, `✅ بیدارباش [${slot.id}] برای ساعت <b>${escapeHtml(slot.time_hhmm)}</b> ثبت شد:\n«${escapeHtml(slot.theme)}»`);
        break;
      }

      case "/delwakeup": {
        const id = parseInt(restOfFirstLine, 10);
        if (!id) {
          await sendMessage(env, chatId, "فرمت درست:\n<code>/delwakeup آیدی_بیدارباش</code>");
          break;
        }
        await stub.deleteWakeSlot(id);
        await sendMessage(env, chatId, `🗑 بیدارباش [${id}] حذف شد.`);
        break;
      }

      case "/notes": {
        const page = parseInt(args[0], 10) || 1;
        await renderNotesPageMessage(env, stub, chatId, page);
        break;
      }

      case "/unlock": {
        await sendMessage(env, chatId, "🔓 سیستم از Cloudflare Queue استفاده می‌کند و هم‌زمانی به صورت خودکار مدیریت می‌شود.");
        break;
      }

      case "/memory": {
        const profile = await stub.getMemoryProfile();
        await sendMessage(env, chatId, profile ? escapeHtml(profile) : "هنوز چیزی در حافظه‌ی بلندمدت ثبت نشده.");
        break;
      }

      case "/todos": {
        const todos = await stub.listTodos({ status: "pending" });
        if (!todos.length) {
          await sendMessage(env, chatId, "یادآوری در انتظاری نیست.");
        } else {
          const body = todos
            .map(
              (t) =>
                `🗒 <b>${escapeHtml(t.title)}</b> — ${new Date(t.due_at).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })}\n${escapeHtml(t.description || "")}`
            )
            .join("\n\n");
          await sendMessage(env, chatId, body);
        }
        break;
      }

      case "/plan": {
        const block = await stub.renderPlanBlock();
        await sendMessage(env, chatId, block || "الان هیچ برنامه‌ی فعالی نیست.");
        break;
      }

      case "/model": {
        await handleModelCommand(env, stub, chatId);
        break;
      }

      case "/logs":
        await sendMessage(env, chatId, await formatAgentLogs(stub, args));
        break;

      case "/stats":
        await sendMessage(env, chatId, await formatAgentStats(stub, args));
        break;

      default:
        await sendMessage(env, chatId, "دستور شناخته‌نشد. /help رو بزن.");
    }
  } catch (err) {
    await sendMessage(env, chatId, `❌ خطا: ${escapeHtml(String(err.message || err))}`);
  }
}

async function formatAgentLogs(stub, args) {
  const limit = Number(args[0]) || 20;
  const status = args[1] || null;
  const logs = await stub.getLogs({ limit, status });
  if (!logs.length) return "لاگی ثبت نشده.";
  let out = `📜 <b>${logs.length} لاگ اخیر</b>${status ? ` (status=${escapeHtml(status)})` : ""}\n\n`;
  for (const l of logs) {
    const t = new Date(l.ts).toISOString().slice(11, 19);
    const icon = l.status === "ok" ? "✅" : l.status === "timeout" ? "⏱" : "❌";
    out += `${icon} ${t} ${escapeHtml(l.kind)}${l.tool_name ? ` / ${escapeHtml(l.tool_name)}` : ""}`;
    if (l.latency_ms != null) out += ` — ${l.latency_ms}ms`;
    if (l.detail) out += `\n    ${escapeHtml(String(l.detail).slice(0, 200))}`;
    out += "\n";
  }
  return out.trim();
}

async function formatAgentStats(stub, args) {
  const hours = Number(args[0]) || 24;
  const s = await stub.getStats({ sinceMs: hours * 3600 * 1000 });
  const t = s.totals || {};
  let out = `📈 <b>آمار ${hours} ساعت اخیر (فراخوانی ابزارها)</b>\n\n`;
  out += `کل: ${t.total || 0} (✅ ${t.ok || 0} / ❌ ${t.errors || 0} / ⏱ ${t.timeouts || 0})\n`;
  out += `میانگین latency: ${t.avg_latency_ms ? Math.round(t.avg_latency_ms) + "ms" : "-"}\n\n`;
  if (s.by_tool && s.by_tool.length) {
    out += "<b>به‌تفکیک ابزار:</b>\n";
    for (const row of s.by_tool) {
      out += `  ${escapeHtml(row.tool_name || "-")}: ${row.calls} فراخوانی (✅${row.ok}/❌${row.errors}/⏱${row.timeouts})\n`;
    }
  }
  return out.trim();
}

async function renderNotesPageData(stub, page = 1) {
  const { notes, totalCount, totalPages, page: currentPage } = await stub.listNotesPaginated({ page, pageSize: NOTES_PAGE_SIZE });
  if (!notes.length) {
    return { text: "هیچ یادداشتی ثبت نشده.", reply_markup: undefined };
  }

  let text = `📝 <b>لیست یادداشت‌ها</b> (صفحه ${currentPage} از ${totalPages} — کل: ${totalCount})\nبرای مشاهده روی عنوان کلیک کن:\n`;

  const inlineKeyboard = notes.map((n) => [
    {
      text: n.title.length > 32 ? `${n.title.slice(0, 32)}...` : n.title,
      callback_data: `note:view:${n.id}:${currentPage}`,
    },
  ]);

  const navRow = [];
  if (currentPage > 1) {
    navRow.push({ text: "⬅️ قبلی", callback_data: `note:page:${currentPage - 1}` });
  }
  navRow.push({ text: `صفحه ${currentPage}/${totalPages}`, callback_data: `note:page:${currentPage}` });
  if (currentPage < totalPages) {
    navRow.push({ text: "بعدی ➡️", callback_data: `note:page:${currentPage + 1}` });
  }
  inlineKeyboard.push(navRow);

  return { text, reply_markup: { inline_keyboard: inlineKeyboard } };
}

async function renderNotesPageMessage(env, stub, chatId, page = 1) {
  const { text, reply_markup } = await renderNotesPageData(stub, page);
  await sendMessage(env, chatId, text, reply_markup ? { reply_markup } : {});
}

async function handleNoteCallback(env, stub, callbackQuery) {
  const data = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;

  if (data.startsWith("agent_model:") && chatId && messageId) {
    const selectedModel = data.split(":")[1];
    await stub.setMeta("selected_chat_model", selectedModel);
    await editMessage(env, chatId, messageId, `🎯 مدل فعال چت با موفقیت به <b>${escapeHtml(selectedModel)}</b> تغییر یافت.`);
    await answerCallbackQuery(env, callbackQuery.id, `تغییر به ${selectedModel}`);
    return;
  }

  if (!data.startsWith("note:") || !chatId || !messageId) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const parts = data.split(":");
  const action = parts[1];

  if (action === "page") {
    const page = parseInt(parts[2], 10) || 1;
    const { text, reply_markup } = await renderNotesPageData(stub, page);
    await editMessage(env, chatId, messageId, text, reply_markup ? { reply_markup } : {});
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  if (action === "view") {
    const noteId = parseInt(parts[2], 10);
    const returnPage = parseInt(parts[3], 10) || 1;
    let note;
    try {
      note = await stub.getNote(noteId);
    } catch {
      await answerCallbackQuery(env, callbackQuery.id, "یادداشت یافت نشد.");
      return;
    }

    const createdStr = new Date(note.created_at).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" });
    const updatedStr = new Date(note.updated_at).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" });

    if (note.body.length <= 3500) {
      const fullText = `📝 <b>${escapeHtml(note.title)}</b>\n<i>ایجاد: ${createdStr} | ویرایش: ${updatedStr}</i>\n\n${escapeHtml(note.body)}`;
      const reply_markup = {
        inline_keyboard: [[{ text: "⬅️ بازگشت به لیست", callback_data: `note:page:${returnPage}` }]],
      };
      await editMessage(env, chatId, messageId, fullText, { reply_markup });
    } else {
      await sendMarkdown(
        env,
        chatId,
        `📝 **${note.title}**\n*ایجاد: ${createdStr} | ویرایش: ${updatedStr}*\n\n${note.body}`
      );
    }
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  await answerCallbackQuery(env, callbackQuery.id);
}

// ===========================================================================
// Real-time model command handling
// ===========================================================================
async function handleModelCommand(env, stub, chatId) {
  try {
    const resp = await env.HERMES_ROUTER.fetch(`${env.AI_ROUTER_BASE_URL.replace(/\/+$/, "")}/v1/models`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${env.AI_ROUTER_PROXY_TOKEN}`,
      },
    });
    if (!resp.ok) {
      throw new Error(`روتر کد خطا برگرداند: ${resp.status}`);
    }
    const json = await resp.json();
    const models = (json.data || []).map((m) => m.id);

    const activeModel = (await stub.getMeta("selected_chat_model")) || "auto";

    let text = `🎯 <b>انتخاب مدل فعال چت</b>\n`;
    text += `مدل فعال فعلی: <code>${escapeHtml(activeModel)}</code>\n\n`;
    text += `مدل‌های زیر به صورت زنده از روتر دریافت شدند. مایلید به کدام مدل سوییچ کنید؟`;

    const inlineKeyboard = [];
    models.forEach((modelName) => {
      const isSelected = modelName === activeModel;
      const label = isSelected ? `🔹 ${modelName} (انتخاب شده)` : modelName;
      inlineKeyboard.push([{ text: label, callback_data: `agent_model:${modelName}` }]);
    });

    await sendMessage(env, chatId, text, { reply_markup: { inline_keyboard: inlineKeyboard } });
  } catch (err) {
    await sendMessage(env, chatId, `❌ خطا در برقراری ارتباط با روتر:\n<code>${escapeHtml(err.message || String(err))}</code>`);
  }
}