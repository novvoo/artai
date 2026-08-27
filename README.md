# artai

Deterministic minimal-zine poster engine — theme in, editorial poster out.

**Architecture:** [docs/architecture.md](docs/architecture.md) · the design is grounded
in two source projects: `gc-minimal-zine-poster` (decision system) × `p5.brush` (rendering system).

## Status — build order (architecture §21)

| # | Step | State |
|---|---|---|
| 1 | `core/types` zod schemas + JSON-Schema export | ✅ |
| 2 | `core/recipe` variation + batch constraints | ✅ |
| 3 | `agent/ports` + heuristic providers (offline default) | ✅ |
| 4 | `core/prompt` four-paragraph compiler | ✅ |
| 5 | `core/layout` families + solver + budgets (200-seed verified) | ✅ |
| 6 | `core/scene` IR compiler + golden harness | ✅ IR · goldens pending |
| 7–9 | render backend (`paper/fill/hatch` via p5.brush standalone · canvas-fallback · shared overlay) | ✅ v0.9 dual-rasterizer |
| 10–11 | gate repair envelope ✅ · pixel gate + Playwright visual suite ⏳ | partial |
| 12 | styles loader | ⏳ |
| 13 | `agent/pi` adapter (spec'd §11; BrowserIntentProvider shipped instead for web BYOK) | ⏳ |
| 14 | Studio SPA (Create / Result / **poster image** / Gate / Settings / model vault) | ✅ v0.9 |
| 15 | Studio second wave (batch grid, library persistence, share links) | ⏳ |
| 16 | CI-generated llms.txt · Pages workflow | ⏳ |

## Run

```bash
npm install            # workspaces: packages/artai + apps/studio

npm run build          # esbuild bundle (3 entries + d.ts) → schema → vite spa
npm test               # vitest: schema / variation / solver / pipeline / ir
npm run typecheck      # tsc both packages

npm run dev            # studio @ http://localhost:5173 (builds lib first)
npm run demo           # CLI end-to-end prompt generation, offline heuristic

node packages/artai/bin/artai.mjs doctor     # capability report
node packages/artai/bin/artai.mjs make "一只麋鹿与花草错过的夏天" --seed 42
node packages/artai/bin/artai.mjs batch "晴天下午的海边沙滩" --count 6   # variety-enforced
node packages/artai/bin/artai.mjs schema    # recipe JSON Schema
```

## Model configuration (web)

Studio → 模型设置: preset (OpenRouter / OpenAI / Anthropic / custom OpenAI-compatible),
API key kept **local-only** (`localStorage`, requests go browser→provider directly),
"测试连接" validates reachability + structured-output contract. No key configured ⇒
fully functional offline heuristic tier; every Envelope records its `intentSource`
provenance. The Node-side `pi-coding-agent` transport (multi-provider sessions,
session trees) follows the same `IntentProvider` port when landed.

## Guarantees today

- Same seed → identical Recipe / Plan / SceneIR / prompt, cross-platform.
- Negative-space and cluster budgets hold across arbitrary seeds (property-tested).
- Eval #8 as code: non-maritime themes can never grow maritime grammar tokens.
- Zero native binaries at runtime (§19.1).
