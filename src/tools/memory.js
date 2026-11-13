import { EMBEDDING_DIMENSIONS } from "../config.js";
import { callEmbeddings } from "../aiRouter.js";

const PATCH_OP_SCHEMA = {
  type: "object",
  description:
    "یک عملیات ویرایش جزئی: یا { old_text, new_text } برای جایگزینی دقیقِ متن یکتا، یا { start_line, end_line, expected_first_line, new_text } برای ویرایش بر اساس شماره خط.",
  properties: {
    old_text: { type: "string", description: "متن دقیق و یکتای فعلی (بدون پیشوند 'N | '). برای حذف، new_text را خالی بفرست." },
    new_text: { type: "string", description: "متن جایگزین (بدون پیشوند 'N | '). برای حذف، رشته خالی \"\" بفرست." },
    start_line: { type: "integer", description: "شماره خط شروع (۱-مبنا، از روی <user_profile>)." },
    end_line: { type: "integer", description: "شماره خط پایان (اختیاری؛ پیش‌فرض برابر با start_line)." },
    expected_first_line: { type: "string", description: "متن مورد انتظار در خط start_line برای جلوگیری از خطای جابه‌جایی خط (الزامی در حالت خطی)." },
  },
};

export const definitions = [
  {
    type: "function",
    function: {
      name: "patch_memory",
      description:
        "ویرایش دقیق و جزئی پروفایل حافظه‌ی بلندمدت کاربر (<user_profile>) با عملیات patch (جایگزینی یکتا یا بازه‌ی خطی). " +
        "برای افزودن، اصلاح یا حذف چند خط همیشه این را به update_memory ترجیح بده. هرگز پیشوندهای نمایشی 'N | ' را داخل پچ نفرست.",
      parameters: {
        type: "object",
        properties: {
          edits: {
            type: "array",
            items: PATCH_OP_SCHEMA,
            description: "آرایه‌ای از عملیات پچ که به‌صورت اتمیک و به ترتیب اعمال می‌شوند.",
          },
        },
        required: ["edits"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_memory",
      description:
        "بازنویسی کامل پروفایل حافظه‌ی بلندمدت کاربر (who they are, job, preferences, ongoing situations). " +
        "فقط برای ساخت اولیه (وقتی پروفایل خالی است) یا بازآرایی کلی کل پروفایل استفاده کن؛ برای تغییرات روزمره و جزئی از patch_memory استفاده کن.",
      parameters: {
        type: "object",
        properties: { content: { type: "string", description: "The full, updated profile text (without line-number prefixes)." } },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_memory",
      description:
        "Search your compressed long-term memory of older conversations (anything older than what's in your current visible history) by meaning, not just keywords. " +
        "Check notes (search_notes) and <older_rollup> first before calling this.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          top_k: { type: "integer", description: "How many results to return (default 3)." },
        },
        required: ["query"],
      },
    },
  },
];

export async function execute(name, args, { stub, env }) {
  switch (name) {
    case "patch_memory": {
      return await stub.patchMemoryProfile(args.edits);
    }
    case "update_memory": {
      await stub.setMemoryProfile(args.content);
      return { ok: true };
    }
    case "search_memory": {
      if (!env.MEMORY_INDEX) {
        return { ok: false, error: "Vectorize binding (MEMORY_INDEX) is not configured on this worker yet." };
      }
      const [vector] = await callEmbeddings(env, args.query, EMBEDDING_DIMENSIONS);
      const topK = Number.isFinite(args.top_k) ? args.top_k : 3;
      const result = await env.MEMORY_INDEX.query(vector, { topK, returnMetadata: "all" });

      const matches = result.matches || [];
      if (matches.length === 0) {
        return { ok: true, matches: [] };
      }

      // Collect IDs for bulk lookup in SQLite
      const rollupIds = [];
      const vectorIds = [];
      for (const m of matches) {
        if (m.metadata?.rollup_id) {
          rollupIds.push(m.metadata.rollup_id);
        } else if (m.id) {
          vectorIds.push(m.id);
        }
      }

      // 1 single query for rollup_id lookups
      const rollupsById = rollupIds.length ? await stub.getRollupsByIds(rollupIds) : [];
      // 1 single query for vector_id fallback lookups
      const rollupsByVectorId = vectorIds.length ? await stub.getRollupsByVectorIds(vectorIds) : [];

      const rollupMap = new Map();
      for (const r of rollupsById) rollupMap.set(`id:${r.id}`, r);
      for (const r of rollupsByVectorId) rollupMap.set(`vec:${r.vector_id}`, r);

      const enrichedMatches = matches.map((m) => {
        let rollup = null;
        if (m.metadata?.rollup_id) {
          rollup = rollupMap.get(`id:${m.metadata.rollup_id}`);
        }
        if (!rollup && m.id) {
          rollup = rollupMap.get(`vec:${m.id}`);
        }

        return {
          score: m.score,
          covers_from_day: m.metadata?.covers_from_day || rollup?.covers_from_day,
          covers_to_day: m.metadata?.covers_to_day || rollup?.covers_to_day,
          summary: rollup?.window_summary || m.metadata?.window_summary || rollup?.summary || m.metadata?.summary || null,
        };
      });

      return { ok: true, matches: enrichedMatches };
    }
    default:
      throw new Error(`unknown memory tool: ${name}`);
  }
}
