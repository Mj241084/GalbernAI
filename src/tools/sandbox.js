import { sendPhoto, sendDocument } from "../telegram.js";
import { bytesToBase64 } from "../util.js";

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
      description: "یک فایل را از داخل محیط سندباکس خوانده و آن را مستقیماً برای کاربر در تلگرام ارسال می‌کند یا محتوای آن را برمی‌گرداند.",
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
          }
        },
        required: ["path"]
      }
    }
  }
];

export async function execute(name, args, { env, chatId }) {
  const apiKey = env.FREESTYLE_API_KEY;
  const vmId = env.FREESTYLE_VM_ID;

  if (!apiKey || !vmId) {
    return { ok: false, error: "تنظیمات Freestyle (API Key یا VM ID) در ورکر ست نشده است." };
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

        // ۱. آپلود کد روی دیسک ماشین مجازی از طریق API v5
        const writeResp = await fetch(`https://beta-api.freestyle.sh/v5/vms/${vmId}/fs/write?path=${encodeURIComponent(filename)}`, {
          method: "PUT",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/octet-stream"
          },
          body: args.code
        });

        if (!writeResp.ok) {
          const errText = await writeResp.text().catch(() => "Unknown error");
          return { ok: false, error: `خطا در انتقال کد به دیسک ماشین مجازی: ${errText}` };
        }

        // ۲. اجرای دستور روی ماشین مجازی از طریق API v5
        const execResp = await fetch(`https://beta-api.freestyle.sh/v5/vms/${vmId}/exec-await`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            command: runCommand
          })
        });

        if (!execResp.ok) {
          const errText = await execResp.text().catch(() => "Unknown error");
          return { ok: false, error: `خطا در اجرای کد در محیط ماشین مجازی: ${errText}` };
        }

        const result = await execResp.json();
        return {
          ok: true,
          stdout: result.stdout || "",
          stderr: result.stderr || "",
          exitCode: result.statusCode ?? 0
        };
      } catch (err) {
        return { ok: false, error: `خطا در فرآیند اجرای سندباکس: ${err.message || err}` };
      }
    }

    case "get_sandbox_file": {
      try {
        const filePath = args.path.startsWith("/") ? args.path : `/${args.path}`;
        
        // ۱. دریافت فایل از API فایل‌سیستم v5
        const fileResp = await fetch(`https://beta-api.freestyle.sh/v5/vms/${vmId}/fs/read?path=${encodeURIComponent(filePath)}`, {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${apiKey}`
          }
        });

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

        const base64 = bytesToBase64(new Uint8Array(buf));
        const filename = filePath.split("/").pop() || "file.bin";
        const extension = filename.split(".").pop().toLowerCase();

        // ۲. تشخیص MIME Type بر اساس پسوند
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
        const mimeType = mimeMap[extension] || "application/octet-stream";

        // ۳. ارسال فایل به تلگرام کاربر
        let tgResult;
        if (args.send_as_photo && ["jpg", "jpeg", "png", "webp", "gif"].includes(extension)) {
          tgResult = await sendPhoto(env, chatId, {
            base64,
            mimeType,
            caption: args.caption || `فایل تصویری دریافت شده: ${filename}`
          });
        } else {
          tgResult = await sendDocument(env, chatId, {
            base64,
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

    default:
      throw new Error(`Unknown action in sandbox tool: ${name}`);
  }
}
