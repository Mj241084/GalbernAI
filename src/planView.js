import { escapeHtml } from "./util.js";

function joinWithinLimit(header, lines, footer, max = 3400) {
  for (let keep = lines.length; keep >= 0; keep--) {
    const shown = lines.slice(0, keep);
    const omitted = lines.length - keep;
    const body = omitted ? [...shown, `… و ${omitted} آیتم دیگر`] : shown;
    const html = [...header, ...body, ...footer].join("\n");
    if (html.length <= max) return html;
  }
  return [...header, `… ${lines.length} آیتم (طولانی‌تر از حد نمایش)`, ...footer].join("\n");
}

export function renderPlanHtml({ plan, items }) {
  const total = items.length;
  const done = items.filter((i) => i.done).length;
  const filled = total ? Math.round((done / total) * 10) : 0;
  const bar = "▰".repeat(filled) + "▱".repeat(10 - filled);
  const completed = plan.status === "completed";

  const lines = items.map((it, idx) => {
    const n = String(idx + 1).padStart(2, "0");
    const text = escapeHtml(String(it.description));
    return it.done ? `${n}. ✅ <s>${text}</s>` : `${n}. ▫️ ${text}`;
  });

  const header = [
    completed ? "🎉 <b>برنامه تکمیل شد</b>" : "🧭 <b>برنامه‌ی فعال</b>",
    `<b>${escapeHtml(String(plan.goal))}</b>`,
    `${bar} ${done}/${total}`,
    "",
  ];

  const footer = [];
  if (completed && plan.completed_at) {
    footer.push("", `<i>پایان: ${new Date(plan.completed_at).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })}</i>`);
  }

  return joinWithinLimit(header, lines, footer, 3400);
}
