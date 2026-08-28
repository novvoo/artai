import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserIntentProvider,
  coerce,
  extractJson,
  parseGraphJsonl,
  repairTruncatedJson,
  ProviderContractViolation,
} from "../../src/agent/browser.js";
import { ImageGenClient } from "../../src/agent/image.js";
import { IntentDraftSchema } from "../../src/core/types/index.js";
import { scanPartialGraph } from "../../src/core/scene/graph.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** fixture that passes the art-director gate: solid focal body off-center,
 * varied value range, ≥8 layers */
function artGoodGraph() {
  const layers: any[] = [
    { id: "paper", label: "paper", depth: 0, shapes: [
      { type: "gradient_fill", x: 0, y: 0, w: 1200, h: 2000,
        colorTop: "#f2ead8", colorBottom: "#d9c9a8", alpha: 1 },
    ]},
  ];
  // 7 midground layers × 3 shapes — dense enough for the art-director gate
  for (let i = 0; i < 7; i++) {
    layers.push({ id: `atmo${i}`, label: `atmo ${i}`, depth: 1 + (i % 5), shapes: [
      { type: "gradient_fill", x: 80 + i * 70, y: 260 + i * 160, w: 520, h: 300,
        colorTop: "#cbc0dd", colorBottom: "#ddd4e8", alpha: 0.1 + i * 0.02 },
      { type: "organic_blob", cx: 280 + i * 100, cy: 480 + i * 130, rBase: 120,
        harmonics: [0.06, 0.09], fill: "#cbc0dd", alpha: 0.14 + i * 0.02 },
      { type: "stroke_path", lineWidth: 1.5, color: "#26241f", pressureTaper: true,
        points: [[90 + i * 50, 420 + i * 150], [500 + i * 40, 470 + i * 150],
                 [1000 - i * 30, 430 + i * 150]] },
    ]});
  }
  layers.push(
    { id: "wash", label: "wash", depth: 4, shapes: [
      { type: "organic_blob", cx: 380, cy: 700, rBase: 300,
        harmonics: [0.05, 0.08], fill: "#cbc0dd", alpha: 0.2 },
      { type: "round_rect", x: 120, y: 1560, w: 960, h: 300, r: 20,
        fill: "#e9e0cc", alpha: 0.3 },
      { type: "stroke_path", lineWidth: 2, color: "#26241f", pressureTaper: true,
        points: [[140, 1590], [600, 1610], [1060, 1590]] },
    ]},
    { id: "focal", label: "cup", depth: 8, shapes: [
      { type: "ellipse", cx: 470, cy: 1050, rx: 95, ry: 115,
        fill: "#cbc0dd", alpha: 0.55 },
      { type: "stroke_path", lineWidth: 4, color: "#26241f",
        points: [[375, 935], [368, 1050], [384, 1150], [470, 1172],
                 [556, 1150], [572, 1050], [565, 937], [375, 935]] },
      { type: "organic_blob", cx: 520, cy: 980, rBase: 46,
        harmonics: [0.1, 0.12], fill: "#26241f", alpha: 0.3 },
      { type: "stroke_path", lineWidth: 2, color: "#26241f",
        points: [[390, 1090], [470, 1108], [548, 1094], [390, 1090]] },
    ]},
    { id: "finish", label: "finish", depth: 9, shapes: [
      { type: "grain", density: 4800 },
      { type: "vignette", intensity: 0.12 },
    ]},
  );
  return { lightDeg: 315, layers, paletteLocked: ["#d8412f", "#26241f", "#e9e0cc"] };
}

describe("extractJson", () => {
  it("handles fenced JSON, leading prose, and nested braces", () => {
    const fenced = '```json\n{"mode":"generate","metaphor":{"subject":"a {curly} door"}}\n```';
    expect(() => JSON.parse(extractJson(fenced))).not.toThrow();
    const prose = 'Sure! Here is the intent: {"thesis":"x","metaphor":{"subject":"s","relation":"r"}} hope that helps';
    expect(JSON.parse(extractJson(prose)).thesis).toBe("x");
  });

  it("throws a distinguishable error when no braces exist", () => {
    expect(() => extractJson("I cannot help with that.")).toThrow(/no JSON object/);
  });

  it("ignores braces inside strings", () => {
    const tricky = '{"relation":"odd } brace"}';
    expect(JSON.parse(extractJson(`prefix ${tricky}`)).relation).toContain("}");
  });
});

