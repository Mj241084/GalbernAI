// ---------------------------------------------------------------------------
// AI router integration
// ---------------------------------------------------------------------------

export function routerChatUrl(env) {
  return `${env.AI_ROUTER_BASE_URL.replace(/\/+$/, "")}/v1/chat/completions`;
}
export function routerEmbeddingsUrl(env) {
  return `${env.AI_ROUTER_BASE_URL.replace(/\/+$/, "")}/v1/embeddings`;
}

export const CHAT_MODEL = "auto";
export const EMBEDDING_MODEL = "auto";
export const EMBEDDING_DIMENSIONS = 768; // must match the Vectorize index's configured dimensions

// Model used for the "which of these candidate images actually match" step
// of the find_images tool (tools/images.js). Kept as a single named
// constant so renaming/replacing it on the router is a one-line change.
export const IMAGE_ANALYSIS_MODEL = "gemini-3.5-flash-lite";

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

// Two clock anchors are injected into the system prompt on every turn: your
// local time (Asia/Tehran) and a US Gregorian reference (Pacific time - the
// most common "default American time" convention in tech contexts). This is
// purely for the model's scheduling reasoning; change PACIFIC_TZ if you'd
// rather anchor to Eastern time instead.
export const IRAN_TZ = "Asia/Tehran";
export const US_REFERENCE_TZ = "America/Los_Angeles";

// Conversation-day boundary: plain midnight in Tehran time (NOT the 12:30
// boundary used by the other worker for Google quota resets - that's an
// unrelated concept). "Today"/"yesterday" here match how a person actually
// thinks about their day.
export const HISTORY_DAY_TZ = IRAN_TZ;

// ---------------------------------------------------------------------------
// Agent loop limits / timeouts
// ---------------------------------------------------------------------------

export const MAX_TOOL_ITERATIONS = 15; // per incoming message, safety valve against tool-call loops
export const TURN_SOFT_DEADLINE_MS = 12 * 60 * 1000; // 12 minutes soft deadline before self-continuation

// Timeout for a single call to the AI router (chat/completions or
// embeddings). This used to be 10 minutes, matching the router's own
// generous per-upstream-attempt budget - but that meant that if a single
// call genuinely stalled (rather than erroring out fast), this Worker's
// background (waitUntil) execution would just hang with the status message
// stuck on screen and nothing else visibly wrong. Real responses - even
// slow ones with high thinking and 80k+ token context - have consistently
// come back in single-digit seconds to at most a couple of minutes, so 2
// minutes is generous headroom without being effectively unbounded.
export const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

// Timeout for web_search (Tavily) / web_extract (Firecrawl) calls. These
// normally return in 1-5 seconds; 25s is generous. THIS WAS MISSING
// ENTIRELY BEFORE - see tools/web.js - and is the confirmed root cause of
// turns that got stuck forever on "🔎 در حال جستجو...".
export const WEB_TOOL_TIMEOUT_MS = 25 * 1000;

// Timeout for calls to the Telegram Bot API itself (send/edit/delete
// message, download file, send photo/audio). Telegram is normally very
// fast; this is just a safety net so a Telegram hiccup can't hang a turn.
export const TELEGRAM_API_TIMEOUT_MS = 20 * 1000;

// Outer safety-net timeout applied around EVERY tool execution in
// tools/index.js's dispatchTool wrapper, in addition to whatever timeout
// the tool's own internal fetch() calls already have. This is what
// actually guarantees the agent loop can never hang forever even if some
// future tool forgets to add its own timeout: if a tool doesn't settle in
// time, the loop gets an error result back and can keep going (or at
// least fail loudly with an owner alert) instead of freezing silently.
export const DEFAULT_TOOL_TIMEOUT_MS = 45 * 1000;
export const TOOL_TIMEOUTS = {
  web_search: WEB_TOOL_TIMEOUT_MS + 5000,
  web_extract: WEB_TOOL_TIMEOUT_MS + 5000,
  search_memory: UPSTREAM_TIMEOUT_MS + 10000, // includes an embedding call to the router
  speak: 150 * 1000, // model call + native TTS + WAV wrap + Telegram upload
  find_images: 240 * 1000, // parallel image downloads + one big multimodal call + Telegram uploads
  run_code_sandbox: 10 * 60 * 1000,
  get_sandbox_file: 10 * 60 * 1000,
  look: 60 * 1000,
};

