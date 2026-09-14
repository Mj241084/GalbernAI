import { freestyleReadFile } from "../freestyleClient.js";
import { bytesToBase64 } from "../util.js";
import { mimeFromExtension } from "./sandbox.js";

export const definitions = [{
  type: "function",
  function: {
    name: "look",
    description: "یک تصویر (نمودار، اسکرین‌شات و...) رو از داخل سندباکس بخون تا خودت مستقیماً ببینی و بررسی کنی. برخلاف get_sandbox_file، چیزی برای کاربر نمی‌فرسته.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "مسیر کامل فایل تصویر در سندباکس" },
        sandbox_code: { type: "string", description: "کد سندباکس (اختیاری - پیش‌فرض سندباکس اصلی)" },
      },
      required: ["path"],
    },
  },
}];

export async function execute(name, args, { env, stub }) {
  if (name !== "look") throw new Error(`unknown vision tool: ${name}`);
  const sandbox = args.sandbox_code ? await stub.getSandboxByCode(args.sandbox_code) : await stub.getMainSandbox();
  if (!sandbox) return { ok: false, error: "سندباکس پیدا نشد." };

  const resp = await freestyleReadFile(env, sandbox.vm_id, args.path);
  if (!resp.ok) {
    return { ok: false, error: resp.status === 404 ? `فایلی در «${args.path}» پیدا نشد.` : `خطای HTTP ${resp.status}` };
  }
  const mimeType = mimeFromExtension(args.path);
  if (!mimeType?.startsWith("image/")) return { ok: false, error: "فایل مشخص‌شده یک تصویر نیست." };

  const buf = await resp.arrayBuffer();
  const base64 = bytesToBase64(new Uint8Array(buf));
  const cacheKey = `sandbox:${sandbox.code}:${args.path}`;
  await stub.setCachedMedia(cacheKey, base64, mimeType);

  return { ok: true, path: args.path, __pendingImage: { cacheKey, mimeType } };
}
