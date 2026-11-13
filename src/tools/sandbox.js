import { sendPhoto, sendDocument, sendMediaGroup, sendRichMediaGallery } from "../telegram.js";
import { bytesToBase64 } from "../util.js";
import { freestyleReadFile, freestyleWriteFile, freestyleExec } from "../freestyleClient.js";

export const definitions = [
  {
    type: "function",
    function: {
      name: "run_code_sandbox",
      description: "کدهای برنامه‌نویسی (Python, Node.js, Bash) را در یک محیط لینوکس امن و کاملاً ایزوله (Sandbox) اجرا می‌کند و خروجی متنی (stdout/stderr) را برمی‌گرداند.",
      parameters: {
        type: "object",
        properties: {
          language: {
            type: "string",
            enum: ["python", "javascript", "bash"],
            description: "زبان برنامه‌نویسی برای اجرای کد"
          },
          code: {
            type: "string",
            description: "متن کامل کد یا دستوراتی که باید اجرا شوند"
          },
          sandbox_code: {
            type: "string",
            description: "کد یا شناسه‌ی سندباکس که می‌خواهید کد در آن اجرا شود (اختیاری - در صورت فرستاده نشدن، در سندباکس پیش‌فرض/اصلی اجرا می‌شود)"
          }
        },
        required: ["language", "code"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_sandbox_file",
      description:
        "یک فایل تکی را از داخل محیط سندباکس خوانده و مستقیماً برای کاربر در تلگرام ارسال می‌کند. " +
        "WHEN NOT TO USE: برای ارسال ۲ فایل یا بیشتر (مثلاً چند عکس یا چند خروجی) هرگز از این ابزار به‌صورت پشت‌سرهم استفاده نکن — به‌جایش از send_sandbox_files استفاده کن. همچنین برای دیدن تصویر توسط خودت، از look استفاده کن نه این ابزار.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "مسیر کامل فایل در سندباکس، مثلاً '/tmp/chart.png' یا '/tmp/report.xlsx'"
          },
          caption: {
            type: "string",
            description: "توضیح یا کپشنی که همراه فایل در تلگرام فرستاده می‌شود (اختیاری)"
          },
          send_as_photo: {
            type: "boolean",
            description: "اگر فایل یک عکس است، آن را به عنوان تصویر می‌فرستد. در غیر این صورت به عنوان سند (document) ارسال می‌شود."
          },
          sandbox_code: {
            type: "string",
            description: "کد سندباکسی که می‌خواهید فایل را از آن بخوانید (اختیاری - در صورت فرستاده نشدن، از سندباکس پیش‌فرض/اصلی خوانده می‌شود)"
          }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "send_sandbox_files",
      description:
        "چندین فایل را از محیط سندباکس می‌خواند و برای کاربر ارسال می‌کند. عکس‌ها تا ۲۰تایی به‌صورت اسلایدشو (یا کلاژ/آلبوم) و سایر فایل‌ها به‌صورت سند ارسال می‌شوند. " +
        "WHEN NOT TO USE: برای ارسال یک فایل تکی که نیاز به کپشن/کنترل تکی دارد از get_sandbox_file استفاده کن.",
      parameters: {
        type: "object",
        properties: {
          paths: {
            type: "array",
            items: { type: "string" },
            description: "آرایه‌ای از مسیرهای کامل فایل‌ها در سندباکس"
          },
          caption: {
            type: "string",
            description: "توضیح یا کپشنی که همراه گالری/آلبوم/فایل‌ها در تلگرام فرستاده می‌شود (اختیاری)"
          },
          display: {
            type: "string",
            enum: ["slideshow", "collage", "album"],
            description: "نحوه‌ی نمایش چند عکس: slideshow (اسلایدشو، پیش‌فرض برای ۲ عکس یا بیشتر)، collage (کلاژ/شبکه)، یا album (آلبوم کلاسیک ۱۰تایی تلگرام)"
          },
          sandbox_code: {
            type: "string",
            description: "کد سندباکس (اختیاری - پیش‌فرض: سندباکس اصلی)"
          }
        },
        required: ["paths"]
      }
    }
  }
];

export function mimeFromExtension(path) {
  const filename = path.split("/").pop() || "file.bin";
  const extension = filename.split(".").pop().toLowerCase();
  const mimeMap = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    doc: "application/msword",
    csv: "text/csv",
    txt: "text/plain",
    json: "application/json",
    zip: "application/zip",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    mp4: "video/mp4"
  };
  return mimeMap[extension] || "application/octet-stream";
}

