/**
 * pi-bridge — local HTTP protocol bridge between the Studio (browser) and
 * @earendil-works/pi-coding-agent (Node-only SDK).
 *
 * WHY: pi is a terminal harness; its SDK cannot run inside a browser tab.
 * The bridge exposes an OpenAI-compatible `/v1/chat/completions` endpoint,
 * so artai's BrowserIntentProvider — which already speaks that wire format —
 * routes every LLM capability (parse, designMotif, composeGraph,
 * refinePrompt) through pi unchanged. You get pi's full provider catalog
 * (anthropic / openai / google / openrouter / zai / …), subscription auth
 * (~/.pi/agent/auth.json via `pi /login`) and env-var API keys for free.
 *
 * Usage:
 *   npm run bridge            # starts on http://127.0.0.1:8787
 *   PORT=9000 npm run bridge  # custom port
 *
 * Studio config: preset "pi-node", BASE URL http://127.0.0.1:<port>/v1,
 * MODEL ID "<providerId>/<modelId>" (e.g. anthropic/claude-sonnet-4-5).
 * API KEY stays empty — auth lives with pi on this machine.
 */

import { createServer } from "node:http";

const DEFAULT_PORT = Number(process.env.PI_BRIDGE_PORT ?? 8787);

/** Extract plain text from a pi assistant message (string or content blocks). */
export function assistantText(message) {
  if (!message || message.role !== "assistant") return "";
  const c = message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("");
  }
  return "";
}

/** Flatten the [system?, user] chat wire payload into one pi prompt. */
export function flattenMessages(messages) {
  const parts = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const text = typeof m?.content === "string"
      ? m.content
      : Array.isArray(m?.content)
        ? m.content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("")
        : "";
    if (text.trim()) parts.push(text);
  }
  return parts.join("\n\n");
}

/** Map an OpenAI-style model string to a pi catalog model + optional thinking level. */
export function resolveModel(runtime, modelStr, log = () => {}) {
  if (!modelStr) return { error: "model is required (\"<providerId>/<modelId>\")" };
  let id = String(modelStr);
  let thinkingLevel;
  const colon = id.lastIndexOf(":");
  if (colon > 0 && /^(off|minimal|low|medium|high|xhigh|max)$/.test(id.slice(colon + 1))) {
    thinkingLevel = id.slice(colon + 1);
    id = id.slice(0, colon);
  }
  const slash = id.indexOf("/");
  if (slash < 1) {
    // bare id: search the whole catalog
    const hits = runtime.getModels().filter((m) => m.id === id);
    if (hits.length === 0)
      return { error: `model "${id}" not found in pi catalog (use provider/model form)` };
    return { model: hits[0], thinkingLevel };
  }
  const providerId = id.slice(0, slash);
  const modelId = id.slice(slash + 1);
  const model = runtime.getModel(providerId, modelId);
  if (!model)
    return { error: `model "${providerId}/${modelId}" not found in pi catalog` };
  return { model, thinkingLevel };
}

/**
 * Create the bridge request handler.
 * @param deps injected for testing:
 *   createAgentSession, ModelRuntime-like factory, or fully-faked sessionFactory
 */
export function createBridgeHandler(deps = {}) {
  const {
    // dynamic import of the pi SDK happens lazily so the file can be
    // type-checked/tested without the dependency being resolved eagerly
    loadPi = async () => import("@earendil-works/pi-coding-agent"),
    sessionFactory,           // async ({model, thinkingLevel}) => {prompt(text)=>…, messages}
    catalog,                  // optional pre-built ModelRuntime-like object
    configDir = process.env.PI_AGENT_DIR ?? undefined,
  } = deps;

  let cachedRuntime = null;
  async function getRuntime() {
    if (catalog) return catalog;
    if (cachedRuntime) return cachedRuntime;
    const { ModelRuntime } = await loadPi();
    cachedRuntime = await ModelRuntime.create({ agentDir: configDir });
    return cachedRuntime;
  }

  return async function handle(req, res) {
    const url = new URL(req.url, "http://local");
    res.setHeader("content-type", "application/json");

    try {
      if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
        const rt = await getRuntime().catch(() => null);
        const nModels = rt ? rt.getModels().length : 0;
        res.end(JSON.stringify({
          ok: true,
          service: "artai-pi-bridge",
          models: nModels,
          hint: "BASE URL = http://127.0.0.1:" + (req.socket?.localPort ?? DEFAULT_PORT) + "/v1 · MODEL ID = provider/model",
        }));
        return;
      }

      if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
        const chunks = [];
        for await (const ch of req) chunks.push(ch);
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: { message: "invalid JSON body" } }));
          return;
        }

        const runtime = await getRuntime();
        const pick = resolveModel(runtime, body.model);
        if (pick.error) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: { message: pick.error, type: "invalid_request_error" } }));
          return;
        }

        const promptText = flattenMessages(body.messages);
        if (!promptText.trim()) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: { message: "messages must contain non-empty user/system content" } }));
          return;
        }

        let session;
        if (sessionFactory) {
          session = await sessionFactory(pick);
        } else {
          const { createAgentSession, SessionManager } = await loadPi();
          const built = await createAgentSession({
            model: pick.model,
            ...(pick.thinkingLevel ? { thinkingLevel: pick.thinkingLevel } : {}),
            noTools: "all",
            sessionManager: SessionManager.inMemory(),
          });
          session = built.session;
        }

        await session.prompt(promptText);

        const msgs = session.messages ?? [];
        const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
        const content = assistantText(lastAssistant);
        if (!content.trim()) {
          res.statusCode = 502;
          res.end(JSON.stringify({
            error: {
              message: `pi session produced no assistant text (stopReason=${lastAssistant?.stopReason ?? "?"})`,
              type: "bridge_empty_reply",
            },
          }));
          return;
        }

        const u = lastAssistant?.usage ?? {};
        res.end(JSON.stringify({
          id: "chatcmpl-pi-" + Date.now(),
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{
            index: 0,
            message: { role: "assistant", content },
            finish_reason: lastAssistant?.stopReason === "aborted" ? "abort" : "stop",
          }],
          usage: {
            prompt_tokens: u.input ?? 0,
            completion_tokens: u.output ?? 0,
            total_tokens: (u.input ?? 0) + (u.output ?? 0),
          },
        }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${url.pathname}` } }));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({
        error: { message: String(err?.stack ?? err).slice(0, 600), type: "bridge_internal" },
      }));
    }
  };
}

export function startBridge(deps, port = DEFAULT_PORT) {
  const handler = createBridgeHandler(deps);
  const server = createServer(handler);
  server.listen(port, "127.0.0.1", () => {
    console.log(`[pi-bridge] http://127.0.0.1:${port}/v1  (Studio preset: pi-node)`);
  });
  return server;
}

// direct run: node apps/pi-bridge/server.mjs [--port N]
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const argvPort = process.argv.includes("--port")
    ? Number(process.argv[process.argv.indexOf("--port") + 1])
    : DEFAULT_PORT;
  startBridge({}, argvPort);
}
