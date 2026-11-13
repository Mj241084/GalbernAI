import { AgentDO } from "./agentDO.js";
import { handleScheduled } from "./cron.js";
import { runAgentTurnLocked } from "./agentLoop.js";
import {
  extractIncomingMedia,
  sendMessage,
  sendMarkdown,
  sendRichMessage,
  editRichMessage,
  sendOwnerAlert,
  downloadTelegramFile,
  editMessage,
  answerCallbackQuery,
} from "./telegram.js";
import { publishPlanMessage } from "./tools/plan.js";
import { IMGSEARCH_PY } from "./sandboxAssets/imgsearch.js";
import { BUILTIN_SKILLS } from "./builtinSkills.js";
import { NOTES_PAGE_SIZE } from "./config.js";
import { escapeHtml, safeJsonParse, base64ToUtf8Text } from "./util.js";

export { AgentDO };

function freshStub(env) {
  const id = env.AGENT_DO.idFromName("global");
  return env.AGENT_DO.get(id);
}

// یک wrapper روی stub که اگه instance واقعی DO وسط کار عوض/evict بشه
// (خطای "Connection closed... no longer active")، خودش به‌طور شفاف یک
// stub تازه می‌گیره و همون فراخوانی رو دوباره امتحان می‌کنه - به‌جای این‌که
// کل turn با یک throw ناگهانی نیمه‌کاره رها بشه.
function getStub(env) {
  let current = freshStub(env);
  return new Proxy(
    {},
    {
      get(_, prop) {
        if (typeof prop !== "string" || prop === "then") return undefined;
        return async (...args) => {
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              return await current[prop](...args);
            } catch (err) {
              const msg = String(err?.message || err);
              const isStale = /no longer active|Connection closed/i.test(msg);
              if (!isStale || attempt === 2) throw err;
              current = freshStub(env);
            }
          }
        };
      },
    }
  );
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
/sandboxes — لیست همه سندباکس‌های ثبت‌شده
/addsandbox &lt;code&gt; &lt;vm_id&gt; [توضیح...] — ثبت یک سندباکس جدید
/setmainsandbox &lt;code&gt; — تعیین سندباکس پیش‌فرض/اصلی
/delsandbox &lt;code&gt; — حذف یک سندباکس
/enablesandbox &lt;code&gt; — فعال‌سازی مجدد یک سندباکس
/disablesandbox &lt;code&gt; — غیرفعال‌سازی موقت یک سندباکس
/provisionsandbox [code] — تنظیم اسکریپت‌ها و کلیدهای مورد نیاز در سندباکس
/seedskills — نصب/به‌روزرسانی skillهای داخلی سیستم
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

  async queue(batch, env, ctx) {
    const stub = getStub(env);
    for (const message of batch.messages) {
      try {
        await runAgentTurnLocked({
          env,
          ctx,
          stub,
          chatId: message.body.chatId,
          trigger: message.body.trigger,
          dedupeKey: message.body.dedupeKey,
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
          item: {
            fileId: media.fileId,
            kind: media.kind,
            mimeType: media.mimeType,
            filename: media.filename,
            fileSize: media.fileSize,
            duration: media.duration,
          },
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

  const mediaRefs = media
    ? [{
        fileId: media.fileId,
        kind: media.kind,
        mimeType: media.mimeType,
        filename: media.filename,
        fileSize: media.fileSize,
        duration: media.duration,
      }]
    : [];
  const messageId = message.message_id;
  await env.TURNS_QUEUE.send({
    chatId,
    trigger: { kind: "user_message", text, mediaRefs },
    dedupeKey: messageId ? `tg:${chatId}:${messageId}` : undefined,
  });

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
        const view = await renderSkillsView(stub);
        await sendRichOrFallback(env, chatId, view.richMsg, view.fallbackHtml, view.fallbackExtra);
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
        const view = await renderWakeupsView(stub);
        await sendRichOrFallback(env, chatId, view.richMsg, view.fallbackHtml, view.fallbackExtra);
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

      case "/sandboxes": {
        const view = await renderSandboxesView(stub);
        await sendRichOrFallback(env, chatId, view.richMsg, view.fallbackHtml, view.fallbackExtra);
        break;
      }

      case "/addsandbox": {
        const match = restOfFirstLine.match(/^(\S+)\s+(\S+)(?:\s+(.+))?$/s);
        if (!match) {
          await sendMessage(env, chatId, "فرمت درست:\n<code>/addsandbox code vm_id [توضیحات...]</code>\nمثال: <code>/addsandbox main vm-1234 کارهای محاسباتی من</code>");
          break;
        }
        const [, code, vmId, description] = match;
        const s = await stub.addSandbox({ code, vmId, description: description || null });
        await sendMessage(env, chatId, `✅ سندباکس <b>${escapeHtml(s.code)}</b> با vm_id <code>${escapeHtml(s.vm_id)}</code> ثبت شد.`);
        break;
      }

      case "/setmainsandbox": {
        if (!restOfFirstLine) {
          await sendMessage(env, chatId, "فرمت درست:\n<code>/setmainsandbox code</code>");
          break;
        }
        const s = await stub.setMainSandbox(restOfFirstLine);
        await sendMessage(env, chatId, `⭐ سندباکس <b>${escapeHtml(s.code)}</b> به عنوان سندباکس اصلی تعیین شد.`);
        break;
      }

      case "/delsandbox": {
        if (!restOfFirstLine) {
          await sendMessage(env, chatId, "فرمت درست:\n<code>/delsandbox code</code>");
          break;
        }
        await stub.deleteSandbox(restOfFirstLine);
        await sendMessage(env, chatId, `🗑 سندباکس <b>${escapeHtml(restOfFirstLine)}</b> حذف شد.`);
        break;
      }

      case "/enablesandbox": {
        if (!restOfFirstLine) {
          await sendMessage(env, chatId, "فرمت درست:\n<code>/enablesandbox code</code>");
          break;
        }
        const existing = await stub.getSandboxByCode(restOfFirstLine);
        if (!existing) {
          await sendMessage(env, chatId, `سندباکسی با کد ${escapeHtml(restOfFirstLine)} پیدا نشد.`);
          break;
        }
        await stub.addSandbox({ code: existing.code, vmId: existing.vm_id, description: existing.description, enabled: true });
        await sendMessage(env, chatId, `✅ سندباکس <b>${escapeHtml(restOfFirstLine)}</b> فعال شد.`);
        break;
      }

      case "/disablesandbox": {
        if (!restOfFirstLine) {
          await sendMessage(env, chatId, "فرمت درست:\n<code>/disablesandbox code</code>");
          break;
        }
        const existing = await stub.getSandboxByCode(restOfFirstLine);
        if (!existing) {
          await sendMessage(env, chatId, `سندباکسی با کد ${escapeHtml(restOfFirstLine)} پیدا نشد.`);
          break;
        }
        await stub.addSandbox({ code: existing.code, vmId: existing.vm_id, description: existing.description, enabled: false });
        await sendMessage(env, chatId, `⛔ سندباکس <b>${escapeHtml(restOfFirstLine)}</b> غیرفعال شد.`);
        break;
      }

      case "/provisionsandbox": {
        const targetCode = restOfFirstLine.trim();
        let targetSandbox;
        if (targetCode) {
          targetSandbox = await stub.getSandboxByCode(targetCode);
        } else {
          targetSandbox = await stub.getMainSandbox();
        }
        if (!targetSandbox) {
          await sendMessage(env, chatId, `❌ سندباکسی پیدا نشد.`);
          break;
        }

        const vmId = targetSandbox.vm_id;
        const q = (v) => `'${String(v || "").replace(/'/g, `'\\''`)}'`;
        const envSh =
          `export SERPER_API_KEY=${q(env.SERPER_API_KEY)}\n` +
          `export AI_ROUTER_BASE_URL=${q(env.AI_ROUTER_BASE_URL)}\n` +
          `export AI_ROUTER_PROXY_TOKEN=${q(env.AI_ROUTER_PROXY_TOKEN)}\n`;

        await sendMessage(env, chatId, `⏳ در حال آماده‌سازی سندباکس <b>${escapeHtml(targetSandbox.code)}</b>...`);

        try {
          const { freestyleWriteFile, freestyleExec } = await import("./freestyleClient.js");
          const encoder = new TextEncoder();
          await freestyleExec(env, vmId, "mkdir -p /home/ubuntu/.galbern /home/ubuntu/tools /home/ubuntu/uploads");
          await freestyleWriteFile(env, vmId, "/home/ubuntu/.galbern/env.sh", encoder.encode(envSh));
          await freestyleExec(env, vmId, "chmod 600 /home/ubuntu/.galbern/env.sh");
          await freestyleWriteFile(env, vmId, "/home/ubuntu/tools/imgsearch.py", encoder.encode(IMGSEARCH_PY));
          await freestyleExec(env, vmId, "chmod +x /home/ubuntu/tools/imgsearch.py");

          const smoke = await freestyleExec(
            env,
            vmId,
            `python3 -c 'import urllib.request,json,base64,concurrent.futures; print("ok")'`
          );
          const helpCheck = await freestyleExec(env, vmId, "python3 /home/ubuntu/tools/imgsearch.py --help");

          if (smoke.stdout.includes("ok") && helpCheck.stdout.includes("imgsearch.py")) {
            await sendMessage(env, chatId, `✅ آماده‌سازی سندباکس <b>${escapeHtml(targetSandbox.code)}</b> با موفقیت انجام شد.\n۳ متغیر محیطی نوشته شد و اسکریپت imgsearch.py نصب گردید.`);
          } else {
            await sendMessage(env, chatId, `⚠️ آماده‌سازی انجام شد ولی تست اسکریپت با خطا مواجه گردید:\n<code>${escapeHtml(smoke.stderr || helpCheck.stderr)}</code>`);
          }
        } catch (err) {
          await sendMessage(env, chatId, `❌ خطا در آماده‌سازی سندباکس:\n<code>${escapeHtml(err.message || String(err))}</code>`);
        }
        break;
      }

      case "/seedskills": {
        let added = 0;
        for (const skill of BUILTIN_SKILLS) {
          await stub.addSkill(skill);
          added++;
        }
        await sendMessage(env, chatId, `✅ تعداد ${added} skill داخلی با موفقیت در سیستم نصب/به‌روزرسانی شد.`);
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
        const view = await renderTodosView(stub);
        await sendRichOrFallback(env, chatId, view.richMsg, view.fallbackHtml, view.fallbackExtra);
        break;
      }

      case "/plan": {
        const active = await stub.getActivePlan();
        if (!active) {
          await sendMessage(env, chatId, "الان هیچ برنامه‌ی فعالی نیست.");
        } else {
          const msgId = await publishPlanMessage(env, stub, chatId, active.plan.id);
          if (msgId) {
            await sendMessage(env, chatId, "📌 برنامه‌ی فعال بالای چت پین شده است.");
          } else {
            await sendMessage(env, chatId, "⚠️ خطا در انتشار یا پین کردن برنامه‌ی فعال.");
          }
        }
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

async function sendRichOrFallback(env, chatId, richMsg, fallbackHtml, fallbackExtra = {}) {
  const res = await sendRichMessage(env, chatId, richMsg);
  if (res?.ok) return res;
  return sendMessage(env, chatId, fallbackHtml, fallbackExtra);
}

async function editRichOrFallback(env, chatId, messageId, richMsg, fallbackHtml, fallbackExtra = {}) {
  const res = await editRichMessage(env, chatId, messageId, richMsg);
  if (res?.ok || /message is not modified/i.test(res?.description || "")) return res;
  return editMessage(env, chatId, messageId, fallbackHtml, fallbackExtra);
}

export async function renderNotesPageRich(stub, page = 1) {
  let data = await stub.listNotesPaginated({ page, pageSize: NOTES_PAGE_SIZE });
  if (data.totalCount > 0 && data.notes.length === 0 && page > data.totalPages) {
    data = await stub.listNotesPaginated({ page: data.totalPages, pageSize: NOTES_PAGE_SIZE });
  }
  const { notes, totalCount, totalPages, page: currentPage } = data;
  if (!notes.length) {
    return { html: "<p>هیچ یادداشتی ثبت نشده.</p>", is_rtl: true };
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

async function renderNotesPageData(stub, page = 1) {
  let data = await stub.listNotesPaginated({ page, pageSize: NOTES_PAGE_SIZE });
  if (data.totalCount > 0 && data.notes.length === 0 && page > data.totalPages) {
    data = await stub.listNotesPaginated({ page: data.totalPages, pageSize: NOTES_PAGE_SIZE });
  }
  const { notes, totalCount, totalPages, page: currentPage } = data;
  if (!notes.length) {
    return { text: "هیچ یادداشتی ثبت نشده.", reply_markup: undefined };
  }

  const text = `📝 <b>لیست یادداشت‌ها</b> (صفحه ${currentPage} از ${totalPages} — کل: ${totalCount})\nبرای مشاهده روی عنوان کلیک کن:\n`;

  const inlineKeyboard = notes.map((n) => [
    {
      text: n.title.length > 28 ? `${n.title.slice(0, 28)}...` : n.title,
      callback_data: `note:view:${n.id}:${currentPage}`,
    },
    {
      text: "🗑 حذف",
      callback_data: `note:del:${n.id}:${currentPage}`,
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
  const [richMsg, fallback] = await Promise.all([renderNotesPageRich(stub, page), renderNotesPageData(stub, page)]);
  await sendRichOrFallback(env, chatId, richMsg, fallback.text, fallback.reply_markup ? { reply_markup: fallback.reply_markup } : {});
}

async function renderTodosView(stub) {
  const todos = await stub.listTodos({ status: "pending" });
  if (!todos.length) {
    return {
      richMsg: { html: "<p>یادآوری در انتظاری نیست.</p>", is_rtl: true },
      fallbackHtml: "یادآوری در انتظاری نیست.",
      fallbackExtra: {},
    };
  }
  const blocks = ["<h3>🗒 یادآوری‌های در انتظار</h3>"];
  const fallbackLines = [];
  const inlineKeyboard = [];
  for (const t of todos) {
    const dueStr = new Date(t.due_at).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" });
    blocks.push(
      `<p><b>[${t.id}] ${escapeHtml(t.title)}</b><br><i>زمان: ${escapeHtml(dueStr)}</i>${t.description ? `<br>${escapeHtml(t.description)}` : ""}</p>` +
      `<tg-button-row align="left">` +
      `<tg-button type="callback_data" style="success" data="todo:done:${t.id}">✅ انجام شد</tg-button>` +
      `<tg-button type="callback_data" style="danger" data="todo:del:${t.id}">🗑 حذف</tg-button>` +
      `</tg-button-row>`
    );
    fallbackLines.push(`🗒 <b>[${t.id}] ${escapeHtml(t.title)}</b> — ${escapeHtml(dueStr)}${t.description ? `\n${escapeHtml(t.description)}` : ""}`);
    inlineKeyboard.push([
      { text: `✅ [${t.id}] انجام شد`, callback_data: `todo:done:${t.id}` },
      { text: "🗑 حذف", callback_data: `todo:del:${t.id}` },
    ]);
  }
  return {
    richMsg: { html: blocks.join("\n"), is_rtl: true },
    fallbackHtml: fallbackLines.join("\n\n"),
    fallbackExtra: { reply_markup: { inline_keyboard: inlineKeyboard } },
  };
}

async function renderSandboxesView(stub) {
  const list = await stub.listSandboxes({ enabledOnly: false });
  if (!list.length) {
    return {
      richMsg: { html: "<p>هیچ سندباکسی ثبت نشده است.</p>", is_rtl: true },
      fallbackHtml: "هیچ سندباکسی ثبت نشده است.",
      fallbackExtra: {},
    };
  }
  const blocks = ["<h3>💻 سندباکس‌های ثبت‌شده</h3>"];
  const fallbackLines = [];
  const inlineKeyboard = [];
  for (const s of list) {
    blocks.push(
      `<p>${s.enabled ? "✅" : "⛔"} ${s.is_main ? "⭐ " : ""}<b>${escapeHtml(s.code)}</b> (<code>${escapeHtml(s.vm_id)}</code>)<br>${escapeHtml(s.description || "بدون توضیح")}</p>` +
      `<tg-button-row align="left">` +
      (s.is_main
        ? `<tg-button type="disabled">⭐ اصلی</tg-button>`
        : `<tg-button type="callback_data" style="primary" data="sb:main:${s.id}">⭐ اصلی</tg-button>`) +
      (s.enabled
        ? `<tg-button type="callback_data" data="sb:toggle:${s.id}:0">⛔ غیرفعال</tg-button>`
        : `<tg-button type="callback_data" style="success" data="sb:toggle:${s.id}:1">✅ فعال</tg-button>`) +
      `<tg-button type="callback_data" style="danger" data="sb:del:${s.id}">🗑 حذف</tg-button>` +
      `</tg-button-row>`
    );
    fallbackLines.push(
      `${s.enabled ? "✅" : "⛔"} ${s.is_main ? "⭐ " : ""}<b>${escapeHtml(s.code)}</b> (vm: <code>${escapeHtml(s.vm_id)}</code>)\n${escapeHtml(s.description || "بدون توضیح")}`
    );
    const row = [];
    if (!s.is_main) row.push({ text: `⭐ ${s.code} اصلی`, callback_data: `sb:main:${s.id}` });
    row.push({ text: s.enabled ? `⛔ ${s.code}` : `✅ ${s.code}`, callback_data: `sb:toggle:${s.id}:${s.enabled ? 0 : 1}` });
    row.push({ text: "🗑", callback_data: `sb:del:${s.id}` });
    inlineKeyboard.push(row);
  }
  return {
    richMsg: { html: blocks.join("\n"), is_rtl: true },
    fallbackHtml: fallbackLines.join("\n\n"),
    fallbackExtra: { reply_markup: { inline_keyboard: inlineKeyboard } },
  };
}

async function renderWakeupsView(stub) {
  const slots = await stub.listWakeSchedule();
  if (!slots.length) {
    return {
      richMsg: { html: "<p>هیچ زمان بیدارباشی ثبت نشده.</p>", is_rtl: true },
      fallbackHtml: "هیچ زمان بیدارباشی ثبت نشده.",
      fallbackExtra: {},
    };
  }
  const blocks = ["<h3>⏰ زمان‌بندی بیدارباش‌های خودکار</h3>"];
  const fallbackLines = [];
  const inlineKeyboard = [];
  for (const s of slots) {
    blocks.push(
      `<p>${s.enabled ? "⏰" : "⛔"} <b>[${s.id}] ${escapeHtml(s.time_hhmm)}</b> — ${escapeHtml(s.theme)}</p>` +
      `<tg-button-row align="left">` +
      (s.enabled
        ? `<tg-button type="callback_data" data="wake:toggle:${s.id}:0">⛔ غیرفعال</tg-button>`
        : `<tg-button type="callback_data" style="success" data="wake:toggle:${s.id}:1">✅ فعال</tg-button>`) +
      `<tg-button type="callback_data" style="danger" data="wake:del:${s.id}">🗑 حذف</tg-button>` +
      `</tg-button-row>`
    );
    fallbackLines.push(`${s.enabled ? "⏰" : "⛔"} <b>[${s.id}] ${escapeHtml(s.time_hhmm)}</b> — ${escapeHtml(s.theme)}`);
    inlineKeyboard.push([
      { text: s.enabled ? `⛔ [${s.id}] غیرفعال` : `✅ [${s.id}] فعال`, callback_data: `wake:toggle:${s.id}:${s.enabled ? 0 : 1}` },
      { text: "🗑 حذف", callback_data: `wake:del:${s.id}` },
    ]);
  }
  return {
    richMsg: { html: blocks.join("\n"), is_rtl: true },
    fallbackHtml: fallbackLines.join("\n"),
    fallbackExtra: { reply_markup: { inline_keyboard: inlineKeyboard } },
  };
}

async function renderSkillsView(stub) {
  const skills = await stub.listSkills({ enabledOnly: false });
  if (!skills.length) {
    return {
      richMsg: { html: "<p>هیچ skillای ثبت نشده.</p>", is_rtl: true },
      fallbackHtml: "هیچ skillای ثبت نشده.",
      fallbackExtra: {},
    };
  }
  const blocks = ["<h3>🧩 لیست Skillهای ثبت‌شده</h3>"];
  const fallbackLines = [];
  const inlineKeyboard = [];
  for (const s of skills) {
    blocks.push(
      `<p>${s.enabled ? "✅" : "⛔"} <b>${escapeHtml(s.name)}</b><br>${escapeHtml(s.description)}</p>` +
      `<tg-button-row align="left">` +
      (s.enabled
        ? `<tg-button type="callback_data" data="skill:toggle:${s.id}:0">⛔ غیرفعال</tg-button>`
        : `<tg-button type="callback_data" style="success" data="skill:toggle:${s.id}:1">✅ فعال</tg-button>`) +
      `<tg-button type="callback_data" style="danger" data="skill:del:${s.id}">🗑 حذف</tg-button>` +
      `</tg-button-row>`
    );
    fallbackLines.push(`${s.enabled ? "✅" : "⛔"} <b>${escapeHtml(s.name)}</b>\n${escapeHtml(s.description)}`);
    inlineKeyboard.push([
      { text: s.enabled ? `⛔ ${s.name}` : `✅ ${s.name}`, callback_data: `skill:toggle:${s.id}:${s.enabled ? 0 : 1}` },
      { text: "🗑 حذف", callback_data: `skill:del:${s.id}` },
    ]);
  }
  return {
    richMsg: { html: blocks.join("\n"), is_rtl: true },
    fallbackHtml: fallbackLines.join("\n\n"),
    fallbackExtra: { reply_markup: { inline_keyboard: inlineKeyboard } },
  };
}

async function handleNoteCallback(env, stub, callbackQuery) {
  const data = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;

  if (data.startsWith("agent_model:") && chatId && messageId) {
    const selectedModel = data.slice("agent_model:".length);
    await stub.setMeta("selected_chat_model", selectedModel);
    await editMessage(env, chatId, messageId, `🎯 مدل فعال چت با موفقیت به <b>${escapeHtml(selectedModel)}</b> تغییر یافت.`);
    await answerCallbackQuery(env, callbackQuery.id, `تغییر به ${selectedModel}`);
    return;
  }

  if (!chatId || !messageId) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  if (data.startsWith("todo:")) {
    const [, action, idStr] = data.split(":");
    const id = parseInt(idStr, 10);
    if (action === "done" && id) {
      await stub.updateTodo(id, { status: "done" });
      const view = await renderTodosView(stub);
      await editRichOrFallback(env, chatId, messageId, view.richMsg, view.fallbackHtml, view.fallbackExtra);
      await answerCallbackQuery(env, callbackQuery.id, "انجام شد ✅");
      return;
    }
    if (action === "del" && id) {
      await stub.deleteTodo(id);
      const view = await renderTodosView(stub);
      await editRichOrFallback(env, chatId, messageId, view.richMsg, view.fallbackHtml, view.fallbackExtra);
      await answerCallbackQuery(env, callbackQuery.id, "حذف شد 🗑");
      return;
    }
  }

  if (data.startsWith("sb:")) {
    const [, action, idStr, val] = data.split(":");
    const id = parseInt(idStr, 10);
    const sb = id ? await stub.getSandboxById(id) : null;
    if (!sb) {
      await answerCallbackQuery(env, callbackQuery.id, "سندباکس پیدا نشد.");
      return;
    }
    if (action === "main") {
      await stub.setMainSandbox(sb.code);
      const view = await renderSandboxesView(stub);
      await editRichOrFallback(env, chatId, messageId, view.richMsg, view.fallbackHtml, view.fallbackExtra);
      await answerCallbackQuery(env, callbackQuery.id, "سندباکس اصلی شد ⭐");
      return;
    }
    if (action === "toggle") {
      await stub.addSandbox({ code: sb.code, vmId: sb.vm_id, description: sb.description, enabled: val === "1" });
      const view = await renderSandboxesView(stub);
      await editRichOrFallback(env, chatId, messageId, view.richMsg, view.fallbackHtml, view.fallbackExtra);
      await answerCallbackQuery(env, callbackQuery.id, val === "1" ? "فعال شد ✅" : "غیرفعال شد ⛔");
      return;
    }
    if (action === "del") {
      await stub.deleteSandbox(sb.code);
      const view = await renderSandboxesView(stub);
      await editRichOrFallback(env, chatId, messageId, view.richMsg, view.fallbackHtml, view.fallbackExtra);
      await answerCallbackQuery(env, callbackQuery.id, "حذف شد 🗑");
      return;
    }
  }

  if (data.startsWith("wake:")) {
    const [, action, idStr, val] = data.split(":");
    const id = parseInt(idStr, 10);
    if (action === "toggle" && id) {
      await stub.toggleWakeSlot(id, val === "1");
      const view = await renderWakeupsView(stub);
      await editRichOrFallback(env, chatId, messageId, view.richMsg, view.fallbackHtml, view.fallbackExtra);
      await answerCallbackQuery(env, callbackQuery.id, val === "1" ? "فعال شد ✅" : "غیرفعال شد ⛔");
      return;
    }
    if (action === "del" && id) {
      await stub.deleteWakeSlot(id);
      const view = await renderWakeupsView(stub);
      await editRichOrFallback(env, chatId, messageId, view.richMsg, view.fallbackHtml, view.fallbackExtra);
      await answerCallbackQuery(env, callbackQuery.id, "حذف شد 🗑");
      return;
    }
  }

  if (data.startsWith("skill:")) {
    const [, action, idStr, val] = data.split(":");
    const id = parseInt(idStr, 10);
    if (action === "toggle" && id) {
      await stub.toggleSkill(id, val === "1");
      const view = await renderSkillsView(stub);
      await editRichOrFallback(env, chatId, messageId, view.richMsg, view.fallbackHtml, view.fallbackExtra);
      await answerCallbackQuery(env, callbackQuery.id, val === "1" ? "فعال شد ✅" : "غیرفعال شد ⛔");
      return;
    }
    if (action === "del" && id) {
      await stub.deleteSkillById(id);
      const view = await renderSkillsView(stub);
      await editRichOrFallback(env, chatId, messageId, view.richMsg, view.fallbackHtml, view.fallbackExtra);
      await answerCallbackQuery(env, callbackQuery.id, "حذف شد 🗑");
      return;
    }
  }

  if (!data.startsWith("note:")) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const parts = data.split(":");
  const action = parts[1];

  if (action === "page") {
    const page = parseInt(parts[2], 10) || 1;
    const [richMsg, fallback] = await Promise.all([renderNotesPageRich(stub, page), renderNotesPageData(stub, page)]);
    await editRichOrFallback(env, chatId, messageId, richMsg, fallback.text, fallback.reply_markup ? { reply_markup: fallback.reply_markup } : {});
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  if (action === "del") {
    const noteId = parseInt(parts[2], 10);
    const returnPage = parseInt(parts[3], 10) || 1;
    if (noteId) {
      await stub.deleteNote(noteId);
    }
    const [richMsg, fallback] = await Promise.all([renderNotesPageRich(stub, returnPage), renderNotesPageData(stub, returnPage)]);
    await editRichOrFallback(env, chatId, messageId, richMsg, fallback.text, fallback.reply_markup ? { reply_markup: fallback.reply_markup } : {});
    await answerCallbackQuery(env, callbackQuery.id, "یادداشت حذف شد 🗑");
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
      const richMsg = {
        html:
          `<h3>📝 ${escapeHtml(note.title)}</h3>` +
          `<p><i>ایجاد: ${escapeHtml(createdStr)} | ویرایش: ${escapeHtml(updatedStr)}</i></p>` +
          `<p>${escapeHtml(note.body).replace(/\n/g, "<br/>")}</p>` +
          `<tg-button-row align="left">` +
          `<tg-button type="callback_data" style="primary" data="note:page:${returnPage}">⬅️ بازگشت به لیست</tg-button>` +
          `<tg-button type="callback_data" style="danger" data="note:del:${noteId}:${returnPage}">🗑 حذف</tg-button>` +
          `</tg-button-row>`,
        is_rtl: true,
      };
      const fullText = `📝 <b>${escapeHtml(note.title)}</b>\n<i>ایجاد: ${createdStr} | ویرایش: ${updatedStr}</i>\n\n${escapeHtml(note.body)}`;
      const reply_markup = {
        inline_keyboard: [[{ text: "⬅️ بازگشت به لیست", callback_data: `note:page:${returnPage}` }]],
      };
      await editRichOrFallback(env, chatId, messageId, richMsg, fullText, { reply_markup });
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
    const models = (json.data || [])
      .filter((m) => !m.kind || m.kind === "chat")
      .map((m) => m.id);

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