async function resolveVmId(stub, sandboxCode) {
  const sandbox = sandboxCode ? await stub.getSandboxByCode(sandboxCode) : await stub.getMainSandbox();
  if (!sandbox) {
    throw new Error(sandboxCode ? `سندباکسی با کد «${sandboxCode}» پیدا نشد.` : "هیچ سندباکس اصلی/پیش‌فرضی ثبت نشده است.");
  }
  return sandbox.vm_id;
}

export async function execute(name, args, { env, stub, chatId }) {
  const apiKey = env.FREESTYLE_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "تنظیمات Freestyle (API Key) در ورکر ست نشده است." };
  }

  let vmId;
  try {
    vmId = await resolveVmId(stub, args.sandbox_code);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  switch (name) {
    case "run_code_sandbox": {
      try {
        let filename = "/tmp/app.py";
        let runCommand = `python3 ${filename}`;
        if (args.language === "javascript") {
          filename = "/tmp/app.js";
          runCommand = `node ${filename}`;
        } else if (args.language === "bash") {
          filename = "/tmp/script.sh";
          runCommand = `bash ${filename}`;
        }

        // ۱. آپلود کد روی دیسک ماشین مجازی از طریق کلاینت مشترک
        const encoder = new TextEncoder();
        await freestyleWriteFile(env, vmId, filename, encoder.encode(args.code));

        // ۲. اجرای دستور روی ماشین مجازی
        const execResult = await freestyleExec(env, vmId, runCommand);
        return {
          ok: true,
          stdout: execResult.stdout || "",
          stderr: execResult.stderr || "",
          exitCode: execResult.statusCode ?? 0
        };
      } catch (err) {
        return { ok: false, error: `خطا در فرآیند اجرای سندباکس: ${err.message || err}` };
      }
    }

    case "get_sandbox_file": {
      try {
        const filePath = args.path.startsWith("/") ? args.path : `/${args.path}`;
        
        // ۱. دریافت فایل
        const fileResp = await freestyleReadFile(env, vmId, filePath);
        if (!fileResp.ok) {
          if (fileResp.status === 404) {
            return { ok: false, error: `فایل مورد نظر در مسیر '${args.path}' پیدا نشد.` };
          }
          const errText = await fileResp.text().catch(() => "Unknown error");
          return { ok: false, error: `خطا در دریافت فایل از دیسک ماشین مجازی: ${errText}` };
        }

        const buf = await fileResp.arrayBuffer();
        if (buf.byteLength === 0) {
          return { ok: false, error: "فایل خالی است و حجم آن صفر بایت می‌باشد." };
        }

        const filename = filePath.split("/").pop() || "file.bin";
        const extension = filename.split(".").pop().toLowerCase();
        const mimeType = mimeFromExtension(filePath);

        // ۲. ارسال فایل به تلگرام کاربر
        let tgResult;
        if (args.send_as_photo && ["jpg", "jpeg", "png", "webp", "gif"].includes(extension)) {
          const base64 = bytesToBase64(new Uint8Array(buf));
          tgResult = await sendPhoto(env, chatId, {
            base64,
            mimeType,
            caption: args.caption || `فایل تصویری دریافت شده: ${filename}`
          });
        } else {
          tgResult = await sendDocument(env, chatId, {
            bytes: new Uint8Array(buf),
            mimeType,
            filename,
            caption: args.caption || `فایل دریافت شده از سندباکس: ${filename}`
          });
        }

        if (tgResult && tgResult.ok) {
          return { ok: true, message: `فایل '${filename}' با موفقیت دانلود شد و برای کاربر در تلگرام ارسال گردید.` };
        } else {
          return { ok: false, error: `دانلود فایل موفق بود اما ارسال آن به تلگرام با خطا مواجه شد. ${JSON.stringify(tgResult)}` };
        }

      } catch (err) {
        return { ok: false, error: `خطا در فرآیند دریافت فایل از سندباکس: ${err.message || err}` };
      }
    }

    case "send_sandbox_files": {
      try {
        const paths = args.paths;
        if (!Array.isArray(paths) || paths.length === 0) {
          return { ok: false, error: "پارامتر paths باید یک آرایه‌ی غیرخالی از مسیرها باشد." };
        }
        if (paths.length > 40) {
          return { ok: false, error: "تعداد مسیرها خیلی زیاده (حداکثر ۴۰ مورد مجازه)، لطفاً در چند فراخوانی بفرست." };
        }

        const photoPaths = [];
        const docPaths = [];
        for (const rawPath of paths) {
          const filePath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
          const filename = filePath.split("/").pop() || "file.bin";
          const ext = filename.split(".").pop().toLowerCase();
          if (["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) {
            photoPaths.push(rawPath);
          } else {
            docPaths.push(rawPath);
          }
        }

        const failed = [];
        let sentCount = 0;

        const readOne = async (rawPath) => {
          const filePath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
          try {
            const fileResp = await freestyleReadFile(env, vmId, filePath);
            if (!fileResp.ok) {
              return { error: `HTTP status ${fileResp.status}`, path: rawPath };
            }
            const buf = await fileResp.arrayBuffer();
            if (buf.byteLength === 0) {
              return { error: "فایل خالی است (۰ بایت)", path: rawPath };
            }
            const filename = filePath.split("/").pop() || "file.bin";
            const mimeType = mimeFromExtension(filePath);
            const bytes = new Uint8Array(buf);
            return { path: rawPath, bytes, filename, mimeType };
          } catch (err) {
            return { error: err.message || String(err), path: rawPath };
          }
        };

        const display = args.display || "slideshow";
        const photoBatchSize = display === "album" ? 10 : 20;

        // ارسال عکس‌ها در دسته‌های ۲۰تایی (Rich UI) یا ۱۰تایی (آلبوم کلاسیک)
        for (let i = 0; i < photoPaths.length; i += photoBatchSize) {
          const slice = photoPaths.slice(i, i + photoBatchSize);
          const loadedResults = await Promise.all(slice.map(readOne));
          const validPhotos = [];
          for (const item of loadedResults) {
            if (item.error) {
              failed.push({ path: item.path, error: item.error });
            } else {
              validPhotos.push(item);
            }
          }

          if (validPhotos.length === 1) {
            const only = validPhotos[0];
            const res = await sendPhoto(env, chatId, {
              base64: bytesToBase64(only.bytes),
              mimeType: only.mimeType,
              caption: (sentCount === 0 && args.caption) ? args.caption : undefined,
            });
            if (res && res.ok) {
              sentCount++;
            } else {
              failed.push({ path: only.path, error: `sendPhoto failed: ${JSON.stringify(res)}` });
            }
          } else if (validPhotos.length > 1) {
            if (display === "album") {
              const items = validPhotos.map((item, idx) => ({
                bytes: item.bytes,
                mimeType: item.mimeType,
                filename: item.filename,
                caption: (sentCount === 0 && idx === 0 && args.caption) ? args.caption : undefined,
              }));
              const res = await sendMediaGroup(env, chatId, items);
              if (res && res.ok) {
                sentCount += validPhotos.length;
              } else {
                validPhotos.forEach((item) => failed.push({ path: item.path, error: `sendMediaGroup failed: ${JSON.stringify(res)}` }));
              }
            } else {
              const mode = display === "collage" ? "collage" : "slideshow";
              const items = validPhotos.map((item) => ({
                bytes: item.bytes,
                mimeType: item.mimeType,
                filename: item.filename,
              }));
              const res = await sendRichMediaGallery(env, chatId, items, {
                mode,
                caption: (sentCount === 0 && args.caption) ? args.caption : undefined,
              });
              if (res && res.ok) {
                sentCount += validPhotos.length;
              } else {
                validPhotos.forEach((item) => failed.push({ path: item.path, error: `sendRichMediaGallery failed: ${JSON.stringify(res)}` }));
              }
            }
          }
        }

        // ارسال فایل‌های غیرعکس تک‌تک با خواندن و آزادسازی فوری
        for (const docPath of docPaths) {
          const item = await readOne(docPath);
          if (item.error) {
            failed.push({ path: item.path, error: item.error });
            continue;
          }
          const res = await sendDocument(env, chatId, {
            bytes: item.bytes,
            mimeType: item.mimeType,
            filename: item.filename,
            caption: args.caption && sentCount === 0 ? args.caption : undefined,
          });
          if (res && res.ok) {
            sentCount++;
          } else {
            failed.push({ path: item.path, error: `sendDocument failed: ${JSON.stringify(res)}` });
          }
        }

        if (sentCount === 0) {
          return { ok: false, sent: 0, failed };
        }
        return { ok: true, sent: sentCount, failed };

      } catch (err) {
        return { ok: false, error: `خطا در اجرای send_sandbox_files: ${err.message || err}` };
      }
    }

    default:
      throw new Error(`Unknown action in sandbox tool: ${name}`);
  }
}