export function timeoutForTool(toolName) {
  return TOOL_TIMEOUTS[toolName] || DEFAULT_TOOL_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Image search (find_images tool)
// ---------------------------------------------------------------------------

export const IMAGE_RESULTS_PER_QUERY = 6;
export const MAX_IMAGE_QUERIES = 3;
export const MAX_IMAGES_TO_SEND = 10;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export const MAX_LOG_ROWS = 3000;

// ---------------------------------------------------------------------------
// Proactive wake-ups - a few times a day the agent is woken up on its own
// (no user message involved) and told to go find something worth sharing.
// `hour` is Tehran local time; the cron tick (every 5 min) fires a slot the
// first time it observes minute < 5 within that hour, once per day per
// slot (tracked in kv_meta - see cron.js).
// ---------------------------------------------------------------------------

export const PROACTIVE_WAKE_SLOTS = [
  { id: "morning", hour: 8, theme: "morning" },
  { id: "midday", hour: 13, theme: "midday" },
  { id: "evening", hour: 19, theme: "evening" },
  { id: "night", hour: 23, theme: "night" },
];

export function proactiveThemePrompt(theme) {
  const prompts = {
    morning:
      "الان صبحه. یک شعر، حدیث، آیه، یا داستان کوتاه جالب/آموزنده پیدا کن (با web_search) و به‌صورت کوتاه و دلنشین برای کاربر بفرست. اگه از حافظه‌ی بلندمدتت علاقه‌ی خاصی درباره‌ی کاربر می‌دونی، می‌تونی به‌جاش یا در کنارش بر همون اساس چیزی پیدا کنی.",
    midday:
      "بر اساس چیزی که از حافظه‌ی بلندمدت درباره‌ی علایق کاربر می‌دونی، یک خبر تازه، اطلاعات جالب، یا مطلب مرتبط پیدا کن (با web_search) و خلاصه‌ی کوتاهی براش بفرست. اگه چیز خاصی درباره‌ی علایقش نمی‌دونی، یک خبر یا مطلب عمومی جالب پیدا کن.",
    evening:
      "یک داستان کوتاه، نکته‌ی جالب، یا خبری که فکر می‌کنی برای کاربر جذاب باشه پیدا کن (با web_search) و کوتاه براش بفرست.",
    night:
      "یک جمله‌ی آرامش‌بخش، حدیث، یا داستان کوتاه مناسب پایان روز پیدا کن (با web_search) و کوتاه براش بفرست.",
  };
  return (
    (prompts[theme] || prompts.midday) +
    " کوتاه و مستقیم بنویس. به تاریخچه‌ی امروز/دیروز نگاه کن که چیز مشابهی رو قبلاً نفرستاده باشی. اگه واقعاً چیز جالب و تازه‌ای پیدا نکردی، پیام کوتاهی بفرست یا از فرستادن پیام صرف‌نظر کن (لازم نیست هرقیمتی چیزی بفرستی)."
  );
}

// ---------------------------------------------------------------------------
// Real-time status pings (deterministic, per tool name - NOT model-written)
// ---------------------------------------------------------------------------

export const NOTES_PAGE_SIZE = 8;

export const TOOL_STATUS_TEXT = {
  web_search: "🔎 در حال جستجو در وب...",
  web_extract: "📄 در حال استخراج محتوای صفحه...",
  create_todo: "🗒 در حال ثبت یادآوری...",
  edit_todo: "✏️ در حال ویرایش یادآوری...",
  delete_todo: "🗑 در حال حذف یادآوری...",
  list_todos: "📋 در حال بررسی یادآوری‌ها...",
  create_plan: "🧭 در حال برنامه‌ریزی...",
  complete_plan_item: "✅ در حال ثبت پیشرفت برنامه...",
  update_memory: "🧠 در حال به‌روزرسانی حافظه...",
  search_memory: "🧠 در حال جستجو در خاطرات قدیمی...",
  speak: "🔊 در حال تبدیل متن به صوت...",
  find_images: "🖼 در حال جستجوی عکس...",
  run_code_sandbox: "💻 در حال اجرای کد در سندباکس...",
  get_sandbox_file: "📤 در حال ارسال فایل از سندباکس...",
  look: "👁️ در حال نگاه‌کردن به تصویر...",
  create_note: "📝 در حال ثبت یادداشت...",
  edit_note: "✏️ در حال ویرایش یادداشت...",
  delete_note: "🗑 در حال حذف یادداشت...",
  search_notes: "🔍 در حال جستجو در یادداشت‌ها...",
  get_note: "📖 در حال خواندن یادداشت...",
};

export function statusTextFor(toolName) {
  return TOOL_STATUS_TEXT[toolName] || `⚙️ در حال اجرای ${toolName}...`;
}

// ---------------------------------------------------------------------------
// System prompt (static portion - dynamic sections are appended in
// agentLoop.js: current time, memory profile, active plan, skills list).
//
// Structured with internal "## " headers (mirroring the "--- عنوان ---"
// style the dynamic sections use) so the whole assembled prompt reads as
// one coherent document instead of one undifferentiated paragraph. Each
// section answers one question the model actually has to make a decision
// about on every turn, rather than restating background info it doesn't
// need to re-derive each time.
// ---------------------------------------------------------------------------

export const BASE_SYSTEM_PROMPT = `تو دستیار شخصی کاربر هستی و فقط با او (از طریق تلگرام) در ارتباطی؛ هیچ‌کس دیگه‌ای بهت پیام نمی‌ده، پس نیازی به احتیاط‌های مربوط به هویت یا مجوز نیست. هدفت کمک واقعی و عملیه، نه پاسخ مؤدبانه‌ی بی‌محتوا.

## لحن و فرمت
- همیشه فارسی، صمیمی و با خطاب "تو" بنویس.
- کوتاه و مستقیم جواب بده، مگر کاربر جزئیات بیشتر خواسته باشه یا موضوع واقعاً پیچیده باشه.
- خروجی نهایی‌ت با مارک‌داون به فرمت تلگرام تبدیل می‌شه: **بولد**، *ایتالیک*، \`کد\`، بلاک کد سه‌بک‌تیک، [متن](URL)، # برای تیتر، - برای لیست. از این‌ها برای خوانایی استفاده کن، نه به‌عنوان تزئین اضافه.

## قانون ثابت ابزارها
هر بار ابزاری صدا می‌زنی، دو کار همیشگیه:
۱. توی content خودت یک جمله‌ی کوتاه و صمیمانه به فارسی بنویس که دقیقاً بگه همین الان چیکار داری می‌کنی (مثال: «دارم به خاطراتت سر می‌زنم تا دستور پخت رو پیدا کنم...»).
۲. دقیقاً همون جمله رو توی پارامتر report_message هم بذار - این مستقیم پیام وضعیت زنده‌ی تلگرام کاربره؛ هیچ‌وقت خالی نذارش.

## حافظه / یادداشت / یادآوری / برنامه - این‌ها رو قاطی نکن
- **update_memory**: فقط واقعیت‌های پایدار و کلی درباره‌ی خودِ کاربر (شغل، علایق، شرایط زندگی) که باید همیشه جلوی چشمت باشه. هر بار کل متن پروفایل رو (نسخه‌ی کامل و به‌روز، نه فقط چیز جدید) بفرست.
- **create_note / search_notes**: محتوایی که خودش ارزش نگه‌داری داره ولی بخشی از پروفایل کاربر نیست - ایده، لیست، دستور پخت، خلاصه‌ی یک موضوع خاص. قبل از ساختن یادداشت جدید، با search_notes چک کن که تکراری نساخته باشی.
- **create_todo**: فقط یادآوری‌های زمان‌دار (due_at اجباریه). به محض این‌که وسط مکالمه متوجه یک اتفاق آینده (قرار، ددلاین، مصاحبه) شدی، بدون این‌که از کاربر اجازه بگیری یا حتی بهش بگی، خودت یادآوری بساز.
- **create_plan / complete_plan_item**: فقط برای تجزیه‌ی یک درخواست پیچیده و چندمرحله‌ای که خودت باید اجراش کنی. برای کارهای ساده و تک‌مرحله‌ای هیچ‌وقت plan نساز؛ در آنِ واحد فقط یک plan فعال می‌تونه باشه.
- **search_memory**: فقط وقتی سؤال درباره‌ی گذشته‌ایه که نه توی تاریخچه‌ی امروز/دیروز هست، نه توی خلاصه‌ی فشرده‌ای که همین الان توی همین پرامپت داری.

## بقیه‌ی ابزارها
- **web_search / web_extract**: برای اطلاعات به‌روز، وقایع جاری، یا هر چیزی که مطمئن نیستی. برای دانش عمومی و پایدار جستجو الکی نکن.
- **find_images**: بین ۱ تا ۳ کوئری جستجو + یک توضیح از چیزی که دنبالشی بده. عکس‌های منتخب مستقیم برای کاربر می‌ره؛ توی متنت دوباره توصیفشون نکن.
- **speak**: فقط وقتی صدا واقعاً کمک می‌کنه صداش کن. خروجیش مستقیم برای کاربره؛ متن رو توی جواب خودت تکرار نکن.
- **run_code_sandbox / get_sandbox_file / look**: برای اجرای کد، تولید فایل/نمودار، و دیدن مستقیم تصاویر داخل سندباکس. قبل از هر عملیات مخرب یا غیرقابل‌بازگشت (حذف فایل، بازنویسی، rm -rf و مشابه) روی سندباکس اصلی، یک بار بگو داری چیکار می‌کنی، مگر کاربر دقیقاً همینو خواسته باشه.

## خطا و timeout
اگه ابزاری خطا داد یا timeout خورد، صادقانه به کاربر بگو مشکلی پیش اومده (بدون جزئیات فنی اضافه) و در صورت امکان دوباره امتحان کن یا یک راه جایگزین پیشنهاد بده. هیچ‌وقت ساکت نمون یا کاربر رو بی‌جواب نذار.`;
