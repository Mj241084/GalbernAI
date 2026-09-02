import {
  WEB_TOOL_TIMEOUT_MS,
  IMAGE_ANALYSIS_MODEL,
  IMAGE_RESULTS_PER_QUERY,
  MAX_IMAGE_QUERIES,
  MAX_IMAGES_TO_SEND,
} from "../config.js";
import { callChatCompletions } from "../aiRouter.js";
import { sendPhotoByUrl, sendOwnerAlert } from "../telegram.js";
import { safeJsonParse, fetchImageAsDataUri } from "../util.js";

async function serperImageSearch(env, query, num) {
  let resp;
  try {
    resp = await fetch("https://google.serper.dev/images", {
      method: "POST",
      headers: { "X-API-KEY": env.SERPER_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num }),
      signal: AbortSignal.timeout(WEB_TOOL_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new Error(timedOut ? `Serper Images تایم‌اوت خورد (query: ${query})` : `Serper Images خطای شبکه: ${err.message || err}`);
  }
  if (resp.status === 429) {
    await sendOwnerAlert(env, `🚨 <b>Serper rate limit خورد</b>\nquery: ${query}`);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Serper Images خطای HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  const json = await resp.json();
  return (json.images || []).map((im) => ({
    title: im.title,
    imageUrl: im.imageUrl,
    link: im.link,
    source: im.source,
  }));
}

export const definitions = [
  {
    type: "function",
    function: {
      name: "find_images",
      description:
        "Search the web for images matching a description, have a vision model filter the candidates, and send the best matches directly to the user. Use 1-3 differently-worded queries to widen coverage.",
      parameters: {
        type: "object",
        properties: {
          queries: { type: "array", items: { type: "string" }, description: "1 to 3 image search queries." },
          description: {
            type: "string",
            description: "What you're actually looking for - used to filter which candidate images actually match.",
          },
        },
        required: ["queries", "description"],
      },
    },
  },
];

// NOTE ON A DESIGN ASSUMPTION: candidate images are passed to the analysis
// model as remote image_url URLs (Serper's own imageUrl), not downloaded
// and re-uploaded as base64. This relies on Gemini's OpenAI-compat layer
// being able to fetch external image URLs server-side - which is standard,
// documented behavior for OpenAI-compatible vision endpoints in general,
// but wasn't separately verified against a live call in this environment.
// If it turns out unreliable in practice, the fix is localized to the loop
// below that builds `messages`: download each candidate + base64-encode it
// (same pattern as agentLoop.js's history rehydration) before sending.
export async function execute(name, args, { env, chatId }) {
  if (name !== "find_images") throw new Error(`unknown images tool: ${name}`);
  if (!env.SERPER_API_KEY) return { ok: false, error: "SERPER_API_KEY تنظیم نشده." };

  const rawQueries = Array.isArray(args.queries) ? args.queries : [args.queries];
  const queries = rawQueries.filter((q) => typeof q === "string" && q.trim()).slice(0, MAX_IMAGE_QUERIES);
  if (queries.length === 0) throw new Error("حداقل یک کوئری معتبر لازم است.");

  const candidates = [];
  const queryErrors = [];
  let idCounter = 0;
  for (const q of queries) {
    try {
      const results = await serperImageSearch(env, q, IMAGE_RESULTS_PER_QUERY);
      for (const r of results) candidates.push({ id: `img${idCounter++}`, query: q, ...r });
    } catch (err) {
      queryErrors.push(`${q}: ${String(err.message || err)}`);
    }
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      found: 0,
      selected: 0,
      error: queryErrors.length ? queryErrors.join(" | ") : "هیچ نتیجه‌ای پیدا نشد.",
    };
  }

  // Parallel download candidate images into base64 data URIs
  const downloadResults = await Promise.allSettled(
    candidates.map((c) => fetchImageAsDataUri(c.imageUrl, WEB_TOOL_TIMEOUT_MS))
  );

  const validCandidates = [];
  const downloadErrors = [];
  for (let i = 0; i < candidates.length; i++) {
    const res = downloadResults[i];
    if (res.status === "fulfilled") {
      validCandidates.push({ ...candidates[i], dataUri: res.value });
    } else {
      downloadErrors.push(`${candidates[i].id} (${candidates[i].imageUrl}): ${String(res.reason?.message || res.reason)}`);
    }
  }

  if (validCandidates.length === 0) {
    return {
      ok: false,
      found: candidates.length,
      selected: 0,
      error: `تمام عکس‌های پیدا شده (${candidates.length} عدد) در دانلود/دریافت ناموفق بودند: ${downloadErrors.join(" | ")}`,
    };
  }

  const instructionText =
    `توضیح چیزی که دنبالشیم: ${args.description || "(بدون توضیح اضافه)"}\n\n` +
    `در ادامه ${validCandidates.length} عکس کاندید میاد، هرکدوم قبلش آیدیش نوشته شده. فقط عکس‌هایی که واقعاً با توضیح بالا مطابقت دارن رو انتخاب کن ` +
    `(بین صفر تا ${MAX_IMAGES_TO_SEND} تا - اگه هیچ‌کدوم مطابقت نداشت، آرایه‌ی خالی برگردون). ` +
    `دقیقاً و فقط این JSON رو برگردون، بدون هیچ متن یا توضیح اضافه:\n{"selected_ids": ["id1", "id2"]}`;

  const messages = [{ role: "user", content: instructionText }];
  for (const c of validCandidates) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: `آیدی: ${c.id}` },
        { type: "image_url", image_url: { url: c.dataUri } },
      ],
    });
  }

  let selectedIds = [];
  try {
    const response = await callChatCompletions(env, {
      model: IMAGE_ANALYSIS_MODEL,
      messages,
      response_format: { type: "json_object" },
    });
    const raw = response.choices?.[0]?.message?.content || "{}";
    const parsed = safeJsonParse(raw, {});
    if (Array.isArray(parsed.selected_ids)) selectedIds = parsed.selected_ids;
  } catch (err) {
    return { ok: false, found: validCandidates.length, selected: 0, error: `خطا در تحلیل عکس‌ها: ${String(err.message || err)}` };
  }

  const selected = validCandidates.filter((c) => selectedIds.includes(c.id)).slice(0, MAX_IMAGES_TO_SEND);

  for (const img of selected) {
    try {
      await sendPhotoByUrl(env, chatId, { url: img.imageUrl, caption: img.title ? img.title.slice(0, 900) : undefined });
    } catch {
      // one failed send shouldn't kill the report for the rest
    }
  }

  return {
    ok: true,
    found: candidates.length,
    selected: selected.length,
    selected_titles: selected.map((s) => s.title).filter(Boolean),
    ...(queryErrors.length ? { partial_query_errors: queryErrors } : {}),
  };
}