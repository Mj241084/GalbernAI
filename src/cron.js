import { EMBEDDING_DIMENSIONS, IRAN_TZ } from "./config.js";
import { getDayWindow, shiftDayWindow, getIranHourMinute, formatHumanDateTime } from "./util.js";
import { callChatCompletions, callEmbeddings } from "./aiRouter.js";
import { sendOwnerAlert } from "./telegram.js";

const LAST_SEEN_DAY_KEY = "last_seen_day";

export async function handleScheduled(env, ctx, getStub) {
  const stub = getStub(env);
  await checkDueTodos(env, ctx, stub);
  await checkProactiveWakeups(env, ctx, stub);
  await checkRollover(env, ctx, stub);
}

// ---------------------------------------------------------------------------
// Due-todo wake-up
// ---------------------------------------------------------------------------

async function checkDueTodos(env, ctx, stub) {
  let due;
  try {
    due = await stub.getDueTodos();
  } catch (err) {
    await sendOwnerAlert(env, `🚨 <b>خطا در چک کردن یادآوری‌ها</b>\\n<code>${String(err.message || err).slice(0, 400)}</code>`);
    return;
  }
  for (const todo of due) {
    await stub.markTodoFired(todo.id);
    try {
      await env.TURNS_QUEUE.send({
        chatId: env.TELEGRAM_OWNER_CHAT_ID,
        trigger: { kind: "todo_fired", todo },
      });
    } catch (err) {
      await sendOwnerAlert(
        env,
        `🚨 <b>خطا هنگام انکیو کردن یادآوری «${todo.title}»</b>\\n<code>${String(err.message || err).slice(0, 400)}</code>`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Proactive wake-ups: a few fixed times a day (PROACTIVE_WAKE_SLOTS in
// config.js), the agent is woken up on its own - no user message involved -
// via the same synthetic tool-call/tool-result pattern used for todos. The
// cron ticks every 5 minutes, so a slot fires the first time its hour is
// observed with minute < 5; a per-day flag in kv_meta prevents re-firing it
// for the rest of that hour/day.
// ---------------------------------------------------------------------------

async function checkProactiveWakeups(env, ctx, stub) {
  if (!env.TELEGRAM_OWNER_CHAT_ID) return;
  const { hour, minute } = getIranHourMinute();
  const nowMinutes = hour * 60 + minute;
  const today = getDayWindow();

  let dueSlots = [];
  try {
    dueSlots = await stub.getDueWakeSlots(nowMinutes, today, 60);
  } catch (err) {
    await sendOwnerAlert(env, `🚨 <b>خطا در دریافت زمان‌بندی بیدارباش</b>\\n<code>${String(err.message || err).slice(0, 300)}</code>`);
    return;
  }

  for (const slot of dueSlots) {
    try {
      await stub.markWakeSlotFired(slot.id, today);
    } catch (err) {
      await sendOwnerAlert(env, `🚨 <b>خطا در ثبت وضعیت بیدارباش (${slot.id})</b>\\n<code>${String(err.message || err).slice(0, 300)}</code>`);
      continue;
    }

    try {
      await env.TURNS_QUEUE.send({
        chatId: env.TELEGRAM_OWNER_CHAT_ID,
        trigger: { kind: "proactive_wake", theme: slot.theme },
      });
    } catch (err) {
      await sendOwnerAlert(env, `🚨 <b>خطا در بیدارباش خودکار (${slot.id})</b>\\n<code>${String(err.message || err).slice(0, 400)}</code>`);
    }
  }
}

// ---------------------------------------------------------------------------
// Day-3 rollover (unchanged from before - compounding summary + Vectorize)
// ---------------------------------------------------------------------------

export async function checkRollover(env, ctx, stub) {
  const today = getDayWindow();
  const lastSeenDay = await stub.getMeta(LAST_SEEN_DAY_KEY);
  if (lastSeenDay === today) return;
  await stub.setMeta(LAST_SEEN_DAY_KEY, today);

  const oldestAged = await stub.getOldestAgedDay();
  if (!oldestAged) return;

  const boundary = shiftDayWindow(today, -2);
  const agedMessages = await stub.getMessagesOlderThan(boundary);
  if (agedMessages.length === 0) return;

  const conversationText = agedMessages
    .map((m) => {
      const stamp = formatHumanDateTime(m.ts, IRAN_TZ);
      if (m.role === "user") return m.content ? `[${stamp}] کاربر: ${m.content}` : null;
      if (m.role === "assistant") return m.content ? `[${stamp}] دستیار: ${m.content}` : null;
      return null;
    })
    .filter(Boolean)
    .join("\n");

  if (!conversationText.trim()) {
    await stub.deleteMessagesOlderThan(boundary);
    return;
  }

  const currentRollup = await stub.getCurrentRollup();
  const previousSummaryBlock = currentRollup ? `خلاصه‌ی قبلی (تا این لحظه):\n${currentRollup.summary}\n\n` : "";
  const coversFromDay = currentRollup ? currentRollup.covers_from_day : oldestAged;

  const summarizationPrompt =
    `${previousSummaryBlock}مکالمات جدیدی که باید به خلاصه اضافه بشن (با تاریخ و زمان دقیق):\n${conversationText}\n\n` +
    `یک خلاصه‌ی جامع، ساختاریافته و دقیق از تمام موارد بالا (خلاصه‌ی قبلی + مکالمات جدید، ترکیب‌شده) بنویس:\n` +
    `- تاریخ و ساعت دقیق رویدادها، قرارها و زمان وقوع اتفاقات را حفظ کن.\n` +
    `- بین «تصمیم‌های قطعی و انجام‌شده‌ی کاربر» و «پیشنهادهای تاییدنشده‌ی دستیار یا ایده‌های خام» تمایز واضح بگذار.\n` +
    `- فقط جزئیات کاملاً بی‌ربط، تکراری یا تعارف‌های کم‌اهمیت را حذف کن — خلاصه باید جامع و قابل اتکا باشد.\n` +
    `- فقط متن خلاصه را بنویس، بدون مقدمه یا توضیح اضافه.`;

  let summaryText;
  try {
    const resp = await callChatCompletions(env, { model: "auto", messages: [{ role: "user", content: summarizationPrompt }] });
    summaryText = resp.choices?.[0]?.message?.content?.trim();
    if (!summaryText) throw new Error("empty summary returned");
  } catch (err) {
    await sendOwnerAlert(env, `🚨 <b>خطا در ساخت خلاصه‌ی هفتگی (rollover)</b>\n<code>${String(err.message || err).slice(0, 500)}</code>`);
    return;
  }

  // خلاصه‌ی اختصاصی همین بازه‌ی زمانی (oldestAged..boundary) برای Vectorize تا هر وکتور یک چانک متمایز زمانی باشد
  let windowSummaryText = summaryText;
  if (currentRollup) {
    const windowPrompt =
      `این فقط مکالمات بازه‌ی ${oldestAged} تا ${boundary} است:\n${conversationText}\n\n` +
      `یک خلاصه‌ی جامع و مستقل فقط از همین بازه‌ی زمانی بنویس (بدون اطلاعات بازه‌های قبل):\n` +
      `- تاریخ و ساعت دقیق رویدادها و تصمیم‌ها را حفظ کن.\n` +
      `- بین تصمیم‌های قطعی کاربر و پیشنهادهای تاییدنشده‌ی دستیار تمایز بگذار.\n` +
      `- فقط متن خلاصه را بنویس، بدون مقدمه یا توضیح اضافه.`;
    try {
      const winResp = await callChatCompletions(env, { model: "auto", messages: [{ role: "user", content: windowPrompt }] });
      const winText = winResp.choices?.[0]?.message?.content?.trim();
      if (winText) windowSummaryText = winText;
    } catch (err) {
      await sendOwnerAlert(env, `⚠️ <b>هشدار در ساخت خلاصه‌ی پنجره‌ای برای Vectorize</b>\n<code>${String(err.message || err).slice(0, 400)}</code>`);
    }
  }

  const vectorId = crypto.randomUUID();
  const rollupRecord = await stub.setCurrentRollup({
    coversFromDay,
    coversToDay: boundary,
    summary: summaryText,
    windowSummary: windowSummaryText,
    vectorId,
  });
  const rollupId = rollupRecord?.id || null;

  try {
    const [vector] = await callEmbeddings(env, windowSummaryText, EMBEDDING_DIMENSIONS);
    if (env.MEMORY_INDEX) {
      await env.MEMORY_INDEX.upsert([
        {
          id: vectorId,
          values: vector,
          metadata: { rollup_id: rollupId, covers_from_day: oldestAged, covers_to_day: boundary },
        },
      ]);
    }
  } catch (err) {
    await sendOwnerAlert(env, `🚨 <b>خطا در embed/ذخیره‌ی خلاصه در Vectorize</b>\n<code>${String(err.message || err).slice(0, 500)}</code>`);
  }

  await stub.deleteMessagesOlderThan(boundary);
}