# دستیار شخصی (Cloudflare Worker + Telegram)

یک ایجنت شخصی مجزا، روی یک Worker و یک بات تلگرام کاملاً جدا از `gemini-hermes-router`.
تمام تماس‌های هوش مصنوعی (چت، TTS، embedding) از طریق همون Worker روتر می‌ره — این
پروژه هیچ کلید Gemini/OpenRouter‌ای مدیریت نمی‌کنه.

---

## ۱) معماری

```
Telegram (بات دوم، جدا) ──▶ این Worker
                              │
                              ├─▶ Durable Object (SQLite): تاریخچه، حافظه، تودو،
                              │    برنامه، skillها، خلاصه‌های rollup، لاگ ابزارها،
                              │    بافر آلبوم عکس/ویدیو، وضعیت ویزارد اسکیل
                              ├─▶ gemini-hermes-router (/v1/chat/completions ،
                              │    /v1/embeddings) — همه‌ی تماس‌های AI از اینجا
                              ├─▶ Vectorize (MEMORY_INDEX) — جستجوی معنایی خاطرات قدیمی
                              ├─▶ Tavily (جستجوی وب) / Firecrawl (استخراج URL)
                              ├─▶ Serper Images (find_images)
                              ├─▶ YouTube Data API v3 (get_latest_youtube_video)
                              └─▶ Cron Trigger هر ۵ دقیقه — تودوهای موعددار،
                                   بیدارباش خودکار، rollover
```

---

## ۲) پیش‌نیاز: ساخت Vectorize index

**قبل از اولین deploy**:
```bash
npx wrangler vectorize create agent-memory --dimensions=768 --metric=cosine
```
اگه اسمش رو عوض کردی، `index_name` توی `wrangler.toml` رو هم مطابقش کن.

---

## ۳) نصب و Deploy

```bash
cd agent
npm install
npx wrangler login

# base URL همون worker روتر (بدون /v1 در انتها - config.js خودش /v1/... اضافه می‌کنه)
# این خط رو توی wrangler.toml ویرایش کن:
#   AI_ROUTER_BASE_URL = "https://gemini-hermes-router.<your-subdomain>.workers.dev"

npx wrangler secret put AI_ROUTER_PROXY_TOKEN   # همون PROXY_TOKEN ورکر روتر
npx wrangler secret put TELEGRAM_BOT_TOKEN      # توکن بات دوم (جدا از بات روتر)
npx wrangler secret put TELEGRAM_OWNER_CHAT_ID
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET # اختیاری ولی پیشنهادشده
npx wrangler secret put TAVILY_API_KEY
npx wrangler secret put FIRECRAWL_API_KEY
npx wrangler secret put YOUTUBE_API_KEY         # رایگان، از Google Cloud Console
npx wrangler secret put SERPER_API_KEY          # ۲۵۰۰ جستجوی رایگان یک‌باره

npx wrangler deploy
```

---

## ۴) ساخت بات تلگرام دوم (کاملاً جدا از بات روتر)