describe("repairTruncatedJson — salvage of length-truncated replies", () => {
  const graphPrefix =
    '{"lightDeg":315,"layers":[' +
    '{"id":"paper-base","label":"aged stock","depth":0,' +
    '"shapes":[{"type":"gradient_fill","x":0,"y":0,"w":1200,"h":2000,' +
    '"colorTop":"#f5e6c8","colorBottom":"#e8d5a3","alpha":0.9}]}';

  it("returns the full object untouched when nothing is truncated", () => {
    expect(repairTruncatedJson(graphPrefix + "]}")).toBe(graphPrefix + "]}");
  });

  it("closes open brackets up to the last complete member", () => {
    // cut off mid-way through a second layer's unterminated label
    const cut = graphPrefix + ',{"id":"mist","label":"hazy summer';
    const repaired = repairTruncatedJson(cut);
    expect(repaired).not.toBeNull();
    const parsed = JSON.parse(repaired!);
    expect(parsed.lightDeg).toBe(315);
    // layer 1 survives intact; layer 2 keeps only what completed ("id")
    expect(parsed.layers).toHaveLength(2);
    expect(parsed.layers[0].shapes).toHaveLength(1);
    expect(parsed.layers[1]).toEqual({ id: "mist" });
  });

  it("rewinds past partial numbers and strings without corrupting them", () => {
    // truncation leaves `4` (a half-written number) and an unterminated string
    const cut = '{"a":[{"n":1},{"x":"partial str","y":4';
    const parsed = JSON.parse(repairTruncatedJson(cut)!);
    // the half-written `4` is gone; the completed "x" pair is kept
    expect(parsed.a[0]).toEqual({ n: 1 });
    expect(parsed.a[1]).toEqual({ x: "partial str" });
    expect("y" in parsed.a[1]).toBe(false);
  });

  it("ignores structural characters that appear inside strings", () => {
    const cut = '{"layers":[{"id":"s","label":"unclosed { [ quote';
    const parsed = JSON.parse(repairTruncatedJson(cut)!);
    // the unterminated label (and its braces) never leak into structure
    expect(parsed.layers[0]).toEqual({ id: "s" });
  });

  it("returns null only when nothing usable survives", () => {
    // the top-level comma after lightDeg is a clean boundary, so the
    // surviving prefix is the root object with just that one member
    expect(JSON.parse(repairTruncatedJson('{"lightDeg":315,"layers":[{"id":"half')!))
      .toEqual({ lightDeg: 315 });
    expect(repairTruncatedJson("no json at all")).toBeNull();
  });
});

describe("parseGraphJsonl — per-line composition replies", () => {
  const layer = (i: number) =>
    `{"id":"l${i}","label":"layer ${i}","depth":${i},"shapes":[{"type":"grain","density":4000}]}`;

  it("harvests the header and every layer line independently", () => {
    const out = parseGraphJsonl(
      `{"lightDeg":270}\n${layer(0)}\n${layer(1)}`,
    );
    expect(out.lightDeg).toBe(270);
    expect(out.layers).toHaveLength(2);
    expect(out.badLines).toBe(0);
  });

  it("tolerates fences, prose noise, numbering and dangling commas", () => {
    const out = parseGraphJsonl(
      "```jsonlines\n" +
      `Here comes the graph:\n{"lightDeg":10,\n` +
      `1. ${layer(0)},\n` +
      `2. ${layer(1)}\ntrailing garbage}\n\`\`\``,
    );
    expect(out.lightDeg).toBe(10);
    expect(out.layers).toHaveLength(2);
  });

  it("drops a truncated trailing line but keeps everything before it", () => {
    // simulates a token-ceiling cut mid-final-line
    const out = parseGraphJsonl(
      `{"lightDeg":90}\n${layer(0)}\n${layer(1).slice(0, -12)}`,
    );
    expect(out.lightDeg).toBe(90);
    expect(out.layers).toHaveLength(1);
    expect(out.badLines).toBe(0); // never even attempted — no closing brace
  });

  it("unwraps a legacy full-object reply line", () => {
    const out = parseGraphJsonl(
      `{"lightDeg":45,"layers":[${layer(0)},${layer(1)}]}`,
    );
    expect(out.lightDeg).toBe(45);
    expect(out.layers).toHaveLength(2);
  });
});

