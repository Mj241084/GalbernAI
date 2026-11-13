import { sendMessage, editMessage, pinMessage, unpinMessage, sendOwnerAlert } from "../telegram.js";
import { renderPlanHtml } from "../planView.js";

// A "plan" is task decomposition for YOUR OWN execution of a complex,
// multi-step request - not a user-facing reminder. Only one can be active
// at a time; it can only be carried out (completed item by item), never
// edited or deleted. It is rendered into the system prompt automatically
// on every turn while active - you don't need a tool to "read" it back.
// The plan is published and updated as a pinned Telegram message automatically.

export const definitions = [
  {
    type: "function",
    function: {
      name: "create_plan",
      description:
        "Break a complex, multi-step request into an ordered plan you will execute yourself, item by item. Only use this for genuinely multi-step work - not simple requests. Only one plan can be active at a time; finish (complete every item of) the current one before starting another. Note: The plan is published as a pinned message for the user automatically; do NOT repeat the entire plan items list in your chat response.",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "One-line description of what the plan accomplishes." },
          items: {
            type: "array",
            items: { type: "string" },
            description: "Ordered list of concrete steps.",
          },
        },
        required: ["goal", "items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_plan_item",
      description:
        "Mark one item of the currently active plan as done, right after you actually finish that step. Use the item_id shown in your system prompt's active plan section. When the last item is completed, the plan closes and unpins automatically. Do NOT repeat the remaining items list in your chat response.",
      parameters: {
        type: "object",
        properties: { item_id: { type: "integer" } },
        required: ["item_id"],
      },
    },
  },
];

/**
 * تنها نقطه‌ی حقیقت برای «پیام پین‌شده‌ی برنامه».
 * نبود پیام → می‌سازه و پین می‌کنه. وجود پیام → ویرایشش می‌کنه.
 * پاک‌شدن پیام توسط کاربر → خودکار از نو می‌سازه.
 * هیچ خطایی اینجا نباید خود ابزار رو بشکنه.
 */
export async function publishPlanMessage(env, stub, chatId, planId) {
  const snapshot = await stub.getPlanById(planId);
  if (!snapshot) return null;
  const html = renderPlanHtml(snapshot);
  const existingId = snapshot.plan.telegram_message_id;

  const createAndPin = async () => {
    const sent = await sendMessage(env, chatId, html);
    const messageId = sent?.result?.message_id;
    if (!messageId) return null;
    await stub.setPlanMessageId(planId, messageId);
    await pinMessage(env, chatId, messageId);
    return messageId;
  };

  if (!existingId) return createAndPin();

  const res = await editMessage(env, chatId, existingId, html);
  if (res?.ok) return existingId;
  if (/not modified/i.test(res?.description || "")) return existingId;  // محتوا عوض نشده، مشکلی نیست
  return createAndPin();                                                 // معمولاً یعنی کاربر پیام رو پاک کرده
}

export async function execute(name, args, { env, stub, chatId }) {
  switch (name) {
    case "create_plan": {
      const result = await stub.createPlan({ goal: args.goal, items: args.items });
      if (result && result.plan) {
        try {
          await publishPlanMessage(env, stub, chatId, result.plan.id);
        } catch (err) {
          await sendOwnerAlert(env, `⚠️ خطا در انتشار پیام پین‌شده‌ی برنامه: ${err.message || err}`);
        }
      }
      return {
        ok: true,
        plan: result.plan,
        items: result.items,
        note: "برنامه به‌صورت یک پیام پین‌شده برای کاربر فرستاده شد؛ لازم نیست دوباره کل آیتم‌ها رو توی جوابت بنویسی.",
      };
    }
    case "complete_plan_item": {
      const result = await stub.completePlanItem(args.item_id);
      if (result && result.planId) {
        try {
          const msgId = await publishPlanMessage(env, stub, chatId, result.planId);
          if (result.planCompleted && msgId) {
            await unpinMessage(env, chatId, msgId);
          }
        } catch (err) {
          await sendOwnerAlert(env, `⚠️ خطا در ویرایش/آنپین پیام برنامه: ${err.message || err}`);
        }
      }
      return { ok: true, ...result };
    }
    default:
      throw new Error(`unknown plan tool: ${name}`);
  }
}