۱. به [@BotFather](https://t.me/BotFather) پیام بده، `/newbot` بزن، یک نام/یوزرنیم
   **متفاوت** از بات مدیریتی روتر انتخاب کن.
۲. توکن رو با `TELEGRAM_BOT_TOKEN` بالا ثبت کن.
۳. `chat_id` خودت رو از [@userinfobot](https://t.me/userinfobot) بگیر و با
   `TELEGRAM_OWNER_CHAT_ID` ثبت کن.
۴. ثبت webhook:
```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<your-agent-worker>.workers.dev/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```
۵. توی تلگرام به باتت `/help` بزن.

### راه‌اندازی کلیدهای YouTube و Serper

**YouTube Data API v3** (رایگان، ۱۰,۰۰۰ واحد/روز):
۱. به [Google Cloud Console](https://console.cloud.google.com/) برو، یک پروژه بساز.
۲. از «Enabled APIs» سرچ کن «YouTube Data API v3» و فعالش کن.
۳. از «Credentials» یک API Key بساز (نیازی به OAuth نیست، چون فقط از داده‌ی عمومی
   می‌خونیم).

**Serper** (۲۵۰۰ جستجوی رایگان یک‌باره، نه ماهانه):
۱. به [serper.dev](https://serper.dev) برو، ثبت‌نام کن (بدون کارت).
۲. از داشبورد API key رو کپی کن.

---

## ۵) دستورات بات

```
/help                     — راهنما
/skills                   — لیست skillهای ثبت‌شده
/addskill                 — ساخت skill جدید، قدم‌به‌قدم (پایین‌تر توضیح کامل)
/cancel                   — لغو ساخت skill نیمه‌کاره
/delskill <name>          — حذف skill
/memory                   — نمایش حافظه‌ی بلندمدت فعلی
/todos                    — لیست یادآوری‌های در انتظار
/plan                     — نمایش برنامه‌ی فعال
/logs [تعداد] [status]    — لاگ اخیر فراخوانی ابزارها (status: ok/error/timeout)
/stats [ساعت]             — آمار فراخوانی ابزارها به‌تفکیک
```

هر پیام دیگه (بدون `/`) مستقیم به‌عنوان درخواست به ایجنت می‌ره.

### `/addskill` — ویزارد قدم‌به‌قدم

نسخه‌ی اول این پروژه `/addskill` رو در یک پیام واحد (نام+توضیح+متن) می‌خوند، ولی
تلگرام پیام‌های طولانی رو خودش قبل از رسیدن به webhook تیکه‌تیکه می‌کنه — یعنی هر
skill واقعی (چند کیلوبایتی) از همون ابتدا شکسته می‌شد. الان یک ویزارد stateful است:

1. `/addskill` رو بزن.
2. اسم skill رو بفرست.
3. توضیح کوتاه (کِی باید استفاده بشه) رو بفرست.
4. متن کامل دستورالعمل رو بفرست — می‌تونی توی **هر تعداد پیام جدا** بفرستی (به بدنه
   اضافه می‌شن)، یا مستقیم یک فایل `.md`/`.txt` آپلود کنی.
5. `/done` رو بزن تا ثبت بشه، یا `/cancel` برای لغو در هر مرحله.

---

## ۶) ابزارهای ایجنت

| ابزار | توضیح |
|---|---|
| `create_todo` / `list_todos` / `edit_todo` / `delete_todo` | یادآوری‌های زمان‌دار، چندتایی، مستقل از هم |
| `create_plan` / `complete_plan_item` | برنامه‌ی تک‌فعال با چند آیتم، فقط قابل اجرا (نه ویرایش) |
| `update_memory` / `search_memory` | حافظه‌ی بلندمدت + جستجوی معنایی در خلاصه‌های قدیمی (Vectorize) |
| `web_search` (Tavily) | جستجوی وب |
| `web_extract` (Firecrawl) | استخراج محتوای یک URL مشخص |
| `speak` | تبدیل متن به گفتار، مستقیم به کاربر با ترنسکریپت آکاردیونی |
| `find_images` | جستجوی عکس (Serper) + فیلتر با مدل چندوجهی + ارسال خودکار |
| `get_latest_youtube_video` | آخرین ویدیوی یک کانال یوتیوب |
| `view_skill` | بارگذاری متن کامل یک skill بر اساس نام |

### تودو در برابر برنامه
- **تودو**: چندتایی، هرکدوم با عنوان/توضیح/زمان مستقل، قابل ویرایش و حذف. سر زمانش،
  ایجنت با یک جفت پیام مصنوعی «assistant tool_call + tool result» بیدار می‌شه (نه یک
  پیام مستقیم به کاربر) و خودش تصمیم می‌گیره چی بگه.
- **برنامه**: فقط یکی در آنِ واحد، چند آیتم، فقط قابل اجراست (نه ویرایش/حذف). بعد از
  تکمیل آخرین آیتم خودکار بسته می‌شه. همیشه ته system prompt رندر می‌شه.

### `find_images` — جریان کاری دقیق
مدل بین ۱ تا ۳ کوئری جستجو + یک توضیح از چیزی که دنبالشه می‌ده → هر کوئری تا ۶ نتیجه
از Serper Images می‌گیره → همه‌ی کاندیدها (هرکدوم در یک user message جدا، همراه آیدی
خودش) به `gemini-3.5-flash-lite` می‌رن تا با structured output (`json_object`) بین
۰ تا ۱۰ تا رو انتخاب کنه → منتخب‌ها مستقیم (با URL، بدون دانلود/آپلود مجدد) به تلگرام
فرستاده می‌شن → فقط یک گزارش کوتاه (تعداد یافته/انتخاب‌شده) به مدل اصلی برمی‌گرده.

### بیدارباش خودکار (Proactive wake-up)
۴ اسلات ثابت به وقت تهران (`PROACTIVE_WAKE_SLOTS` در `config.js`: صبح ۸، ظهر ۱۳، عصر
۱۹، شب ۲۳). کرون هر ۵ دقیقه چک می‌کنه؛ هر اسلات دقیقاً یک‌بار در روز (با یک فلگ در
`kv_meta`) با همون الگوی «assistant tool_call + tool result» مصنوعی که برای تودو
داریم بیدار می‌شه و طبق تم اون بازه (شعر/حدیث/داستان صبح، خبر بر اساس علایق در
حافظه ظهر، و...) دنبال چیزی می‌گرده — طبق سیستم پرامپت، اگه چیز جالبی پیدا نکنه
می‌تونه از فرستادن پیام صرف‌نظر کنه. برای تغییر ساعت‌ها یا تم‌ها، `PROACTIVE_WAKE_SLOTS`
و `proactiveThemePrompt` در `agent/src/config.js` رو ویرایش کن.

### بافر آلبوم عکس/ویدیو (media_group_id)
تلگرام هر آیتم یک آلبوم رو یک webhook جدا می‌فرسته. با یک DO alarm (دبانس ۱.۵ ثانیه‌ای
در `agentDO.js`) همه‌ی آیتم‌های یک `media_group_id` جمع می‌شن و وقتی آلبوم دیگه رشد
نمی‌کنه، یک‌جا به‌عنوان یک turn واحد با همه‌ی عکس‌ها به ایجنت می‌رن.

---

## ۷) سیستم Timeout — رفع ریشه‌ای «قفل شدن / بی‌جوابی»

**ریشه‌ی مشکل:** فراخوانی‌های `web_search`/`web_extract` (Tavily/Firecrawl) در نسخه‌ی
اول هیچ timeout ای روی `fetch()` نداشتن. اگه upstream stall می‌کرد (نه خطای سریع، بلکه
سکوت)، `await` برای همیشه معلق می‌موند — بدون خطا، بدون لاگ — و کل turn روی همون پیام
«در حال جستجو...» یخ می‌زد. حالا سه لایه‌ی محافظتی وجود داره:

1. **هر فراخوانی شبکه‌ای هر ابزار** (`web.js`, `youtube.js`, `images.js`) یک
   `AbortSignal.timeout(...)` مخصوص خودش داره (`WEB_TOOL_TIMEOUT_MS` = ۲۵ ثانیه).
2. **یک wrapper عمومی** دور *هر* اجرای ابزاری در `tools/index.js` (`dispatchTool`) یک
   سقف زمانی کلی می‌ذاره (`timeoutForTool` در `config.js`، هرکدام مطابق پیچیدگی خودش
   تنظیم شده — از ۲۰ ثانیه برای یوتیوب تا ۲۱۰ ثانیه برای `find_images`)؛ اگه رد بشه،
   یک نتیجه‌ی خطا به مدل برمی‌گرده (می‌تونه واکنش نشون بده) **و** فوراً از طریق تلگرام
   به کاربر اطلاع داده می‌شه — این محافظت برای *هر* ابزار حال و آینده کار می‌کنه، نه
   فقط همین چندتا.
3. **تماس با AI router** (`UPSTREAM_TIMEOUT_MS`) و **تماس‌های تلگرام**
   (`TELEGRAM_API_TIMEOUT_MS`) هم مقدار مشخصی دارن.

علاوه بر این، `StatusPing` (پیام «در حال...») مقاوم شد — هیچ hiccup تلگرامی نمی‌تونه
turn رو بکشه — و ارسال پاسخ نهایی یک fallback داره (اگه تبدیل مارک‌داون شکست بخوره،
متن خام escape‌شده فرستاده می‌شه به‌جای سکوت کامل).

مقادیر timeout در `agent/src/config.js` (`WEB_TOOL_TIMEOUT_MS`, `TELEGRAM_API_TIMEOUT_MS`,
`TOOL_TIMEOUTS`, `UPSTREAM_TIMEOUT_MS`) قابل تنظیمن.

---

## ۸) سیستم لاگ ایجنت

هر فراخوانی ابزار (موفق/خطا/تایم‌اوت + latency) و شروع/پایان/خطای هر turn در جدول
`logs` داخل `AgentDO` ثبت می‌شه (حداکثر `MAX_LOG_ROWS` ردیف، خودکار prune می‌شه).
دسترسی از طریق:
```
/logs [تعداد] [status]   — مثال: /logs 20 error
/stats [ساعت]            — مثال: /stats 24
```

---

## ۹) تبدیل مارک‌داون به فرمت تلگرام

پاسخ نهایی ایجنت (که مدل به‌صورت مارک‌داون می‌نویسه) با `markdownToTelegramHtml` در
`telegram.js` به HTML subset تلگرام تبدیل می‌شه: `**bold**`، `*italic*`، `` `code` ``،
بلاک‌کد سه‌بک‌تیک، لینک `[متن](url)`، `#` به bold، `-` به `•`. این یک فایده‌ی جانبی
مهم هم داره: قبلاً اگه مدل `<`/`>` خام می‌نوشت، تلگرام اون رو تگ HTML ناقص می‌دید و
کل ارسال fail می‌شد بی‌صدا؛ الان همه‌چیز اول escape می‌شه.

splitter پیام‌های بلند هم tag-آگاهه — موقع بریدن، تگ‌های باز رو می‌بنده و توی چانک
بعدی دوباره باز می‌کنه، تا هیچ `<pre><code>` یا `<b>` وسط بریده نشه.

---

## ۱۰) TTS، رسانه، و دلایل فنی

### TTS
مسیر TTS از طریق روتر و مستقیم به endpoint بومی `generateContent` گوگل می‌ره (نه لایه‌ی
بتای OpenAI-compat) — جزئیات کامل در README خود روتر (بخش ۷). خروجی صدا مستقیم برای
کاربر می‌ره (`sendVoiceWithTranscript`)، فقط ترنسکریپت (نه بایت‌های صوت) وارد تاریخچه
می‌شه، و در تلگرام با `<blockquote expandable>` (آکاردیون رسمی Bot API 7.3+) نمایش
داده می‌شه.

### دانلود رسانه از تلگرام — رفع Stack Overflow
`downloadTelegramFile` عکس/فایل رو با `bytesToBase64` (پیاده‌سازی chunk-به-chunk، هر
بار ۸ کیلوبایت) تبدیل می‌کنه. نسخه‌ی اول از
`btoa(String.fromCharCode(...bytes))` استفاده می‌کرد که با آرایه‌های بزرگ (`...`
روی هزاران بایت) call stack رو پر می‌کرد و از حدود ۱۳۰ کیلوبایت به بالا
`RangeError: Maximum call stack size exceeded` می‌داد — یعنی عملاً روی هر عکس واقعی
تلگرام (که معمولاً ۲۰۰ کیلوبایت به بالاست) throw می‌کرد، و چون این خطا در یک
`catch {}` خالی خاموش می‌شد، عکس بی‌صدا از پیام حذف می‌شد.

### رسانه در تاریخچه — از طریق `file_id` تلگرام
به‌جای آپلود به Gemini Files API گوگل، فقط `file_id` تلگرام ذخیره می‌شه. هر بار
تاریخچه‌ی امروز/دیروز برای مدل فرستاده می‌شه، عکس‌ها از تلگرام دوباره گرفته و inline
(base64) ضمیمه می‌شن — همون ۲ روز حافظه رو بدون هیچ storage جداگانه می‌ده. **ویدیو
فعلاً rehydrate نمی‌شه** (فقط عکس) — چون در روتر هم هیچ مسیر content-part از نوع ویدیو
وایر نشده، فقط `image_url`.

---

## ۱۱) Rollover (خلاصه‌سازی روز سوم)

پیاده‌سازی «compounding»: هر بار که rollover اجرا می‌شه، **خلاصه‌ی جدید = خلاصه‌سازی
جامع (خلاصه‌ی قبلی + مکالمات تازه‌واردشده)**، با `model: auto` از طریق روتر. خلاصه‌ی
قبلی حذف نمی‌شه — یک ردیف جدید و جدا در Vectorize ذخیره می‌شه (برای `search_memory`
همیشه در دسترسه)، فقط اشاره‌گر «خلاصه‌ی فعلی که توی هر system prompt تزریق می‌شه» جلو
می‌ره. خلاصه هم‌زمان با `gemini-embedding-2` (۷۶۸ بعد) امبد می‌شه.

بعد از rollover، تاریخچه می‌شه: **امروز + دیروز + خلاصه‌ی فشرده‌ی همه‌چیز قبل‌تر**.

---

## ۱۲) چیزهایی که ساخته نشد (و چرا)

- **Freestyle Sandbox**: فرمت دقیق REST API (نه SDK) با اطمینان کافی برای تحویل کد
  کاربردی و درست تأیید نشد؛ ریسک تحویل کد ناقص بالا بود. اگه مستندات دقیق endpoint/auth
  رو تأیید کنی، در یک فاز جدا وصلش می‌کنیم.
- **deAPI (ساخت/ویرایش عکس و ویدیو)**: طبق تصمیم، چون مصرف کمی داشت، این فاز اضافه
  نشد.
- **ابزار YouTube API**: اضافه شد (بخش ۶ بالا).

---

## ۱۳) خلاصه‌ی secrets / vars

| نام | نوع | توضیح |
|---|---|---|
| `AI_ROUTER_BASE_URL` | var | آدرس worker روتر (بدون `/v1`) |
| `AI_ROUTER_PROXY_TOKEN` | secret | همون `PROXY_TOKEN` ورکر روتر |
| `TELEGRAM_BOT_TOKEN` | secret | توکن بات دوم (جدا از بات مدیریتی روتر) |
| `TELEGRAM_OWNER_CHAT_ID` | secret | فقط این چت پاسخ می‌گیره |
| `TELEGRAM_WEBHOOK_SECRET` | secret (اختیاری) | جلوگیری از جعل وبهوک |
| `TAVILY_API_KEY` | secret | جستجوی وب (`web_search`) |
| `FIRECRAWL_API_KEY` | secret | استخراج URL (`web_extract`) |
| `YOUTUBE_API_KEY` | secret | `get_latest_youtube_video` (رایگان، ۱۰,۰۰۰ واحد/روز) |
| `SERPER_API_KEY` | secret | `find_images` (۲۵۰۰ جستجوی رایگان یک‌باره) |

---

## ۱۴) صداقت درباره‌ی تست

منطق DO (تاریخچه، حافظه، تودو، برنامه، skillها، rollup، لاگ‌ها)، حلقه‌ی کامل ایجنت،
و کرون (بیدارشدن تودو + rollover + idempotency) با SQLite واقعی + شبیه‌سازی کامل
شبکه تست شدن. چیزهایی که نیاز به تأیید زنده دارن:
- فرمت دقیق پاسخ TTS بومی گوگل (`inlineData.data` / نرخ نمونه‌برداری واقعی).
- رفتار واقعی Vectorize روی اکانتت (محدودیت پلن رایگان).
- این فرض که لایه‌ی OpenAI-compat جمنای می‌تونه URL عکس خارجی (Serper) رو خودش fetch
  کنه برای `find_images` — رفتار استاندارد endpoint های vision سازگار با OpenAI است،
  ولی با یک تماس زنده در این محیط تأیید نشد. اگه غیرقابل‌اعتماد بود، راه‌حل محدود به
  حلقه‌ی ساخت `messages` در `tools/images.js` است (دانلود + base64 مثل رهیدریشن
  تاریخچه).