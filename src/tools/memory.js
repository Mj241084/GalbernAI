import { EMBEDDING_DIMENSIONS } from "../config.js";
import { callEmbeddings } from "../aiRouter.js";

export const definitions = [
  {
    type: "function",
    function: {
      name: "update_memory",
      description:
        "Overwrite your long-term profile of the user (who they are, job, preferences, ongoing situations) - this is always shown to you in full on every turn. Send the COMPLETE updated profile text, not just what changed.",
      parameters: {
        type: "object",
        properties: { content: { type: "string", description: "The full, updated profile text." } },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_memory",
      description:
        "Search your compressed long-term memory of older conversations (anything older than what's in your current visible history) by meaning, not just keywords.",
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
          covers_from_day: rollup ? rollup.covers_from_day : m.metadata?.covers_from_day,
          covers_to_day: rollup ? rollup.covers_to_day : m.metadata?.covers_to_day,
          summary: rollup ? rollup.summary : (m.metadata?.summary || null),
        };
      });

      return { ok: true, matches: enrichedMatches };
    }
    default:
      throw new Error(`unknown memory tool: ${name}`);
  }
}
