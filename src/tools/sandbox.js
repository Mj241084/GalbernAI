import { sendPhoto, sendDocument } from "../telegram.js";
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
          },
          sandbox_code: {
            type: "string",
            description: "کد سندباکسی که می‌خواهید فایل را از آن بخوانید (اختیاری - در صورت فرستاده نشدن، از سندباکس پیش‌فرض/اصلی خوانده می‌شود)"
          }
        },
        required: ["path"]
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

    default:
      throw new Error(`Unknown action in sandbox tool: ${name}`);
  }
}
