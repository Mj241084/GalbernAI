import { WEB_TOOL_TIMEOUT_MS } from "../config.js";
import { sendOwnerAlert } from "../telegram.js";
import { safeReadText } from "../util.js";

export const definitions = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current information.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          max_results: { type: "integer", description: "Default 5." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_extract",
      description: "Fetch and extract the readable content (as markdown) of a specific URL, including URLs given directly by the user.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
];

// THIS FUNCTION USED TO HAVE NO TIMEOUT ON ITS fetch() CALL. If Tavily ever
// stalled instead of returning a fast error, this await would hang forever
// with no error and no log line - freezing the entire agent turn on the
// "🔎 در حال جستجو..." status message. This is the confirmed root cause of
// turns that never responded. Same fix applied to firecrawlExtract below.
async function tavilySearch(env, query, maxResults = 5) {
  let resp;
  try {
    resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: env.TAVILY_API_KEY, query, max_results: maxResults }),
      signal: AbortSignal.timeout(WEB_TOOL_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err && (err.name === "TimeoutError" || err.name === "AbortError");
    await sendOwnerAlert(
      env,
      `🚨 <b>Tavily ${timedOut ? "timeout خورد" : "خطای شبکه داد"}</b>\nquery: ${query}\n<code>${String(err.message || err).slice(0, 300)}</code>`
    );
    throw new Error(
      timedOut ? `Tavily search timed out after ${WEB_TOOL_TIMEOUT_MS / 1000}s` : `Tavily network error: ${err.message || err}`
    );
  }
  if (resp.status === 429) {
    await sendOwnerAlert(env, `🚨 <b>Tavily rate limit خورد</b>\nquery: ${query}`);
  }
  if (!resp.ok) {
    const text = await safeReadText(resp);
    throw new Error(`Tavily error HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  const json = await resp.json();
  return (json.results || []).map((r) => ({ title: r.title, url: r.url, content: r.content, score: r.score }));
}

async function firecrawlExtract(env, url) {
  let resp;
  try {
    resp = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.FIRECRAWL_API_KEY}`,
      },
      body: JSON.stringify({ url, formats: ["markdown"] }),
      signal: AbortSignal.timeout(WEB_TOOL_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err && (err.name === "TimeoutError" || err.name === "AbortError");
    await sendOwnerAlert(
      env,
      `🚨 <b>Firecrawl ${timedOut ? "timeout خورد" : "خطای شبکه داد"}</b>\nurl: ${url}\n<code>${String(err.message || err).slice(0, 300)}</code>`
    );
    throw new Error(
      timedOut ? `Firecrawl extract timed out after ${WEB_TOOL_TIMEOUT_MS / 1000}s` : `Firecrawl network error: ${err.message || err}`
    );
  }
  if (resp.status === 429) {
    await sendOwnerAlert(env, `🚨 <b>Firecrawl rate limit خورد</b>\nurl: ${url}`);
  }
  if (!resp.ok) {
    const text = await safeReadText(resp);
    throw new Error(`Firecrawl error HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  const json = await resp.json();
  return { url, title: json.data?.metadata?.title, markdown: json.data?.markdown };
}

export async function execute(name, args, { env }) {
  switch (name) {
    case "web_search": {
      const results = await tavilySearch(env, args.query, args.max_results);
      return { ok: true, results };
    }
    case "web_extract": {
      const result = await firecrawlExtract(env, args.url);
      return { ok: true, ...result };
    }
    default:
      throw new Error(`unknown web tool: ${name}`);
  }
}