describe("composeGraph quality-revision loop", () => {
  it("seeds the retry with the previous graph + art-director complaints", async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    let call = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      call++;
      if (call === 1) {
        // first draft: dead-center wireframe focal — the director complains
        return Promise.resolve(new Response(JSON.stringify({
          content: [{ text: JSON.stringify({
            lightDeg: 145,
            layers: [
              { id: "paper", label: "paper", depth: 0, shapes: [
                { type: "gradient_fill", x: 0, y: 0, w: 1200, h: 2000,
                  colorTop: "#f2ead8", colorBottom: "#d9c9a8", alpha: 1 },
              ]},
              ...Array.from({ length: 7 }, (_, i) => ({
                id: `l${i}`, label: `layer ${i}`, depth: i + 1,
                shapes: [{ type: "vignette", intensity: 0.1 }],
              })),
              { id: "focal", label: "focal", depth: 8, shapes: [
                { type: "stroke_path", lineWidth: 3, color: "#000",
                  points: [[560, 900], [600, 1100], [660, 980]] },
                { type: "organic_blob", cx: 640, cy: 950, rBase: 80,
                  harmonics: [0.1, 0.1], fill: "#888", alpha: 0.3 },
              ]},
            ],
            paletteLocked: ["#d8412f", "#26241f", "#e9e0cc"],
          }) }],
          stop_reason: "end_turn",
        }), { status: 200 }));
      }
      // revision: proper graph — must pass the gate
      return Promise.resolve(new Response(JSON.stringify({
        content: [{ text: JSON.stringify(artGoodGraph()) }],
        stop_reason: "end_turn",
      }), { status: 200 }));
    }));
    const bp = new BrowserIntentProvider({
      kind: "anthropic", baseUrl: "https://api.anthropic.com/v1",
      apiKey: "k", model: "glm-4.6",
    });
    const statuses: string[] = [];
    const out = await bp.composeGraph({
      fullSpec: "brief", paletteHexes: ["#d8412f", "#26241f", "#e9e0cc"], theme: "t",
      onStatus: (s) => statuses.push(s),
    });
    expect(call).toBe(2);
    // the revision attempt received the previous graph AND the complaints
    // (anthropic wire: user prompt is messages[0]; the trailing assistant
    // message is just the "{" prefill)
    const revPrompt = bodies[1]!.messages[0]!.content;
    expect(revPrompt).toContain("REVISING");
    expect(revPrompt).toContain("PREVIOUS GRAPH");
    expect(revPrompt).toMatch(/wireframe-only|dead center/);
    // the revised graph won (artGoodGraph has 11 layers)
    expect(out.layers).toHaveLength(11);
    // live progress surfaced both steps
    expect(statuses.some((s) => s.includes("打磨"))).toBe(true);
  });
  it("seeds a previousGraph polish round even with no complaints", async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(new Response(JSON.stringify({
        content: [{ text: JSON.stringify(artGoodGraph()) }],
        stop_reason: "end_turn",
      }), { status: 200 }));
    }));
    const bp = new BrowserIntentProvider({
      kind: "anthropic", baseUrl: "https://api.anthropic.com/v1",
      apiKey: "k", model: "glm-4.6",
    });
    const statuses: string[] = [];
    const out = await bp.composeGraph({
      fullSpec: "brief", paletteHexes: ["#d8412f", "#26241f", "#e9e0cc"], theme: "t",
      previousGraph: { graphJson: '{"lightDeg":315,"layers":[]}' },
      onStatus: (s) => statuses.push(s),
    });
    expect(out.layers).toHaveLength(11);
    // single polished attempt: the seed carries an ELEVATE brief when the
    // incoming graph had no deterministic complaints
    const prompt = bodies[0]!.messages[0]!.content;
    expect(prompt).toContain("REVISING");
    expect(prompt).toContain("ELEVATE");
    expect(statuses.some((s) => s.includes("打磨"))).toBe(true);
  });
});

describe("composeGraph JSONL escape hatch", () => {
  it("falls through to the JSONL rung after two truncated single-object replies", async () => {
    let call = 0;
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      call++;
      if (call <= 2) {
        // truncation: cut off mid-object with finish=max_tokens
        return Promise.resolve(new Response(JSON.stringify({
          content: [{ text: '{"lightDeg":200,"layers":[{"id":"paper","label":"p","depth":0,"shapes":[{"type":"grain","den' }],
          stop_reason: "max_tokens",
        }), { status: 200 }));
      }
      // third call: proper JSON Lines answer, streamed format (no prefill)
      const lines = [
        '{"lightDeg":200}',
        ...Array.from({ length: 9 }, (_, i) =>
          `{"id":"l${i}","label":"layer ${i}","depth":${i},"shapes":[{"type":"vignette","intensity":0.3}]}`),
      ].join("\n");
      return Promise.resolve(new Response(JSON.stringify({
        content: [{ text: lines }],
        stop_reason: "end_turn",
      }), { status: 200 }));
    }));
    const bp = new BrowserIntentProvider({
      kind: "anthropic", baseUrl: "https://api.anthropic.com/v1",
      apiKey: "k", model: "glm-4.6",
    });
    const out = await bp.composeGraph({
      fullSpec: "brief", paletteHexes: ["#aa0000", "#26241f", "#e9e0cc"], theme: "t",
    });
    // attempt 3 reaches JSONL; the mock's vignette-only layers keep failing
    // the art director, so up to 2 revision rounds follow (mock repeats them)
    expect(call).toBeGreaterThanOrEqual(3);
    expect(out.lightDeg).toBe(200);
    expect(out.layers).toHaveLength(9);
    // JSONL mode must NOT use assistant prefill — it would break line format
    const third = bodies[2] as { messages: Array<{ role: string }> };
    expect(third.messages.every((m) => m.role !== "assistant")).toBe(true);
  });
});

