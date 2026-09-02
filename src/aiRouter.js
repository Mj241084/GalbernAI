import { routerChatUrl, routerEmbeddingsUrl, UPSTREAM_TIMEOUT_MS } from "./config.js";
import { safeReadText } from "./util.js";

export async function callChatCompletions(env, body) {
  const resp = await env.HERMES_ROUTER.fetch(routerChatUrl(env), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.AI_ROUTER_PROXY_TOKEN}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await safeReadText(resp);
    const err = new Error(`AI router chat/completions failed: HTTP ${resp.status}: ${text.slice(0, 500)}`);
    err.status = resp.status;
    err.body = text;
    throw err;
  }
  return resp.json();
}

export async function callEmbeddings(env, input, dimensions) {
  const resp = await env.HERMES_ROUTER.fetch(routerEmbeddingsUrl(env), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.AI_ROUTER_PROXY_TOKEN}`,
    },
    body: JSON.stringify({ model: "auto", input, dimensions }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await safeReadText(resp);
    const err = new Error(`AI router embeddings failed: HTTP ${resp.status}: ${text.slice(0, 500)}`);
    err.status = resp.status;
    err.body = text;
    throw err;
  }
  const json = await resp.json();
  return json.data.map((d) => d.embedding);
}
