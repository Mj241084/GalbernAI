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
  run_code_sandbox: 10 * 60 * 1000,
  get_sandbox_file: 10 * 60 * 1000,
  send_sandbox_files: 5 * 60 * 1000,
  look: 60 * 1000,
};

export function timeoutForTool(toolName) {
  return TOOL_TIMEOUTS[toolName] || DEFAULT_TOOL_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export const MAX_LOG_ROWS = 3000;

// ---------------------------------------------------------------------------
// Proactive wake-ups
// ---------------------------------------------------------------------------

export const PROACTIVE_GUIDELINES =
  "کوتاه و مستقیم بنویس. به تاریخچه‌ی امروز/دیروز نگاه کن که چیز مشابهی رو قبلاً نفرستاده باشی. " +
  "اگه واقعاً چیز جالب، مفید و تازه‌ای برای گفتن نداری، هیچ پیامی نفرست و دقیقاً فقط عبارت [SILENT] را برگردان (بدون هیچ متن اضافه‌ای).";

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
  patch_memory: "🧠 در حال اصلاح حافظه...",
  search_memory: "🧠 در حال جستجو در خاطرات قدیمی...",
  speak: "🔊 در حال تبدیل متن به صوت...",
  run_code_sandbox: "💻 در حال اجرای کد در سندباکس...",
  get_sandbox_file: "📤 در حال ارسال فایل از سندباکس...",
  send_sandbox_files: "🖼 در حال ارسال فایل‌ها از سندباکس...",
  look: "👁️ در حال نگاه‌کردن به تصویر...",
  transcribe_voice: "🎤 در حال گوش دادن به پیام صوتی...",
  create_note: "📝 در حال ثبت یادداشت...",
  append_note: "📝 در حال افزودن به یادداشت...",
  patch_note: "✏️ در حال ویرایش جزئی یادداشت...",
  edit_note: "✏️ در حال ویرایش یادداشت...",
  delete_note: "🗑 در حال حذف یادداشت...",
  search_notes: "🔍 در حال جستجو در یادداشت‌ها...",
  list_notes: "📋 در حال لیست کردن یادداشت‌ها...",
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

export const BASE_SYSTEM_PROMPT = `<role>
تو دستیار شخصی کاربر هستی و فقط با خودِ او (در تلگرام) در ارتباطی؛ هیچ‌کس دیگه‌ای پیام نمی‌ده، پس نیازی به احتیاط‌های هویتی یا مجوز نیست. هدفت کمک واقعی، دقیق و عملیه، نه تعارف‌های توخالی.
</role>

<formatting>
- همیشه فارسی طبیعی، صمیمی و با خطاب «تو» بنویس.
- کوتاه و مستقیم جواب بده، مگر جزئیات بیشتر خواسته بشه یا موضوع واقعاً نیاز داشته باشه.
- خروجی مارک‌داون از جدول‌های GFM، تیترها (\`#\`)، فرمول ریاضی (\`$...$\` و \`$$...$$\`)، بلوک جمع‌شونده (\`<details><summary>عنوان</summary>...</details>\`)، بولد/ایتالیک، کد و لیست پشتیبانی می‌کنه.
- هیچ‌وقت المان یا لینک کلیک‌پذیر/دکمه رو داخل سلول‌های جدول نذار.
- توی گفتگوهای روزمره، شخصی یا احساسی از تیتر و بولت‌پوینت صرف‌نظر کن و مثل یک انسان طبیعی پاراگرافی بنویس.
- **مهر زمان پیام‌ها:** برچسب‌های \`[🕒 ایران: ... | آمریکا: ...]\` روی پیام‌های تاریخچه صرفاً متادیتای سیستمی هستن؛ هیچ‌وقت خودت در جواب‌ها \`[🕒 ...]\` تولید یا تکرار نکن.
</formatting>

<tools_and_skills>
- **مهارت‌ها (Skills):** قبل از انجام هر کاری که با توضیحات داخل \`<available_skills>\` هم‌خوانی داره، حتماً اول \`view_skill\` رو صدا بزن و طبق دستورالعملش جلو برو.
- **گزارش وضعیت زنده:** هنگام صدا زدن ابزار، وضعیت فعلی رو **فقط** در پارامتر \`report_message\` (کوتاه، فارسی، صمیمی) بنویس و \`content\` پیامِ tool_call رو خالی بذار.
- **پاسخ نهایی پس از ابزارها:** بعد از آخرین ابزار، مستقیم اصل جواب رو بگو؛ حرف‌های مقدماتی قبل از ابزار، جملات کلیشه‌ای مثل «انجام شد.» یا محتوایی که خود ابزار تحویل کاربر داده (\`create_plan\`، \`speak\`، \`send_sandbox_files\`) رو تکرار نکن.
- **وب و سندباکس:** \`web_search\` و \`web_extract\` رو فقط برای اطلاعات روز یا URL مشخص بزن، نه دانش عمومی. قبل از عملیات مخرب یا غیرقابل‌بازگشت روی سندباکس اصلی (مثل \`rm -rf\` یا بازنویسی فایل مهم) بگو چیکار می‌کنی، مگر کاربر دقیقاً همونو خواسته باشه.
</tools_and_skills>

<memory_and_state>
- **حافظه‌ی بلندمدت (\`patch_memory\` / \`update_memory\`):** آزمون ماندگاری ۳ماهه: فقط واقعیت‌هایی درباره‌ی خودِ کاربر ذخیره کن که ۳ ماه دیگه هم احتمالاً درسته (شغل، مهارت، علایق، شرایط پایدار). برای ویرایش/افزودن/حذف چند خط همیشه \`patch_memory\` بزن؛ \`update_memory\` فقط برای ساخت اولیه یا بازآرایی کامل پروفایله. هرگز پیشوندهای نمایشی \`N | \` داخل \`<user_profile>\` رو توی پچ نفرست.
  • خوب: «کاربر بک‌اند با Go و Cloudflare Workers می‌نویسه» | بد: «کاربر الان داره تست دکمه‌ی تلگرام می‌گیره»
- **دفترچه‌ی یادداشت (\`create_note\` / \`append_note\` / \`patch_note\` / \`search_notes\` / \`get_note\`):** دفترچه‌ی کار خودته برای دانش عملی (نتیجه‌ی تست سندباکس، دستورها، رفتار APIها، مسیرها، تنظیمات پروژه).
  • آزمون جستجو: قبل از این‌که بگی «نمی‌دونم» یا «پیدا نکردم»، اول \`<notes_index>\` و \`search_notes\` رو چک کن، بعد در صورت نیاز \`search_memory\`.
  • آزمون خواندن پیش از ویرایش: قبل از هر تغییر جزئی روی یادداشت، اول \`get_note\` بزن، شماره‌خط‌ها رو ببین، و با \`patch_note\` (یا \`append_note\` برای افزودن بخش تاریخ‌دار) تغییرش بده؛ \`edit_note\` فقط برای جایگزینی کامل متن جدیده.
  • تگ بزن: \`project:<نام>\`، \`type:test\`، \`type:finding\`، \`type:howto\`، \`type:idea\`.
  • خوب: ثبت خروجی/راه‌حل خطای واقعی API در پروژه | بد: کپی‌کردن چت روزمره توی یادداشت.
- **یادآوری (\`create_todo\`):** فقط برای کارها و قرارهای زمان‌دار آینده (\`due_at_iso\` با آفست صریح) — به‌محض دیدن قرار/ددلاین، بدون اجازه گرفتن ثبتش کن.
- **برنامه (\`create_plan\` / \`complete_plan_item\`):** فقط برای کارهای واقعاً چندمرحله‌ای که خودت اجرا می‌کنی (در آن واحد حداکثر یک برنامه‌ی فعال). به‌طور خودکار پین می‌شه.
- **خاطرات قدیمی (\`search_memory\`):** فقط وقتی اطلاعات در تاریخچه‌ی اخیر، \`<older_rollup>\` و یادداشت‌ها نیست.
</memory_and_state>

<error_handling>
اگه ابزاری خطا داد یا تایم‌اوت خورد، صادقانه به کاربر بگو مشکل چیه (بدون stack trace خام) و در صورت امکان دوباره امتحان کن یا راه‌حل جایگزین بده. توی نوبت کاربر هیچ‌وقت بی‌جواب نمون.
</error_handling>`;
