# دستیار شخصی (Cloudflare Worker + Telegram) — نسخه ۲

یک ایجنت شخصی مجزا، روی یک Worker و یک بات تلگرام کاملاً جدا از `gemini-hermes-router`.
تمام تماس‌های هوش مصنوعی (چت، TTS، embedding) از طریق همون Worker روتر می‌ره — این
پروژه هیچ کلید Gemini/OpenRouter‌ای مدیریت نمی‌کنه.

---

## ۱) معماری

```
Telegram (بات دوم، جدا) ──▶ این Worker
                              │
                              ├─▶ Durable Object (SQLite): تاریخچه، حافظه، تودو،
                              │    برنامه (پین‌شده)، یادداشت‌ها (دفترچه ایجنت + تگ)، skillها،
                              │    خلاصه‌های rollup، لاگ ابزارها، بافر آلبوم عکس/ویدیو، وضعیت ویزارد اسکیل
                              ├─▶ gemini-hermes-router (/v1/chat/completions ،
                              │    /v1/embeddings) — همه‌ی تماس‌های AI از اینجا
                              ├─▶ Vectorize (MEMORY_INDEX) — جستجوی معنایی خاطرات قدیمی
                              ├─▶ Tavily (جستجوی وب) / Firecrawl (استخراج URL)
                              ├─▶ Freestyle Sandbox (اجرای کد، جستجوی عکس با imgsearch.py، ارسال فایل)
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
cd GalbernAI
pnpm install
npx wrangler login

# base URL همون worker روتر (بدون /v1 در انتها - config.js خودش /v1/... اضافه می‌کنه)
# این خط رو توی wrangler.toml ویرایش کن:
#   AI_ROUTER_BASE_URL = "https://gemini-hermes-router.<your-subdomain>.workers.dev"

npx wrangler secret put AI_ROUTER_PROXY_TOKEN   # همون PROXY_TOKEN ورکر روتر
npx wrangler secret put FREESTYLE_API_KEY       # کلید API پلتفرم Freestyle.sh
npx wrangler secret put TELEGRAM_BOT_TOKEN      # توکن بات دوم (جدا از بات روتر)
npx wrangler secret put TELEGRAM_OWNER_CHAT_ID
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET # اختیاری ولی پیشنهادشده
npx wrangler secret put TAVILY_API_KEY
npx wrangler secret put FIRECRAWL_API_KEY
npx wrangler secret put SERPER_API_KEY          # ۲۵۰۰ جستجوی رایگان یک‌باره

npx wrangler deploy

# بعد از دیپلوی موفق:
# ۱. آماده‌سازی اسکریپت‌ها و کلیدهای سندباکس: /provisionsandbox
# ۲. نصب skillهای داخلی سیستم: /seedskills
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

---

## ۵) دستورات بات

```
/help                     — راهنمای دستورات (فرمت کامل HTML و بدون خطای تگ)
/skills                   — لیست skillهای ثبت‌شده
/addskill                 — ساخت skill جدید، قدم‌به‌قدم
/cancel                   — لغو ساخت skill نیمه‌کاره
/delskill <name>          — حذف skill
/wakeups                  — لیست زمان‌بندی بیدارباش‌های خودکار
/addwakeup HH:MM <موضوع> — افزودن بیدارباش جدید
/delwakeup <id>           — حذف زمان بیدارباش
/unlock                   — آزادسازی قفل نوبت ایجنت
/memory                   — نمایش حافظه‌ی بلندمدت فعلی
/todos                    — لیست یادآوری‌های در انتظار
/plan                     — انتشار/ارسال دوباره‌ی برنامه‌ی فعال پین‌شده
/notes [صفحه]             — لیست پیج‌بندی‌شده‌ی یادداشت‌ها
/sandboxes                — لیست همه سندباکس‌های ثبت‌شده
/addsandbox <code> <vm_id> [توضیح...] — ثبت سندباکس جدید
/setmainsandbox <code>    — تعیین سندباکس اصلی
/delsandbox <code>        — حذف سندباکس
/enablesandbox <code>     — فعال‌سازی سندباکس
/disablesandbox <code>    — غیرفعال‌سازی سندباکس
/provisionsandbox [code]  — تنظیم اسکریپت‌ها و کلیدهای مورد نیاز در سندباکس
/seedskills               — نصب/به‌روزرسانی skillهای داخلی سیستم
/model                    — انتخاب زنده مدل چت از روتر
/logs [تعداد] [status]    — لاگ اخیر فراخوانی ابزارها (status: ok/error/timeout)
/stats [ساعت]             — آمار فراخوانی ابزارها به‌تفکیک
```

هر پیام دیگه (بدون `/`) مستقیم به‌عنوان درخواست به ایجنت می‌ره.

---

## ۶) ابزارهای ایجنت

| ابزار | توضیح |
|---|---|
| `create_todo` / `list_todos` / `edit_todo` / `delete_todo` | یادآوری‌های زمان‌دار، چندتایی، مستقل از هم |
| `create_plan` / `complete_plan_item` | برنامه‌ی تک‌فعال، انتشار خودکار به‌صورت پیام پین‌شده، ویرایش زنده با پیشرفت و آنپین شدن در انتها |
| `create_note` / `append_note` / `edit_note` / `delete_note` / `list_notes` / `search_notes` / `get_note` | دفترچه‌ی کاری خودِ ایجنت با پشتیبانی از تگ‌ها (مثلاً `project:foo, type:test`) و آپند لاگ تست‌ها |
| `update_memory` / `search_memory` | حافظه‌ی بلندمدت کاربر + جستجوی معنایی در خلاصه‌های قدیمی (Vectorize) |
| `web_search` (Tavily) | جستجوی وب |
| `web_extract` (Firecrawl) | استخراج محتوای یک URL مشخص |
| `speak` | تبدیل متن به گفتار، مستقیم به کاربر با ترنسکریپت آکاردیونی |
| `send_sandbox_files` | ارسال فایل‌ها از سندباکس (عکس‌ها در دسته‌های ۱۰ تایی به‌صورت آلبوم با `sendMediaGroup` و بقیه به‌صورت document) |
| `view_skill` | بارگذاری متن کامل یک skill بر اساس نام |
| `run_code_sandbox` | اجرای کدهای برنامه‌نویسی در لینوکس ایزوله Freestyle |
| `get_sandbox_file` | دریافت یک فایل تکی از دیسک ماشین مجازی و ارسال به تلگرام |
| `look` | مشاهده و تحلیل مستقیم یک تصویر موجود در سندباکس توسط خود مدل چندوجهی |

---

## ۷) برنامه‌ی پین‌شده در تلگرام

به محض فراخوانی `create_plan`:
1. یک پیام شکیل شامل عنوان، نوار پیشرفت (`▰▰▱▱▱▱▱▱▱▱`) و لیست گام‌ها در تلگرام ارسال و **پین** می‌گردد.
2. شناسه‌ی پیام در دیتابیس SQL ذخیره می‌شود.
3. با هر `complete_plan_item` همان پیام پین‌شده ویرایش می‌گردد (پیام جدید اسپم نمی‌شود).
4. با تکمیل آخرین آیتم، عنوان به «🎉 برنامه تکمیل شد» تغییر یافته و پیام **آنپین** می‌شود.
5. در صورتی که کاربر پیام پین‌شده را پاک کند، سیستم به‌طور خودکار پیام جدید ساخته و مجدداً پین می‌کند.

---

## ۸) پشتیبانی از پیام صوتی (Voice)

وقتی کاربر پیام صوتی (Voice)، فایل صوتی (Audio) یا ویدیو کامنت (Video Note) ارسال می‌کند:
1. هیچ بایت صوتی وارد دیتابیس تاریخچه نمی‌گردد.
2. ایجنت با مدل `fast` روی روتر و دستورالعمل اختصاصی، صوت را به متن (Transcript) تبدیل می‌کند.
3. متن تبدیل‌شده با پیشوند `🎤 [پیام صوتی کاربر، متن استخراج‌شده]: ...` در تاریخچه ثبت و پردازش می‌شود.
4. کلیه فرایندهای بعدی (Rollup، Embedding و جستجوی حافظه) بدون هیچ تغییری کار می‌کنند.

---

## ۹) جستجوی عکس از طریق سندباکس (انتقال از Worker به سندباکس)

ابزار قدیمی `find_images` حذف شده است. دلیل: دانلود تا ۱۸ عکس در حافظه Worker باعث سنگینی و Timeout و خطاهای ۴۰۰ در لایه بومی می‌شد.

**طراحی جدید:**
1. اسکریپت پایتون `/home/ubuntu/tools/imgsearch.py` در سندباکس مستقر می‌شود.
2. جستجو در Serper، دانلود موازی ۸ تایی تصاویر، و فیلترینگ دسته‌ای چندوجهی با مدل `fast` روی روتر کاملاً داخل سندباکس صورت می‌گیرد.
3. عکس‌های فیلترشده در سندباکس ذخیره شده و خروجی فشرده JSON روی stdout برمی‌گردد.
4. ایجنت با skill داخلی `image-search` و ابزار `send_sandbox_files` عکس‌ها را در دسته‌های ۱۰تایی به‌صورت آلبوم برای کاربر ارسال می‌کند.

---

## ۱۰) بیدارباش خودکار (Proactive wake-up)

منطق بیدارباش بر اساس جدول `wake_schedule` پیاده‌سازی شده است. دستورالعمل عمومی پاسخ‌دهی بیدارباش `PROACTIVE_GUIDELINES` اصلاح گردید تا ایجنت کوتاه‌تر، مستقیم‌تر و بدون اسپم تکراری پیام بفرستد یا در صورت عدم وجود مطلب جدید سکوت کند.

---

## ۱۱) بافر آلبوم عکس/ویدیو (media_group_id)

تلگرام هر آیتم یک آلبوم را در یک webhook جدا می‌فرستد. با یک DO alarm (دبانس ۱.۵ ثانیه‌ای در `agentDO.js`) همه‌ی آیتم‌های یک `media_group_id` جمع می‌شن و وقتی آلبوم دیگه رشد نمی‌کنه، یک‌جا به‌عنوان یک turn واحد با همه‌ی عکس‌ها به ایجنت می‌رن.

---

## ۱۲) سیستم Timeout و Logging

همه ابزارها و فراخوانی‌های شبکه‌ای دارای `AbortSignal.timeout` و لایه‌ی محافظتی `withTimeout` هستند. تمام فراخوانی‌ها در جدول `logs` ذخیره شده و با `/logs` و `/stats` قابل مشاهده است.

---

## ۱۳) خلاصه‌ی secrets / vars

| نام | نوع | توضیح |
|---|---|---|
| `AI_ROUTER_BASE_URL` | var | آدرس worker روتر (بدون `/v1`) |
| `AI_ROUTER_PROXY_TOKEN` | secret | همون `PROXY_TOKEN` ورکر روتر |
| `FREESTYLE_API_KEY` | secret | کلید احراز هویت API پلتفرم Freestyle.sh |
| `TELEGRAM_BOT_TOKEN` | secret | توکن بات دوم (جدا از بات مدیریتی روتر) |
| `TELEGRAM_OWNER_CHAT_ID` | secret | فقط این چت پاسخ می‌گیره |
| `TELEGRAM_WEBHOOK_SECRET` | secret (اختیاری) | جلوگیری از جعل وبهوک |
| `TAVILY_API_KEY` | secret | جستجوی وب (`web_search`) |
| `FIRECRAWL_API_KEY` | secret | استخراج URL (`web_extract`) |
| `SERPER_API_KEY` | secret | جستجوی عکس در سندباکس |

---

## ۱۴) وضعیت تست‌ها

پروژه دارای مجموعه تست‌های واحد خودکار با `node:sqlite` روی محیط Node / WSL است (`pnpm test`):
- تست کامل Migration دیتابیس قدیمی به جدید (افزودن ستون‌های `telegram_message_id` و `tags`) و حفظ کامل داده‌ها.
- تست چرخه حیات کامل برنامه‌های پین‌شده و رندر HTML و Truncate.
- تست ابزار دفترچه یادداشت، تگ‌گذاری، `append_note` و فیلترها.
- تست توابع خالص تبدیل مارک‌داون به HTML تلگرام و split عاری از شکاف تگ‌ها.
- ۳۴ تست از ۳۴ تست با موفقیت پاس می‌شوند (`Passed: 34/34`).