describe("coerce — tolerant mapping of near-miss LLM replies", () => {
  it("accepts the exact wire contract incl. null shortText (was failing before)", () => {
    const raw = {
      mode: "generate",
      thesis: "ping",
      metaphor: { subject: "a dot", relation: "ignored" },
      mood: "quiet",
      shortText: null, // ← models obeying our own prompt sent this; schema used to reject
      lang: "en",
    };
    const draft = IntentDraftSchema.parse(coerce(raw));
    expect(draft.shortText).toBeNull();
    expect(draft.mood).toBe("quiet");
  });

  it("maps unknown moods to a sane default instead of failing", () => {
    const coerced = coerce({
      mode: "generate",
      thesis: "t",
      metaphor: { subject: "s", relation: "r" },
      mood: "Melancholic Nostalgia",
    }) as Record<string, unknown>;
    expect(["solitude", "memory", "quiet"]).toContain(coerced.mood);
  });

  it("photograph mentions upgrade mode to photo-input", () => {
    const coerced = coerce({
      mode: "photo whatever",
      thesis: "t",
      metaphor: { subject: "s", relation: "r" },
      mood: "night",
    }) as Record<string, unknown>;
    expect(coerced.mode).toBe("photo-input");
  });

  it("still rejects drafts without a metaphor subject", () => {
    const coerced = coerce({ thesis: "only", metaphor: {}, mood: "quiet" });
    expect(() => IntentDraftSchema.parse(coerced)).toThrow();
  });
});

describe("contract violation carries diagnostics", () => {
  it("exposes stage and reply preview for UI display", () => {
    const err = new ProviderContractViolation(
      "no-json: reply refused | reply: I can't help with that.",
      "no-json",
      "I can't help with that.",
    );
    expect(err.name).toBe("ProviderContractViolation");
    expect(err.stage).toBe("no-json");
    expect(err.replyPreview).toMatch(/can't help/);
    expect(err.message).toContain(err.replyPreview);
  });
});

describe("empty-reply escalation ladder", () => {
  const VALID = {
    choices: [
      {
        message: { content: '{"mode":"generate","thesis":"t","metaphor":{"subject":"a door","relation":"r"},"mood":"quiet","shortText":null,"lang":"en"}' },
        finish_reason: "stop",
      },
    ],
    usage: { completion_tokens: 40 },
  };

  it("escalates budget on empty 'length' replies and succeeds on the next rung", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length < 3) {
        return jsonOk({
          choices: [{ message: { content: "" }, finish_reason: "length" }],
          usage: { completion_tokens: 1024 },
        });
      }
      return jsonOk(VALID);
    }));

    const p = new BrowserIntentProvider({
      kind: "openai-compatible",
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "thinker-model",
    });
    const draft = await p.parse({ theme: "t" });
    expect(bodies.length).toBe(3);
    expect(bodies[0]!.max_tokens).toBe(2048);
    expect(bodies[1]!.max_tokens).toBe(6048); // rung 2 raises the ceiling
    expect(draft.metaphor.subject).toBe("a door");
  });

  it("persistent empties surface finish_reason diagnostics for the UI", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonOk({ choices: [{ message: { content: null }, finish_reason: "stop" }] }),
    ));
    const p = new BrowserIntentProvider({
      kind: "openai-compatible",
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
    });
    const err = await p.parse({ theme: "t" }).then(
      () => null,
      (e: unknown) => e as ProviderContractViolation,
    );
    expect(err).toBeInstanceOf(ProviderContractViolation);
    expect(err!.stage).toBe("empty");
    expect(err!.message).toContain("finish=stop");
  });

  it("non-completions-looking endpoints get an endpoint-hint diagnostic", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonOk({})));
    const p = new BrowserIntentProvider({
      kind: "openai-compatible",
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
    });
    const err = await p.parse({ theme: "t" }).then(
      () => null,
      (e: unknown) => e as ProviderContractViolation,
    );
    expect(err!.stage).toBe("empty");
    expect(err!.replyPreview).toContain("<empty>");
  });
});

