/**
 * pi-bridge tests — node:test with a fully faked pi runtime, so no real
 * credentials are needed. Run: node --test apps/pi-bridge/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBridgeHandler, resolveModel, flattenMessages, assistantText } from "./server.mjs";

function fakeModel(id, providerId) {
  return { id, providerId, api: "anthropic-messages", reasoning: true };
}

const CATALOG = [
  fakeModel("claude-sonnet-4-5", "anthropic"),
  fakeModel("glm-5.3", "zai"),
];

function makeRuntime() {
  return {
    getModels: () => CATALOG,
    getModel: (p, id) => CATALOG.find((m) => m.providerId === p && m.id === id) ?? null,
  };
}

/** session stub: prompt() appends an assistant reply to messages */
function stubSession(replyText, stopReason = "stop") {
  return {
    messages: [],
    async prompt(text) {
      if (!text || !text.trim()) throw new Error("empty prompt rejected");
      this.messages.push({ role: "user", content: text });
      this.messages.push({
        role: "assistant",
        content: Array.isArray(replyText)
          ? replyText.map((t) => ({ type: "text", text: t }))
          : replyText,
        stopReason,
        usage: { input: 120, output: 45 },
      });
    },
  };
}

async function call(handler, method, path, body) {
  let resBody = "";
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = new (class extends EventTarget {})();
  const res = {
    headers: {}, statusCode: 200, socket: { localPort: 8787 },
    setHeader(k, v) { this.headers[k] = v; },
    end(b) { resBody += b ?? ""; },
  };
  // minimal async-iterable request stub
  req[Symbol.asyncIterator] = async function* () { for (const c of chunks) yield c; };
  await handler({ method, url: path, ...req }, res);
  return { status: res.statusCode, json: JSON.parse(resBody || "{}") };
}

test("health reports the catalog size and a BASE URL hint", async () => {
  const handler = createBridgeHandler({
    loadPi: async () => ({ ModelRuntime: { create: async () => makeRuntime() } }),
    sessionFactory: async () => stubSession("hi"),
  });
  const { status, json } = await call(handler, "GET", "/health");
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.models, 2);
});

test("chat/completions returns OpenAI-shaped completion from pi session", async () => {
  const seen = [];
  const handler = createBridgeHandler({
    loadPi: async () => ({ ModelRuntime: { create: async () => makeRuntime() } }),
    sessionFactory: async (pick) => {
      seen.push(pick);
      return stubSession('{"mode":"generate","thesis":"ok"}');
    },
  });
  const { status, json } = await call(handler, "POST", "/v1/chat/completions", {
    model: "anthropic/claude-sonnet-4-5",
    messages: [
      { role: "system", content: "STRICT JSON only." },
      { role: "user", content: "Theme: rain" },
    ],
  });
  assert.equal(status, 200);
  const choice = json.choices?.[0];
  assert.equal(choice.finish_reason, "stop");
  assert.match(choice.message.content, /"mode":"generate"/);
  assert.equal(json.usage.completion_tokens, 45);
  // system+user flattened into one prompt and handed to the picked model
  assert.equal(seen.length, 1);
  assert.equal(seen[0].model.providerId, "anthropic");
  assert.match(flattenMessages([{ role: "system", content: "A" }, { role: "user", content: "B" }]), /^A\n\nB$/);
});

test("content-block assistant replies are joined into plain text", () => {
  const text = assistantText({
    role: "assistant",
    content: [{ type: "thinking", thinking: "..." }, { type: "text", text: "FINAL" }],
  });
  assert.equal(text, "FINAL");
});

test("thinking-level suffix is parsed out of the model string", () => {
  const rt = makeRuntime();
  const pick = resolveModel(rt, "zai/glm-5.3:high");
  assert.equal(pick.model.id, "glm-5.3");
  assert.equal(pick.thinkingLevel, "high");
  // bare id resolves when it exists in the catalog
  const bare = resolveModel(rt, "claude-sonnet-4-5");
  assert.equal(bare.error, undefined);
  assert.equal(bare.model.providerId, "anthropic");
  const missingBare = resolveModel(rt, "unknown-model");
  assert.match(missingBare.error, /not found/);
  const missing = resolveModel(rt, "nope/nope");
  assert.match(missing.error, /not found/);
  const none = resolveModel(rt, "");
  assert.match(none.error, /model is required/);
});

test("unknown or malformed requests answer with structured errors, not crashes", async () => {
  const handler = createBridgeHandler({
    loadPi: async () => ({ ModelRuntime: { create: async () => makeRuntime() } }),
    sessionFactory: async () => stubSession("x"),
  });
  const bad = await call(handler, "POST", "/v1/chat/completions", { model: "nope/x", messages: [{ role: "user", content: "hi" }] });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error.message, /not found in pi catalog/);

  const nomsg = await call(handler, "POST", "/v1/chat/completions", { model: "anthropic/claude-sonnet-4-5", messages: [] });
  assert.equal(nomsg.status, 400);

  const notfound = await call(handler, "GET", "/nope");
  assert.equal(notfound.status, 404);
});

test("empty assistant output becomes a diagnosable 502, never silent success", async () => {
  const handler = createBridgeHandler({
    loadPi: async () => ({ ModelRuntime: { create: async () => makeRuntime() } }),
    sessionFactory: async () => stubSession("", "aborted"),
  });
  const { status, json } = await call(handler, "POST", "/v1/chat/completions", {
    model: "anthropic/claude-sonnet-4-5",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(status, 502);
  assert.match(json.error.message, /stopReason=aborted/);
});
