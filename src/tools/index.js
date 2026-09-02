import * as todos from "./todos.js";
import * as plan from "./plan.js";
import * as memory from "./memory.js";
import * as web from "./web.js";
import * as tts from "./tts.js";
import * as skills from "./skills.js";
import * as youtube from "./youtube.js";
import * as images from "./images.js";
import * as notes from "./notes.js";
import { timeoutForTool } from "../config.js";
import { withTimeout } from "../util.js";
import { sendOwnerAlert } from "../telegram.js";

const MODULES = [todos, plan, memory, web, tts, skills, youtube, images, notes];

export function allToolDefinitions() {
  return MODULES.flatMap((m) => m.definitions);
}

const NAME_TO_MODULE = new Map();
for (const m of MODULES) {
  for (const def of m.definitions) {
    NAME_TO_MODULE.set(def.function.name, m);
  }
}

export function isKnownTool(name) {
  return NAME_TO_MODULE.has(name);
}

// Fire-and-forget log write. Uses ctx.waitUntil (present on both a normal
// Worker ExecutionContext AND a DurableObjectState) so the write survives
// even though we never await it here - logging must never add latency to
// the tool call itself, and must never be able to break it either.
function logToolEvent(context, entry) {
  if (!context || !context.stub) return;
  try {
    const p = context.stub.appendLog(entry);
    const settled = p && typeof p.catch === "function" ? p.catch(() => {}) : Promise.resolve();
    if (context.ctx && typeof context.ctx.waitUntil === "function") {
      context.ctx.waitUntil(settled);
    }
  } catch {
    // logging must never break the tool call path
  }
}

/**
 * Every tool call in the app goes through here, which wraps the actual
 * execution in a hard timeout (see config.js's timeoutForTool) AND records
 * an entry in the agent's own log table (see agentDO.js's appendLog).
 *
 * This is the fix for the confirmed root cause of turns that got stuck
 * forever: Tavily/Firecrawl fetch() calls originally had no timeout at
 * all, so a stalled upstream API meant the `await` never resolved and
 * never rejected - no error, no log line, just a frozen turn sitting on
 * whatever status message happened to be showing ("🔎 در حال جستجو...").
 * Individual tools now carry their OWN internal timeouts too (see
 * web.js, youtube.js, images.js), but this wrapper is the guarantee that
 * NO current or future tool - including one that forgets its own
 * timeout - can hang the agent loop indefinitely. If withTimeout's race
 * is lost, the underlying promise may keep running in the background
 * (JS can't force-cancel it), but its eventual result is simply ignored -
 * the loop already moved on with an error result the model can react to.
 */
export async function dispatchTool(name, args, context) {
  const startedAt = Date.now();
  const mod = NAME_TO_MODULE.get(name);

  if (!mod) {
    const err = new Error(`Unknown tool: ${name}`);
    logToolEvent(context, { kind: "tool_call", toolName: name, status: "error", detail: err.message, latencyMs: 0 });
    throw err;
  }

  const timeoutMs = timeoutForTool(name);
  const timeoutMessage = `ابزار "${name}" بیش از ${Math.round(timeoutMs / 1000)} ثانیه طول کشید و لغو شد.`;

  try {
    const result = await withTimeout(mod.execute(name, args, context), timeoutMs, timeoutMessage);
    logToolEvent(context, {
      kind: "tool_call",
      toolName: name,
      status: "ok",
      detail: null,
      latencyMs: Date.now() - startedAt,
    });
    return result;
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const isTimeout = err && err.message === timeoutMessage;
    logToolEvent(context, {
      kind: "tool_call",
      toolName: name,
      status: isTimeout ? "timeout" : "error",
      detail: String(err.message || err).slice(0, 500),
      latencyMs,
    });
    if (isTimeout && context && context.env) {
      sendOwnerAlert(
        context.env,
        `🚨 <b>ابزار "${name}" تایم‌اوت خورد</b>\nبعد از ${Math.round(latencyMs / 1000)} ثانیه بدون پاسخ متوقف شد - به مدل یک خطا برگردونده شد تا بتونه ادامه بده.`
      ).catch(() => {});
    }
    throw err;
  }
}