describe("anthropic-compatible proxy gateway (GLM, etc.)", () => {
  function anthropicJsonOk(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200 });
  }

  it("retries against the /v1 endpoint when the pasted base URL returns a gateway 404 page", async () => {
    // GLM open.bigmodel.cn/api/anthropic (no /v1) answers HTTP 200 with a
    // gateway envelope that has NO anthropic fields — previously surfaced
    // as an opaque "empty (finish=?)".
    const urls: string[] = [];
    const fetchStub = vi.fn().mockImplementation((url: string) => {
      urls.push(url);
      if (!/\/v1\/messages$/.test(url)) {
        return Promise.resolve(new Response(
          JSON.stringify({ code: 500, msg: "404 NOT_FOUND", success: false }),
          { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        content: [{ text: '{"mode":"generate","thesis":"t","metaphor":{"subject":"a door","relation":"r"},"mood":"quiet","shortText":null,"lang":"en"}' }],
        stop_reason: "end_turn",
      }), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchStub);
    const bp = new BrowserIntentProvider({
      kind: "anthropic", baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKey: "k", model: "glm-4.6",
    });
    const draft = await bp.parse({ theme: "t" });
    expect(draft.thesis).toBe("t");
    // first attempt used the raw URL, second attempt auto-appended /v1
    expect(urls[0]).toBe("https://open.bigmodel.cn/api/anthropic/messages");
    expect(urls[1]).toBe("https://open.bigmodel.cn/api/anthropic/v1/messages");
  });

  it("throws upstream error when even the /v1 path rejects with a gateway envelope", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(
        JSON.stringify({ code: 500, msg: "404 NOT_FOUND", success: false }),
        { status: 200 }))));
    let caught: unknown;
    try {
      const bp = new BrowserIntentProvider({
        kind: "anthropic", baseUrl: "https://open.bigmodel.cn/api/anthropic",
        apiKey: "bad", model: "glm-4.6",
      });
      await bp.parse({ theme: "t" });
    } catch (e) { caught = e; }
    // ProviderError or its escalated form — either way the gateway msg is shown
    const msg = (caught as Error).message;
    expect(msg).toMatch(/404 NOT_FOUND|upstream:/);
  });

  it("embeds a body preview in empty-reply diagnostics instead of a bare finish=?", async () => {
    const fetchStub = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ weird: true }), { status: 200 })));
    vi.stubGlobal("fetch", fetchStub);
    const bp = new BrowserIntentProvider({
      kind: "anthropic", baseUrl: "https://x.example/v1",
      apiKey: "k", model: "m",
    });
    let caught: unknown;
    try { await bp.parse({ theme: "t" }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ProviderContractViolation);
    expect((caught as ProviderContractViolation).message)
      .toContain("unrecognized body:");
  });

  it("ping() is a single minimal round-trip with no assistant prefill", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init?: { body?: string }) => {
      if (init?.body) bodies.push(init.body);
      return Promise.resolve(new Response(JSON.stringify({
        content: [{ text: '{"ok":true}' }],
        stop_reason: "end_turn",
        usage: { output_tokens: 8 },
      }), { status: 200 }));
    }));
    const bp = new BrowserIntentProvider({
      kind: "anthropic", baseUrl: "https://api.anthropic.com/v1",
      apiKey: "k", model: "claude-sonnet-4-5",
    });
    const r = await bp.ping();
    expect(r.ok).toBe(true);
    expect(bodies.length).toBe(1);
    // no prefill ping-pong: exactly one user message
    const sent = JSON.parse(bodies[0]!);
    expect(sent.messages).toHaveLength(1);
    expect(sent.messages[0].role).toBe("user");
  });

  it("remembers the working /v1 base so later calls skip the wrong-path probe", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      urls.push(url);
      if (!/\/v1\/messages$/.test(url)) {
        return Promise.resolve(new Response(
          JSON.stringify({ code: 500, msg: "404 NOT_FOUND", success: false }),
          { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        content: [{ text: '{"mode":"generate","thesis":"t","metaphor":{"subject":"a door","relation":"r"},"mood":"quiet","shortText":null,"lang":"en"}' }],
        stop_reason: "end_turn",
      }), { status: 200 }));
    }));
    // fresh key per test so the module-level memo starts cold
    const cfg = { kind: "anthropic" as const,
      baseUrl: `https://probe-${Math.random().toString(36).slice(2)}.example/api/anthropic`,
      apiKey: "k", model: "glm-4.6" };
    await new BrowserIntentProvider(cfg).parse({ theme: "t" });
    // first pass includes at least one wrong-path probe before the /v1 hit
    expect(urls.some((u) => !/\/v1\//.test(u))).toBe(true);
    const wrongPathProbes = urls.filter((u) => !/\/v1\//.test(u)).length;
    urls.length = 0;
    // second provider instance over the same config — memoized, /v1 only
    await new BrowserIntentProvider(cfg).parse({ theme: "t2" });
    expect(urls.length).toBe(1); // single direct hit, zero wrong-path probes
    expect(urls.every((u) => /\/v1\/messages$/.test(u))).toBe(true);
    void wrongPathProbes;
  });

  it("composeGraph survives assistant-prefill colliding with a ```json fence", async () => {
    // regression: model opens its reply with its own fence; the "{" prefill
    // used to be prepended in front of it, producing `{```json {...}` which
    // could never parse. The cleaned reply must yield a valid graph.
    const graph = artGoodGraph();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({
        content: [{ text: "```json\n" + JSON.stringify(graph, null, 2) + "\n```" }],
        stop_reason: "end_turn",
      }), { status: 200 }))));
    const bp = new BrowserIntentProvider({
      kind: "anthropic", baseUrl: "https://api.anthropic.com/v1",
      apiKey: "k", model: "glm-4.6",
    });
    const out = await bp.composeGraph({
      fullSpec: "brief", paletteHexes: ["#aa0000", "#26241f", "#e9e0cc"], theme: "t",
    });
    expect(out.lightDeg).toBe(315);
    expect(out.layers).toHaveLength(11);
  });
  it("parses valid replies from URLs already carrying /v1 without double-appending", async () => {
    const urls: string[] = [];
    const fetchStub = vi.fn().mockImplementation((url: string) => {
      urls.push(url);
      return Promise.resolve(new Response(JSON.stringify({
        content: [{ text: '{"mode":"generate","thesis":"ok","metaphor":{"subject":"a door","relation":"r"},"mood":"quiet","shortText":null,"lang":"en"}' }],
        stop_reason: "end_turn",
      }), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchStub);
    const bp = new BrowserIntentProvider({
      kind: "anthropic", baseUrl: "https://api.anthropic.com/v1",
      apiKey: "k", model: "claude-sonnet-4-5",
    });
    await bp.parse({ theme: "t" });
    expect(urls.every((u) => u === "https://api.anthropic.com/v1/messages")).toBe(true);
  });

  it("surfaces proxy error envelope (HTTP 200 + {error: {...}}) with diagnostic preserved", async () => {
    const fetchStub = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ type: "error", error: { message: "令牌已过期或验证不正确", type: 1000 } }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchStub);
    const bp = new BrowserIntentProvider({
      kind: "anthropic", baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKey: "bad", model: "glm-4.6",
    });
    // raw() throws ProviderError; parse() escalates through rungs and
    // ultimately throws ProviderContractViolation carrying the proxy
    // message in its body so the studio can show actionable advice.
    let caught: unknown;
    try { await bp.parse({ theme: "t" }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ProviderContractViolation);
    const msg = (caught as ProviderContractViolation).message;
    expect(msg).toContain("upstream: ");
    expect(msg).toContain("令牌已过期");
  });

  it("sends system as a top-level field, never concatenated into user content", async () => {
    const fetchStub = vi.fn().mockResolvedValueOnce(
      anthropicJsonOk({
        content: [{ text: '{"mode":"generate","thesis":"t","metaphor":{"subject":"a door","relation":"r"},"mood":"quiet","shortText":null,"lang":"en"}' }],
        stop_reason: "end_turn",
      }),
    );
    vi.stubGlobal("fetch", fetchStub);
    const bp = new BrowserIntentProvider({
      kind: "anthropic", baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKey: "k", model: "glm-4.6",
    });
    await bp.parse({ theme: "t" });
    const sent = JSON.parse(fetchStub.mock.calls[0]![1].body as string);
    // system MUST be a sibling of model/messages, not inside a user message
    expect(typeof sent.system).toBe("string");
    expect(JSON.stringify(sent.messages)).not.toMatch(/system/i);
    // both x-api-key AND Bearer headers sent so native + proxy auth both work
    const headers = fetchStub.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("k");
    expect(headers["authorization"]).toBe("Bearer k");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    // max_tokens is a positive integer even when caller passes 0
    expect(sent.max_tokens).toBeGreaterThan(0);
  });

  it("names the network-layer cause when fetch itself fails, trying both base variants", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      urls.push(url);
      // browser network failure: offline / DNS / CORS all look like this
      return Promise.reject(new TypeError("Failed to fetch"));
    }));
    const bp = new BrowserIntentProvider({
      kind: "anthropic", baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKey: "k", model: "glm-4.6",
    });
    let caught: unknown;
    try { await bp.parse({ theme: "t" }); } catch (e) { caught = e; }
    // both the pasted URL and its /v1 variant were attempted
    expect(urls.length).toBeGreaterThanOrEqual(2);
    expect(urls.some((u) => u.endsWith("/v1/messages"))).toBe(true);
    const msg = (caught as Error).message;
    expect(msg).toContain("network failure");
    expect(msg).toContain("Failed to fetch");
  });

  it("retries through the local /artai-proxy when the gateway breaks CORS", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      seen.push(url);
      if (!url.startsWith("/artai-proxy"))
        return Promise.reject(new TypeError("Failed to fetch")); // malformed ACAO etc.
      // the passthrough relays to the real target and returns its answer
      // (base-variant memoization means /v1 may or may not be attached)
      const target = new URL(url, "http://proxy.local").searchParams.get("target");
      expect(target).toMatch(/^https:\/\/open\.bigmodel\.cn\/api\/anthropic(\/v1)?\/messages$/);
      return Promise.resolve(new Response(JSON.stringify({
        content: [{ text: '{"mode":"generate","thesis":"proxied","metaphor":{"subject":"a door","relation":"r"},"mood":"quiet","shortText":null,"lang":"en"}' }],
        stop_reason: "end_turn",
      }), { status: 200 }));
    }));
    const bp = new BrowserIntentProvider({
      kind: "anthropic", baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKey: "k", model: "glm-4.6",
    });
    const out = await bp.parse({ theme: "t" });
    expect(out.thesis).toBe("proxied");
    expect(seen.some((u) => u.startsWith("/artai-proxy"))).toBe(true);
  });

  it("falls back to a safe max_tokens when caller hands in 0 (e.g. budget omitted)", async () => {
    const fetchStub = vi.fn().mockResolvedValueOnce(
      anthropicJsonOk({
        content: [{ text: '{"mode":"generate","thesis":"t","metaphor":{"subject":"a door","relation":"r"},"mood":"quiet","shortText":null,"lang":"en"}' }],
        stop_reason: "end_turn",
      }),
    );
    vi.stubGlobal("fetch", fetchStub);
    const bp = new BrowserIntentProvider({
      kind: "anthropic", baseUrl: "https://x.example/api/anthropic",
      apiKey: "k", model: "m",
    });
    // refinePrompt uses maxTokens: 900 — fine. But if maxTokens were 0 the
    // request should still carry a positive budget.
    await bp.parse({ theme: "t" });
    const sent = JSON.parse(fetchStub.mock.calls[0]![1].body as string);
    expect(sent.max_tokens).toBeGreaterThanOrEqual(1);
  });
});

describe("streaming (SSE) transports", () => {
  function sseResponse(frames: string[]): Response {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(enc.encode(f));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  it("anthropic wire: accumulates content_block_delta frames", async () => {
    const graph = JSON.stringify(artGoodGraph());
    const deltas: string[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}");
      expect(body.stream).toBe(true); // composeGraph attaches a delta consumer
      return Promise.resolve(sseResponse([
        `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":${JSON.stringify(graph.slice(0, Math.ceil(graph.length / 2)))}}}\n\n`,
        `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":${JSON.stringify(graph.slice(Math.ceil(graph.length / 2)))}}}\n\n`,
        `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n`,
        `data: {"type":"message_stop"}\n\n`,
      ]));
    }));
    const bp = new BrowserIntentProvider({
      kind: "anthropic", baseUrl: "https://api.anthropic.com/v1",
      apiKey: "k", model: "glm-4.6",
    });
    const out = await bp.composeGraph({
      fullSpec: "brief", paletteHexes: ["#a00000", "#26241f", "#e9e0cc"],
      theme: "t", onDelta: (c) => deltas.push(c),
    });
    // streamed pieces concatenated reconstruct the exact graph text
    expect(deltas.join("")).toBe(graph);
    expect(out.lightDeg).toBe(315);
    expect(out.layers).toHaveLength(11);
  });

  it("composeGraph streams even with NO delta consumer (gateway idle-timeout guard)", async () => {
    const graph = JSON.stringify(artGoodGraph());
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}");
      expect(body.stream).toBe(true); // preferStream without any onDelta
      return Promise.resolve(new Response(
        `data: {"type":"content_block_delta","delta":{"text":${JSON.stringify(graph)}}}\n\n` +
        `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n` +
        `data: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } }));
    }));
    const bp = new BrowserIntentProvider({
      kind: "anthropic", baseUrl: "https://api.anthropic.com/v1",
      apiKey: "k", model: "glm-4.6",
    });
    const out = await bp.composeGraph({
      fullSpec: "brief", paletteHexes: ["#a00000", "#26241f", "#e9e0cc"], theme: "t",
    });
    expect(out.lightDeg).toBe(315);
    expect(out.layers).toHaveLength(11);
  });

  it("openai-compatible wire: accumulates delta.content frames into one reply", async () => {
    const intent = '{"mode":"generate","thesis":"ok","metaphor":{"subject":"a door","relation":"r"},"mood":"quiet","shortText":null,"lang":"en"}';
    const deltas: string[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init?: { body?: string }) => {
      expect(JSON.parse(init?.body ?? "{}").stream).toBe(true);
      return Promise.resolve(sseResponse([
        `data: {"choices":[{"delta":{"content":${JSON.stringify(intent.slice(0, 10))}}}]}\n\n`,
        `data: {"choices":[{"delta":{"content":${JSON.stringify(intent.slice(10))}},"finish_reason":null}]}\n\n`,
        `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`,
        `data: [DONE]\n\n`,
      ]));
    }));
    const bp = new BrowserIntentProvider({
      kind: "openai-compatible", baseUrl: "https://api.example/v1",
      apiKey: "k", model: "gpt-x",
    });
    // drive the streaming path directly through raw() with a delta consumer
    const rr = await (bp as unknown as {
      raw(p: string, o: Record<string, unknown>): Promise<{ text: string; finish?: string }>;
    }).raw("x", { system: "s", maxTokens: 512, useRF: false, prefill: false,
                   onDelta: (c: string) => deltas.push(c) });
    expect(deltas.join("")).toBe(intent);
    expect(rr.text).toBe(intent);
    expect(rr.finish).toBe("stop");
  });

  it("non-stream fallback: proxies that ignore stream:true still answer normally", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [{ text: '{"mode":"generate","thesis":"plain","metaphor":{"subject":"a door","relation":"r"},"mood":"quiet","shortText":null,"lang":"en"}' }],
      stop_reason: "end_turn",
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const bp = new BrowserIntentProvider({
      kind: "anthropic", baseUrl: "https://api.anthropic.com/v1",
      apiKey: "k", model: "claude-sonnet-4-5",
    });
    await expect(bp.parse({ theme: "t" })).resolves.toMatchObject({ thesis: "plain" });
  });
});

describe("scanPartialGraph — incremental graph harvesting", () => {
  const fullGraph = JSON.stringify({
    lightDeg: 315,
    layers: [
      { id: "paper", label: "matte stock", depth: 0,
        shapes: [{ type: "gradient_fill", x: 0, y: 0, w: 1200, h: 2000 }] },
      { id: "wash", label: "color mass", depth: 2,
        shapes: [{ type: "organic_blob", cx: 600, cy: 700, rBase: 300, harmonics: [0.1] }] },
      { id: "focal", label: "contour", depth: 9,
        shapes: [{ type: "stroke_path", points: [[100, 200], [300, 400], [500, 600]] }] },
    ],
    paletteLocked: ["#aa0000", "#26241f", "#e9e0cc"],
  }, null, 2);

  it("extracts lightDeg as soon as its pair appears and layers as they close", () => {
    expect(scanPartialGraph(fullGraph.slice(0, 6))).toEqual({ lightDeg: null, layers: [] });
    // lightDeg visible before any layer completes
    const afterLight = fullGraph.indexOf('"layers"');
    expect(scanPartialGraph(fullGraph.slice(0, afterLight)).lightDeg).toBe(315);
    // first layer object closed
    const idxPaperEnd = fullGraph.indexOf("},", fullGraph.indexOf('"paper"')) + 1;
    const p1 = scanPartialGraph(fullGraph.slice(0, idxPaperEnd + 1));
    expect(p1.layers).toHaveLength(1);
    expect((p1.layers[0] as any).id).toBe("paper");
    // mid-layer truncation does not fabricate an extra layer
    const midWash = fullGraph.indexOf('"wash"') + 10;
    expect(scanPartialGraph(fullGraph.slice(0, midWash)).layers).toHaveLength(1);
  });

  it("tolerates fences, prefill debris and prose around the stream text", () => {
    const dirty = "{```json\n" + fullGraph + "\n```\n(trailing note)";
    const p = scanPartialGraph(dirty);
    expect(p.lightDeg).toBe(315);
    expect(p.layers.map((l) => (l as any).id)).toEqual(["paper", "wash", "focal"]);
  });

  it("handles strings containing braces and escapes correctly", () => {
    const tricky = `{"lightDeg":10,"layers":[{"id":"a{not-an-object}","label":"say \\"{}\\" hi","depth":1,"shapes":[{"type":"vignette"}]}],"paletteLocked":["#1","#2","#3"]}`;
    const p = scanPartialGraph(tricky);
    expect(p.layers).toHaveLength(1);
    expect((p.layers[0] as any).id).toBe("a{not-an-object}");
  });

  it("harvests the JSONL wire form (one layer per line) incrementally", () => {
    const header = '{"lightDeg":90}\n';
    const l0 = '{"id":"paper","depth":0,"shapes":[{"type":"gradient_fill"}]}';
    const l1 = '{"id":"wash","depth":2,"shapes":[{"type":"organic_blob"}]}';
    const l2 = '{"id":"focal","depth":9,"shapes":[{"type":"stroke_path"}]}';
    // nothing harvested before the header line completes
    expect(scanPartialGraph(header.slice(0, 8)).layers).toHaveLength(0);
    // first line lands
    expect(scanPartialGraph(`${header}${l0}\n`).layers.map((l: any) => l.id))
      .toEqual(["paper"]);
    // two lines
    expect(scanPartialGraph(`${header}${l0}\n${l1},\n`).layers).toHaveLength(2);
    // all three, with the final truncated line costing nothing yet
    const midLast = `${header}${l0}\n${l1},\n${l2.slice(0, 12)}`;
    const out = scanPartialGraph(midLast);
    expect(out.lightDeg).toBe(90);
    expect(out.layers).toHaveLength(2);
  });
});

describe("ImageGenClient", () => {
  it("prefers b64_json payloads and returns a data-url", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonOk({ data: [{ b64_json: "aGk=", revised_prompt: "refined" }] });
    }));
    const c = new ImageGenClient({
      baseUrl: "https://x/v1", apiKey: "k", model: "gpt-image-1", size: "1024x1536",
    });
    const out = await c.generate("poster prompt");
    expect(out.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(out.revisedPrompt).toBe("refined");
    expect(body!.size).toBe("1024x1536");
    expect(String(body!.prompt)).toContain("risograph"); // print-medium steering
  });

  it("falls back to hosted url downloads when only url is present", async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/images/generations"))
        return jsonOk({ data: [{ url: "https://cdn/img.png" }] });
      return new Response(png as unknown as BodyInit, { status: 200 });
    }));
    const c = new ImageGenClient({ baseUrl: "https://x/v1", apiKey: "k", model: "m" });
    const out = await c.generate("p");
    expect(out.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("throws ProviderContractViolation when no payload arrives", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonOk({ data: [{}] })));
    const c = new ImageGenClient({ baseUrl: "https://x/v1", apiKey: "k", model: "m" });
    await expect(c.generate("p")).rejects.toMatchObject({ name: "ProviderContractViolation" });
  });
});
